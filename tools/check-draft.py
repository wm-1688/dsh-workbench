#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按写作技能跑对应的 L1 硬性检查。

为什么需要这一层：不同写作技能的硬性规则是**互斥**的。

    aws-wechat-article-writing          导语 80-128 字、加粗密度、恰好一行金句（write.py check）
    khazix-writer                       禁冒号/破折号、禁小标题、禁大量加粗、8-10 个口语词（check-khazix.py）
    write-entertainment-wechat-articles  （暂无独立检查器）
    A 类 / B 类                         见 README「写作技能路由」

拿 A 类的配额去卡 B 类的稿子，必然失败——那不是稿子的问题，是**用错了尺子**。
所以在 打磨 与 定稿 两个阶段，都要按 `drafts.skill` 选检查器，不能写死一个。

用法：
    python tools/check-draft.py <草稿目录>          # 按目录查数据层，得到该草稿的 skill
    python tools/check-draft.py <草稿目录> --skill khazix-writer   # 手动指定（数据层查不到时）

退出码：0 = 通过（或该技能暂无检查器）；1 = 未通过；2 = 用法/环境错误。
"""

import argparse
import base64
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
PY = sys.executable


def skill_root():
    """技能安装目录。不要写死绝对路径：换机器 / 换用户名都会变。

    解析顺序：环境变量覆盖 > DSH_HOME/skills > ~/.dsh/skills
    """
    env = os.environ.get("DSH_WORKBENCH_SKILL_ROOT")
    if env and os.path.isdir(env):
        return env
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "skills")


SK = skill_root()

DB = os.path.join(HERE, "workbench-db.py")
KHAZIX = os.path.join(HERE, "check-khazix.py")
AWS_WRITE = os.path.join(SK, "aws-wechat-article-writing", "scripts", "write.py")

# 写作技能 → 检查器。value 是 (可执行文件, 参数构造器) 或 None（暂无检查器）。
ROUTES = {
    "khazix-writer": ("khazix", KHAZIX),
    "aws-wechat-article-writing": ("aws", AWS_WRITE),
    "write-entertainment-wechat-articles": (None, None),
}


def skill_from_db(draft_dir):
    """按草稿路径去数据层问 skill。数据层挂了也不阻塞，返回 None。"""
    try:
        req = {"op": "list-drafts"}
        p = base64.b64encode(json.dumps(req, ensure_ascii=False).encode()).decode()
        r = subprocess.run([PY, "-X", "utf8", DB, "api", "--payload", p],
                           capture_output=True, text=True, encoding="utf-8")
        data = json.loads((r.stdout or r.stderr).strip().splitlines()[-1])
    except Exception as e:
        print(f"  ⚠️  查数据层失败（{type(e).__name__}），无法确定写作技能")
        return None
    d = os.path.basename(os.path.normpath(draft_dir))
    for row in data.get("drafts", []):
        pth = (row.get("path") or "").rstrip("/")
        if pth and os.path.basename(pth) == d:
            return row.get("skill")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("draft_dir")
    ap.add_argument("--skill", default=None, help="手动指定写作技能（数据层查不到时用）")
    args = ap.parse_args()

    d = os.path.abspath(args.draft_dir)
    md = os.path.join(d, "draft.md")
    if not os.path.exists(md):
        print(f"  ❌ 找不到 {md}")
        return 2

    skill = args.skill or skill_from_db(d)
    if not skill:
        print("  ⚠️  没能确定这篇的写作技能，跳过 L1 检查。")
        print("      传 --skill <技能名> 可手动指定。")
        return 0

    if skill not in ROUTES:
        print(f"  ⚠️  写作技能 {skill} 未登记检查器，跳过。")
        print(f"      已登记：{', '.join(ROUTES)}")
        return 0

    kind, exe = ROUTES[skill]
    if exe is None:
        print(f"  ·  {skill} 暂无独立 L1 检查器（只有全局符号门禁兜底），跳过。")
        return 0

    print(f"  写作技能 {skill} → 用 {os.path.basename(exe)} 检查")
    if kind == "aws":
        cmd = [PY, "-X", "utf8", exe, "check", md]
    else:
        cmd = [PY, "-X", "utf8", exe, md]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout or "") + (r.stderr or "")
    # aws 的 check 会把 OK 写在 stdout；khazix 检查器自带排版，直接转发
    for line in out.splitlines():
        if kind == "aws" and ("OK" in line or "❌" in line):
            print("  " + line.strip())
        elif kind == "khazix":
            print(line)
    if r.returncode != 0:
        print(f"\n  ❌ {skill} 的 L1 硬性规则未通过，停下。")
        return 1
    print(f"  ✅ {skill} 的 L1 硬性规则通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
