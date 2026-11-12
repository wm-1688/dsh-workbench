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
    check-docs.py           把文档的声明当断言，跟代码实际状态对账 ⛔ 不一致则中止

**文档对账放在最后且会中止构建**：它是"文档不落后于代码"的机器闸门。
2026-10-06 出现过两次文档与代码不符（文档停留在「数据层还没接」、
写进文档的「6 张表」是 grep 数错的），靠"记得改文档"管不住，所以做成闸门。
改了代码就要同步文档（README + DEVELOPMENT.md）；确实要临时跳过时用 --skip-doc-check，但要清楚为什么。

改完界面后必须重启 DSH（client 半按模块 id 加载）。
"""

import glob
import io
import os
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


def run_quiet(script, *args):
    """跟 run 一样，但失败不中止构建——只把输出转发出来。"""
    path = os.path.join(HERE, script)
    if not os.path.isfile(path):
        print(f"  （跳过 {script}：不存在）")
        return 0
    r = subprocess.run([PY, "-X", "utf8", path, *args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    if out:
        for ln in out.splitlines():
            print("  " + ln)
    return r.returncode


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
        os.path.join(plugin, "skills"),          # 插件自带的技能库（整体打包时在这）
        os.path.join(plugin, "..", "skills"),
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
    """草稿根目录。build.py 在 <插件>/tools/ 下，草稿在 <workspace>/drafts/。

    工作区不一定是插件的上一级（DSH_WORKBENCH_HOME 可另行指定），
    统一交给 ws_path 解析，避免装到 profile 里之后指错目录。
    """
    plugin = os.path.dirname(HERE)
    sys.path.insert(0, HERE)
    import ws_path
    return os.path.join(ws_path.resolve_workspace(plugin), "drafts")


def main():
    if "--no-fetch" not in sys.argv:
        run("gen-materials.py")
        # 素材抓完 → 生成选题加工指令（不直接产出选题）。
        # 2026-11-08 改造：选题改由 Agent 按四步流程加工（拆解→定命题→定方向→出选题），
        # 脚本只负责挑素材 + 写加工指令，因为「从素材能提炼什么命题」纯规则做不到。
        # 每日 10 条素材 × 2 个方向不同的选题 = 20 个选题。
        run("topic-pipeline.py", "--date", datetime.now().strftime("%Y-%m-%d"))
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
        print("   · 同步文档里的表清单 / 路由清单 / 状态机 / 数字 / 命令 / 文件结构")
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

    # 事实核查：稿子里的每个具体断言（数字/时间/引语）能否在素材找到。
    # 2026-11-08 加：写 v9 时发现 3 处编造（「六点起的床」「9 点半」「六点半起床」），
    # 而当时的三个检查器（符号/质感/结构）全是形式检查，一个都不查事实出处，
    # 于是编造的稿子一路绿灯。这道闸门补的就是这个洞。
    print("\n=== check_facts ===")
    facts_targets = sorted(glob.glob(os.path.join(workspace_drafts(), "*", "draft.md")))
    if facts_targets:
        rc = run("check-facts.py", *facts_targets)
    else:
        print("  （没有草稿，跳过）")
        rc = 0
    if rc != 0 and "--skip-facts-check" not in sys.argv:
        print("\n❌ 有草稿的具体断言找不到素材出处，构建中止。")
        print("   · 处理：删掉、改成「报道未提及」、或回素材补")
        print("   · 骨架第⑥步要求「每个实词都要能在②指出出处，编造=不合格」")
        print("   · 确认要临时跳过：python tools/build.py --skip-facts-check")
        return 1

    # 结构检查：教程 03 里能机器校验的部分
    # （开头废话 / 结尾总结全文 / 空转过渡句 / 小节字数失衡）。
    # 语义判断（悬念够不够、每段是否只承担一个功能）交给骨架第⑥步的 Agent 自检。
    print("\n=== check_structure ===")
    struct_targets = sorted(glob.glob(os.path.join(workspace_drafts(), "*", "draft.md")))
    if struct_targets:
        rc = run("check-structure.py", *struct_targets)
    else:
        print("  （没有草稿，跳过）")
        rc = 0
    if rc != 0 and "--skip-structure-check" not in sys.argv:
        print("\n❌ 有草稿的结构不合格，构建中止。")
        print("   · 判据见 client.template.js 的 STRUCTURE_RULES（教程 03 结构工程）")
        print("   · 开头 100 字不许有：众所周知 / 近年来 / 随着 / 在当今")
        print("   · 结尾不许总结全文：总之 / 综上 / 所以说")
        print("   · 确认要临时跳过：python tools/build.py --skip-structure-check")
        return 1

    # 内容质感 + 选题对齐：这两项**不进硬闸门**，只报数。
    # 原因：它们查的是「表达倾向」，不是「对错」——
    #   某些题材本来就不适合第一人称，某些选题字段本来就该放弃。
    #   硬卡会让所有稿子写成同一个模子。但每一条都该被看见。
    print("\n=== check_quality（提示，不阻断）===")
    quality_targets = sorted(glob.glob(os.path.join(workspace_drafts(), "*", "draft.md")))
    if quality_targets:
        run_quiet("check-quality.py", *quality_targets)
    else:
        print("  （没有草稿，跳过）")
    print("\n=== check_topic_align（提示，不阻断）===")
    align_targets = sorted(glob.glob(os.path.join(workspace_drafts(), "*", "draft.md")))
    if align_targets:
        run_quiet("check-topic-align.py", *align_targets)
    else:
        print("  （没有草稿，跳过）")

    # 论点一致性：这篇文章有没有在讲同一件事。
    # 2026-11-10 加。立冬那篇脚本全绿但内容发散（10 个话题、3 个论点），
    # 现有检查器一条都没拦住——check-quality 只查形式，check-structure 只查套话。
    print("\n=== check_thesis ===")
    _thesis_dirs = sorted(d for d in glob.glob(os.path.join(workspace_drafts(), "*")) if os.path.isdir(d))
    if not _thesis_dirs:
        print("  （没有草稿，跳过）")
        rc = 0
    else:
        rc = run("check-thesis.py", *_thesis_dirs)
    if rc != 0 and "--skip-thesis-check" not in sys.argv:
        print("\n❌ 有稿子的论点不一致，构建中止。")
        print("   · 判据：主论点落地率、结尾回扣开头、单节占比、每节与主论点的关联度")
        print("   · 修法：找出跑题的那一节删掉或压成一句；结尾改成回扣主论点，不要另起新观点")
        print("   · 确认要临时跳过：python tools/build.py --skip-thesis-check")
        return 1

    # 封面专项：不能是「左图右纯色」的两半拼贴。
    # 2026-11-09 加：v13/v14/v15 三张封面被旧规范误导成一分为二，
    # 而 check-image-layout 只看图位数量，看不出构图问题。
    print("\n=== check_cover ===")
    # check-cover 要的是目录列表，不是 draft.md 文件路径
    _cover_dirs = sorted(d for d in glob.glob(os.path.join(workspace_drafts(), "*")) if os.path.isdir(d))
    if not _cover_dirs:
        print("  （没有草稿，跳过）")
        rc = 0
    else:
        rc = run("check-cover.py", *_cover_dirs)
    if rc != 0 and "--skip-cover-check" not in sys.argv:
        print("\n❌ 有封面的构图不合格，构建中止。")
        print("   · 判据见 配图路线.md 第四章：封面必须整幅画面，不允许纯色留白区")
        print("   · 提示词里不要写「左侧X成…右侧六成纯色」，那是设计稿思路")
        print("   · 确认要临时跳过：python tools/build.py --skip-cover-check")
        return 1

    # 配图位置：图位数量、均匀性、结尾覆盖。
    # 2026-11-07 加：实测四篇全部不合格，最严重的一篇两张图紧贴（间隔 0 字），
    # 后半段连续 1324 字无图。这类问题靠肉眼数不出来，必须做成闸门。
    # 只检查已经有图位的稿子（queued 阶段还没写，不参与）。
    print("\n=== check_image_layout ===")
    layout_targets = sorted(glob.glob(os.path.join(workspace_drafts(), "*", "draft.md")))
    if not layout_targets:
        print("  （没有草稿，跳过配图位置检查）")
        rc = 0
    else:
        rc = run("check-image-layout.py", *layout_targets)
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
