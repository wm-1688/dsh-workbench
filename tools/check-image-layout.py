#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""配图位置检查：数量、均匀性、结尾覆盖。

用法：
    python tools/check-image-layout.py drafts/20261107-cunshang-aws
    python tools/check-image-layout.py drafts/*/            # 批量

为什么需要（2026-11-07）：
    旧规范只说「跨度 ≥400 字」，没有数量标准与均匀性要求。实测四篇全部不合格：
    最严重的一篇两张图间隔 0 字，后半段连续 1324 字无图。
    这类问题靠肉眼数不出来，必须机器查。

判据（与 配图路线.md「图位数量与位置」逐条对应）：
    图位数 = clamp(ceil(字数/500), 1, 5)
    平均间隔 = 字数 / (图位数 + 1)
    合格区间 = [平均×0.7, 平均×1.5]
    硬禁止：两图间隔 <200；任何连续无图 >800
"""
import io
import os
import re
import sys
import glob

HERE = os.path.dirname(os.path.abspath(__file__))


def body_chars(text):
    """正文字数：去掉 H1 标题行、图位行、引用块。"""
    lines = []
    for ln in text.split("\n"):
        st = ln.strip()
        if st.startswith("!["):
            continue
        if re.match(r"^#\s", st):
            continue
        lines.append(ln)
    return len(re.findall(r"[\u4e00-\u9fff]", "\n".join(lines)))


def analyze(path):
    text = io.open(path, encoding="utf-8").read()

    # 逐行累计汉字，记录每个图位之前的字数
    cum = 0
    positions = []
    for ln in text.split("\n"):
        st = ln.strip()
        if st.startswith("![") and "placeholder" in st:
            # 封面标记不计入正文图位：按 aws 规范它放在 # 行之前，
            # 排版时会单独抽出来当文章封面，不进正文。
            # 这里如果算进去，就会多算一张图，还报「首图前 0 字」。
            if not st.startswith("![封面"):
                positions.append(cum)
        elif re.match(r"^#\s", st):
            continue
        else:
            cum += len(re.findall(r"[\u4e00-\u9fff]", ln))
    total = cum

    return total, positions


def check(path, verbose=True):
    total, pos = analyze(path)
    name = os.path.basename(os.path.dirname(path))
    problems = []

    # 字数太少不检查
    if total < 800:
        if verbose:
            print(f"  {name:<34} {total:>5}字  {len(pos)}图  —  (短于800字，跳过)")
        return []

    expect = max(1, min(5, -(-total // 500)))   # ceil
    n = len(pos)

    if n != expect:
        problems.append(f"图位数 {n}，按公式应为 {expect}（{total}字/{500}）")

    if n > 0:
        avg = total / (n + 1)
        lo, hi = avg * 0.7, avg * 1.5
        gaps = []
        prev = 0
        for x in pos:
            gaps.append(x - prev)
            prev = x
        gaps.append(total - prev)

        for i, g in enumerate(gaps):
            label = ("首图前" if i == 0 else
                     ("结尾" if i == len(gaps) - 1 else f"第{i}与第{i+1}图间"))
            if g < 200 and len(gaps) > 1:
                problems.append(f"{label} {g}字 < 200（挤在一起）")
            elif g > 800 and len(gaps) > 1:
                problems.append(f"{label} {g}字 > 800（读者划过整屏无图）")
            elif not (lo <= g <= hi) and len(gaps) > 1:
                problems.append(f"{label} {g}字 超出 {lo:.0f}~{hi:.0f}")

        # 两张图完全贴一起
        for i in range(len(pos) - 1):
            if pos[i + 1] - pos[i] < 200:
                problems.append(f"第{i+1}与第{i+2}张仅隔 {pos[i+1]-pos[i]} 字")
                break

    if verbose:
        mark = "✅" if not problems else "❌"
        print(f"  {name:<34} {total:>5}字  {n}图(应{expect})  {mark}")
        if problems:
            for p in problems[:4]:
                print(f"       · {p}")
    return problems


def has_placeholder(path):
    """稿子里有没有图位。没有就说明还没到配图阶段，不归这个检查管。"""
    try:
        text = io.open(path, encoding="utf-8").read()
    except Exception:
        return False
    return "](placeholder)" in text


def active_dirs():
    """返回「还在创作中」的草稿目录名集合。

    为什么要有这一步（2026-11-07）：
      第一版把范围放成「所有 draft.md」，结果 26 篇历史稿全被拦，构建永远过不去，
      闸门等于失效。只查 status 在 queued~illustrated 的，已入草稿箱/已发布的不查。
      另外跳过目录名含 skilltest 的测试稿。
    """
    db = os.path.join(os.path.dirname(HERE), "tools", "workbench-db.py")
    if not os.path.isfile(db):
        return None          # 拿不到就退化成全查
    try:
        import json
        import subprocess
        r = subprocess.run([sys.executable, "-X", "utf8", db, "api"],
                           input=json.dumps({"op": "list-drafts"}),
                           capture_output=True, text=True, encoding="utf-8")
        drafts = json.loads(r.stdout.strip().splitlines()[-1]).get("drafts", [])
    except Exception:
        return None
    ACTIVE = {"queued", "draft", "polished", "reviewed", "formatted", "illustrated"}
    out = set()
    for d in drafts:
        if d.get("status") not in ACTIVE:
            continue
        path = (d.get("path") or "").strip("/")
        if path:
            out.add(os.path.basename(path))
    return out


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

    active = active_dirs()
    if active is not None:
        before = len(paths)
        paths = [p for p in paths if os.path.basename(os.path.dirname(p)) in active]

    # 跳过测试稿
    paths = [p for p in paths if "skilltest" not in p]

    # 只追责新规则生效（2026-11-07）之后建的稿子。
    # 规范是这天才有「图位数公式/均匀性」这些要求，拿它去判更早的稿子
    # 既不公平也没意义——那些稿子当初按旧规范写的，不是错误。
    RULE_DATE = "20261107"
    paths = [p for p in paths
             if os.path.basename(os.path.dirname(p))[:8] >= RULE_DATE]

    # 只追责「已经有图位」的稿子。
    # draft 阶段还没配图是正常的，不能因为「0 图」判不合格——
    # 第一版就是漏了这条，把 5 篇未配图的稿子全判成 ❌，闸门变成噪音。
    paths = [p for p in paths if has_placeholder(p)]

    print("  配图位置检查（只查已有图位、创作中的稿子）")
    print("  " + "=" * 62)
    if not paths:
        print("  （没有处于创作中的草稿，跳过）")
        return 0
    bad = 0
    for p in paths:
        if check(p):
            bad += 1
    print()
    print(f"  {bad} / {len(paths)} 篇有问题")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
