#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""选题对齐检查：文章有没有用上选题设计的读者三问。

    python tools/check-topic-align.py drafts/20260801-slug

为什么需要（2026-11-08，复盘 v11 后）：
    选题加工时产出了三个字段：
      · reader_why_click  读者为什么点
      · reader_what_get   读完多知道什么
      · reader_why_share  为什么会转发

    materials 里也带给了 Agent。但**没有任何环节验证文章用了没有**。
    v11 的选题写「我妈天天转发长寿文章」，正文里「我妈」一次没出现。

查法：
    对每个字段，从选题原文里抽出「有辨识度的词」（人称、具体对象、动作），
    再检查正文里有没有出现。命中率低就报警，由 Agent 判断要不要改。

    这不是精确语义匹配——只是一个提醒器。查出来不一定错（比如角度换了），
    但每一条都该被看见。
"""
import io
import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import ws_path  # noqa: E402

WORKSPACE = ws_path.ensure_workspace(PLUGIN)
DB = os.path.join(WORKSPACE, "workbench", "workbench.db")

# 抽取「有辨识度」的片段：人称词、具体名词、动作
SIGNAL = re.compile(
    r"(我[妈爸哥姐弟妹朋友同事]{1,2}|[\u4e00-\u9fff]{2,4}(?:文章|秘方|视频|新闻|热搜)"
    r"|[\u4e00-\u9fff]{2,3}(?:转发|刷到|点开|看到|相信|怀疑))"
)


def load_topic(draft_dir):
    name = os.path.basename(os.path.normpath(draft_dir))
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    draft = None
    for r in conn.execute("SELECT id, topic_id, path FROM drafts"):
        p = (r["path"] or "").rstrip("/")
        if p and os.path.basename(p) == name:
            draft = r
            break
    if not draft or not draft["topic_id"]:
        conn.close()
        return None
    t = conn.execute("SELECT * FROM topics WHERE id=?", (draft["topic_id"],)).fetchone()
    conn.close()
    return t


def check(draft_dir):
    md = os.path.join(draft_dir, "draft.md")
    if not os.path.isfile(md):
        print(f"  ❌ 找不到 {md}")
        return None
    body = io.open(md, encoding="utf-8").read()
    name = os.path.basename(os.path.normpath(draft_dir))

    t = load_topic(draft_dir)
    if not t:
        print(f"  ⚠️  {name}: 数据层没有关联选题，跳过")
        return []

    FIELDS = [
        ("reader_why_click", "读者为什么点"),
        ("reader_what_get", "读完得到什么"),
        ("reader_why_share", "为什么会转发"),
    ]
    problems = []
    for key, label in FIELDS:
        val = t[key]
        if not val:
            continue
        sigs = set(SIGNAL.findall(val))
        # 没有可识别信号就跳过（字段写得太抽象，没法查）
        if not sigs:
            continue
        hit = [x for x in sigs if x in body]
        rate = len(hit) / len(sigs)
        if rate < 0.3:
            problems.append(
                f"{label} 未落地（原句「{val[:34]}…」，"
                f"正文只命中 {len(hit)}/{len(sigs)} 个信号：{'、'.join(hit) if hit else '无'}）")

    mark = "OK " if not problems else "XX "
    print(f"  {mark}{name:<34} 选题#{t['id']}")
    for p in problems:
        print(f"       · {p}")
    return problems


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    dirs = [a for a in args if os.path.isdir(a)]
    if not dirs:
        print("  没有找到草稿目录")
        return 1
    print("  选题对齐检查（文章有没有用上读者三问）")
    print("  " + "=" * 70)
    bad = 0
    for d in dirs:
        r = check(d)
        if r:
            bad += 1
    print()
    print(f"  {bad} / {len(dirs)} 篇有问题")
    print()
    print("  说明：查出来不一定错（如角度换了、或该字段本来就不适合本篇）。")
    print("        但每一条都该被看见——选题白设计了才是真浪费。")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
