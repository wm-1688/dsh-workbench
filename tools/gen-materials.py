#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓一次热榜快照，供「素材库」表格展示。

用法：
    python tools/gen-materials.py

输出：lib/materials.snapshot.json（再由 gen-catalog.py 一起注入 client.js）

数据来源分两类（详见 collect-source-material/references/platforms.md 的实测记录）：
  · 直取（能拿到真实原文链接）：今日头条、百度热搜、抖音热榜
  · 聚合兜底（拿不到原文链接，用平台搜索链接代替）：微博、知乎 走 60s API

注意：热榜数据是**某一时刻的快照**，不是实时。表格里会显示抓取日期。
"""

import datetime
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
OUT = os.path.join(PLUGIN, "lib", "materials.snapshot.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# 原文链接拿不到就留空（不用搜索链接冒充原文）——表格里会显示「—」

DIRECT = [
    # (平台名, 接口, 条目数组路径, 标题键, 热度键, 链接键, (id键, 链接模板))
    ("今日头条", "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
     ["data"], ["Title", "title"], ["HotValue", "hot_value"], ["Url", "url"], None),
    ("百度", "https://top.baidu.com/api/board?platform=wise&tab=realtime",
     ["data", "cards", "0", "content", "0", "content"],
     ["word", "query", "title"], ["hotScore", "hot"], ["url", "rawUrl"], None),
    ("抖音", "https://www.douyin.com/aweme/v1/web/hot/search/list/",
     ["data", "word_list"], ["word", "sentence"], ["hot_value", "hot"],
     ["url", "share_url"], ("sentence_id", "https://www.douyin.com/hot/{}")),
]

AGG = [("微博", "weibo"), ("知乎", "zhihu")]

# ── AIHOT（AI 与 IT 渠道）──
# 60s 聚合没有 AI/IT 频道（实测 36kr / hackernews / github / v2ex / ithome … 全部 404），
# AIHOT 是多源聚合，覆盖 IT之家(RSS)、Hacker News、TechCrunch、X、技术博客等，
# 一条接入同时补上 AI 与 IT 两类渠道。
# 用 JSON 接口（/api/v1/*），不用 /agent/*（返回给人读的 Markdown）；
# AIHOT 使用说明写明：做定时同步或本地副本请用 JSON 接口，UA 用 aihot-api/2.0.0。
AIHOT_BASE = "https://aihot.news"
AIHOT_UA = "aihot-api/2.0.0"
AIHOT = [
    ("AI·热点", "/api/v1/hot-topics", "hot"),                 # 多源交叉的热点事件
    ("AI·资讯", "/api/v1/items?limit=50&window=24h", "feed"),  # 24 小时内的 AI 资讯，带摘要
]


def fetch_json(url, timeout=25, retries=2):
    """取 JSON。抖音等站偶发 SSL 瞬时失败，所以重试一次。"""
    last = None
    for _ in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json,text/html,*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Referer": url,
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
            for enc in ("utf-8", "gb18030"):
                try:
                    return json.loads(raw.decode(enc))
                except Exception:
                    continue
            raise ValueError("response is not JSON")
        except Exception as e:      # noqa: BLE001  网络瞬时错误统一重试
            last = e
    raise last


def dig(obj, path):
    cur = obj
    for key in path:
        if isinstance(cur, dict):
            cur = cur.get(key)
        elif isinstance(cur, list) and key.isdigit():
            idx = int(key)
            cur = cur[idx] if idx < len(cur) else None
        else:
            return None
        if cur is None:
            return None
    return cur


def pick(item, keys):
    low = {k.lower(): v for k, v in item.items()}
    for k in keys:
        if k.lower() in low and low[k.lower()] not in (None, ""):
            return low[k.lower()]
    return ""


def normalize(platform, items, title_keys, hot_keys, url_keys, id_rule, date):
    rows = []
    for i, item in enumerate(items, 1):
        if not isinstance(item, dict):
            continue
        title = str(pick(item, title_keys)).strip()
        if not title:
            continue
        hot = pick(item, hot_keys)
        real = str(pick(item, url_keys)).strip()
        url, kind = real, "原文"
        # 平台给的是搜索页而不是原文（百度 board 就是这种），按「拿不到」处理，留空
        if url and re.search(r"(/s\?word=|/search\?|/search/|s\?wd=|baidu\.com/s\?)", url):
            url, kind = "", "无"
        if not url and id_rule is not None:
            # 平台不给链接但有条目 id 时，拼出详情页地址（抖音 /hot/<id>）
            ident = pick(item, [id_rule[0]])
            if ident not in (None, ""):
                url, kind = id_rule[1].format(ident), "原文"
        rows.append({
            "key": f"{platform}@{date}#{i}",
            "platform": platform,
            "rank": i,
            "title": title,
            "hot": str(hot) if str(hot).isdigit() else "",
            "url": url,
            "date": date,
            "urlKind": kind,
        })
    return rows


def main():
    date = datetime.datetime.now().strftime("%Y-%m-%d")
    all_rows = []
    notes = []
    # 本次抓取成功的平台。合并时只替换这些平台的数据——
    # 抓失败的平台保留当天上一版，避免"一次失败把当天已有的数据抹掉"。
    fetched_ok = set()

    for platform, url, path, tk, hk, uk, id_rule in DIRECT:
        try:
            data = fetch_json(url)
            items = dig(data, path) or []
            rows = normalize(platform, items, tk, hk, uk, id_rule, date)
            all_rows.extend(rows)
            fetched_ok.add(platform)
            notes.append(f"{platform}: {len(rows)} 条（直取）")
        except Exception as e:
            notes.append(f"{platform}: 失败 {type(e).__name__} {e}")

    for platform, path in AGG:
        try:
            data = None
            for _ in range(3):          # 聚合接口会抖动，重试两次
                try:
                    req = urllib.request.Request("https://60s.viki.moe/v2/" + path,
                                                 headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=25) as r:
                        data = json.loads(r.read().decode("utf-8"))
                    break
                except Exception:
                    data = None
            if data is None:
                raise RuntimeError("三次都失败")
            items = data.get("data", [])
            rows = []
            for i, t in enumerate(items, 1):
                title = (t.get("title") or t.get("name") or "").strip()
                if not title:
                    continue
                rows.append({
                    "key": f"{platform}@{date}#{i}",
                    "platform": platform,
                    "rank": i,
                    "title": title,
                    "hot": str(t.get("hot_value") or t.get("hot") or ""),
                    "url": "",                 # 聚合接口不给原文链接，留空
                    "date": date,
                    "urlKind": "无",
                })
            all_rows.extend(rows)
            fetched_ok.add(platform)
            notes.append(f"{platform}: {len(rows)} 条（聚合兜底）")
        except Exception as e:
            notes.append(f"{platform}: 失败 {type(e).__name__} {e}")

    # ── AIHOT：AI 与 IT 渠道 ──
    # 为什么接它：60s 聚合只有微博/知乎/抖音/头条，**没有 AI/IT 频道**（实测全部 404）。
    # AIHOT 是多源聚合，覆盖 IT之家(RSS)、Hacker News、TechCrunch、X、技术博客等，
    # 一条接入就同时补上 AI 与 IT 两类渠道。
    # 用 JSON 接口而非 /agent/*（后者返回给人读的 Markdown，不适合本地归档）——
    # AIHOT 使用说明明确：做定时同步/本地副本请用 JSON 接口，UA 用 aihot-api/2.0.0。
    for platform, path, kind in AIHOT:
        try:
            req = urllib.request.Request(AIHOT_BASE + path,
                                         headers={"User-Agent": AIHOT_UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            items = data.get("items") or []
            rows = []
            for i, it in enumerate(items, 1):
                if not isinstance(it, dict):
                    continue
                title = str(it.get("title") or "").strip()
                if not title:
                    continue
                links = it.get("links") or {}
                src = it.get("source")
                src_name = (src.get("name") if isinstance(src, dict) else str(src or "")) or ""
                if kind == "hot":
                    # 来源数当热度：被越多源同时报道的才是真热点
                    hot = str(it.get("sourceCount") or "")
                    extra = "、".join((it.get("sourceNames") or [])[:3])
                else:
                    hot = str(it.get("score") or "")
                    extra = str(it.get("summary") or "")[:150]
                orig = links.get("original") or ""
                rows.append({
                    "key": f"{platform}@{date}#{i}",
                    "platform": platform,
                    "rank": i,
                    "title": title,
                    "hot": hot if hot.isdigit() else "",
                    "url": orig or links.get("aihot") or "",
                    "date": date,
                    "urlKind": "原文" if orig else ("AIHOT" if links.get("aihot") else "无"),
                    "summary": extra,
                    "sourceName": src_name,
                })
            all_rows.extend(rows)
            fetched_ok.add(platform)
            notes.append(f"{platform}: {len(rows)} 条（AIHOT）")
        except Exception as e:
            notes.append(f"{platform}: 失败 {type(e).__name__} {e}")

    # 合并进「7 天滚动归档」：同一天重跑就覆盖当天，超过 7 天的日期被裁掉
    archive = {"byDate": {}}
    if os.path.exists(OUT):
        try:
            prev = json.load(io.open(OUT, encoding="utf-8"))
            if isinstance(prev.get("byDate"), dict):
                archive["byDate"] = prev["byDate"]
        except Exception:
            pass
    # 按平台合并：成功的平台用新数据替换，失败的平台保留当天上一版。
    # （以前是整日覆盖 archive[byDate][date] = all_rows——抖音抓失败一次，
    #   当天早先采到的 49 条抖音数据就被一起抹掉了。）
    if all_rows or fetched_ok:
        prev_today = archive["byDate"].get(date) or []
        kept = [r for r in prev_today if r.get("platform") not in fetched_ok]
        if kept:
            stale = sorted({r["platform"] for r in kept})
            notes.append("保留当天上一版（本次未抓到）: " + "、".join(stale))
        archive["byDate"][date] = kept + all_rows

    keep = sorted(archive["byDate"].keys())[-7:]
    archive["byDate"] = {d: archive["byDate"][d] for d in keep}
    archive["dates"] = keep                        # 升序，最后一个是最新
    archive["platforms"] = sorted({r["platform"] for d in keep for r in archive["byDate"][d]})
    archive["fetchedAt"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    archive["today"] = date

    io.open(OUT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(archive, ensure_ascii=False, indent=1))

    total = sum(len(v) for v in archive["byDate"].values())
    print(f"素材归档写入 {os.path.relpath(OUT, PLUGIN)}：{len(keep)} 天 / 共 {total} 条 / {len(archive['platforms'])} 平台")
    for d in keep:
        n = len(archive["byDate"][d])
        mark = "  ← 今天" if d == date else ""
        print(f"  {d}  {n:>3} 条{mark}")
    for n in notes:
        print("  " + n)
    return 0 if keep else 1


if __name__ == "__main__":
    sys.exit(main())
