#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""符号规范检查器（含自动修复）。

    python tools/check-symbols.py drafts/20261006-xxx          # 检查，违规则退出码 1
    python tools/check-symbols.py drafts/20261006-xxx --fix    # 先修直引号，再检查

**为什么必须检查排版产物**：2026-10-06 踩的坑——
    稿件里用的是 ASCII 直引号 "，draft.md 里「」计数为 0，看着合规；
    但 format.py 的「Markdown 预格式化」会把直引号转成 「」，
    于是 article.html 里凭空多出 18 对「」，并发布进了微信草稿箱。
    只查 markdown 等于没查。

规则（来自 .aws-article/writing-spec.md 的符号使用规范）：
    · 「」『』 一律禁用，改用中文双引号 “”
    · —— 仅允许出现在金句行（`> 金句。 —— 出处`，write.py check 的机器语法）
    · …… 不用；（） 尽量少用（超阈值仅告警）
    · ASCII 直引号 " 禁用（排版会把它变成 「」）

无第三方依赖。
"""

import io
import os
import re
import sys

BANNED = {"\u300c": "「", "\u300d": "」", "\u300e": "『", "\u300f": "』"}
FILES = ["draft.md", "draft-stripped.md", "article.md", "article.html"]
PROSE_MAX_PAREN = 6          # 全角括号告警阈值
QUOTE_L, QUOTE_R = "\u201c", "\u201d"


def fix_quotes(text):
    """成对替换 ASCII 直引号 → 中文双引号。"""
    out, n = [], 0
    for ch in text:
        if ch == '"':
            out.append(QUOTE_L if n % 2 == 0 else QUOTE_R)
            n += 1
        else:
            out.append(ch)
    return "".join(out), n


def is_quote_line(line):
    """金句行：以 > 开头且含 —— （write.py check 认的机器语法）。"""
    return line.lstrip().startswith(">") and "——" in line


def check_file(path):
    name = os.path.basename(path)
    if not os.path.exists(path):
        return None
    text = io.open(path, encoding="utf-8").read()
    lines = text.splitlines()
    is_html = name.endswith(".html")

    problems, warnings = [], []

    # 1. 直角引号
    for ch, label in BANNED.items():
        n = text.count(ch)
        if n:
            problems.append(f"{label} × {n}（禁用，改用中文双引号）")

    # 2. 破折号：只允许金句行
    if is_html:
        # HTML 里金句在 blockquote 内，行首不是 >，所以按总数判定
        n = text.count("——")
        if n > 1:
            problems.append(f"—— × {n}（一篇只允许金句行 1 处）")
    else:
        bad = [i + 1 for i, l in enumerate(lines) if "——" in l and not is_quote_line(l)]
        if bad:
            problems.append(f"—— 出现在非金句行（第 {bad} 行）")

    # 3. ASCII 直引号（仅 markdown 有意义；HTML 的属性引号是正常的）
    if not is_html:
        n = text.count('"')
        if n:
            problems.append(f'ASCII 直引号 " × {n}（排版会转成 「」，请用中文双引号）')

    # 4. 省略号与括号（告警）
    if text.count("\u2026\u2026"):
        warnings.append(f"…… × {text.count(chr(0x2026)+chr(0x2026))}（尽量不用）")
    if not is_html:
        n = text.count("\uff08")
        if n > PROSE_MAX_PAREN:
            warnings.append(f"全角括号 × {n}（尽量少用，阈值 {PROSE_MAX_PAREN}）")

    return {"file": name, "problems": problems, "warnings": warnings,
            "counts": {"「": text.count("\u300c"), "——": text.count("——"),
                       '"': text.count('"'), "“": text.count(QUOTE_L)}}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    do_fix = "--fix" in sys.argv
    if not args:
        print(__doc__)
        return 2
    d = args[0]
    if not os.path.isdir(d):
        print(f"  目录不存在: {d}")
        return 2

    if do_fix:
        print("=== 自动修复 ===")
        for f in ("draft.md", "draft-stripped.md", "article.md"):
            p = os.path.join(d, f)
            if not os.path.exists(p):
                continue
            t = io.open(p, encoding="utf-8").read()
            if '"' in t:
                t2, n = fix_quotes(t)
                io.open(p, "w", encoding="utf-8", newline="\n").write(t2)
                print(f"  {f}: {n} 个直引号 → 中文双引号")
        print("  （article.html 需重新排版才能同步，见 README：排版前跑一次 --fix）")

    print(f"\n=== 符号检查 · {os.path.basename(d.rstrip(os.sep))} ===")
    total = 0
    for f in FILES:
        r = check_file(os.path.join(d, f))
        if r is None:
            continue
        total += len(r["problems"])
        flag = "❌" if r["problems"] else "✅"
        print(f"  {flag} {r['file']:<20} 「{r['counts']['「']}  ——{r['counts']['——']}")
        for p in r["problems"]:
            print(f"        ❌ {p}")
        for w in r["warnings"]:
            print(f"        ⚠️  {w}")

    print("=" * 56)
    if total:
        print(f"发现 {total} 处违规。修法：check-symbols.py <目录> --fix，然后重新排版。")
        return 1
    print("符号规范通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
