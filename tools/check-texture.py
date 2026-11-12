#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""质感检查：给 MS-008「人格叙事体」这类克制风格用的尺子。

    python tools/check-texture.py drafts/20260801-slug

为什么需要（2026-11-08）：
    MS-008 与 A 类技能（aws）的配额冲突：
      · aws 要求每 100 字一处加粗 + 必须有带出处的金句
      · MS-008 要求克制、不大量加粗、金句不硬凑
    这两个互斥。用户决策：**风格优先，换尺子**——
    选了 MS-008 就不跑 aws 配额，改用这套质感检查。

    对应教程 04《语言质感与文气》里能机器校验的部分。

查 5 项：
    ① 形容词/程度副词密度（教程第一课：形容词换动词名词）
    ② 连续同主语开头（教程第四课：句子开口闷）
    ③ 全篇句长是否一个节奏（教程第四课：长短结合）
    ④ 结尾是否在总结全文（教程：最浪费的结尾）
    ⑤ 开头 100 字有无废话（教程：一律重写）

不查的（需语义判断，交给 Agent 自检）：
    细节密度对不对、克制够不够、金句是不是硬凑的。

**关于金句的明确豁免（2026-11-08 决定）**：
    A 类技能（aws）的配额要求「恰好一行带出处的金句」。
    但选了克制风格（MS-008）时，check-draft.py 会走本检查器、跳过 aws 配额。
    这带来一个空档：本检查器也不查金句，于是金句两边都不管。

    这个空档是**有意的**，不是漏了。
    MS-008 的原话是「金句不是憋出来的，是反复打磨的结果」「金句 0-1 处」。
    强制要求一行带出处的金句，恰恰违背这个风格的定位——
    会逼着 Agent 为了满足配额硬凑一句。

    所以：走本检查器时，**金句不设硬性要求**。有就要求打磨过，没有也不算不合格。
    这条豁免必须写在这里，否则后来的人会以为是 check-texture 漏查了。
"""
import io
import os
import re
import sys
import glob

# 教程明确要换掉的：形容词与程度副词
# 只收「确实在当程度副词用」的词。
# 实测踩过：「十分」在「9 点 45 分」「7 点 20 分」里会误报，
# 所以这类有歧义的词改用正则带上下文判断，不做裸字符串匹配。
ADJ_WORDS = ["非常", "极其", "特别", "深深", "巨大", "充分",
             "完全", "无比", "令人震撼", "深刻", "广泛", "重大",
             "充足", "至关重要", "重中之重", "深远", "强烈", "极为"]

# 有歧义的词：带上下文正则
ADJ_REGEX = [
    (r"十分(?![钟点分])", "十分"),      # 「十分感动」算，「十分钟」不算
    (r"很(?![多久少])[\u4e00-\u9fff]", "很"),  # 「很好」算，「很久」「很多」不算
]

# 正确的废话
EMPTY_WORDS = ["众所周知", "近年来", "随着", "在当今", "不可否认", "毋庸置疑",
               "我们常说", "如今的社会", "随着社会的发展", "随着时代的发展",
               "在这个信息爆炸"]

# 总结式结尾
SUMMARY_ENDING = ["总之", "综上", "综上所述", "所以说", "总结一下", "总而言之",
                  "以上就是", "最后总结", "回顾一下全文"]


def body_of(text):
    lines = []
    for ln in text.split("\n"):
        st = ln.strip()
        if st.startswith("![") or re.match(r"^#\s", st):
            continue
        lines.append(ln)
    return "\n".join(lines)


def split_sentences(body):
    """按中文句末标点切句。"""
    s = re.sub(r"\n+", "", body)
    parts = re.split(r"[。！？!?；;]", s)
    return [p.strip() for p in parts if len(p.strip()) >= 2]


def check(path):
    text = io.open(path, encoding="utf-8").read()
    body = body_of(text)
    cn = len(re.findall(r"[\u4e00-\u9fff]", body))
    name = os.path.basename(os.path.dirname(path))
    problems = []

    if cn < 400:
        print(f"  {name:<34} {cn:>5}字  —  (太短，跳过)")
        return []

    # ① 形容词/程度副词密度
    hits = []
    for w in ADJ_WORDS:
        n = body.count(w)
        if n:
            hits.append((w, n))
    for pat, label in ADJ_REGEX:
        n = len(re.findall(pat, body))
        if n:
            hits.append((label, n))
    total_adj = sum(n for _, n in hits)
    per_k = total_adj / max(cn, 1) * 1000
    if per_k > 8:
        top = "、".join(f"{w}×{n}" for w, n in sorted(hits, key=lambda x: -x[1])[:4])
        problems.append(f"形容词/程度副词密度 {per_k:.1f}/千字（建议 ≤8）：{top}")

    # ② 连续同主语开头
    paras = [p.strip() for p in body.split("\n\n") if p.strip()]
    starts = []
    for p in paras:
        first = p[:2]
        starts.append(first)
    max_run, cur = 1, 1
    for a, b in zip(starts, starts[1:]):
        if a and a == b and a in ("他", "她", "它", "这", "那", "我", "你"):
            cur += 1
            max_run = max(max_run, cur)
        else:
            cur = 1
    if max_run >= 3:
        problems.append(f"连续 {max_run} 段同主语开头，节奏会闷")

    # ③ 句长是否一个节奏
    sents = split_sentences(body)
    if len(sents) >= 8:
        lens = [len(re.findall(r"[\u4e00-\u9fff]", x)) for x in sents]
        lens = [x for x in lens if x > 0]
        if lens:
            avg = sum(lens) / len(lens)
            short = sum(1 for x in lens if x <= 12)
            long_ = sum(1 for x in lens if x >= 35)
            if short == 0:
                problems.append(f"没有短句（≤12字）——缺收束，全篇一个节奏")
            if long_ == 0 and avg < 20:
                problems.append(f"没有长句（≥35字）——缺铺陈，全篇一个节奏")

    # ④ 结尾总结全文
    tail = body[-200:]
    hits2 = [w for w in SUMMARY_ENDING if w in tail]
    if hits2:
        problems.append(f"结尾在总结全文：{'、'.join(hits2[:3])}")

    # ⑤ 开头废话
    head = ""
    cnt = 0
    for ch in body:
        if re.match(r"[\u4e00-\u9fff]", ch):
            cnt += 1
            if cnt > 100:
                break
        head += ch
    hits3 = [w for w in EMPTY_WORDS if w in head]
    if hits3:
        problems.append(f"开头 100 字内有废话：{'、'.join(hits3[:3])}")

    mark = "OK " if not problems else "XX "
    print(f"  {mark}{name:<34} {cn:>5}字  形容词 {per_k:>4.1f}/千字")
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

    print("  质感检查（教程 04 可机器校验的部分）")
    print("  " + "=" * 70)
    bad = 0
    for p in paths:
        if check(p):
            bad += 1
    print()
    print(f"  {bad} / {len(paths)} 篇有问题")
    print()
    print("  说明：细节密度、克制程度、金句是否硬凑，需语义判断，交给 Agent 自检。")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
