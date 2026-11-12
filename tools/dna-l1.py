#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""L1 表层语言分析（writing-dna-skill 的 Step 3）。

对咪蒙 6 篇代表作做：词频（名/动/副）、句长分布、短长句占比、
段落节奏、标点习惯、人称密度、情绪标点。

只分析**正文文章**；标题库/结构模板/自我剖析是参考资料，不进统计。
"""
import io
import json
import os
import re
import shutil
import sys
from collections import Counter

import jieba
import jieba.posseg as pseg

SRC = r"C:\data\test\_ref\mimeng-ghostwriter\raw"
DST = r"C:\data\test\dsh-workbench\writing-dna\mimeng"
RAW = os.path.join(DST, "raw")

ARTICLES = [
    "代表作-北漂押一付三.md",
    "代表作-她那么丑凭什么让王菲大哭.md",
    "代表作-如何写出100万+爆款.md",
    "代表作-婚姻死于无话.md",
    "代表作-情商高就是好好说话.md",
    "代表作-我是因为你才爱上世界.md",
]

# ── 建目录 + 拷原文 ──
os.makedirs(RAW, exist_ok=True)
os.makedirs(os.path.join(DST, "meta"), exist_ok=True)
for f in ARTICLES:
    s = os.path.join(SRC, f)
    if os.path.exists(s):
        shutil.copy2(s, os.path.join(RAW, f))
# 参考资料放 refs/（不叫 references——沙箱对那个名字有保护）
REFS = os.path.join(DST, "refs")
os.makedirs(REFS, exist_ok=True)
for f in ("标题库.md", "结构模板.md", "咪蒙内容解读及自我剖析梳理.md"):
    s = os.path.join(SRC, f)
    if os.path.exists(s):
        shutil.copy2(s, os.path.join(REFS, f))


def strip_front(text):
    """去掉 YAML frontmatter 与图片行，只留正文。"""
    t = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)
    t = re.sub(r"^!\[.*?\]\(.*?\)\s*$", "", t, flags=re.M)
    return t.strip()


texts = {}
for f in ARTICLES:
    p = os.path.join(RAW, f)
    if os.path.exists(p):
        texts[f] = strip_front(io.open(p, encoding="utf-8").read())

print(f"  语料 {len(texts)} 篇")

# ── 统计 ──
all_sents, per_art = [], []
pos_all = Counter()
pron = Counter()
punct = Counter()
for f, t in texts.items():
    body = re.sub(r"\s+", "", t)
    sents = [s for s in re.split(r"(?<=[。！？…])", t) if s.strip()]
    lens = [len(re.sub(r"\s", "", s)) for s in sents if len(re.sub(r"\s", "", s)) > 1]
    paras = [p for p in t.split("\n") if p.strip()]
    plen = [len(re.sub(r"\s", "", p)) for p in paras]
    # 词性
    for w, flag in pseg.cut(re.sub(r"\s+", "", t)):
        # 人称要先数——「你」「我」是单字，会被下面的长度过滤掉（第一版就漏了）
        if w in ("你", "我", "我们", "你们", "咱们", "自己", "他", "她", "他们", "大家"):
            pron[w] += 1
        if len(w) < 2:
            continue
        pos_all[flag] += 1
    for ch in t:
        if ch in "。！？，、；：…—（）「」“”":
            punct[ch] += 1
    all_sents += lens
    per_art.append({
        "file": f, "chars": len(body), "sents": len(lens),
        "avg_sent": round(sum(lens) / len(lens), 1) if lens else 0,
        "max_sent": max(lens) if lens else 0,
        "paras": len(plen),
        "avg_para": round(sum(plen) / len(plen), 1) if plen else 0,
        "short_pct": round(100 * sum(1 for x in lens if x <= 15) / len(lens), 1) if lens else 0,
        "long_pct": round(100 * sum(1 for x in lens if x >= 50) / len(lens), 1) if lens else 0,
        "q": t.count("？"), "ex": t.count("！"),
    })

N = sum(per_art[i]["chars"] for i in range(len(per_art)))
avg = sum(all_sents) / len(all_sents)
short = 100 * sum(1 for x in all_sents if x <= 15) / len(all_sents)
long_ = 100 * sum(1 for x in all_sents if x >= 50) / len(all_sents)
mid = 100 - short - long_

print(f"\n  === 逐篇 ===")
print(f"  {'篇':<26}{'字数':>6}{'句数':>6}{'均句长':>7}{'短句%':>7}{'长句%':>7}{'段数':>6}{'均段长':>7}{'问':>4}{'叹':>4}")
for a in per_art:
    nm = a["file"].replace("代表作-", "").replace(".md", "")[:14]
    print(f"  {nm:<26}{a['chars']:>6}{a['sents']:>6}{a['avg_sent']:>7}{a['short_pct']:>7}"
          f"{a['long_pct']:>7}{a['paras']:>6}{a['avg_para']:>7}{a['q']:>4}{a['ex']:>4}")

print(f"\n  === 合计（{N} 字 / {len(all_sents)} 句）===")
print(f"  平均句长 {avg:.1f} 字")
print(f"  短句(≤15) {short:.1f}%   中句 {mid:.1f}%   长句(≥50) {long_:.1f}%")
print(f"  段落 {len(texts)} 篇共 {sum(a['paras'] for a in per_art)} 段，平均每段 "
      f"{N/sum(a['paras'] for a in per_art):.1f} 字")
print(f"  问号 {sum(a['q'] for a in per_art)}  感叹号 {sum(a['ex'] for a in per_art)}")

print(f"\n  === 人称密度（每千字）===")
for w, c in pron.most_common(6):
    print(f"  　{w:<6}{c:>5}   {1000*c/N:.1f}/千字")

print(f"\n  === 标点习惯（每千字）===")
tot_p = sum(punct.values())
for ch, c in punct.most_common(10):
    print(f"  　{ch}  {c:>5}  {1000*c/N:>5.1f}/千字")

print(f"\n  === 高频词（按词性）===")
for flag, label in (("n", "名词"), ("v", "动词"), ("d", "副词"), ("a", "形容词")):
    print(f"\n  [{label}]")
    cnt = Counter()
    for t in texts.values():
        for w, fl in pseg.cut(re.sub(r"\s+", "", t)):
            if fl == flag and len(w) >= 2:
                cnt[w] += 1
    for w, c in cnt.most_common(20):
        print(f"  　{w:<8}{c:>4}")

json.dump({"perArticle": per_art,
           "total": {"chars": N, "sentences": len(all_sents), "avgSent": round(avg, 1),
                     "shortPct": round(short, 1), "longPct": round(long_, 1),
                     "pronounPer1k": {w: round(1000*c/N, 1) for w, c in pron.most_common()}},
           "punctPer1k": {ch: round(1000*c/N, 1) for ch, c in punct.most_common()}},
          io.open(os.path.join(DST, "meta", "l1-stats.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)
print(f"\n  统计写入 meta/l1-stats.json")
