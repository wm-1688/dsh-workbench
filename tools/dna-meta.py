#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 _meta/ 元数据标注（writing-dna-skill Step 2，要求覆盖 ≥80% 语料）。

frontmatter 里有 title/date/source 可直接抽；article_type / topic_tags /
hook_type / structure_pattern 由篇名和内容特征判定，**只填能从语料确认的**，
不确定的留空而不是编。
"""
import io
import json
import os
import re

DST = r"C:\data\test\dsh-workbench\writing-dna\mimeng"
RAW = os.path.join(DST, "raw")
META = os.path.join(DST, "_meta")

# 逐篇的人工判定（依据：篇名 + 已读内容；不确定的一律留空）
CURATED = {
    "代表作-北漂押一付三.md": {
        "article_type": "深度观察",
        "topic_tags": ["北漂", "租房", "阶层", "居住", "大城市"],
        "hook_type": "场景式",
        "structure_pattern": "并列式（5个案例按房租递增排列）",
        "source_types": ["一手采访", "问答记录"],
        "notable": "5 个受访者按房租 750→2.4万→16亿 排列，形成递进对比；文末反问收尾",
    },
    "代表作-她那么丑凭什么让王菲大哭.md": {
        "article_type": "影视评论",
        "topic_tags": ["影视", "外貌", "演员", "反常识"],
        "hook_type": "观点式",
        "structure_pattern": "反常识切入 → 论证 → 升华",
        "source_types": ["影视作品", "公开资料"],
        "notable": "标题即反常识；用「丑」这个负面词做钩子",
    },
    "代表作-如何写出100万+爆款.md": {
        "article_type": "方法论自述",
        "topic_tags": ["写作方法", "爆款", "新媒体运营"],
        "hook_type": "观点式",
        "structure_pattern": "总-分（法则清单）",
        "source_types": ["个人经验", "自有数据"],
        "notable": "⚠️ 她本人讲方法论，可能存在自我美化，需与另 5 篇实证表现对照",
    },
    "代表作-婚姻死于无话.md": {
        "article_type": "情感短评",
        "topic_tags": ["婚姻", "沟通", "亲密关系"],
        "hook_type": "观点式",
        "structure_pattern": "观点先行 → 案例论证 → 收束",
        "source_types": ["身边案例", "个人观察"],
        "notable": "后期风格：更凝练、长句占比仅 3.5%",
    },
    "代表作-情商高就是好好说话.md": {
        "article_type": "清单干货",
        "topic_tags": ["情商", "沟通", "职场", "人际关系"],
        "hook_type": "引用+观点",
        "structure_pattern": "清单式（每条带小故事）",
        "source_types": ["二手整理", "案例"],
        "notable": "句长最长（30.1字）、长句占比最高（16.3%），与情感故事型差异显著",
    },
    "代表作-我是因为你才爱上世界.md": {
        "article_type": "情感故事",
        "topic_tags": ["情感", "爱情", "共鸣"],
        "hook_type": "故事悬念",
        "structure_pattern": "故事先行 → 观点 → 解读",
        "source_types": ["个人经历", "读者投稿"],
        "notable": "短句占比 47.8%、均句长 18.2 字，是全语料最极端的短句流",
    },
}


def front(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, flags=re.S)
    if not m:
        return {}
    d = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            d[k.strip()] = v.strip()
    return d


os.makedirs(META, exist_ok=True)
rows = []
for f in sorted(os.listdir(RAW)):
    if not f.endswith(".md"):
        continue
    t = io.open(os.path.join(RAW, f), encoding="utf-8").read()
    fm = front(t)
    body = re.sub(r"^---\n.*?\n---\n", "", t, flags=re.S)
    body = re.sub(r"^!\[.*?\]\(.*?\)\s*$", "", body, flags=re.M)
    c = CURATED.get(f, {})
    meta = {
        "file": f,
        "title": fm.get("title", f.replace("代表作-", "").replace(".md", "")),
        "date": fm.get("date", ""),
        "author": "咪蒙",
        "source": fm.get("source", ""),
        "column": "",
        "article_type": c.get("article_type", ""),
        "topic_tags": c.get("topic_tags", []),
        "hook_type": c.get("hook_type", ""),
        "structure_pattern": c.get("structure_pattern", ""),
        "source_types": c.get("source_types", []),
        "word_count": len(re.sub(r"\s", "", body)),
        "notable": c.get("notable", ""),
    }
    out = os.path.join(META, f.replace(".md", ".json"))
    json.dump(meta, io.open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    rows.append(meta)

print(f"  _meta/ 生成 {len(rows)} 个")
print(f"  {'篇名':<26}{'日期':<12}{'体裁':<10}{'字数':>6}  hook")
for m in rows:
    print(f"  {m['title'][:14]:<26}{m['date']:<12}{m['article_type']:<10}"
          f"{m['word_count']:>6}  {m['hook_type']}")
filled = sum(1 for m in rows if m["article_type"] and m["hook_type"] and m["structure_pattern"])
print(f"\n  元数据完整度 {filled}/{len(rows)} = {100*filled//len(rows)}%（技能要求 ≥80%）")
