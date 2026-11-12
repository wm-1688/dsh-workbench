#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""结构检查：教程 03《结构工程》里能机器校验的部分。

    python tools/check-structure.py drafts/20261108-slug
    python tools/check-structure.py drafts/*/

为什么只查这几项（2026-11-08）：
    教程给了完整的结构方法论（悬念/推进/释放、六种结构、开头三秒、中段密度、结尾）。
    但其中**大部分需要语义判断**（悬念够不够、每段是否只承担一个功能），
    纯脚本查不了。这里只查「关键词和统计能确认」的硬项，
    语义部分交给骨架第⑥步的 Agent 自检。

能查的（4 项）：
    ① 开头 100 字内有「正确的废话」（教程明确要求一律重写）
    ② 结尾在总结全文（教程说这是最浪费的结尾）
    ③ 中段有连续的空转过渡句
    ④ 小节字数严重失衡（说明结构没搭好）
"""
import io
import os
import re
import sys
import glob

# 教程点名要删的开头废话
# 教程点名要删的开头废话。
# 2026-11-11 修：「在这个」原来是裸词，子串匹配会把「这个印象…」误判成废话开头。
# 真正要拦的是起手式，所以改成带宾语的精确形式。
OPENING_BAN = ["众所周知", "近年来", "随着", "在当今", "不可否认", "毋庸置疑",
               "众所周知的是", "我们常说", "如今的社会", "随着社会的发展",
               "随着时代的发展", "在这个信息爆炸", "在这个时代", "在这个社会",
               "在当前形势下", "随着科技的"]

# 教程点名「最浪费的结尾」
ENDING_BAN = ["总之", "综上", "综上所述", "所以说", "总结一下", "总而言之",
              "以上就是", "最后总结", "回顾一下全文"]

# 空转过渡句：只有连接作用，没有信息量
EMPTY_TRANSITION = ["接下来我们来看看", "下面让我们", "让我们来看看", "话不多说",
                    "首先我们来看", "然后我们来看", "在这里我想说", "值得一提的是",
                    "不得不说", "可以看到"]


def body_of(text):
    """去掉 H1 标题和图片行，返回正文。"""
    lines = []
    for ln in text.split("\n"):
        st = ln.strip()
        if st.startswith("![") or re.match(r"^#\s", st):
            continue
        lines.append(ln)
    return "\n".join(lines)


def check(path):
    text = io.open(path, encoding="utf-8").read()
    body = body_of(text)
    cn = len(re.findall(r"[\u4e00-\u9fff]", body))
    name = os.path.basename(os.path.dirname(path))
    problems = []

    if cn < 600:
        print(f"  {name:<36} {cn:>5}字  —  (太短，跳过)")
        return []

    # ① 开头 100 字内的废话
    head = re.findall(r"[\u4e00-\u9fff]", body)
    head_txt = ""
    cnt = 0
    for ch in body:
        if re.match(r"[\u4e00-\u9fff]", ch):
            cnt += 1
            if cnt > 100:
                break
        head_txt += ch
    hits = [w for w in OPENING_BAN if w in head_txt]
    if hits:
        problems.append(f"开头 100 字内有废话：{'、'.join(hits[:3])}")

    # ② 结尾总结全文
    tail = body[-200:]
    hits2 = [w for w in ENDING_BAN if w in tail]
    if hits2:
        problems.append(f"结尾在总结全文：{'、'.join(hits2[:3])}")

    # ③ 空转过渡句
    hits3 = [w for w in EMPTY_TRANSITION if w in body]
    if hits3:
        problems.append(f"有空转过渡句 {len(hits3)} 种：{'、'.join(hits3[:3])}")

    # ④ 小节字数失衡（只查有 H2 的）
    h2 = re.findall(r"^## (.+)$", text, re.M)
    if len(h2) >= 3:
        # 按 H2 切分，统计每节字数
        parts = re.split(r"^## .+$", text, flags=re.M)
        sizes = []
        for p in parts[1:]:
            sizes.append(len(re.findall(r"[\u4e00-\u9fff]", body_of(p))))
        sizes = [s for s in sizes if s > 0]
        if len(sizes) >= 3:
            mn, mx = min(sizes), max(sizes)
            if mn > 0 and mx > mn * 4:
                problems.append(f"小节字数失衡：最短 {mn} 字 / 最长 {mx} 字")

    mark = "OK " if not problems else "XX "
    print(f"  {mark}{name:<36} {cn:>5}字  {len(h2)}节")
    for p in problems:
        print(f"       · {p}")
    return problems


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    paths = []
    for a in args:
        if os.path.isdir(a):
            p = os.path.join(a, "draft.md")
            if os.path.isfile(p):
                paths.append(p)
        else:
            paths.extend(glob.glob(a))
    if not paths:
        print("  没有找到 draft.md")
        return 1

    print("  结构检查（教程 03 可机器校验的部分）")
    print("  " + "=" * 66)
    bad = 0
    for p in paths:
        if check(p):
            bad += 1
    print()
    print(f"  {bad} / {len(paths)} 篇有问题")
    print()
    print("  说明：悬念够不够、每段是否只承担一个功能，需要语义判断，")
    print("        交给骨架第⑥步的 Agent 自检。这里只查关键词与统计能确认的硬项。")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
