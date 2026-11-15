#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一配置读取层。**所有脚本取配置都应该走这里**，不要自己去读 aws.env 或注册表。

    from appconfig import get, get_secret, all_settings

    key = get_secret("redfoxKey")        # settings 表 → 环境变量 → aws.env → 注册表
    days = get("materialKeepDays", 7)

为什么要这一层（2026-11-13）：
    在此之前配置散在三处——注册表（REDFOX_API_KEY）、aws.env、config.yaml，
    界面上看不到也改不了。加了 settings 表之后如果各脚本还去读老位置，
    就会出现「界面改了不生效」，比没有设置页更糟。

    所以定一条规矩：**设置表是唯一真源**。老位置只作为兜底——
    表里没值时才回退，保证老用户升级后不会突然跑不动。

取值顺序：
    settings 表  →  环境变量  →  aws.env  →  Windows 注册表

为什么这个顺序：表是用户在界面上改的，优先级最高；
环境变量适合临时覆盖（CI、调试）；文件和注册表是最初的来源，垫底。
"""

import io
import os
import sqlite3

# winreg 只有 Windows 有。macOS / Linux 上直接 import 会抛 ModuleNotFoundError，
# 整个脚本起不来；降级成 None 后，注册表那一级回退自动跳过，其余来源照常。
try:
    import winreg  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - 非 Windows
    winreg = None

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
WORKSPACE = os.path.dirname(PLUGIN)
DB = os.path.join(WORKSPACE, "workbench", "workbench.db")
ENV_FILE = os.path.join(WORKSPACE, "aws.env")

# settings 表的 key → 老位置的环境变量名（兜底用）
LEGACY_ENV = {
    "redfoxKey": "REDFOX_API_KEY",
    "imageModelKey": "IMAGE_MODEL_API_KEY",
    "wechat1AppId": "WECHAT_1_APPID",
    "wechat1AppSecret": "WECHAT_1_APPSECRET",
    "wechat2AppId": "WECHAT_2_APPID",
    "wechat2AppSecret": "WECHAT_2_APPSECRET",
}

_cache = {}


def _db_rows():
    """一次读出整张 settings 表。连不上库时返回空 dict，不抛错。"""
    if "rows" in _cache:
        return _cache["rows"]
    rows = {}
    if os.path.isfile(DB):
        try:
            conn = sqlite3.connect(DB)
            conn.row_factory = sqlite3.Row
            for r in conn.execute("SELECT key, value FROM settings"):
                rows[r["key"]] = r["value"]
            conn.close()
        except Exception:
            pass
    _cache["rows"] = rows
    return rows


def _env_file():
    if "envf" in _cache:
        return _cache["envf"]
    out = {}
    if os.path.isfile(ENV_FILE):
        try:
            for ln in io.open(ENV_FILE, encoding="utf-8", errors="replace"):
                ln = ln.strip()
                if not ln or ln.startswith("#") or "=" not in ln:
                    continue
                k, v = ln.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
        except Exception:
            pass
    _cache["envf"] = out
    return out


def _registry(name):
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


def get_secret(key):
    """按优先级取一个值。表 → 环境变量 → aws.env → 注册表。"""
    v = (_db_rows().get(key) or "").strip()
    if v:
        return v
    legacy = LEGACY_ENV.get(key)
    if legacy:
        v = (os.environ.get(legacy) or "").strip()
        if v:
            return v
        v = (_env_file().get(legacy) or "").strip()
        if v:
            return v
        v = _registry(legacy)
        if v:
            return v
    return ""


def get(key, default=""):
    """取非密钥配置。表里没有就用 default。"""
    v = _db_rows().get(key)
    if v is None or str(v).strip() == "":
        return default
    return v


def get_int(key, default=0):
    try:
        return int(str(get(key, default)).strip())
    except (TypeError, ValueError):
        return default


def get_bool(key, default=False):
    v = str(get(key, "1" if default else "0")).strip().lower()
    return v in ("1", "true", "yes", "on", "是")


def all_settings():
    """整表返回，调试用。"""
    return dict(_db_rows())


def reload():
    """清缓存。同一进程内改了配置后要调这个。"""
    _cache.clear()
