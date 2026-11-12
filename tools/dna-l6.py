#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""L6 中可从 Markdown 实测的部分：加粗密度、小标题、引用块、分隔线、段落节奏。

⛔ 配图策略**测不了**：语料是从 PDF 导出的纯文本，没有图，也没有原始 HTML，
   所以字体层级/色彩只能引用二手来源（她自己的排版说明），并标明未经验证。
"""
import io
import json
import os
import re

DST = r"C:\data\test\dsh-workbench\writing-dna\mimeng"
RAW = os.path.join(DST, "raw")

rows = []
for f in sorted(os.listdir(RAW)):
    if not f.endswith(".md"):
        continue
    t = io.open(os.path.join(RAW, f), encoding="utf-8").read()
    t = re.sub(r"^---\n.*?\n---\n", "", t, flags=re.S)          # 去 frontmatter
    body = re.sub(r"\s+", "", t)
    n = len(body)
    paras = [p for p in t.split("\n") if p.strip()]
    rows.append({
        "file": f,
        "chars": n,
        "paras": len(paras),
        "bold": len(re.findall(r"\*\*[^*]+\*\*", t)),
        "h2": len(re.findall(r"^##\s", t, flags=re.M)),
        "h3": len(re.findall(r"^###\s", t, flags=re.M)),
        "quote": len(re.findall(r"^>\s?", t, flags=re.M)),
        "hr": len(re.findall(r"^---+$", t, flags=re.M)),
        "list": len(re.findall(r"^[-*\d]+[.、]?\s", t, flags=re.M)),
        "avg_para": round(n / len(paras), 1) if paras else 0,
    })

N = sum(r["chars"] for r in rows)
print(f"  语料 {len(rows)} 篇 / {N} 字\n")
print(f"  {'篇名':<24}{'字数':>6}{'段数':>6}{'均段长':>7}{'加粗':>5}{'H2':>4}{'H3':>4}{'引用':>5}{'分线':>5}")
for r in rows:
    nm = r["file"].replace("代表作-", "").replace(".md", "")[:12]
    print(f"  {nm:<24}{r['chars']:>6}{r['paras']:>6}{r['avg_para']:>7}"
          f"{r['bold']:>5}{r['h2']:>4}{r['h3']:>4}{r['quote']:>5}{r['hr']:>5}")

tb = sum(r["bold"] for r in rows)
th2 = sum(r["h2"] for r in rows)
th3 = sum(r["h3"] for r in rows)
tq = sum(r["quote"] for r in rows)
thr = sum(r["hr"] for r in rows)
tl = sum(r["list"] for r in rows)
tp = sum(r["paras"] for r in rows)
print(f"\n  合计：加粗 {tb} 次（{1000*tb/N:.2f}/千字）· H2 {th2} · H3 {th3} · "
      f"引用行 {tq} · 分隔线 {thr} · 列表项 {tl}")
print(f"  段落 {tp} 段，平均 {N/tp:.1f} 字/段")

json.dump({"rows": rows, "total": {"chars": N, "paras": tp, "avgPara": round(N / tp, 1),
                                   "boldPer1k": round(1000 * tb / N, 2),
                                   "h2": th2, "h3": th3, "quoteLines": tq, "hr": thr}},
          io.open(os.path.join(DST, "_meta", "l6-stats.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)
print("  写入 _meta/l6-stats.json")
