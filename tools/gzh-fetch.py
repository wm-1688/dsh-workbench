#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""公众号实力榜取数（urllib 版，不依赖 requests）。

为什么自己写：
  红狐 skill 脚本 `gen_gzh_html.py` / `gzh_growth_fetcher.py` 依赖 requests，
  而本机两个 Python 现在都没有这个包。装包要动沙箱外的目录，所以直接按接口
  自己调——这也和 dsh-workbench 其它工具（gen-materials/gen-sports）保持一致的风格。

接口：GET https://redfox.hk/story/api/cozeSkill/getGzhCozeSkillDataIndex
参数：rankType=day|week|month, rankDate=YYYY-MM-DD, category=<23分类之一>, source=<固定串>
认证：请求头 X-API-KEY

用法：
    python tools/gzh-fetch.py --category 民生资讯 --date 2026-10-20 --top 100
    python tools/gzh-fetch.py --category 知识百科  --date 2026-10-20
    python tools/gzh-fetch.py --list-categories
"""
import argparse
import io
import json
import os
import sys
import urllib.parse
import urllib.request

API = "https://redfox.hk/story/api/cozeSkill/getGzhCozeSkillDataIndex"
SOURCE = "公众号综合实力账号榜-GitHub"
HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
OUTDIR = os.path.join(PLUGIN, "lib", "gzh-rank")

CATEGORIES = [
    "乐活生活", "人文资讯", "企业品牌", "体育娱乐", "健康养生",
    "创投商业", "学术研究", "情感心理", "房产楼市", "搞笑幽默",
    "教育考试", "文摘精选", "旅游出行", "时尚潮流", "民生资讯",
    "汽车交通", "知识百科", "科技数码", "美容美体", "美食餐饮",
    "职场发展", "财富理财", "总排名",
]


def api_key():
    k = os.environ.get("REDFOX_API_KEY", "").strip()
    if k:
        return k
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as h:
            return winreg.QueryValueEx(h, "REDFOX_API_KEY")[0].strip()
    except Exception:
        return ""


def fetch(category, rank_type, rank_date, timeout=40):
    q = urllib.parse.urlencode({
        "rankType": rank_type, "rankDate": rank_date,
        "category": category, "source": SOURCE,
    })
    req = urllib.request.Request(API + "?" + q)
    req.add_header("X-API-KEY", api_key())
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "QoderWork/1.0")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.loads(r.read().decode("utf-8"))
    if j.get("code") != 2000:
        raise RuntimeError(f"接口错误 code={j.get('code')} msg={j.get('msg')}")
    d = j.get("data")
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        for k in ("list", "records", "rows", "data"):
            if isinstance(d.get(k), list):
                return d[k]
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--category")
    ap.add_argument("--date", default="2026-10-20")
    ap.add_argument("--rank-type", default="day")
    ap.add_argument("--top", type=int, default=100)
    ap.add_argument("--list-categories", action="store_true")
    a = ap.parse_args()

    if a.list_categories:
        print("  " + "、".join(CATEGORIES))
        return 0
    if not a.category:
        ap.error("需要 --category 或 --list-categories")

    rows = fetch(a.category, a.rank_type, a.date)
    rows = rows[: a.top]
    print(f"  [{a.category}] {a.date} {a.rank_type}榜 共 {len(rows)} 个账号")
    if rows:
        print("    字段: " + ", ".join(list(rows[0].keys())))
    os.makedirs(OUTDIR, exist_ok=True)
    out = os.path.join(OUTDIR, f"{a.category}-{a.date}.json")
    json.dump(rows, io.open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"    写入 {os.path.relpath(out, PLUGIN)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
