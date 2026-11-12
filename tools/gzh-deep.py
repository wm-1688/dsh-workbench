#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""深挖实力榜 100 个账号的分布（不只是 TOP10）。

TOP10 会骗人：头部几家能拉高均分，但看不到「这个赛道有多少号能出 10w+」。
本脚本对每个分类的 100 个账号算：
  · 出过 10w+ 的账号数与占比  → 天花板有多高
  · 综合分中位数             → 腰部水平
  · 转/赞中位数              → 内容是「存下来/转给朋友」还是「点个赞」
  · 平均发布频次             → 运营强度
  · 账号名抽样               → 判断内容形态（本地号 / 文摘号 / 机构号 / 原创号）
"""
import io
import json
import os
import re
import sys

FILES = [
    ("_rank-民生资讯.html", "民生"),
    ("_rank-体育娱乐.html", "体育娱乐"),
    ("_rank-情感心理.html", "情感"),
    ("_rank-健康养生.html", "健康"),
    ("_rank-职场发展.html", "个人成长"),
    ("_rank-知识百科.html", "知识百科"),
    ("_rank-教育考试.html", "教育"),
    ("_rank-搞笑幽默.html", "搞笑"),
    ("_tmp_gzh.html", "人文（历史归属）"),
]
BASE = r"C:\data\test"


def load(p):
    t = io.open(p, encoding="utf-8", errors="replace").read()
    m = re.search(r"var RAW = (\[.*?\])\s*;", t, re.S)
    return json.loads(m.group(1)) if m else []


def num(v):
    try:
        return int(v)
    except Exception:
        try:
            return int(float(v))
        except Exception:
            return 0


def med(xs):
    xs = sorted(x for x in xs if x)
    if not xs:
        return 0
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) // 2


rows_out = []
for fn, label in FILES:
    p = os.path.join(BASE, fn)
    if not os.path.exists(p):
        print(f"  跳过（不存在）{fn}")
        continue
    a = load(p)
    if not a:
        print(f"  跳过（无数据）{fn}")
        continue
    n = len(a)
    big = [x for x in a if num(x.get("maxReadCount")) >= 100000]
    fwd = [num(x.get("totalForwardCount")) for x in a]
    like = [num(x.get("totalLikeCount")) for x in a]
    ratios = [f / l for f, l in zip(fwd, like) if l >= 50]
    reads = [num(x.get("totalReadCount")) for x in a]
    pub = []
    for x in a:
        s = str(x.get("publishCount") or "")
        if "/" in s:
            try:
                pub.append(int(s.split("/")[0]))
            except Exception:
                pass
    names = [str(x.get("accountName")) for x in a[:12]]
    rows_out.append({
        "赛道": label, "账号": n, "10w+号": len(big),
        "10w+%": round(100 * len(big) / n),
        "均分": round(sum(x.get("compositeScore") or 0 for x in a) / n, 1),
        "分中位": round(med([x.get("compositeScore") or 0 for x in a]), 1),
        "转赞中位": round(med(ratios), 2),
        "阅读中位": med(reads),
        "均发布": round(sum(pub) / len(pub), 1) if pub else 0,
        "TOP": " ".join(names[:10]),
    })

rows_out.sort(key=lambda r: -r["10w+%"])
print(f"\n  {'赛道':<12}{'账号':>5}{'10w+号':>7}{'10w+%':>7}{'均分':>7}{'分中位':>7}"
      f"{'转赞中位':>9}{'阅读中位':>10}{'均发布':>7}")
print("  " + "-" * 78)
for r in rows_out:
    print(f"  {r['赛道']:<12}{r['账号']:>5}{r['10w+号']:>7}{r['10w+%']:>6}%{r['均分']:>7}"
          f"{r['分中位']:>7}{r['转赞中位']:>9}{r['阅读中位']:>10,}{r['均发布']:>7}")

print("\n  各赛道 TOP10 账号名（看内容形态）：")
for r in rows_out:
    print(f"\n  [{r['赛道']}] {r['TOP']}")

out = r"C:\data\test\dsh-workbench\lib\gzh-deep-stats.json"
json.dump(rows_out, io.open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"\n  写入 {out}")
