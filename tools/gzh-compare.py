#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对比各赛道的对标账号生态，用于「定赛道」。

判据（依据前面实测过的规律）：
  · 转/赞比 > 1  → 转发驱动型（民生实用型特征）
  · 转/赞比 < 1  → 点赞驱动型（观点型特征）
  · 最高阅读 10w+ 的账号占比 → 头部天花板
  · 综合分分布 → 竞争烈度
"""
import io
import json
import os
import re
import sys


def load(p):
    t = io.open(p, encoding="utf-8", errors="replace").read()
    m = re.search(r"var RAW = (\[.*?\])\s*;", t, re.S)
    return json.loads(m.group(1)) if m else []


def num(v):
    try:
        return int(v)
    except Exception:
        return 0


files = sys.argv[1:]
data = {}
for f in files:
    rows = load(f)
    if not rows:
        continue
    cat = rows[0].get("category", os.path.basename(f))
    data[cat] = rows

print(f"  {'赛道':<8}{'账号数':>6}{'均综合分':>9}{'10w+占比':>9}{'均转发':>9}{'均点赞':>9}{'转/赞':>7}")
print("  " + "-" * 62)
summary = {}
for cat, rows in data.items():
    n = len(rows)
    avg_score = sum(r.get("compositeScore", 0) for r in rows) / n
    top10w = sum(1 for r in rows if num(r.get("maxReadCount")) >= 100000) / n
    fwd = sum(num(r.get("totalForwardCount")) for r in rows) / n
    like = sum(num(r.get("totalLikeCount")) for r in rows) / n
    ratio = fwd / like if like else 0
    summary[cat] = dict(n=n, score=round(avg_score, 1), top10w=round(top10w * 100, 1),
                        fwd=round(fwd), like=round(like), ratio=round(ratio, 2))
    print(f"  {cat:<8}{n:>6}{avg_score:>9.1f}{top10w*100:>8.1f}%{fwd:>9,.0f}{like:>9,.0f}{ratio:>7.2f}")

print()
for cat, rows in data.items():
    print(f"\n  === {cat} TOP8 ===")
    print(f"  {'#':>3} {'账号':<16}{'综合分':>7}{'总阅读':>9}{'最高阅读':>9}{'转发':>8}{'点赞':>7}{'转/赞':>7}")
    for r in rows[:8]:
        fwd, like = num(r.get("totalForwardCount")), num(r.get("totalLikeCount"))
        rt = f"{fwd/like:.2f}" if like else "-"
        print(f"  {r.get('rankPosition',0):>3} {str(r.get('accountName'))[:14]:<16}"
              f"{r.get('compositeScore',0):>7}{num(r.get('totalReadCount')):>9,}"
              f"{num(r.get('maxReadCount')):>9,}{fwd:>8,}{like:>7,}{rt:>7}")

out = r"C:\data\test\dsh-workbench\lib\gzh-rank-summary.json"
json.dump(summary, io.open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n  汇总写入 {out}")
