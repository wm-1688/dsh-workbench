#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""公众号 10w+ 爆文采集 → lib/gzh-hot.snapshot.json

    python tools/collect-gzh.py                       # 抓昨天，全部 22 个分类
    python tools/collect-gzh.py '{"days":2}'          # 连抓两天
    python tools/collect-gzh.py '{"categories":["总排名","科技数码"]}'
    python tools/collect-gzh.py '{"out":"D:/tmp/x.json"}'   # 自测用，不写插件目录

为什么单独一个脚本、单独一个快照文件：
  公众号爆文带正文（实测最长 9534 字），塞进 materials.snapshot.json 会被
  gen-catalog.py 烘焙进 client.js，把前端产物撑到几 MB。热榜和爆文的数据量、
  刷新频率、字段都不一样，所以分开存、分开取。

数据源（唯一可用）：红狐 cozeSkill getWxDataByCategoryAndTime
  · 必须 POST + JSON body；source 必须带 -GitHub 后缀，否则 code=500
  · 每天 18:30 同步前一天的榜单，所以默认抓「昨天」
  · 22 个标准分类，见 CATEGORIES

字段口径：
  clicksCount 是「10w+」这种字符串，不是数字 → 原样存 readLabel，不硬转 int
  hot 用互动量（在看+点赞+分享）算，只用于排序和热度展示，**不是阅读量**
  content 只取前 180 字做摘要，全文不进快照（素材库点「原文」跳转即可）
"""

import datetime
import html
import json
import os
import re
import sys
import urllib.request
import winreg

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
OUT = os.path.join(PLUGIN, "lib", "gzh-hot.snapshot.json")

API = "https://redfox.hk/story/api/cozeSkill/getWxDataByCategoryAndTime"
SOURCE = "公众号10w+阅读文章推荐-GitHub"
UA = "QoderWork/1.0"

# 官方文档给的标准分类（category-mapping.md）。总排名是综合榜，放最前面。
CATEGORIES = [
    "总排名", "人文资讯", "知识百科", "健康养生", "时尚潮流", "美食餐饮",
    "乐活生活", "旅游出行", "搞笑幽默", "情感心理", "体育娱乐", "美容美体",
    "文摘精选", "财富理财", "科技数码", "创投商业", "汽车交通", "房产楼市",
    "职场发展", "教育考试", "学术研究", "企业品牌",
]

KEEP_DAYS = 7


def api_key():
    """取红狐 Key：环境变量 > HKCU\\Environment。

    和 gzh-fetch.py 同一套取法——Key 只配在用户环境变量里，
    DSH 进程未必继承，所以必须回退到注册表读。
    """
    key = (os.environ.get("REDFOX_API_KEY") or "").strip()
    if key:
        return key
    for root, path, name in [
        (winreg.HKEY_CURRENT_USER, "Environment", "REDFOX_API_KEY"),
        (winreg.HKEY_LOCAL_MACHINE,
         r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "REDFOX_API_KEY"),
    ]:
        try:
            with winreg.OpenKey(root, path) as h:
                v = (winreg.QueryValueEx(h, name)[0] or "").strip()
                if v:
                    return v
        except OSError:
            continue
    raise RuntimeError("缺少 REDFOX_API_KEY（环境变量或 HKCU\\Environment 都没有）")


def clean(text, limit=0):
    """去标签、解实体、压空白。公众号正文是富文本，摘要不能带标签。"""
    if not text:
        return ""
    s = re.sub(r"<[^>]+>", " ", str(text))
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit] if limit else s


def num(v):
    """把 '246' / '10w+' / None 转成可排序的数字；10w+ 记 100000。"""
    if v is None:
        return 0
    s = str(v).strip().lower().replace(",", "")
    if not s:
        return 0
    m = re.match(r"^([\d.]+)\s*w\+?$", s)
    if m:
        return int(float(m.group(1)) * 10000)
    m = re.match(r"^([\d.]+)\s*亿$", s)
    if m:
        return int(float(m.group(1)) * 100000000)
    m = re.match(r"^(\d+)$", s)
    return int(m.group(1)) if m else 0


def pull(key, category, date):
    """取一个分类一天的榜单。失败抛异常，由上层记进 notes。"""
    body = json.dumps({
        "type": category, "source": SOURCE, "startDate": date, "endDate": date,
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "X-API-KEY": key,
        "User-Agent": UA,
    })
    with urllib.request.urlopen(req, timeout=45) as r:
        payload = json.loads(r.read().decode("utf-8"))
    code = payload.get("code")
    if code != 2000:
        raise RuntimeError(f"code={code} msg={payload.get('msg')}")
    data = payload.get("data") or {}
    return data.get("tenWReadingRank") or []


def normalize(category, items, date):
    rows = []
    for i, it in enumerate(items, 1):
        if not isinstance(it, dict):
            continue
        title = clean(it.get("title"))
        pid = str(it.get("photoId") or "").strip()
        if not title or not pid:
            continue
        insee = num(it.get("watchCount"))
        like = num(it.get("likeCount"))
        share = num(it.get("shareCount"))
        rows.append({
            "pid": pid,
            "category": category,
            "rank": i,
            "title": title,
            "account": clean(it.get("userName")),
            "accountId": str(it.get("accountId") or "").strip(),
            "avatar": str(it.get("userHeadUrl") or "").strip(),
            "cover": str(it.get("coverUrl") or "").strip(),
            "url": str(it.get("oriUrl") or "").strip(),
            "readLabel": str(it.get("clicksCount") or "").strip(),
            "insee": insee,
            "like": like,
            "share": share,
            "hot": insee + like + share,
            "publicTime": str(it.get("publicTime") or "").strip(),
            "original": 1 if num(it.get("originalFlag")) else 0,
            "summary": clean(it.get("content"), 180),
            "date": date,
        })
    return rows


def merge_day(bucket, fresh):
    """按 photoId 合并同一篇文章在多个分类里的出现。

    一篇 10w+ 同时进「总排名」和「科技数码」是常态，不能算两篇：
      · cats 记全部命中分类，筛分类时按 cats 包含判断
      · rank 取最小名次（总榜名次最有意义）
      · 数值字段取最大（不同分类回填完整度不一样，取到有值的那个）
    """
    for row in fresh:
        old = bucket.get(row["pid"])
        if old is None:
            row["cats"] = [row["category"]]
            bucket[row["pid"]] = row
            continue
        if row["category"] not in old["cats"]:
            old["cats"].append(row["category"])
        old["rank"] = min(old["rank"], row["rank"])
        for f in ("insee", "like", "share", "hot"):
            if row[f] > old.get(f, 0):
                old[f] = row[f]
        for f in ("cover", "url", "readLabel", "avatar", "summary", "account", "publicTime"):
            if not old.get(f) and row.get(f):
                old[f] = row[f]


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else "{}"
    try:
        opts = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"参数不是合法 JSON：{e}"}, ensure_ascii=False))
        return 2

    out_path = opts.get("out") or OUT
    cats = [c for c in (opts.get("categories") or CATEGORIES) if c in CATEGORIES] or CATEGORIES
    days = max(1, min(int(opts.get("days") or 1), KEEP_DAYS))

    # 榜单是「每天 18:30 出前一天」的，所以默认从昨天往前抓
    today = datetime.date.today()
    want = [(today - datetime.timedelta(days=d)).strftime("%Y-%m-%d") for d in range(1, days + 1)]

    try:
        key = api_key()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 3

    # 读旧快照，做增量合并：只替换本次抓成功的「日期×分类」格子
    archive = {"byDate": {}, "dates": [], "fetchedAt": "", "categories": CATEGORIES}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                old = json.load(f)
            if isinstance(old.get("byDate"), dict):
                archive["byDate"] = old["byDate"]
        except Exception:
            pass

    notes = []
    ok_pairs = set()
    for date in want:
        bucket = {r["pid"]: r for r in archive["byDate"].get(date, [])}
        got = 0
        for cat in cats:
            try:
                items = pull(key, cat, date)
                merge_day(bucket, normalize(cat, items, date))
                ok_pairs.add((date, cat))
                got += 1
            except Exception as e:                      # noqa: BLE001 单分类失败不影响整体
                notes.append(f"{date} {cat}: {type(e).__name__} {str(e)[:60]}")
        if got:
            rows = sorted(bucket.values(), key=lambda r: (-r["hot"], r["rank"]))
            for i, r in enumerate(rows, 1):
                r["key"] = f"公众号@{date}#{r['pid']}"
            archive["byDate"][date] = rows

    keep = sorted(archive["byDate"].keys())[-KEEP_DAYS:]
    archive["byDate"] = {d: archive["byDate"][d] for d in keep}
    archive["dates"] = keep
    archive["fetchedAt"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    archive["today"] = datetime.date.today().strftime("%Y-%m-%d")
    archive["latest"] = (keep[-1] if keep else "")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(archive, f, ensure_ascii=False, separators=(",", ":"))

    total = sum(len(v) for v in archive["byDate"].values())
    print(json.dumps({
        "ok": True,
        "rows": total,
        "dates": keep,
        "categories": len(cats),
        "bytes": os.path.getsize(out_path),
        "notes": notes[:6],
        "out": out_path,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
