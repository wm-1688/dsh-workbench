#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一条命令刷新界面数据 + 校验文档一致性。

    python tools/build.py                  # 抓热榜 + 导出快照 + 生成 client.js + 文档对账
    python tools/build.py --no-fetch       # 不抓热榜，只重新导出与生成（改完数据常用这个）
    python tools/build.py --skip-doc-check # 明确跳过文档对账（不建议）

流程：
    gen-materials.py       抓 7 天热榜归档 → lib/materials.snapshot.json
    workbench-db.py export 导出 SQLite 快照 → lib/db.snapshot.json
    gen-catalog.py          把技能包 + 素材 + 数据库 注入 → lib/client.js
    check-docs.py           把 README 的声明当断言，跟代码实际状态对账 ⛔ 不一致则中止

**文档对账放在最后且会中止构建**：它是"文档不落后于代码"的机器闸门。
2026-10-06 出现过两次文档与代码不符（README 停留在「数据层还没接」、
写进 README 的「6 张表」是 grep 数错的），靠"记得改文档"管不住，所以做成闸门。
改了代码就要同步 README；确实要临时跳过时用 --skip-doc-check，但要清楚为什么。

改完界面后必须重启 DSH（client 半按模块 id 加载）。
"""

import glob
import io
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


def run(script, *args, fatal=False):
    path = os.path.join(HERE, script)
    print(f"\n=== {script} {' '.join(args)} ===")
    rc = subprocess.call([PY, "-X", "utf8", path, *args])
    if rc != 0:
        mark = "❌" if fatal else "⚠️"
        print(f"  {mark} {script} 退出码 {rc}")
    return rc


def check_writing_skills():
    """WRITING_SKILLS 里的每个 name 都必须在 skills 目录下真实存在。

    为什么做成闸门：2026-11-06 发现创作配置里混进了 5 个编出来的技能名，
    界面照常显示、能选中，但 Agent 找不到对应 skill，静默失效。
    这类错误人眼看不出，必须机器校验。
    """
    import glob
    import re

    plugin = os.path.dirname(HERE)          # build.py 在 tools/ 下，上一级即插件根
    tpl = os.path.join(plugin, "lib", "client.template.js")
    if not os.path.isfile(tpl):
        print("  ⚠️ 找不到 client.template.js，跳过技能校验")
        return 0
    src = io.open(tpl, encoding="utf-8").read()

    # 只取 WRITING_SKILLS 数组那一段。
    # ⚠️ 不能用 find("]") 截断：每项里的 covers: [...] 会先遇到 ]，
    #    结果只解析到第一个技能。2026-11-07 就这么把 8 个错报成 1 个。
    #    改为按括号配对找到真正闭合的那个 ]。
    i = src.find("const WRITING_SKILLS = [")
    if i < 0:
        print("  ⚠️ 没找到 WRITING_SKILLS 定义，跳过")
        return 0
    depth, j = 0, i
    while j < len(src):
        if src[j] == "[":
            depth += 1
        elif src[j] == "]":
            depth -= 1
            if depth == 0:
                break
        j += 1
    block = src[i:j + 1]
    # 每项是 { name: '...', ... }，用 name 切段逐项校验
    items = re.findall(r"\{\s*name:\s*'([^']+)'(.*?)\}", block, re.S)
    names = [n for n, _ in items]

    roots = [
        os.path.join(plugin, "..", ".dsh", "skills"),
        os.path.join(plugin, "..", ".dsh", "redfox-skills"),
        os.path.expanduser(os.path.join("~", ".dsh", "skills")),
    ]

    missing = []
    for n in names:
        found = any(os.path.isfile(os.path.join(r, n, "SKILL.md")) for r in roots)
        if not found:
            missing.append(n)

    # 字段校验：以后自己加技能时，这是第一道闸门
    valid_keys = {"load", "digest", "angle", "outline", "write", "check", "deliver"}
    bad = []
    for n, rest in items:
        m_klass = re.search(r"klass:\s*'([^']+)'", rest)
        if not m_klass or m_klass.group(1) not in ("A", "B"):
            bad.append(f"{n}: klass 必须是 A 或 B（当前 {m_klass.group(1) if m_klass else '缺失'}）")
        m_kind = re.search(r"kind:\s*'([^']+)'", rest)
        if not m_kind or m_kind.group(1) not in ("from_zero", "rewrite", "other"):
            bad.append(f"{n}: kind 必须是 from_zero/rewrite/other"
                       f"（当前 {m_kind.group(1) if m_kind else '缺失'}）")
        m_cov = re.search(r"covers:\s*\[([^\]]*)\]", rest)
        if m_cov:
            keys = re.findall(r"'([^']+)'", m_cov.group(1))
            unknown = [k for k in keys if k not in valid_keys]
            if unknown:
                bad.append(f"{n}: covers 里有未知阶段 {unknown}（合法值：{sorted(valid_keys)}）")
        elif "from_zero" in rest:
            bad.append(f"{n}: from_zero 技能必须填 covers，否则骨架不知道该补哪几步")
        m_def = re.search(r"defaultStyle:\s*'([^']+)'", rest)
        if m_def and not re.match(r"^MS-\d+$", m_def.group(1)):
            bad.append(f"{n}: defaultStyle 应形如 'MS-006'（当前 {m_def.group(1)}）")

    print(f"  写作技能清单 {len(names)} 个")
    if missing:
        print(f"  ❌ 以下技能在 skills 目录里不存在：{', '.join(missing)}")
        print("     · 修法：改 lib/client.template.js 的 WRITING_SKILLS，只留真实存在的")
        return 1
    if bad:
        print(f"  ❌ 字段不合规 {len(bad)} 处：")
        for b in bad:
            print(f"     · {b}")
        print("     · 字段含义见 client.template.js 顶部的 REQUIRED_SKILL_FIELDS")
        return 1
    print(f"  ✅ 全部真实存在，字段合规")
    return 0


def workspace_drafts():
    """草稿根目录。build.py 在 <插件>/tools/ 下，草稿在 <workspace>/drafts/。"""
    plugin = os.path.dirname(HERE)
    return os.path.join(plugin, "..", "drafts")


def main():
    if "--no-fetch" not in sys.argv:
        run("gen-materials.py")
        # 素材抓完立刻生成选题：250 条热榜靠人挑既慢又会漏，
        # 这里把「筛选 + 定角度」自动做掉，人只需要从候选里选。
        # 不足 10 个就如实报数，不硬凑（见 gen-topics.py 结尾）。
        run("gen-topics.py")
    else:
        print("（跳过抓取与选题生成）")
    # 图片相关的 4 张表（image_jobs/series/assets/usage）由 image-db.py 建，
    # workbench-db.py 不管它们。build 时不先建，新装的环境里就缺这 4 张表，
    # README 的「9 张业务表」对不上（2026-11-08 打包验证时发现）。
    run("image-db.py", "init")
    run("workbench-db.py", "init")
    run("workbench-db.py", "export")
    run("gen-catalog.py")

    rc = run("check-docs.py")
    if rc != 0 and "--skip-doc-check" not in sys.argv:
        print("\n❌ 文档与代码不一致，构建中止（界面数据其实已刷新，但请先修文档）。")
        print("   · 同步 README 里的表清单 / 路由清单 / 状态机 / 数字 / 命令 / 文件结构")
        print("   · 确认要临时跳过：python tools/build.py --skip-doc-check")
        return 1

    # 写作技能必须真实存在：编出来的名字在界面上看不出问题，但 Agent 会静默失效。
    print("\n=== check_writing_skills ===")
    if check_writing_skills() != 0:
        print("\n❌ 写作技能清单里有不存在的技能，构建中止。")
        return 1

    # 草稿的技能是按建草稿那一刻的路由算的；路由表一改就会与赛道对不上。
    # 还没写的（queued）必须改，否则写作阶段会照旧技能写，与赛道不符。
    rc = run("check-drafts.py")
    if rc != 0:
        print("\n❌ 有 queued 草稿的技能与当前赛道路由不一致，构建中止。")
        print("   · 修法：python tools/check-drafts.py --fix")
        print("   · 原因：skill/skill_class 在建草稿时写死；改了路由表就要顺手同步")
        return 1

    # 配图位置：图位数量、均匀性、结尾覆盖。
    # 2026-11-07 加：实测四篇全部不合格，最严重的一篇两张图紧贴（间隔 0 字），
    # 后半段连续 1324 字无图。这类问题靠肉眼数不出来，必须做成闸门。
    # 只检查已经有图位的稿子（queued 阶段还没写，不参与）。
    print("\n=== check_image_layout ===")
    rc = run("check-image-layout.py", *sorted(glob.glob(os.path.join(workspace_drafts(), "*", "draft.md"))))
    if rc != 0 and "--skip-layout-check" not in sys.argv:
        print("\n❌ 有草稿的配图位置不合格，构建中止。")
        print("   · 判据见 配图路线.md「图位数量与位置」")
        print("   · 图位数 = clamp(ceil(字数/500), 1, 5)")
        print("   · 间隔须在 平均×0.7 ~ 平均×1.5 之间，且 <200 或 >800 一律不合格")
        print("   · 确认要临时跳过：python tools/build.py --skip-layout-check")
        return 1

    print("\n完成。重启 DSH 后生效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
