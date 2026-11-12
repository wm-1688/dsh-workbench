#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工作区路径解析：让插件在开发环境和安装环境都能正确找到数据目录。

背景（2026-11-08，打包验证时发现）：
    三个脚本都写死 `WORKSPACE = PLUGIN/..`。这行只在开发环境成立
    （插件放在 <workspace>/dsh-workbench/ 下）。打包发给别人后，
    工作区被算成包的父目录，数据库建到了包外面。

解析顺序：
    1. 环境变量 DSH_WORKBENCH_HOME —— 显式指定，最高优先级
    2. PLUGIN/.. 下有 drafts/ 或 workbench/ —— 开发环境，沿用原行为
    3. 都不满足 —— 安装环境，用 PLUGIN 自己（数据落在插件目录内）

这样：开发环境行为不变；别人装上去零配置能用；想自定义也能用环境变量。
"""
import os


def resolve_workspace(plugin_dir):
    """返回工作区绝对路径。plugin_dir = 插件根目录（tools 的上一级）。"""
    # 1) 环境变量
    env = os.environ.get("DSH_WORKBENCH_HOME", "").strip()
    if env:
        return os.path.abspath(env)

    # 2) 开发环境：上级目录里已经有 drafts/ 或 workbench/
    parent = os.path.abspath(os.path.join(plugin_dir, ".."))
    for marker in ("drafts", "workbench"):
        if os.path.isdir(os.path.join(parent, marker)):
            return parent

    # 3) 安装环境：数据就放在插件目录内
    return os.path.abspath(plugin_dir)


def ensure_workspace(plugin_dir):
    """解析并确保目录存在，返回路径。"""
    ws = resolve_workspace(plugin_dir)
    for sub in ("workbench", "drafts", "image-studio"):
        os.makedirs(os.path.join(ws, sub), exist_ok=True)
    return ws
