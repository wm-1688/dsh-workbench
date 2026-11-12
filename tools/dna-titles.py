#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标题库量化：1013 条标题的字数、句式、人称、情绪词、标点统计。

仓库的分类是人工的（疑问挑衅型/否定劝诫型…），但没有统计。
这一步补上数字，用于校验人工分类是否站得住。
"""
import io
import json
import os
import re
from collections import Counter, OrderedDict

SRC = r"C:\data\test\dsh-workbench\writing-dna\mimeng\refs\标题库.md"
OUT = r"C:\data\test\dsh-workbench\writing-dna\mimeng\_meta\titles-stats.json"

t = io.open(SRC, encoding="utf-8").read()
sections = OrderedDict()
cur = "（未分类）"
for line in t.splitlines():
    if line.startswith("## "):
        cur = line[3:].strip()
        sections.setdefault(cur, [])
    elif line.startswith("- ") and cur:
        s = line[2:].strip()
        if s:
            sections[cur].append(s)

allt = [x for v in sections.values() for x in v]
print(f"  分节 {len(sections)} 个 / 标题 {len(allt)} 条\n")

lens = [len(x) for x in allt]
print(f"  === 字数 ===")
print(f"  最短 {min(lens)} · 最长 {max(lens)} · 平均 {sum(lens)/len(lens):.1f} · 中位 {sorted(lens)[len(lens)//2]}")
buckets = Counter()
for n in lens:
    b = "≤12" if n <= 12 else "13-16" if n <= 16 else "17-20" if n <= 20 else "21-25" if n <= 25 else ">25"
    buckets[b] += 1
for b in ("≤12", "13-16", "17-20", "21-25", ">25"):
    c = buckets[b]
    print(f"  　{b:<7}{c:>5}  {100*c/len(allt):>5.1f}%  {'█'*int(c/6)}")

print(f"\n  === 特征命中率 ===")
FEATS = {
    "含「你/我/我们」": r"[你我]|我们",
    "问号结尾": r"[？?]\s*$",
    "句中含有疑问": r"[？?]|为什么|凭什么|怎么|难道|怎样|如何|多少",
    "否定/劝诫": r"别|不要|不该|没有|不是|不必|不用",
    "极致断言（最/永远/根本）": r"最|永远|从来|根本",
    "数字": r"\d",
    "身份词（男/女/老公/老婆）": r"男人|女人|女生|男孩|女孩|男朋友|女朋友|老公|老婆|单身",
    "婚恋词": r"婚姻|结婚|离婚|出轨|爱情|恋爱|前任|分手|暧昧",
    "反差（凭什么/竟然/居然/原来）": r"凭什么|竟然|居然|原来|才知道",
    "感叹号": r"[！!]",
}
stat = {}
for name, pat in FEATS.items():
    hit = [x for x in allt if re.search(pat, x)]
    stat[name] = len(hit)
    print(f"  {name:<28}{len(hit):>5}/{len(allt)}  {100*len(hit)/len(allt):>5.1f}%")

print(f"\n  === 各分节的实测特征（校验人工分类）===")
print(f"  {'分节':<24}{'条数':>5}{'均字数':>7}{'含你我%':>8}{'疑问%':>7}{'否定%':>7}")
sec_stat = {}
for name, items in sections.items():
    if not items:
        continue
    n = len(items)
    avg = sum(len(x) for x in items) / n
    p_you = 100 * sum(1 for x in items if re.search(r"[你我]|我们", x)) / n
    p_q = 100 * sum(1 for x in items if re.search(r"[？?]|为什么|凭什么|怎么|如何", x)) / n
    p_neg = 100 * sum(1 for x in items if re.search(r"别|不要|不是|没有|不必", x)) / n
    sec_stat[name] = {"count": n, "avgLen": round(avg, 1),
                      "youPct": round(p_you, 1), "qPct": round(p_q, 1), "negPct": round(p_neg, 1)}
    print(f"  {name[:22]:<24}{n:>5}{avg:>7.1f}{p_you:>8.1f}{p_q:>7.1f}{p_neg:>7.1f}")

json.dump({"total": len(allt), "avgLen": round(sum(lens) / len(lens), 1),
           "buckets": dict(buckets), "features": stat, "sections": sec_stat},
          io.open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n  写入 {os.path.relpath(OUT, os.path.dirname(os.path.dirname(OUT)))}")
