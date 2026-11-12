#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一条命令跑完一个阶段该跑的所有检查。

    python tools/check-all.py drafts/20260801-slug --stage=draft
    python tools/check-all.py drafts/20260801-slug --stage=review
    python tools/check-all.py drafts/20260801-slug --stage=layout
    python tools/check-all.py drafts/*/ --stage=draft

为什么做这个（2026-11-08）：
    到这一天，检查器已经有 11 个。Agent 每推进一个阶段要记一串命令：
        python tools/check-symbols.py ...
        python tools/check-facts.py ...
        python tools/check-texture.py ...
        ...
    记不全就漏跑，漏跑就等于没检查（check-symbols 那条注释里写着：
    「只查 draft.md 等于没查」——同一个坑）。

    这个脚本只做一件事：**按阶段把该跑的串起来**，不再让 Agent 记命令。

阶段 → 检查的映射（依据每个检查器自己的注释）：

    draft    初稿写完，准备打磨
             · symbols     符号（违规则退出码 1，硬）
             · facts       事实出处（硬）
             · structure   结构硬项（硬）
             · texture     质感（软：某些风格本来就不追求这个）
             · quality     内容质感（软）
             · topic-align 选题对齐（软）

    review   polish 完成，准备定稿排版
             · symbols     再查一次（这一阶段最容易改出符号问题）
             · facts       事实（改稿可能改出新断言）
             · texture / structure / quality / topic-align（软）
             · prohibited  违禁词（提示工具，恒 0）
             · draft       技能分流检查（aws 配额 / 卡兹克 L1）

    layout   已排版，准备配图
             · symbols     必须查 article.html，这是它真正的用武之地
             · image-layout 图位数量与均匀性

硬 vs 软：
    硬（退出码 1 = 停下）：symbols / facts / structure / image-layout / draft
    软（只报告，不阻断）：texture / quality / topic-align / prohibited

    为什么 texture / quality 是软：
    它们查的是「表达倾向」不是「对错」。MS-008 追求低形容词密度，
    但换成别的风格这条就不适用；quality 查第一人称缺席，
    但某些题材本来就不该用第一人称。硬卡会让所有稿子写成同一个模子。

用法补充：
    --hard-only    只跑硬检查（快速确认能不能继续往下走）
    --json         输出 JSON 摘要（给程序读）
"""
import argparse
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable

# 检查器登记表：name -> (脚本名, 是否硬闸门)
CHECKS = {
    "symbols":       ("check-symbols.py", True),
    "facts":         ("check-facts.py", True),
    "structure":     ("check-structure.py", True),
    "texture":       ("check-texture.py", False),
    "quality":       ("check-quality.py", False),
    "topic-align":   ("check-topic-align.py", False),
    "prohibited":    ("check-prohibited.py", False),
    "draft":         ("check-draft.py", True),
    "image-layout":  ("check-image-layout.py", True),
    # 论点一致性：2026-11-10 加。硬闸门——一篇塞三个论点是结构性错误。
    "thesis":        ("check-thesis.py", True),
}

# 阶段 → 要跑哪几个
STAGES = {
    "draft":  ["symbols", "facts", "structure", "thesis", "texture", "quality", "topic-align"],
    "review": ["symbols", "facts", "texture", "structure", "thesis",
               "topic-align", "prohibited", "draft"],
    "layout": ["symbols", "image-layout"],
}


def run_one(name, dirs):
    """跑一个检查器，返回 (name, rc, output)。"""
    script, _hard = CHECKS[name]
    path = os.path.join(HERE, script)
    if not os.path.isfile(path):
        return name, 0, f"（跳过：{script} 不存在）"
    cmd = [PY, "-X", "utf8", path, *dirs]
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    return name, r.returncode, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--stage", required=True, choices=sorted(STAGES))
    ap.add_argument("--hard-only", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    # 只保留存在的草稿目录
    dirs = []
    for d in args.dirs:
        if os.path.isdir(d) and os.path.isfile(os.path.join(d, "draft.md")):
            dirs.append(d)
        elif glob.has_magic(d):
            dirs.extend(sorted(x for x in glob.glob(d)
                               if os.path.isfile(os.path.join(x, "draft.md"))))
    if not dirs:
        print("  没有找到含 draft.md 的草稿目录")
        return 2

    todo = STAGES[args.stage]
    if args.hard_only:
        todo = [n for n in todo if CHECKS[n][1]]

    summary = []
    hard_failed = []

    for name in todo:
        _script, hard = CHECKS[name]
        label = "硬闸门" if hard else "提示"
        if not args.json:
            print()
            print(f"  ┌── {name}（{label}） " + "─" * max(0, 40 - len(name)))
        n, rc, out = run_one(name, dirs)
        ok = (rc == 0)
        if hard and not ok:
            hard_failed.append(name)
        summary.append({"check": name, "hard": hard, "rc": rc, "ok": ok})
        if not args.json:
            if out:
                # 全量转发。软检查的关键信息就在「· 」开头的详情行里，
                # 只打通过/不通过等于没说。
                for ln in out.splitlines():
                    print("  │ " + ln)
            print(f"  └── {'✅ 通过' if ok else ('❌ 未通过' if hard else '⚠️  有提示')}")

    if args.json:
        print(json.dumps({
            "stage": args.stage,
            "dirs": dirs,
            "results": summary,
            "hard_failed": hard_failed,
            "passed": not hard_failed,
        }, ensure_ascii=False, indent=2))
        return 1 if hard_failed else 0

    print()
    print("  " + "═" * 60)
    hard_n = sum(1 for s in summary if s["hard"])
    soft_n = len(summary) - hard_n
    if hard_failed:
        print(f"  ❌ 硬闸门未通过：{'、'.join(hard_failed)}")
        print(f"     修完再往下走。软检查的提示可以自行判断要不要改。")
        print("  " + "═" * 60)
        return 1
    soft_warn = [s["check"] for s in summary if not s["hard"] and not s["ok"]]
    if soft_warn:
        print(f"  ⚠️  硬闸门全过（{hard_n} 项），但有 {len(soft_warn)} 项软提示：")
        print(f"     {'、'.join(soft_warn)}")
        print(f"     这些不是错误，是「该看一眼」。改不改要给出理由，不能当没看见。")
    else:
        print(f"  ✅ 全部通过（硬闸门 {hard_n} 项 / 软提示 {soft_n} 项）")
    print("  " + "═" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
