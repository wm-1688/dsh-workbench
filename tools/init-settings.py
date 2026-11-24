#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""初始化 settings 表的默认项，并把已有密钥从环境变量/文件迁移进来。

    python tools/init-settings.py           # 建默认项 + 从现有来源导入
    python tools/init-settings.py --check   # 只报状态，不写

为什么要迁移：这些密钥原来散在注册表（REDFOX_API_KEY）和 aws.env
（IMAGE_MODEL_API_KEY / WECHAT_*）里，用户根本不知道在哪。迁进 settings
之后界面上能看能改，但**原有位置保持不变**——脚本仍会先读 settings，
读不到再回退老位置，避免升级后老用户突然跑不动。
"""

import io
import os
import re
import sqlite3
import subprocess
import sys

# winreg 只有 Windows 有。macOS / Linux 上直接 import 会抛 ModuleNotFoundError，
# 整个脚本起不来；降级成 None 后，注册表那一级回退自动跳过，其余来源照常。
try:
    import winreg  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - 非 Windows
    winreg = None

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
DB_PY = os.path.join(HERE, "workbench-db.py")
# 库位置交给 ws_path 解析：装到 profile 里或另设 DSH_WORKBENCH_HOME 时，
# 硬写 PLUGIN/.. 会指到不存在的目录，初始化会建出一个没人读的空库。
sys.path.insert(0, HERE)
import ws_path
WORKSPACE = ws_path.resolve_workspace(PLUGIN)
DB = os.path.join(WORKSPACE, "workbench", "workbench.db")

# 默认配置项。key 用小驼峰，界面直接按 key 读写。
DEFAULTS = [
    # ── 生图工作台（group=image）──
    ("imageModelKey", "secret", "API Key",
     "生图工作台出图用。默认接 GRS AI 聚合站", "image"),
    ("imageChannel", "channel", "生图模型渠道",
     "GRS AI 官方，或 OpenAI 兼容的第三方中转", "image"),
    ("imageBaseUrl", "text", "API 地址",
     "必须含完整端点路径，如 https://grsai.dakka.com.cn/v1/images/generations", "image"),
    ("imageModel", "text", "图片模型",
     "如 gpt-image-2.6；换了模型名这里也要跟着改", "image"),
    ("imageConcurrency", "number", "批量出图并发数",
     "漫画流多镜同时出图的路数，默认 3。越高越快，但撞接口限流（429）的概率也越高；建议 2–4，上限 8", "image"),
    ("imageRetries", "number", "出图失败重试次数",
     "含首次，默认 3（首发 + 2 次重试）。只重试限流/服务端抖动/网络中断，提示词违规这类不重试", "image"),
    ("textModel", "channel", "文本模型通道",
     "只支持 OpenAI 兼容服务。填下面三项：接口地址、模型名称、API Key", "image"),
    ("textModelBaseUrl", "text", "API 地址",
     "只在「OpenAI 兼容」通道下生效。填完整端点（含 /v1/chat/completions），或只填域名", "image"),
    ("textModelModel", "text", "模型名称",
     "只在「OpenAI 兼容」通道下生效。填模型 id，如 gpt-4o-mini / gemini-2.5-flash", "image"),
    ("textModelKey", "secret", "API Key",
     "只在「OpenAI 兼容」通道下生效。任意 OpenAI 兼容服务都可以", "image"),

    # ── 公众号工作台（group=gzh）──
    ("redfoxKey", "secret", "Redfox API Key",
     "抓热榜、爆文库、违禁词都要它。红狐后台获取", "gzh"),

    # 投递目标会话。
    # 为什么需要它：工作台给 Agent 下指令时，默认投给「最近活跃的会话」，
    # 而那个范围是整个 DSH 的 —— 用户同时开着别的会话就会投错。
    # 这一项把目标钉死在一个具体会话上，配了就用配的，没配才用最近活跃。
    # kind=session：选项由界面实时从 session.list 拉，不写死在库里
    # （会话随时会增删改名，存静态选项必然过期）。
    ("targetSessionId", "session", "关联会话",
     "工作台的选题、写作、配图、发布指令都投给这个会话。留空=用最近活跃的会话", "gzh"),

    # ── 微信公众号多槽位（group=gzh）──
    ("wechatAccounts", "number", "启用的微信账号数",
     "1 或 2。发布脚本按这个数决定读几个槽位", "gzh"),
    ("wechatPublishSlot", "number", "发布用第几个号",
     "1 = 用第 1 个账号发布", "gzh"),
    ("wechat1Name", "text", "账号 1 名称", "显示用", "gzh"),
    ("wechat1AppId", "text", "账号 1 AppID", "公众号后台 → 开发 → 基本配置", "gzh"),
    ("wechat1AppSecret", "secret", "账号 1 AppSecret", "注意 IP 白名单", "gzh"),
    ("wechat2Name", "text", "账号 2 名称", "显示用，不用可留空", "gzh"),
    ("wechat2AppId", "text", "账号 2 AppID", "不用可留空", "gzh"),
    ("wechat2AppSecret", "secret", "账号 2 AppSecret", "不用可留空", "gzh"),

    # ── 账号级自动创作订阅（group=gzh，2026-11-18 加）──
    #
    # 为什么赛道要挂在**账号**上，而不是只用全局的 topicTracks：
    #   topicTracks 是「采集范围」——决定从热榜里捞哪些素材；
    #   账号订阅是「写作范围」——决定这个号每天写哪几篇。
    #   两个号定位不同（一个写 AI，一个写民生），共用一个全局赛道就分不开了。
    #
    # 每天跑的逻辑：账号 N 订阅了哪些赛道 → 每个赛道各挑 1 篇最值得写的 → 各出一篇稿。
    ("wechat1Tracks", "tracks", "账号 1 订阅赛道",
     "这个号每天写哪些赛道，每个赛道出 1 篇。留空=不参与自动创作", "gzh"),
    ("wechat1AutoWrite", "bool", "账号 1 参与每日自动创作",
     "勾上=每天 7:15 自动选题并写稿（写到配图完成，不自动群发）", "gzh"),
    ("wechat2Tracks", "tracks", "账号 2 订阅赛道",
     "同上。留空=不参与", "gzh"),
    ("wechat2AutoWrite", "bool", "账号 2 参与每日自动创作",
     "同上", "gzh"),

    # 账号 3-5（2026-11-18 补）。
    # 一开始只给 1、2 加了订阅项，3-5 漏了 —— 结果界面上账号 3 之后就没有订阅选项。
    # 前端 WECHAT_MAX=5，五个槽位都能填凭据，订阅项也必须五个都有，
    # 否则「能配账号、不能订赛道」是个说不通的半成品。
    ("wechat3Tracks", "tracks", "账号 3 订阅赛道", "同上。留空=不参与", "gzh"),
    ("wechat3AutoWrite", "bool", "账号 3 参与每日自动创作", "同上", "gzh"),
    ("wechat4Tracks", "tracks", "账号 4 订阅赛道", "同上。留空=不参与", "gzh"),
    ("wechat4AutoWrite", "bool", "账号 4 参与每日自动创作", "同上", "gzh"),
    ("wechat5Tracks", "tracks", "账号 5 订阅赛道", "同上。留空=不参与", "gzh"),
    ("wechat5AutoWrite", "bool", "账号 5 参与每日自动创作", "同上", "gzh"),

    # ── 行为开关（group=gzh）──
    # 2026-11-16：默认改成关。用户要的是「一次做完」，骨架自己定，不要中途停。
    ("confirmSkeleton", "bool", "骨架要人工确认",
     "勾上=写好骨架停下等你确认；不勾（默认）=骨架自己定，一路写到图位插好为止", "gzh"),
    ("materialKeepDays", "number", "热榜保留天数",
     "3 / 7 / 14 天，默认 7", "gzh"),

    # ── 选题自动生成（group=gzh，2026-11-18 加）──
    #
    # 为什么要做成设置项而不是留在热榜页的复选框：
    # 它现在决定的是「每次采集之后要不要花几分钟跑 Agent」，
    # 属于长期偏好，放设置页才找得到；热榜页那个复选框跟着页面走，换台机器就丢了
    # （它存的是 localStorage，不是库）。
    #
    # autoTopicEnabled：采集完自动跑一次选题。
    ("autoTopicEnabled", "bool", "采集后自动生成选题",
     "勾上=每次采集完自动挑素材并投递给 Agent 生成选题；"
     "不勾（默认）=只更新素材，选题等你在「选题库」手动点", "gzh"),

    # topicTracks：订阅赛道（多选，顿号分隔）。
    # **只在这些赛道里挑素材** —— 素材本身没有赛道字段，按标题关键词归类，
    # 词表复用 gen-topics.py 的 TRACKS。留空 = 不筛，全部赛道都看。
    ("topicTracks", "tracks", "订阅赛道",
     "只在这些赛道里挑最值得写的素材。留空=不筛。多选，按「、」分隔", "gzh"),

    # autoTopicCount：每次自动生成挑几条素材。
    # 默认 1：只看最值得写的那一条（各出 2 个方向），快且省。
    ("autoTopicCount", "number", "自动生成取几条素材",
     "默认 1（只挑最值得写的一条，出 2 个选题）。调大会多出选题但更慢", "gzh"),

    # ── 每日自动创作流水线（group=gzh，2026-11-18 加）──
    #
    # 整条链：7:15 定时 → 采集热榜 → 生成选题 → 按账号赛道选最优
    #        → 写稿 → 审稿 → 排版 → **停在「已排版」**
    #
    # 2026-11-18 改：**不做配图**。用户要求「我检查没问题再手工配图」。
    # 理由很实在：配图烧生图额度，而且图合不合适得看过正文才知道，
    # 自动配出来的图大概率要重做，不如留给人判断。
    #
    # 为什么也不入草稿箱：群发不可撤销，而且公众号一天只能群发一次。
    # 早上起来看一眼，确认后手动发，这是运营的实际习惯。
    ("autoWriteEnabled", "bool", "每日自动创作",
     "勾上=每天 7:15 自动跑（选题→写稿→排版），停在「已排版」等你检查配图。"
     "不勾（默认）=完全手动", "gzh"),
    ("autoWriteTime", "text", "自动创作时间",
     "格式 HH:MM，默认 07:15。改完要点「重新排程」才生效", "gzh"),
    # 配图上限那一项已删（2026-11-18）。
    # 用户决定：自动流程**不做配图**，稿子停在「已排版」，检查没问题后手工配。
    # 留着会误导 —— 界面上有个「每天最多配图篇数」，但流程根本不会配图。
]


def read_env_file(p):
    """读 aws.env 这种 KEY=VALUE 文件。"""
    out = {}
    if not os.path.isfile(p):
        return out
    for ln in io.open(p, encoding="utf-8", errors="ignore"):
        ln = ln.strip()
        if not ln or ln.startswith("#") or "=" not in ln:
            continue
        k, v = ln.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def reg_key(name):
    if winreg is None:      # 非 Windows：没有注册表这一级
        return ""
    for root, path in [
        (winreg.HKEY_CURRENT_USER, "Environment"),
        (winreg.HKEY_LOCAL_MACHINE,
         r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
    ]:
        try:
            with winreg.OpenKey(root, path) as h:
                v = (winreg.QueryValueEx(h, name)[0] or "").strip()
                if v:
                    return v
        except OSError:
            continue
    return ""


def main():
    check_only = "--check" in sys.argv
    if not os.path.isfile(DB):
        print(f"  ❌ 数据库不存在：{DB}")
        print("     先跑 python tools/workbench-db.py init")
        return 1

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    now = "2026-11-13 00:00:00"

    # ① 建默认项（已存在的不覆盖值）
    added, kept, tagged = 0, 0, 0
    for k, kind, label, hint, grp in DEFAULTS:
        row = conn.execute("SELECT key, group_key FROM settings WHERE key=?", (k,)).fetchone()
        if row:
            kept += 1
            # 老库里这些项已经在，但没归属 —— 补上，否则生图台设置页看不到它们
            if not check_only and not row["group_key"]:
                conn.execute("UPDATE settings SET group_key=? WHERE key=?", (grp, k))
                tagged += 1
            continue
        if not check_only:
            conn.execute(
                "INSERT INTO settings(key, value, kind, label, hint, group_key, updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (k, "", kind, label, hint, grp, now))
        added += 1
    if not check_only:
        conn.commit()
    print(f"  配置项：新增 {added} 个，已存在 {kept} 个，补归属 {tagged} 个（共 {len(DEFAULTS)}）")

    # ② 迁已有密钥（只填空值，不覆盖用户在界面上改过的）
    env = read_env_file(os.path.join(WORKSPACE, "aws.env"))
    MIGRATE = {
        "redfoxKey": reg_key("REDFOX_API_KEY") or env.get("REDFOX_API_KEY", ""),
        "imageModelKey": env.get("IMAGE_MODEL_API_KEY", ""),
        "wechat1AppId": env.get("WECHAT_1_APPID", ""),
        "wechat1AppSecret": env.get("WECHAT_1_APPSECRET", ""),
        "wechat2AppId": env.get("WECHAT_2_APPID", ""),
        "wechat2AppSecret": env.get("WECHAT_2_APPSECRET", ""),
    }
    filled = 0
    for k, v in MIGRATE.items():
        if not v:
            continue
        row = conn.execute("SELECT value FROM settings WHERE key=?", (k,)).fetchone()
        if row and (row["value"] or "").strip():
            print(f"    · {k}：已有值，跳过（不覆盖）")
            continue
        if not check_only:
            conn.execute("UPDATE settings SET value=?, updated_at=? WHERE key=?", (v, now, k))
        filled += 1
        print(f"    ✅ {k}：已从原有位置导入（{v[:6]}…）")

    # ③ 从 config.yaml 补 wechat 槽位信息
    cfg_path = os.path.join(WORKSPACE, ".aws-article", "config.yaml")
    if os.path.isfile(cfg_path):
        txt = io.open(cfg_path, encoding="utf-8", errors="ignore").read()
        import re as _re
        m = _re.search(r"^wechat_accounts:\s*(\d+)", txt, _re.M)
        if m and not check_only:
            conn.execute("UPDATE settings SET value=?, updated_at=? WHERE key=?",
                         (m.group(1), now, "wechatAccounts"))
            print(f"    ✅ wechatAccounts：config.yaml 里是 {m.group(1)}")
        for i in (1, 2):
            mm = _re.search(rf"^wechat_{i}_name:\s*\"?([^\"\n#]*)", txt, _re.M)
            if mm and mm.group(1).strip() and not check_only:
                conn.execute("UPDATE settings SET value=?, updated_at=? WHERE key=?",
                             (mm.group(1).strip(), now, f"wechat{i}Name"))
                print(f"    ✅ wechat{i}Name：{mm.group(1).strip()}")

    if not check_only:
        conn.commit()

    # ③ 纠正陈旧的通道值与文案
    #
    # 两个坑，都是「库里存着旧东西、界面看不出来」：
    #
    # 1) textModel 存着 'dsh'。2026-11-16 移除了 DSH 通道，下拉只剩「OpenAI 兼容」。
    #    但 <select value="dsh"> 找不到匹配项时会显示第一项，
    #    用户看到的是「OpenAI 兼容」，以为已经选好了 —— 实际值还是 dsh。
    #    结果：visibleIf 判定不通过，下面三项被藏起来；下拉只有一项，切不动。
    #    这里直接把旧值归到 openai，配置项本来就在，归位后老用户不用重填。
    #
    # 2) label/hint 是建表时写死的，①里「已存在就跳过」不会更新它们。
    #    于是老库还显示「文本模型通道 / 模型渠道」这类旧文案，和新代码对不上。
    #    这里按 DEFAULTS 重新同步一遍文案（**只改文案，不碰值**）。
    stale_fixed = 0
    if not check_only:
        row = conn.execute("SELECT value FROM settings WHERE key='textModel'").fetchone()
        if row and (row["value"] or "").strip().lower() == "dsh":
            conn.execute("UPDATE settings SET value='openai', updated_at=? WHERE key='textModel'",
                         (now,))
            stale_fixed += 1
            print("    ✅ textModel：旧值 dsh → openai（DSH 通道已移除）")
        for k, kind, label, hint, grp in DEFAULTS:
            r = conn.execute("SELECT label, hint FROM settings WHERE key=?", (k,)).fetchone()
            if not r:
                continue
            if (r["label"] or "") != label or (r["hint"] or "") != hint:
                conn.execute("UPDATE settings SET label=?, hint=? WHERE key=?", (label, hint, k))
                stale_fixed += 1
        if stale_fixed:
            conn.commit()
            print(f"    ✅ 文案同步 {stale_fixed} 处")

    # ③ 报告
    print()
    print("  === 当前状态 ===")
    for r in conn.execute("SELECT key, value, kind, label FROM settings ORDER BY key"):
        v = r["value"] or ""
        mark = "✅" if v else "— "
        shown = (v[:6] + "…") if r["kind"] == "secret" and v else (v[:20] if v else "未配置")
        print(f"    {mark} {r['label']:<24} {shown}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
