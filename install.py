#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键安装 dsh-workbench。全部自动化，用户只需运行一次。

    python install.py            # 自动完成所有步骤
    python install.py --check    # 只检查环境，不改任何东西
    python install.py --no-net   # 不联网（跳过技能补下载）

会自动做的事：
    1. 检查 Python 版本与必需目录
    2. 初始化数据库（9 张业务表）
    3. 生成 client.js（界面代码）
    4. 安装依赖技能（包内自带，复制即可）
    5. 检查 DSH 插件挂载情况，给出精确的下一步指令
    6. 生成一份安装报告 install-report.md

**默认不需要联网**。技能随包分发，装到 $DSH_HOME/skills/。若包内缺某个技能
（精简包或手工删过），会自动按 skills-manifest.json 从上游补下载；断网也不
影响安装完成，只是对应功能会提示缺技能。素材抓取、配图这些需要凭证的，
仍等用户自己按需触发。
"""
import io
import os
import platform
import shutil
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(HERE, "tools")
PY = sys.executable


def say(msg):
    print("  " + msg)


def step(n, title):
    print()
    print(f"[{n}] {title}")
    print("-" * 56)


def run(script, *args, fatal=True):
    """跑 tools 下的脚本，返回 (ok, output)。"""
    path = os.path.join(TOOLS, script)
    if not os.path.isfile(path):
        return False, f"找不到 {script}"
    try:
        r = subprocess.run([PY, "-X", "utf8", path, *args],
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace", cwd=HERE)
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
    out = (r.stdout or "") + (r.stderr or "")
    return r.returncode == 0, out


def main():
    check_only = "--check" in sys.argv
    no_net = "--no-net" in sys.argv or "--offline" in sys.argv
    report = []

    print()
    print("  ╔══════════════════════════════════════════════════╗")
    print("  ║   dsh-workbench · 创作工作台  一键安装           ║")
    print("  ╚══════════════════════════════════════════════════╝")
    print(f"  安装目录: {HERE}")
    print(f"  时间:     {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # ── 1. 环境检查 ──
    step(1, "环境检查")
    ok_env = True
    pyv = sys.version_info
    say(f"Python {pyv.major}.{pyv.minor}.{pyv.micro}")
    if pyv < (3, 9):
        say("❌ 需要 Python 3.9 或更高")
        ok_env = False
    else:
        say("✅ Python 版本满足")

    for d in ("lib", "tools"):
        p = os.path.join(HERE, d)
        if os.path.isdir(p):
            say(f"✅ {d}/")
        else:
            say(f"❌ 缺少 {d}/ —— 安装包不完整")
            ok_env = False

    # 检查 ws_path 存在（工作区解析依赖它）
    if os.path.isfile(os.path.join(TOOLS, "ws_path.py")):
        say("✅ 工作区解析模块")
    else:
        say("❌ 缺少 tools/ws_path.py")
        ok_env = False

    if not ok_env:
        say("")
        say("环境检查未通过，安装中止。")
        return 1

    if check_only:
        say("")
        say("（--check 模式，不做任何改动）")
        return 0

    # ── 2. 初始化数据库 ──
    step(2, "初始化数据库")
    ok1, out1 = run("image-db.py", "init")
    ok2, out2 = run("workbench-db.py", "init")
    if ok1 and ok2:
        # 数一下表
        import sqlite3
        sys.path.insert(0, TOOLS)
        try:
            import ws_path
            ws = ws_path.ensure_workspace(HERE)
            dbp = os.path.join(ws, "workbench", "workbench.db")
            conn = sqlite3.connect(dbp)
            tables = sorted(r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%'"))
            conn.close()
            say(f"✅ 数据库就绪（{len(tables)} 张表）")
            say(f"   {dbp}")
            report.append(f"数据库：{len(tables)} 张表 → {dbp}")
        except Exception as e:
            say(f"⚠️ 数据库已建但统计失败：{e}")
    else:
        say("❌ 数据库初始化失败")
        say(out1[-400:] or out2[-400:])
        return 1

    # ── 3. 生成界面代码 ──
    step(3, "生成界面代码 client.js")
    client = os.path.join(HERE, "lib", "client.js")
    if os.path.isfile(client):
        say(f"✅ 已存在（{os.path.getsize(client)//1024}KB），重新生成")
    # 先导出数据快照（界面靠它显示内容），再生成 client.js
    okexp, outexp = run("workbench-db.py", "export")
    snap = os.path.join(HERE, "lib", "db.snapshot.json")
    if okexp and os.path.isfile(snap):
        say(f"✅ 数据快照（{os.path.getsize(snap)//1024}KB）")
    else:
        say("⚠️ 数据快照生成失败，界面可能显示为空")
        say(outexp[-300:])

    ok3, out3 = run("gen-catalog.py")
    if ok3 and os.path.isfile(client):
        say(f"✅ 生成成功（{os.path.getsize(client)//1024}KB）")
        report.append(f"界面代码：{os.path.getsize(client)//1024}KB")
        if os.path.isfile(snap):
            report.append(f"数据快照：{os.path.getsize(snap)//1024}KB")
    else:
        say("❌ 生成失败")
        say(out3[-600:])
        return 1

    # ── 4. 安装依赖技能 ──
    step(4, "安装依赖技能")
    # 插件硬引用 9 个技能。不装的话界面能开，但写稿/检查/配图全报错。
    # 统一装到 $DSH_HOME/skills/ —— gen-catalog.py 和 lib/index.js 都优先找这里，
    # 不依赖 PLUGIN/..（那个在安装环境是错的）。
    #
    # 完整包自带 skills/，直接复制即可，不需要联网。
    # 万一包内缺了某个技能（精简包 / 手工删过），再按 skills-manifest.json
    # 从上游补下载——属于兜底，不是主路径。
    # 两种来源都是「已存在就跳过」，绝不覆盖用户改过的技能。
    dsh_home = os.environ.get("DSH_HOME", "").strip() or os.path.join(
        os.path.expanduser("~"), ".dsh")
    skills_dst = os.path.join(dsh_home, "skills")
    os.makedirs(skills_dst, exist_ok=True)
    say(f"目标目录: {skills_dst}")

    copied, skipped = 0, 0
    skills_src = os.path.join(HERE, "skills")
    if os.path.isdir(skills_src):
        names = sorted(d for d in os.listdir(skills_src)
                       if os.path.isdir(os.path.join(skills_src, d)))
        for n in names:
            src = os.path.join(skills_src, n)
            dst = os.path.join(skills_dst, n)
            if os.path.isdir(dst):
                # 已存在就不覆盖——用户可能改过，或版本更新过
                skipped += 1
                continue
            try:
                shutil.copytree(src, dst)
                copied += 1
            except Exception as e:
                say(f"⚠️ {n} 复制失败: {type(e).__name__}")
        say(f"✅ 包内技能 {copied} 个" + (f"，跳过已存在 {skipped} 个" if skipped else ""))
        report.append(f"技能：包内新装 {copied} 个，跳过已存在 {skipped} 个")
    else:
        say("· 包内无 skills/，改从上游下载")

    # 兜底：包内缺的技能从上游补下载。下载器自己处理断网/失败，不会让安装中断。
    if no_net:
        say("· --no-net：跳过上游补下载")
    elif os.path.isfile(os.path.join(TOOLS, "fetch-skills.py")):
        ok_dl, out_dl = run("fetch-skills.py")
        tail = [l for l in out_dl.splitlines() if l.strip()][-4:]
        for l in tail:
            say(l.strip())
        if not ok_dl:
            say("   ⚠️ 有技能没下下来，稍后可重试：")
            say(f"   {PY} {os.path.join(TOOLS, 'fetch-skills.py')}")
    else:
        say("· 无 tools/fetch-skills.py，跳过补下载")

    # 检查必需技能是否齐
    REQUIRED = ["aws-wechat-article-writing", "khazix-writer", "lieflat-less-ai-tone"]
    lack = [r for r in REQUIRED if not os.path.isdir(os.path.join(skills_dst, r))]
    if lack:
        say(f"⚠️ 缺少必需技能: {lack}")
        say("   插件能启动，但写稿/检查会失败")
        report.append(f"技能：⚠️ 缺必需技能 {lack}")

    # ── 5. 检查 DSH 挂载 ──
    step(5, "检查 DSH 挂载")
    # 插件靠 package.json + cordis.patch.yml 被 DSH 识别
    pj = os.path.join(HERE, "package.json")
    cp = os.path.join(HERE, "cordis.patch.yml")
    mount_ok = True
    if os.path.isfile(pj):
        say("✅ package.json")
    else:
        say("❌ 缺少 package.json")
        mount_ok = False
    if os.path.isfile(cp):
        say("✅ cordis.patch.yml")
    else:
        say("❌ 缺少 cordis.patch.yml")
        mount_ok = False

    if mount_ok:
        say("")
        say("这个插件需要 DSH 加载才生效。两种方式：")
        say("")
        say("  A) 本地链接（开发用，推荐）")
        say("     把本目录放进 DSH profile 的 node_modules，或用 pnpm link")
        say("")
        say("  B) 让 AI 帮你装")
        say("     把这句话发给 AI：")
        say('     「安装 dsh-workbench 插件，目录是 ' + HERE + '，')
        say('       它靠 cordis.patch.yml 注册，装完重启 DSH」')

    # ── 6. 生成报告 ──
    step(6, "生成安装报告")
    rep = os.path.join(HERE, "install-report.md")
    lines = [
        "# 安装报告",
        "",
        f"- 时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 目录：`{HERE}`",
        f"- Python：{pyv.major}.{pyv.minor}.{pyv.micro}",
        f"- 系统：{platform.system()} {platform.release()}",
        "",
        "## 已完成",
        "",
    ] + [f"- {x}" for x in report] + [
        "",
        "## 依赖技能",
        "",
        f"- 安装位置：`{os.path.join(os.environ.get('DSH_HOME', '').strip() or os.path.join(os.path.expanduser('~'), '.dsh'), 'skills')}`",
        "- 50 个技能随包分发，安装时复制到上述目录",
        "- 这些技能**不是本项目原创**，版权归各自作者，按各自许可证使用；",
        "  本项目只是集成引用，未做二次开发",
        "- 若你的 DSH 已有同名技能，安装器会跳过不覆盖",
        "- 上游来源与许可证见 `SKILLS-CREDITS.md`",
        "",
        "包内缺技能时可从上游补下载：",
        "",
        "```bash",
        "python tools/fetch-skills.py --list     # 看清单",
        "python tools/fetch-skills.py            # 下载缺的",
        "python tools/fetch-skills.py --only aihot",
        "```",
        "",
        "## 下一步",
        "",
        "1. **让 DSH 加载插件**（见上面第 4 步的说明）",
        "2. 重启 DSH，侧边栏会出现「创作工作台」",
        "3. 首次使用前，可选：抓一次热榜素材",
        "",
        "```bash",
        "python tools/gen-materials.py   # 抓 7 平台热榜（需要网络）",
        "python tools/gen-topics.py      # 从素材生成选题",
        "```",
        "",
        "## 可选配置",
        "",
        "需要图片生成？在环境变量或 `aws.env` 里配：",
        "",
        "```",
        "IMAGE_MODEL_API_KEY=你的key",
        "```",
        "",
        "数据默认放在插件目录内。想换位置就设环境变量：",
        "",
        "```",
        "DSH_WORKBENCH_HOME=D:\\my-workbench",
        "```",
        "",
    ]
    io.open(rep, "w", encoding="utf-8").write("\n".join(lines))
    say(f"✅ 已写入 {os.path.basename(rep)}")

    # ── 完成 ──
    print()
    print("  ══════════════════════════════════════════════════")
    print("   ✅ 安装完成")
    print("  ══════════════════════════════════════════════════")
    print()
    print("   最后一步：让 DSH 加载这个插件，然后重启 DSH。")
    print("   不确定怎么装？把上面第 4 步那段话发给 AI 就行。")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
