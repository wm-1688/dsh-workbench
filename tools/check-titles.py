#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标题体检：按 10 条爆款公式的结构要求检查标题。

    python tools/check-titles.py drafts/xxx/draft.md      # 查一篇草稿的标题
    python tools/check-titles.py --topics                 # 查库里所有选题标题
    python tools/check-titles.py "某个标题"                # 查单条

**只提示不阻断**（退出码恒为 0）：标题是创意活，硬拦会误杀好标题。
但问题要具体指出来 —— 只说「不合格」等于没说。

检查依据不是个人偏好，是《拆解了1万篇10W+文章》里反复强调的四件事：
  ① 不要用抽象词收尾（「本质」「格局」「算过账」——读者看完等于没看）
  ② 不要结论式（「不是X，是Y」把答案说了，不需要点进去）
  ③ 不要纯抽象主语（可读性/认知/逻辑开头，无法代入）
  ④ 不要三个以上并列事实（顿号堆砌，没有一个人）
  ⑤ 不要空问句（「为什么XX」后面没具体对象）
  ⑥ 要有具体元素（人/数字/引号至少一个）
"""
import io
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
WORKSPACE = os.path.dirname(PLUGIN)
DB = os.path.join(WORKSPACE, "workbench", "workbench.db")

# 与 gen-topics.py 保持同一份规则。**不要在这里另写一份** ——
# 两处规则必然漂移，届时「生成说合格、检查说不合格」会让人完全不知道该信谁。
sys.path.insert(0, HERE)
from importlib import util as _ilu
_spec = _ilu.spec_from_file_location("_gt", os.path.join(HERE, "gen-topics.py"))
_gt = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_gt)
title_lint = _gt.title_lint
TITLE_FORMULAS = _gt.TITLE_FORMULAS


def report(text, label=""):
    """检查一条标题，打印结果。返回问题数。"""
    probs = title_lint(text)
    head = ("  %-6s" % label) if label else "  "
    if not probs:
        print(head + "✅ " + text)
        return 0
    print(head + "⚠️  " + text)
    for p in probs:
        print("         · " + p)
    return len(probs)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]

    print("标题体检（依据 10 条爆款公式的结构要求）")
    print("=" * 60)

    total = bad = 0

    if "--topics" in flags:
        if not os.path.isfile(DB):
            print("  ❌ 数据库不存在：" + DB)
            return 0
        conn = sqlite3.connect(DB)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, title FROM topics WHERE title IS NOT NULL AND title <> '' "
            "ORDER BY id DESC LIMIT 40").fetchall()
        conn.close()
        print("\n库里最近 %d 个选题标题：\n" % len(rows))
        for r in rows:
            n = report(r["title"], "#" + str(r["id"]))
            total += 1
            if n: bad += 1

    elif args:
        target = args[0]
        # 目录或 .md 文件 → 读第一行标题
        if os.path.isdir(target):
            md = os.path.join(target, "draft.md")
            if not os.path.isfile(md):
                md = os.path.join(target, "article.md")
            if os.path.isfile(md):
                first = io.open(md, encoding="utf-8").readline().strip()
                report(first.lstrip("# ").strip(), "标题")
                total += 1
            else:
                print("  ❌ 目录里没有 draft.md / article.md")
        elif os.path.isfile(target):
            first = io.open(target, encoding="utf-8").readline().strip()
            report(first.lstrip("# ").strip(), "标题")
            total += 1
        else:
            # 当成标题文本
            n = report(target, "标题")
            total += 1
            if n: bad += 1

    else:
        # 没参数：查库里最近 20 条
        if os.path.isfile(DB):
            conn = sqlite3.connect(DB)
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT id, title FROM topics WHERE title IS NOT NULL AND title <> '' "
                "ORDER BY id DESC LIMIT 20").fetchall()
            conn.close()
            print("\n库里最近 %d 个选题标题（没传参数时的默认行为）：\n" % len(rows))
            for r in rows:
                n = report(r["title"], "#" + str(r["id"]))
                total += 1
                if n: bad += 1
        else:
            print("用法：check-titles.py <目录|文件|标题文本>  或  --topics")

    print("\n" + "=" * 60)
    if total:
        print("检查 %d 条，%d 条有问题（%.0f%%）" % (total, bad, 100.0 * bad / total))
        if bad:
            print("\n参考这 10 条公式的结构：")
            for fid, name, when, how in TITLE_FORMULAS:
                print("  %s %-22s %s" % (fid, name, how))
    # **恒返回 0**：只提示不阻断，不能因为标题不合规就让构建/流程停下来
    return 0


if __name__ == "__main__":
    sys.exit(main())
