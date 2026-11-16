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
    ("textModel", "channel", "模型渠道",
     "默认走 DSH 主对话的模型；选 OpenAI 兼容则用下面三项配外部服务", "image"),
    ("textModelBaseUrl", "text", "API 地址",
     "只在「OpenAI 兼容」通道下生效。填完整端点（含 /v1/chat/completions），或只填域名", "image"),
    ("textModelModel", "text", "模型名称",
     "只在「OpenAI 兼容」通道下生效。填模型 id，如 gpt-4o-mini / gemini-2.5-flash", "image"),
    ("textModelKey", "secret", "API Key",
     "只在「OpenAI 兼容」通道下生效。任意 OpenAI 兼容服务都可以", "image"),

    # ── 公众号工作台（group=gzh）──
    ("redfoxKey", "secret", "Redfox API Key",
     "抓热榜、爆文库、违禁词都要它。红狐后台获取", "gzh"),

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

    # ── 行为开关（group=gzh）──
    # 2026-11-16：默认改成关。用户要的是「一次做完」，骨架自己定，不要中途停。
    ("confirmSkeleton", "bool", "骨架要人工确认",
     "勾上=写好骨架停下等你确认；不勾（默认）=骨架自己定，一路写到图位插好为止", "gzh"),
    ("materialKeepDays", "number", "热榜保留天数",
     "3 / 7 / 14 天，默认 7", "gzh"),
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
