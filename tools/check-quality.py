#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内容质感检查：视频 04 里能机器判定的部分。

    python tools/check-quality.py drafts/20260801-slug
    python tools/check-quality.py drafts/*/

为什么需要（2026-11-08，复盘 v11 后）：
    v11 的脚本全过（事实零编造、结构合规、符号通过），但内容上有四个硬伤：
      · 全文没有第一人称，选题里的「我妈天天转发」完全没落地
      · 最痛处被「这不是要苛责报道」按下去了
      · 金句是空转（「中间隔着的就是这件事本身」）
      · 开头只有时间地点，没有抓手

    这几条脚本原本查不了，但**有相当一部分是可以形式化的**：
    第一人称计数、按下感受的句式、空转金句的句式、开头的具体性。
    查出来的不一定都要改，但至少要被看见。

查 4 项：
    ① 第一人称是否缺席（选题三问落地的前提）
    ② 最痛处有没有被解释性短句按下去
    ③ 金句是不是空转（指向不具体的东西）
    ④ 开头有没有具体抓手（时间/地点/人物/动作/数字）

不查（纯语义）：
    情绪势能够不够、细节是否恰好、观点是否有依据。
"""
import io
import os
import re
import sys
import glob

# 把读者感受按下去的句式：出现在最痛处之后就是问题
SOFTENERS = [
    "这不是要苛责", "不必过度解读", "客观来说", "客观地说", "不怪",
    "话虽如此", "当然，这也不", "这并不是说", "也不能全怪",
    "理性看待", "见仁见智", "各有各的道理",
]

# 空转金句：指向「这件事本身」而不是具体对象
EMPTY_MAXIM = [
    "就是这件事本身", "说到底还是", "本质就是这样", "这就是生活",
    "道理都一样", "关键还是那个", "核心无非是", "归根到底就是",
]

# 开头抓手的信号
HOOK_SIGNALS = [
    (r"\d+\s*年|\d+\s*月|\d+\s*日|\d+\s*点", "时间"),
    (r"[\u4e00-\u9fff]{2,4}(县|市|乡|区|镇|村|省)", "地点"),
    (r"我妈|我爸|我朋友|我同事|我认识|我见过|前几天|昨天", "私事"),
    (r"他|她|老人|男子|女子|老师|医生|奶奶|爷爷", "人物"),
    (r"穿|戴|走|站|坐|说|喊|拿|围|推|跑|跳", "动作"),
]


def body_of(text):
    lines = []
    for ln in text.split("\n"):
        st = ln.strip()
        if st.startswith("![") or re.match(r"^#\s", st) or st.startswith(">"):
            continue
        lines.append(ln)
    return "\n".join(lines)


def check(path):
    text = io.open(path, encoding="utf-8").read()
    body = body_of(text)
    cn = len(re.findall(r"[\u4e00-\u9fff]", body))
    name = os.path.basename(os.path.dirname(path))
    problems = []

    if cn < 400:
        print(f"  {name:<34} {cn:>5}字  —  (太短，跳过)")
        return []

    # ① 第一人称缺席
    # 不能只数「我」的次数：v11 里唯一的「我」是「我能照着做的事」，指的是读者。
    # 要判「作者有没有以第一人称讲述自己的处境/观察」。
    fp_all = len(re.findall(r"(?<![自])我(?![们])", body))
    # 作者的「我」通常在讲自己的经历、感受、判断
    AUTHOR_I = re.compile(
        r"我(?:妈|爸|朋友|同事|认识|见过|一直|本来|以为|发现|觉得|想|翻到|刷到|看到)"
        r"|我(?:在|也|就|还|不|没|真|第一)"
    )
    author_fp = len(AUTHOR_I.findall(body))
    if author_fp == 0:
        problems.append(
            f"作者没有以第一人称出现（全文「我」×{fp_all}，但都是指读者或泛指）"
            f"——选题的读者三问多半没落地，文章站在分析者位置而不是读者位置")

    # ② 最痛处被按下去
    hits2 = []
    for i, ln in enumerate(body.split("\n")):
        st = ln.strip()
        for w in SOFTENERS:
            if w in st:
                hits2.append((w, st[:52]))
    if hits2:
        for w, ctx in hits2[:3]:
            problems.append(f"解释性收尾「{w}」把感受按下去了：…{ctx}…")

    # ③ 空转金句
    hits3 = []
    for ln in body.split("\n"):
        for w in EMPTY_MAXIM:
            if w in ln:
                hits3.append((w, ln.strip()[:52]))
    if hits3:
        for w, ctx in hits3[:2]:
            problems.append(f"空转金句「{w}」：…{ctx}…")

    # ④ 开头抓手
    head = body.strip()[:220]
    kinds = set()
    for pat, label in HOOK_SIGNALS:
        if re.search(pat, head):
            kinds.add(label)
    if len(kinds) <= 1:
        problems.append(f"开头只有 {len(kinds)} 类抓手（{'、'.join(kinds) or '无'}），"
                        f"偏平。至少要有具体场景或私事")

    mark = "OK " if not problems else "XX "
    print(f"  {mark}{name:<34} {cn:>5}字  作者我×{author_fp}  开头{len(kinds)}类抓手")
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

    print("  内容质感检查（视频 04 可机器判定的部分）")
    print("  " + "=" * 70)
    bad = 0
    for p in paths:
        if check(p):
            bad += 1
    print()
    print(f"  {bad} / {len(paths)} 篇有问题")
    print()
    print("  说明：查出来的不一定都要改（比如某些题材本来就不适合第一人称），")
    print("        但每一条都该被看见并给出判断。纯语义部分交给骨架第⑥步的三问。")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
