#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生图工作台 · 生成执行器

【这是留给后续功能设计的接缝】
把「提示词怎么组」「参考图怎么垫」「出几张」集中在 build_prompt() 与 run_job() 两个函数里，
界面与路由不用改，只改这里就能换策略。

接口形状是实测确定的（2026-10-06 预研，11/11 成功）：
    POST {host}/v1/api/generate   {"model","prompt","images":[裸base64],"aspectRatio","quality","replyType":"async"}
    GET  {host}/v1/api/result?id=<task_id>   → status: running/… → succeeded → results[].url
    参考图放在 images 数组里（不是 multipart，也不是 data: 前缀）——实测形状。

子命令：
    catalog                         输出归一化后的风格/图型/色卡索引（界面用）
    preview --theme "..." [--style FA-018] [--color C-01] [--layout SC-001] [--with-ref 1]
                                    只组提示词，不调 API、不写库
    run --job <id>                  按库里的任务执行一次生成，结果写回数据层
"""

import argparse
import base64
import io
import json
import os
import random
import re
import sqlite3
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib import util as importlib_util

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
import ws_path as _ws
# 工作区解析：开发环境用 PLUGIN/..，安装环境用 PLUGIN 自己。
# 详见 ws_path.py 顶部说明（2026-11-08 打包验证时修）。
WORKSPACE = _ws.ensure_workspace(PLUGIN)
DATA_DIR = os.path.join(WORKSPACE, "workbench")
DB_PATH = os.path.join(DATA_DIR, "workbench.db")
DB_SCRIPT = os.path.join(HERE, "image-db.py")
OUT_ROOT = os.path.join(WORKSPACE, "image-studio")
# 插图回写要复用 finalize.py 的占位符替换 + 重排版 —— 那套逻辑已经有校验，
# 在这里重写一遍必然和它漂移（它还会改引号、剥引用、查图数）。
FINALIZE_SCRIPT = os.path.join(HERE, "finalize.py")

DEFAULT_HOST = "https://grsai.dakka.com.cn"
DEFAULT_MODEL = "gpt-image-2.5"
HTTP_TIMEOUT = 120
POLL_TIMEOUT = 420
POLL_INTERVAL = 3.0

REF_ISOLATION = (
    "所附图片仅用于参考画风。只提取参考图的风格特征，例如线条、笔触、媒介、材质、色彩倾向和整体视觉语言；"
    "不要使用、复制或延续参考图中的任何主体、人物、动物、服装、道具、动作、姿态、场景、背景、构图、布局、"
    "文字或故事。最终画面内容完全以用户提供的主题为准。"
)

NEG = ("避免", "不要", "不准", "禁止")

# 图型的固定「图文后缀」。**必须逐字追加**（技能规范：不得翻译、裁剪、规范化、改写、标注或重排任何一个字），
# 所以这里是从 SKILL.md 里原样提取的，改这个常量等于改图型的实际行为。
# 例外：电商图型 EC-* 不追加（见 is_ecommerce）。
GRAPHIC_TEXT_SUFFIX = (
    "【如果主题直白包含画面元素那就按主题出图，文案由你来升华，但是不要直接描述画面。"
    " 如果主题比较概念化，那么文案和主题尽量保持一致，如果文案较长由你提炼，"
    "由你先设计画面隐喻（人类和非人类都行）再出图   。    文字参与构图，图文一体】"
)

# 资产库垫图（角色/道具/场景基准图）的约束。
# **注意它与上面「参考图使用约束」的语义正好相反**：
#   画风垫图 → 只要风格，严禁带走主体；
#   资产垫图 → 就要主体，外形/比例/配色都要保持一致。
# 两者混成一句话会让模型同时被要求「抄」和「别抄」，所以必须分开写。
ASSET_REF = (
    "所附资产参考图用于保持主体形象一致：沿用它的外形、比例、配色与关键特征，"
    "不要改变它的造型。画风仍以本提示词的风格要求为准。"
)
ASSET_REF_EN = (
    "Use the attached asset image to keep the subject consistent: follow its shape, "
    "proportions, palette and key features; do not redesign it. "
    "The rendering style still follows the style requirements in this prompt."
)

# 参考图隔离块的英文版（中文版是上面 SKILL.md 原文；英文版同样来自 SKILL.md）
REF_ISOLATION_EN = (
    "Use the attached image only as a style reference. Extract only its stylistic qualities, "
    "such as linework, brushwork, medium, material texture, color tendencies, and overall "
    "visual language. Do not use, copy, or carry over any subject, person, animal, clothing, "
    "prop, action, pose, setting, background, composition, layout, text, or story from the "
    "reference image. The user's written theme is the sole source for the image content."
)

# 改图（垫照片转手绘）固定指令，逐字取自技能的 prompt_style.py。
# 用途：防止模型在写实照片表面机械叠滤镜，强制在手绘维度从零重画。
REDRAW_ZH = ("【请只提取人物的五官特征和姿态，场景轮廓，在画风上严格按 选择的风格重新画，"
             "不要在原照片上加质感。】")
REDRAW_EN = ("[Extract only the character's facial features and posture, and the scene contours. "
             "Strictly redraw from scratch according to the selected style; do not add texture "
             "or filters onto the original photo.]")


# ── 安装位置 ─────────────────────────────────────────────────────────

def skill_root():
    """handraw-style 的安装目录。允许用环境变量覆盖（更新/换机时路径会变，不要写死）。"""
    env = os.environ.get("DSH_WORKBENCH_SKILL_ROOT")
    if env and os.path.isdir(env):
        return env
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "skills", "handraw-style")


def prompter_root():
    return os.path.join(skill_root(), "skills", "handdraw-style-prompter")


def read_json(path, default):
    try:
        with io.open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


# ── 索引归一化（界面与生成共用同一份路径解析） ───────────────────────

def _rel_from_gallery(img):
    """图型/色卡 JSON 里的 image 是相对 gallery/ 的（../../../images/…），
    归一成相对技能根目录的路径。"""
    return re.sub(r"^(\.\./)+", "", img or "")


def norm_custom_styles():
    """自建风格（CS-xxx）。

    **为什么不写进技能的风格库**：技能那套导入流程要求改 4 个脚本里写死的风格数量、
    改源表 `styles_200_reorganized.md`、改 `style_alias_map.json` —— 全是 git 跟踪的文件。
    那样每加一个风格，下次 `git pull` 必冲突（上游加风格时也会改同一批字面量）。

    所以自建风格走**独立命名空间**，数据放在 `.gitignore` 已覆盖的
    `images/custom/styles/` 下（与自建资产 CH-002 同一个用户数据区）：
      · git 永远不碰，pull / 上游校验都不受影响
      · 编号 `CS-xxx` 与 FA..FH 完全隔离，不占上游编号

    代价：绕过了技能的 build_library 与 activation 推导，所以能力策略由文件
    **自描述**（name_activation / traits_activation / use_reference_image）。
    """
    rows = read_json(os.path.join(skill_root(), "images", "custom", "styles", "custom_styles.json"), [])
    if not isinstance(rows, list):
        return []
    out = []
    for i, s in enumerate(rows, 1):
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id") or f"CS-{i:03d}").strip()
        # 只认 CS-NNN：编号空间独立是这套设计的核心，放别的格式进来就失去隔离的意义
        if not re.match(r"^CS-\d{3}$", sid):
            continue
        rel = f"images/custom/styles/{s.get('img') or (sid + '.webp')}"
        out.append({
            "kind": "style", "id": sid, "legacy": str(s.get("legacy") or ""),
            "groupKey": "CS",
            "group": s.get("group") or "CS 自建风格 / Custom Styles",
            "name": s.get("generation_name") or "",
            "author": s.get("reference") or "",
            "traits": s.get("traits") or "",
            "img": rel if os.path.isfile(os.path.join(skill_root(), rel)) else "",
            "custom": True,
            "nameActivation": s.get("name_activation") or "weak",
            "traitsActivation": s.get("traits_activation") or "strong",
            "useReferenceImage": bool(s.get("use_reference_image", True)),
        })
    return out


def norm_styles():
    """风格条目。**库内 327 条 + 自建风格合并在这一处** ——
    `build_catalog()`（界面）与 `_style_traits()`（拼装）都走这个函数，
    所以自建风格在两条链路上自动生效，不必各改一遍。

    `legacy` 是关键：技能契约和用户心智里的编号是 **001–327** 这套全局序号，
    而库里真实的文件名是 `FA-001` 这种「组前缀 + 组内序号」。两套靠
    references/style_alias_map.json 对应（例：257 → FE-059）。
    不把它带出来，用户照文档里的编号就搜不到。
    """
    rows = read_json(os.path.join(prompter_root(), "references", "styles.json"), [])
    alias = read_json(os.path.join(prompter_root(), "references", "style_alias_map.json"), {})
    n2l = alias.get("new_to_legacy") or {}
    out = []
    for s in rows:
        num = s.get("number") or ""
        group = num.split("-")[0]
        rel = f"images/individual/{group}/{num}.webp"
        out.append({
            "kind": "style", "id": num, "legacy": n2l.get(num) or "", "groupKey": group,
            "group": s.get("group") or group,
            "name": s.get("generation_name") or "",
            "author": s.get("reference") or "",
            "traits": s.get("traits") or "",
            "img": rel if os.path.isfile(os.path.join(skill_root(), rel)) else "",
        })
    return out + norm_custom_styles()


def norm_layouts():
    rows = read_json(os.path.join(prompter_root(), "references", "layouts.json"), [])
    out = []
    for l in rows:
        rel = _rel_from_gallery(l.get("image"))
        out.append({
            "kind": "layout", "id": l.get("id"), "groupKey": l.get("category") or "",
            "group": l.get("category") or "", "name": l.get("name") or "",
            "nameEn": l.get("name_en") or "", "keywords": l.get("keywords") or [],
            "promptFile": l.get("prompt_file") or "",
            "img": rel if os.path.isfile(os.path.join(skill_root(), rel)) else "",
        })
    return out


def norm_colors():
    rows = read_json(os.path.join(prompter_root(), "references", "colors.json"), [])
    out = []
    for c in rows:
        rel = _rel_from_gallery(c.get("image"))
        out.append({
            "kind": "color", "id": c.get("id"), "groupKey": c.get("category") or "",
            "group": c.get("category_zh") or c.get("category") or "",
            "name": c.get("name_zh") or "", "nameEn": c.get("name_en") or "",
            "quote": c.get("quote_zh") or "",
            "promptZh": c.get("prompt_zh") or "",
            "promptEn": c.get("prompt_en") or "",
            "img": rel if os.path.isfile(os.path.join(skill_root(), rel)) else "",
        })
    return out


def norm_characters():
    rows = read_json(os.path.join(prompter_root(), "references", "characters.json"), [])
    out = []
    for c in rows:
        rel = _rel_from_gallery(c.get("image"))
        out.append({
            "kind": "character", "id": c.get("id"), "groupKey": "character",
            "group": "角色库", "name": c.get("name") or "", "nameEn": c.get("name_en") or "",
            "tags": c.get("tags") or [], "layout": c.get("layout") or "",
            "img": rel if os.path.isfile(os.path.join(skill_root(), rel)) else "",
        })
    return out


# ══════════════════════════════════════════════════════════════════════
# 资产库（角色 / 道具 / 场景）
#
# **不自己另造一套数据层**：技能包里已经有 custom_library_manager.py，
# 它管着全局配置（~/.handraw-style/config.json）、工作区配置、外部图库目录与 library.json。
# 这里只做两件事：① 把「官方预置 + 自建」合并成界面能吃的形状；
# ② 把 init / save 转发给它。逻辑一律不复制 —— 复制出来的第二份迟早会漂移。
# ══════════════════════════════════════════════════════════════════════

ASSET_CATEGORIES = [
    {"key": "characters", "label": "角色库", "prefix": "CH", "preset": "characters.json",
     "usage": "角色基准图（三视图）",
     "createHint": "图型：IP-002，其他你帮我设计",
     "saveHint": "保存图片到角色库，名称：xxx",
     # 角色有专属图型：IP-002 角色形象三视图基准图
     "presetLayout": "IP-002"},
    {"key": "props", "label": "道具库", "prefix": "PR", "preset": "props.json",
     "usage": "道具基准图", "createHint": "", "saveHint": "保存图片到道具库，名称：xxx",
     "presetLayout": ""},
    {"key": "scenes", "label": "场景库", "prefix": "SCN", "preset": "scenes.json",
     "usage": "场景基准图", "createHint": "", "saveHint": "保存图片到场景库，名称：xxx",
     "presetLayout": ""},
]

_MANAGER = None


def asset_manager():
    """动态加载技能自带的 custom_library_manager（它就在技能目录里）。"""
    global _MANAGER
    if _MANAGER is not None:
        return _MANAGER
    path = os.path.join(prompter_root(), "scripts", "custom_library_manager.py")
    if not os.path.isfile(path):
        raise RuntimeError(f"技能包里没有 custom_library_manager.py：{path}")
    spec = importlib_util.spec_from_file_location("handraw_custom_library", path)
    mod = importlib_util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _MANAGER = mod
    return mod


def asset_notes():
    """角色资产的人物描述（工作台自有，旁挂文件 `workbench/asset-notes.json`）。

    **为什么不写进技能库的 library.json**：那份由技能的 custom_library_manager.py
    维护，塞额外字段会在它下次保存时被覆盖 —— 而且那是 git 跟踪的技能目录。
    旁挂文件在工作区内，技能更新不影响它，也不受沙箱限制。
    文件缺失、或某个 id 没有描述，都只是「详情里没内容」，不报错。
    """
    d = read_json(os.path.join(WORKSPACE, "workbench", "asset-notes.json"), {})
    return d if isinstance(d, dict) else {}


def _asset_rows(cat, merge):
    """一个分类的条目：官方预置 + 自建。"""
    notes = asset_notes()

    def note_of(aid):
        n = notes.get(str(aid)) or {}
        return {"role": n.get("role") or "",
                "desc": n.get("desc") or "",
                "facts": n.get("facts") or []}

    rows = []
    preset = read_json(os.path.join(prompter_root(), "references", cat["preset"]), [])
    for it in preset:
        rel = _rel_from_gallery(it.get("image"))
        rows.append(dict({
            "id": it.get("id"), "name": it.get("name") or "", "nameEn": it.get("name_en") or "",
            "tags": it.get("tags") or [], "layout": it.get("layout") or "",
            "isCustom": False, "createdAt": "",
            "img": rel if os.path.isfile(os.path.join(skill_root(), rel)) else "",
        }, **note_of(it.get("id"))))
    for it in merge.get(cat["key"], []) or []:
        rel = _rel_from_gallery(it.get("image"))
        rows.append(dict({
            "id": it.get("id"), "name": it.get("name") or "", "nameEn": it.get("name_en") or "",
            "tags": it.get("tags") or [], "layout": it.get("layout") or "",
            "isCustom": True, "createdAt": it.get("created_at") or "",
            "img": rel if os.path.isfile(os.path.join(skill_root(), rel)) else "",
        }, **note_of(it.get("id"))))
    return rows


def asset_library():
    """资产库全貌：三个分类 + 图库目录状态。界面与生成器共用这一份。"""
    mgr = asset_manager()
    try:
        c, p, s = mgr.load_custom_assets()
        merge = {"characters": c, "props": p, "scenes": s}
    except Exception:
        merge = {"characters": [], "props": [], "scenes": []}

    try:
        tuku = mgr.get_custom_library_dir()
    except Exception:
        tuku = None

    cats = {}
    for cat in ASSET_CATEGORIES:
        rows = _asset_rows(cat, merge)
        cats[cat["key"]] = {
            "key": cat["key"], "label": cat["label"], "prefix": cat["prefix"],
            "usage": cat["usage"], "createHint": cat["createHint"], "saveHint": cat["saveHint"],
            "presetLayout": cat["presetLayout"],
            "count": len(rows), "customCount": sum(1 for r in rows if r["isCustom"]),
            "items": rows,
        }
    return {
        "ok": True,
        "library": {
            "initialized": bool(tuku),
            "dir": str(tuku) if tuku else "",
            # 没挂载时给一个**真实可用的默认目录**（工作区下的 image-library），
            # 而不是占位符 d:\path\to\tuku —— 占位符没法一键挂载，等于把皮球踢给用户。
            "defaultDir": os.path.join(WORKSPACE, "image-library"),
            "initCmd": f'请帮我初始化图库目录：{os.path.join(WORKSPACE, "image-library")}',
        },
        "categories": cats,
    }


def build_catalog():
    styles, layouts, colors, chars = norm_styles(), norm_layouts(), norm_colors(), norm_characters()
    return {
        "ok": True,
        "skillRoot": skill_root(),
        # 比例 → 接口尺寸的换算表也随索引下发：界面要显示「按 864x1152 出图」，
        # 但**不能在 JS 里再抄一份**（抄一份就必然会跟后端漂移）。
        "ratioToSize": RATIO_TO_SIZE,
        "ratioApprox": RATIO_APPROX,
        "counts": {"styles": len(styles), "layouts": len(layouts),
                   "colors": len(colors), "characters": len(chars)},
        "styles": styles, "layouts": layouts, "colors": colors, "characters": chars,
    }


# ── 提示词构建（**设计接缝**：想换策略改这里） ───────────────────────

def filter_traits(traits):
    """按技能规范：只保留正向可见特征，丢掉含否定词的子句。"""
    parts = re.split(r"[、；;]", traits or "")
    return "、".join(p.strip() for p in parts if p.strip() and not any(n in p for n in NEG))


def layout_text(layout_id, lang):
    """图型文件是 <!-- zh --> / <!-- en --> 两段，按语言取原文。"""
    if not layout_id:
        return ""
    path = os.path.join(prompter_root(), "references", "layouts", f"{layout_id}.md")
    if not os.path.isfile(path):
        return ""
    txt = io.open(path, encoding="utf-8").read()
    marker = "<!-- zh -->" if lang == "zh" else "<!-- en -->"
    other = "<!-- en -->" if lang == "zh" else "<!-- zh -->"
    if marker in txt:
        seg = txt.split(marker, 1)[1]
        if other in seg:
            seg = seg.split(other, 1)[0]
        return seg.strip()
    return ""


def layout_file(layout_id):
    return os.path.join(prompter_root(), "references", "layouts", f"{layout_id}.md")


def is_ecommerce(layout_id):
    """电商图型 EC-* 是例外：不追加通用图文后缀，也不自动拼画风（除非用户明确指定）。"""
    return bool(layout_id) and str(layout_id).upper().startswith("EC-")


def layout_detail(layout_id):
    """一个图型的完整资料：中英原文 + 是否电商 + 实际会追加的后缀。"""
    path = layout_file(layout_id)
    exists = os.path.isfile(path)
    return {
        "id": layout_id,
        "file": f"references/layouts/{layout_id}.md",
        "exists": exists,
        "bytes": os.path.getsize(path) if exists else 0,
        "zh": layout_text(layout_id, "zh"),
        "en": layout_text(layout_id, "en"),
        "isEcommerce": is_ecommerce(layout_id),
        # EC-* 不加后缀，文件不存在也没有「实际会追加什么」可谈，两者都给空
        "suffixZh": "" if (is_ecommerce(layout_id) or not exists) else GRAPHIC_TEXT_SUFFIX,
        "suffixEn": "" if (is_ecommerce(layout_id) or not exists) else GRAPHIC_TEXT_SUFFIX,
    }


def _load_skill_module(name, filename):
    """加载技能自带脚本。脚本之间有 `from style_asset_paths import ...` 这种同目录导入，
    所以先把 scripts 目录塞进 sys.path。"""
    scripts = os.path.join(prompter_root(), "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    path = os.path.join(scripts, filename)
    spec = importlib_util.spec_from_file_location(name, path)
    mod = importlib_util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_DECISION_CACHE = {}
# 并发出图（2026-11-16）后，多个线程会同时进 style_decision / fusion_blocks。
# 这两个缓存本身是**幂等**的（算错了重算一次结果一样），所以不加锁也不会算错，
# 但会重复读盘、重复跑 resolve_reference。加把锁把重复计算挡掉，代价可忽略。
_CACHE_LOCK = threading.Lock()


def style_decision(model, style_id):
    """能力判定：**直接复用技能自带的 resolve_reference.py**，不重新实现。

    它决定三件事：要不要给核心特征词、要不要垫图、参考图取哪张
    （`{编号}_grid.webp` 优先，单图兜底）。这三条是技能规范，不是我该自己拍的东西。

    **自建风格（CS-xxx）例外**：它们不在技能的能力表里，`resolve_reference` 查不到。
    但这不是缺失 —— 自建风格的文件本来就自描述策略，直接用它即可，
    而且比"未知模型"的保守兜底更准确（那是猜，这是声明）。
    """
    key = (model, style_id)
    if key in _DECISION_CACHE:
        return _DECISION_CACHE[key]
    with _CACHE_LOCK:
        # 双检：并发下可能刚被别的线程算好
        if key in _DECISION_CACHE:
            return _DECISION_CACHE[key]
        d = _style_decision_uncached(model, style_id)
        _DECISION_CACHE[key] = d
        return d


def _style_decision_uncached(model, style_id):
    """真正干活的部分（原 style_decision 的函数体），由带锁的 style_decision 调用。"""
    custom = _custom_style_entry(style_id)
    if custom:
        traits = filter_traits(custom.get("traits", ""))
        d = {"name_activation": custom.get("nameActivation") or "weak",
             "traits_activation": custom.get("traitsActivation") or "strong",
             "activation_source": "custom-style-file（自建风格自描述）",
             "use_reference_image": bool(custom.get("useReferenceImage", True)),
             "include_prompt_traits": True,
             "prompt_traits": traits,
             "reference_path": None, "custom": True}
        return d
    try:
        rr = _load_skill_module("handraw_resolve_reference", "resolve_reference.py")
        d = rr.resolve(model or DEFAULT_MODEL, style_id)
    except Exception as e:
        # 判定失败时按「未知模型」的最保守策略：给特征词 + 要参考图
        d = {"name_activation": "unknown", "traits_activation": "unknown",
             "activation_source": "name+style+traits+reference-image",
             "use_reference_image": True, "include_prompt_traits": True,
             "prompt_traits": filter_traits(_style_traits(style_id)),
             "reference_path": None, "error": f"{type(e).__name__}: {e}"}
    return d


def _custom_style_entry(style_id):
    """按编号取一条自建风格（CS-xxx）。非自建编号返回 None。

    单独抽出来，是因为拼装路径与能力判定都要问"这是不是自建风格"，
    两处各写一遍判断必然会漂移。
    """
    if not re.match(r"^CS-\d{3}$", str(style_id or "").strip()):
        return None
    for s in norm_custom_styles():
        if s["id"] == style_id:
            return s
    return None


def _style_traits(style_id):
    for s in norm_styles():
        if s["id"] == style_id:
            return s.get("traits", "")
    return ""


def _extras(ratio="", whitespace="", mood="", subject="", text_req="", constraint="",
            text_layout=""):
    """附加约束。技能里只定义了 画幅/主体限制/文字要求 三项，位置固定；
    「留白 / 情绪 / 构图要求」不是技能参数，但走同一个「附加约束」通道，落在同一处。
    这点要在界面上说清楚，别让人以为技能原生支持留白或情绪。

    constraint（构图要求）：出图模式会带出各自的场景约束，比如海报要「大标题 + 主视觉」、
    摄影要「真实光影与材质」。它是工作台加的场景层，不是技能的东西。
    """
    zh, en = [], []
    if ratio:
        zh.append(f"画幅：{ratio}")
        en.append(f"aspect ratio: {ratio}")
    if whitespace:
        zh.append(f"留白：{whitespace}")
        en.append(f"whitespace: {whitespace}")
    if mood:
        zh.append(f"情绪：{mood}")
        en.append(f"mood: {mood}")
    # 文字排布（图上字下 / 字上图下 / 气泡对话…）：**技能没有这个参数**。
    # 技能里的文字排布是靠「图型」表达的（如 SC-004 上下双格图文分区卡、SC-005 气泡文字思考IP卡），
    # SKILL.md 只有一个固定的图文后缀。所以这里走附加约束通道，界面也要如实标注。
    if text_layout:
        zh.append(f"文字排布：{text_layout}")
        en.append(f"text layout: {text_layout}")
    if constraint:
        zh.append(f"构图要求：{constraint}")
        en.append(f"composition: {constraint}")
    if subject:
        zh.append(f"主体限制：{subject}")
        en.append(f"subject constraints: {subject}")
    if text_req:
        zh.append(f"文字要求：{text_req}")
        en.append(f"text requirement: {text_req}")
    return "；".join(zh), "; ".join(en)


# 画幅 → 生图接口的尺寸参数。
# **这张表必须存在**：接口只认具体像素尺寸（如 864x1152），不认 "3:4" 这种比例字符串。
# 少了它就会出现「提示词写着画幅 3:4、实际却按 1:1 出图」的错位 —— 而且是静默的。
# 取值来自接口对 gpt-image-2.5 支持的比例档位。
RATIO_TO_SIZE = {
    "1:1": "1024x1024", "16:9": "1280x720", "9:16": "720x1280",
    "4:3": "1152x864", "3:4": "864x1152", "3:2": "1536x1024", "2:3": "1024x1536",
    "5:4": "1120x896", "4:5": "896x1120", "21:9": "1456x624", "9:21": "624x1456",
    "2:1": "1536x768", "1:2": "768x1536",
    # 预设里用到的非标准比例：映射到最接近的支持档（不是精确比例，界面要如实说）
    "2.35:1": "1456x624",
    "5:2": "1456x624",
}
# 上面这两条是「最接近档」而不是精确比例 —— 单独标出来，免得界面把近似说成精确
RATIO_APPROX = ["2.35:1", "5:2"]


def size_for_ratio(ratio):
    """把画幅换算成接口尺寸。直接填像素尺寸（1024x1024）就原样用；认不出返回空串。"""
    r = (ratio or "").strip().lower().replace(" ", "")
    if not r:
        return ""
    if re.match(r"^\d{2,5}x\d{2,5}$", r):
        return r
    return RATIO_TO_SIZE.get(r, "")


# ── 漫画流：内容 → 分镜 ───────────────────────────────────────────────
#
# ⚠️ 这里只做**确定性切分**（段落 → 句子）。它解决不了「一句话拆成 5 个不同场景」——
# 那是语义创作，得让 Agent 做。所以拆不够时**如实返回实际条数**，不硬凑：
# 硬凑只能靠复制原句或加序号，产出 5 张几乎一样的图，比拆不出来更糟。

_SENT_RE = re.compile(r"(?<=[。！？!?；;])")


def _merge_to(units, want):
    """把 units 按顺序均匀合并成 want 段。"""
    n = len(units)
    if want >= n:
        return list(units)
    out, start = [], 0
    for i in range(want):
        end = round((i + 1) * n / want)
        chunk = "".join(units[start:end]).strip()
        if chunk:
            out.append(chunk)
        start = end
    return out


# 结构性标签：长得像「发言人：」但不是对白。
# 确定性路线只看字面，分不清「小勇：」和「拍摄建议：」，所以这里显式列出来。
_NOT_SPEAKER = ("拍摄建议", "建议", "备注", "说明", "提示", "要求", "场景", "画面", "机位", "注")

# 发言人的出现位置：行首，或句末标点/右括号/空白之后。
# 卡在「句首」是为了不被正文里的冒号骗到（「会议记录：…」不该算台词）。
_SPEAKER_RE = re.compile(
    r"(?:^|[。！？；\n\s)）】])([\u4e00-\u9fa5A-Za-z0-9]{1,4})[：:]\s*([^。！？\n]+)")


def split_dialogue(line):
    """从一行里分出（画面/叙述文字, 对白）。

    返回的 scene **原样是传入的那一行** —— 确定性路线的契约是逐字保留，
    所以「画面」和「对白」在这里是**同一段文字的两种视图**，不是互斥拆分。
    认不出任何对白就返回 (原行, "")，**不猜**。
    """
    line = line or ""
    out = []
    for m in _SPEAKER_RE.finditer(line):
        who, what = m.group(1).strip(), m.group(2).strip()
        if who in _NOT_SPEAKER or not what:
            continue
        out.append(f"{who}：{what}")
    return line, "；".join(out)


def split_panels(text, want=0):
    """把一段文字拆成分镜。返回 (panels, meta)。

    meta 带 `short`：请求镜数 > 实际能拆出的镜数 —— 界面据此提示
    「要更多镜需要让 Agent 做语义扩展」，而不是假装拆成功了。
    """
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        return [], {"requested": 0, "produced": 0, "short": False, "source": "empty",
                    "splitter": "deterministic"}

    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    requested = int(want or 0)
    # 不指定数量 = 自动：段落数就是分镜数（与参考产品的「自动」一致）
    target = requested if requested > 0 else len(paras)
    target = max(1, min(target, 24))

    if len(paras) >= target:
        panels = _merge_to(paras, target)
        src = "paragraph"
    else:
        sents = []
        for p in paras:
            parts = [s.strip() for s in _SENT_RE.split(p) if s.strip()]
            sents.extend(parts or [p])
        panels = _merge_to(sents, target)
        src = "sentence"

    # 对白只**提取出来给人看**，panels 里的文字一个字都不动 ——
    # 确定性路线的价值就是逐字保留，改了就丢了它存在的理由。
    dialogues, notes = [], []
    for p in panels:
        _, dlg = split_dialogue(p)
        dialogues.append(dlg)
        notes.append("")
    return panels, {
        "requested": requested,
        "produced": len(panels),
        "short": requested > 0 and len(panels) < requested,
        "source": src,
        "splitter": "deterministic",
        "withDialogue": sum(1 for d in dialogues if d),
        "withNotes": 0,
        "paragraphs": len(paras),
        "auto": requested <= 0,
        "dialogues": dialogues,
        "notes": notes,
    }


# ── 风格融合：角色视觉语言 × 场景视觉语言 ─────────────────────────────
#
# 契约来自技能包里的 style-fusion-prompter/SKILL.md，与「图文后缀」同性质：
# 有一段**必须逐字完整复制**的「共存规范」（技能原话：核心契约，严禁删减、提炼、压缩、篡改）。
# 所以这里**运行时从 SKILL.md 原文提取**，而不是抄进代码 —— 抄一份就多一份会漂移的副本，
# 而「必须逐字」的文本手抄一定会静默出错。提取失败直接报错，不静默降级。
_FUSION_CACHE = None


def fusion_blocks():
    global _FUSION_CACHE
    if _FUSION_CACHE is not None:
        return _FUSION_CACHE
    with _CACHE_LOCK:
        if _FUSION_CACHE is not None:      # 双检
            return _FUSION_CACHE
        _FUSION_CACHE = _fusion_blocks_uncached()
        return _FUSION_CACHE


def _fusion_blocks_uncached():
    """读技能包里的融合块（原 fusion_blocks 的函数体），由带锁的外层调用。"""
    path = os.path.join(skill_root(), "skills", "style-fusion-prompter", "SKILL.md")
    if not os.path.isfile(path):
        raise RuntimeError(f"技能包里没有 style-fusion-prompter/SKILL.md：{path}")
    txt = io.open(path, encoding="utf-8").read()
    parts = txt.split("```")
    blocks = [parts[i] for i in range(1, len(parts), 2)]
    if len(blocks) < 2:
        raise RuntimeError("style-fusion-prompter/SKILL.md 结构变了：取不到双语模板代码块")

    def coexist(b, marker):
        idx = b.rfind(marker)          # 共存规范在代码块尾部，取最后一次出现
        if idx < 0:
            raise RuntimeError(f"SKILL.md 里找不到共存规范标记：{marker[:16]}…")
        return b[idx:].rstrip("\n")

    zh_mark = "缩微摄影，角色尺寸异常小，场景保持正常尺寸。"
    en_mark = "Miniature photography, the character scale is exceptionally small"
    return {"zh": coexist(blocks[0], zh_mark), "en": coexist(blocks[1], en_mark)}


def _is_style_id(v):
    return bool(re.match(r"^[A-Za-z]{2}-\d{3}$", str(v or "").strip()))


def _fusion_style_expand(v, lang):
    """按融合技能的输入规范展开一个风格。

    · 编号（FA-018）→ `#序号 名称。参考作者/风格名称：…。核心风格特征：…。`
      其中**特征词逐字复制原文**（技能红线：严禁压缩、提炼、删减、改写）——
      注意这与普通路径**相反**：普通路径会过滤掉含否定词的子句，融合不允许过滤。
    · 名称（写实 / 电影感实拍摄影）→ **原样输出，严禁添枝加叶**。
    """
    v = str(v or "").strip()
    if not v:
        return ""
    if not _is_style_id(v):
        return v                                   # 名称：按用户的来
    st = next((s for s in norm_styles() if s["id"] == v), None)
    if st is None:
        return v
    num = st.get("legacy") or st["id"]
    traits = st.get("traits") or ""
    # 特征词**逐字复制，不做压缩**；只在它已经以句号结尾时不再追加 —— 避免出现「。。」，
    # 这不是删减内容，只是不重复标点。
    zt = traits if traits.endswith(("。", ".", "；", ";")) else traits + "。"
    if lang == "en":
        return (f"#{num} {st['name']}. Reference author/style: {st['author']}. "
                f"Core style traits: {zt}")
    return f"#{num} {st['name']}。参考作者/风格名称：{st['author']}。核心风格特征：{zt}"


def build_fusion_prompt(char_style, scene_style, theme, color_id=None, layout_id=None,
                        ratio="", mood="", asset_refs=None, model=None):
    """风格融合提示词。与 build_prompt 是**两条独立的拼装路径**（技能里本就是独立技能）。

    返回结构与 build_prompt 对齐，外加 `fusion=True` 与 `ratio`（技能规定默认 3:4）。
    """
    if not _is_style_id(char_style):
        raise SystemExit("风格融合的「角色风格」必须是编号（如 FA-018）")
    st = next((s for s in norm_styles() if s["id"] == char_style), None)
    if st is None:
        raise SystemExit(f"角色风格编号不存在：{char_style}")
    if not str(scene_style or "").strip():
        raise SystemExit("风格融合需要「场景风格」（编号或名称，如 写实）")

    co = next((c for c in norm_colors() if c["id"] == color_id), None) if color_id else None
    lay = next((x for x in norm_layouts() if x["id"] == layout_id), None) if layout_id else None
    blocks = fusion_blocks()
    theme = (theme or "").strip().rstrip("。.")
    eff_ratio = (ratio or "").strip() or "3:4"      # 技能规定：默认 3:4

    zh = ["生成一幅“角色视觉语言 × 场景视觉语言”共存的跨媒介融合画面。缩微摄影，角色尺寸异常小，场景保持正常尺寸。",
          f"- 【角色视觉语言】：{_fusion_style_expand(char_style, 'zh')}",
          f"- 【场景视觉语言】：{_fusion_style_expand(scene_style, 'zh')}",
          f"- 【主题】：{theme}"]
    en = ["Generate a cross-media fusion artwork where \"Character Visual Language × Scene Visual Language\" "
          "coexist. Miniature photography, the character scale is exceptionally small, while the scene "
          "maintains normal scale.",
          f"- [Character Visual Language]: {_fusion_style_expand(char_style, 'en')}",
          f"- [Scene Visual Language]: {_fusion_style_expand(scene_style, 'en')}",
          f"- [Theme]: {theme}"]
    if mood:
        zh.append(f"- 【情绪】：{mood}")
        en.append(f"- [Mood]: {mood}")
    if lay:
        zh.append(f"- 【图型】：{lay['id']} {lay.get('name') or ''}")
        en.append(f"- [Layout]: {lay['id']} {lay.get('nameEn') or lay.get('name') or ''}")
    if co:
        zh.append(f"- 【主题色】：{co['id']} {co['name']}（{co['nameEn']}）")
        en.append(f"- [Theme Color]: {co['id']} {co['nameEn']}")
    zh.append(f"- 【画幅比例】：{eff_ratio}")
    en.append(f"- [Aspect Ratio]: {eff_ratio}")

    zh_txt = "\n".join(zh) + "\n\n" + blocks["zh"]
    en_txt = "\n".join(en) + "\n\n" + blocks["en"]

    asset_refs = [p for p in (asset_refs or []) if p]
    send_zh, send_en = zh_txt, en_txt
    if asset_refs:
        send_zh += "\n\n【资产一致性】" + asset_ref_text(asset_refs, "zh")
        send_en += "\n\n[Asset consistency] " + asset_ref_text(asset_refs, "en")

    return {"zh": zh_txt, "en": en_txt, "sendZh": send_zh, "sendEn": send_en,
            # 融合路径**不垫编号参考图**：契约是靠文字把两套风格各自完整展开；
            # 而且两张风格图谁对应角色、谁对应场景在接口层无法表达。
            "refPath": "",
            "assetRefs": asset_refs,
            "style": st, "decision": style_decision(model or DEFAULT_MODEL, char_style),
            "mode": "graphic-text" if lay else "pure-image",
            "fusion": True, "ratio": eff_ratio, "sceneStyle": scene_style,
            "layoutId": layout_id or "", "colorId": color_id or ""}


def asset_ref_text(paths, lang="zh"):
    """资产参考说明。**必须按类别分开说**，这是踩出来的：

    角色参考和商品/道具参考对模型的要求完全不同 ——
    前者是「画面里出现人时必须是这个人」，后者是「照这个外形画、别重新设计」。
    只给一句通用的「保持主体形象一致」，模型面对「1 张人物 + 4 张商品图」时
    会把它们全当产品参考，于是详情页里一个人都不出现（实测：电商详情页 6 张全无人物）。
    """
    norm = [str(p).replace("\\", "/").lower() for p in (paths or [])]
    chars = sum(1 for p in norm if "/characters/" in p)
    others = max(0, len(norm) - chars)
    if lang == "en":
        if not chars:
            return ASSET_REF_EN
        return (f"Of the {len(norm)} attached asset images, {chars} are CHARACTER references and "
                f"{others} are PRODUCT/PROP references. "
                "[How to use the character] The main subject in the image MUST match the character "
                "reference exactly — same species and body type, same facial features, same hair or head "
                "accessory, same outfit and palette, same carried items. Do not swap the species and do not "
                "redesign it. If the theme text says \"person\", \"he\" or \"she\", it refers to the "
                "character in this reference — draw that character, do not turn it into a human just because "
                "the text says person. "
                "[How to use product/prop references] Follow their shape, proportions, palette and key "
                "features without redesigning them.")
    if not chars:
        return ASSET_REF
    # 角色参考的措辞要**兼容非人角色**（松鼠、猫、机器人…）。
    # 原来写的是「同一个人 / 同一张脸 / 同一发型」，遇到动物角色就自相矛盾：
    # 实测选了一只松鼠角色、主题写「一个人坐在窗前发呆」，
    # 模型夹在「人」和「松鼠」之间，最后画出一只猫。
    return (f"所附资产参考图共 {len(norm)} 张：其中 {chars} 张是**角色主体参考**，"
            f"{others} 张是**商品/道具参考**。"
            "【角色的用法】画面里出现的那个主体，外形必须与角色参考图**完全一致** —— "
            "同样的物种与体型、同样的五官或面部特征、同样的发型或头部装饰、同样的服装与配色、"
            "同样的随身物件。不要换一个物种，不要重新设计形象。"
            "如果主题文字里提到「人」「他」「她」这类词，它指的就是这张角色参考图里的那个角色，"
            "**按参考图来画，不要因为文字里写了「人」就改画成人类**。"
            "【商品/道具的用法】沿用其外形、比例、配色与关键特征，不要重新设计。")


def build_bare_prompt(theme, layout_id=None, ratio="", color_id=None, constraint=""):
    """**不依赖风格库**的最小拼装：只给主题（可带图型）。

    角色 / 道具 / 场景的**基准图**不需要画风 —— 它是拿来做垫图参考的，
    画风由之后真正出图时决定。技能层的拼装必须有风格，所以这里是一条**独立的最小路径**，
    而不是硬塞一个默认风格：那会让基准图带上一个谁都没选过的画师风格，用户还无从得知。

    刻意不加图文后缀（GRAPHIC_TEXT_SUFFIX）：基准图要的是干净的造型参考，
    「文字参与构图，图文一体」会往三视图里塞文字，是反效果。
    """
    theme = (theme or "").strip().rstrip("。.")
    if not theme and not layout_id:
        raise SystemExit("提示词不能为空")
    extra_zh, extra_en = _extras(ratio, "", "", "", "", constraint, "")
    co = next((c for c in norm_colors() if c["id"] == color_id), None) if color_id else None

    zh, en = [], []
    lt_zh = lt_en = ""
    if layout_id:
        lt_zh, lt_en = layout_text(layout_id, "zh"), layout_text(layout_id, "en")
        if not lt_zh:
            raise SystemExit(f"图型没有提示词原文：{layout_id}")
        lay = next((x for x in norm_layouts() if x["id"] == layout_id), None)
        lay_zh = (lay or {}).get("name") or layout_id
        lay_en = (lay or {}).get("nameEn") or lay_zh
        zh.append(f"图型：{lay_zh}。")
        en.append(f"Layout: {lay_en}.")
    if co:
        zh.append(f"主题色：{co['name']}（{co['nameEn']}）。")
        en.append(f"Theme color: {co['nameEn']}.")
    zh.append(f"主题：{theme}。")
    en.append(f"Theme: {theme}.")
    if lt_zh:
        zh.append(f"排版要求：{lt_zh}")
        en.append(f"Layout instructions: {lt_en}")
    if extra_zh:
        zh.append(extra_zh)
        en.append(extra_en)

    txt_zh = "".join(zh)
    txt_en = " ".join(en)
    return {"zh": txt_zh, "en": txt_en, "sendZh": txt_zh, "sendEn": txt_en,
            "refPath": "", "assetRefs": [], "style": None, "decision": {},
            "mode": "graphic-text" if layout_id else "pure-image",
            "bare": True, "ratio": (ratio or "")}


def build_prompt(style_id, theme, color_id=None, layout_id=None, with_ref=True,
                 asset_refs=None, model=None, mode="pure-image", ratio="",
                 whitespace="", mood="", subject="", text_req="", redraw=False,
                 constraint="", text_layout=""):
    """按 **技能自己的拼装顺序** 组提示词（对齐 prompt_style.py 的 main()）。

    返回：
      zh / en      可复制的提示词（按技能的模式规则：图文模式下**不含**参考图隔离块）
      sendZh       实际发给生图模型的提示词（会在 zh 基础上补上参考图约束）
      refPath      编号参考图（按能力判定决定是否需要）
      assetRefs    资产垫图绝对路径列表
      decision     能力判定结果（界面要展示「为什么给/不给特征词」）

    **与技能 CLI 的两处刻意差异**（必须记着，否则会以为跑偏了）：
      1. 技能 CLI 在纯图模式下把「参考图：请上传本地参考图 <路径>」写进提示词，那是给人看的；
         我们是**真把图挂上去**，所以只保留隔离块本身，不写「请上传」那句。
      2. 图文模式下可复制提示词里不放隔离块（技能规范），但**实际发出去的那份要放** ——
         技能 SKILL.md 明写「the actual image-generation prompt still receives it together with
         the attached asset」。所以这里区分 zh 与 sendZh。
    """
    styles = {s["id"]: s for s in norm_styles()}
    st = styles.get(style_id)
    if st is None:
        raise SystemExit(f"风格编号不存在：{style_id}")

    model = model or DEFAULT_MODEL
    decision = style_decision(model, style_id)
    traits = (decision.get("prompt_traits") or "").rstrip("。.").strip()

    colors = {c["id"]: c for c in norm_colors()}
    co = colors.get(color_id) if color_id else None
    theme = (theme or "").strip().rstrip("。.")
    extra_zh, extra_en = _extras(ratio, whitespace, mood, subject, text_req, constraint, text_layout)

    # 参考图：按能力判定给默认，用户显式勾选则以用户为准
    ref_path = os.path.normpath(os.path.join(skill_root(), st["img"])) if st.get("img") else ""
    # 自建风格可以声明「别拿我这张图当垫图」（use_reference_image: false）。
    #
    # 为什么需要这个开关：traits 里常把某个槽位写成**变量**
    # （CS-002 就是「实物物件每篇由文案决定」）。而垫图会给这个槽位
    # **一个现成的实例** —— 模型会直接把槽位填成参考图里那个东西，
    # 无视文案里的意象。负面指令（「不要沿用参考图中的道具」）天生弱于一张现成的图。
    # 实测（2026-10-16，同一句「怎得梅花扑鼻香」）：
    #   发垫图 → 画面是参考图里的木质衣夹；不发垫图 → 画面是文案对应的陶碗梅花，
    #   且风格元素一个没丢。所以开关放在**风格数据**上，不让每个调用方自己传。
    style_no_ref = bool(st.get("custom")) and st.get("useReferenceImage") is False
    # 判定说「需要参考图」且解析到了就默认带上；用户关掉、或风格自己声明不要，则不垫
    want_ref = bool(with_ref) and bool(ref_path) and not style_no_ref
    asset_refs = [p for p in (asset_refs or []) if p]
    use_asset_refs = bool(asset_refs)

    if layout_id:
        # ── 图型分支：与 prompt_style.py 一致，且**自动切图文模式** ──
        lt_zh, lt_en = layout_text(layout_id, "zh"), layout_text(layout_id, "en")
        if not lt_zh:
            raise SystemExit(f"图型没有提示词原文：{layout_id}")
        lay = next((x for x in norm_layouts() if x["id"] == layout_id), None)
        lay_zh = (lay or {}).get("name") or layout_id
        lay_en = (lay or {}).get("nameEn") or lay_zh
        is_ec = is_ecommerce(layout_id)

        parts_zh = [f"图型：{lay_zh}。", f"主题：{theme}。", f"排版要求：{lt_zh}"]
        parts_en = [f"Layout: {lay_en}.", f"Theme: {theme}.", f"Layout instructions: {lt_en}"]
        if co:
            parts_zh.insert(1, co.get("promptZh") or f"主题色：{co['name']}（{co['nameEn']}）。")
            parts_en.insert(1, f"Theme color: {co['nameEn']}.")
        # 电商图型默认不拼画风（除非用户明确选了风格）
        if st and not is_ec:
            parts_zh.append(f"风格名称：{st['name']}。参考作者/风格名称：{st['author']}。")
            parts_en.append(f"Style name: {st['name']}. Reference author/style name: {st['author']}.")
            if traits:
                parts_zh.append(f"核心风格特征：{traits}。")
                parts_en.append(f" Core style traits: {traits}.")
        if redraw:
            parts_zh.append(REDRAW_ZH)
            parts_en.append(REDRAW_EN)
        if extra_zh:
            parts_zh.append(f"；{extra_zh}")
            parts_en.append(f" {extra_en}.")
        if not is_ec:
            parts_zh.append(GRAPHIC_TEXT_SUFFIX)
            parts_en.append(GRAPHIC_TEXT_SUFFIX)
        zh = "".join(parts_zh)
        en = " ".join(parts_en)
        mode = "graphic-text"          # 选了图型就自动图文模式（技能规范）
    else:
        # ── 纯风格分支：与 prompt_style.py 同序 ──
        color_zh = co.get("promptZh") if co else ""
        color_en = f" {co['promptEn']}" if co else ""
        zh = f"风格名称：{st['name']}。{color_zh}主题：{theme}。参考作者/风格名称：{st['author']}。"
        en = f"Style name: {st['name']}.{color_en} Theme: {theme}." \
             f" Reference author/style name: {st['author']}."
        if traits:
            zh += f"核心风格特征：{traits}。"
            en += f" Core style traits: {traits}."
        if redraw:
            zh += REDRAW_ZH
            en += f" {REDRAW_EN}"
        if extra_zh:
            zh += f"；{extra_zh}"
            en += f" {extra_en}."
        if mode == "graphic-text":
            zh += GRAPHIC_TEXT_SUFFIX
            en += GRAPHIC_TEXT_SUFFIX

    # ── 实发提示词：把「真的挂上去的图」对应的约束补上 ──
    send_zh = zh
    send_en = en

    # 实发提示词里**去掉「参考作者」那一段**。
    #
    # 2026-11-17 实测（这是硬故障，不是洁癖）：gpt-image 系（2.5 与 2.6 都一样）对
    # **真实艺术家名**有随机内容拦截，返回 status=violation。同一句主题反复打：
    #   带作者名「Jean Jullien」→ 1/6 成功
    #   去掉作者名            → 6/6 成功
    # 换六个艺术家复测（Gemma Correll / Saul Steinberg / Tom Gauld / David Shrigley /
    # Gary Larson / Roz Chast）带名全部 0–1/3，去掉名字 3/3。
    # 而风格库 375 条里有 340 条填的是真实艺术家名 —— 等于绝大多数风格一用就炸。
    # 历史成功过的 #374 / #390 之所以没事，是因为它们的 author 是虚构名
    # （「Jacquemus / 雅克慕斯」「Editorial Doodle / 社论涂鸦」），不是人名。
    #
    # 为什么可以安全去掉：只要挂了垫图（want_ref），画风是由**那张图**承载的，
    # 作者名对模型是冗余信息。可复制的 zh / en 仍保留作者名 —— 那是给人拿去
    # 别处用的，不经过我们的接口，不受这条限制。
    #
    # 没挂垫图时保留作者名：那种情况下它是唯一的画风线索（典型是 CS-002 这类
    # 声明 useReferenceImage: false 的自建风格，作者名本身是虚构的，不会触发拦截）。
    author = (st.get("author") or "").strip()
    if author and want_ref:
        send_zh = send_zh.replace(f"参考作者/风格名称：{author}。", "")
        send_en = send_en.replace(f"Reference author/style name: {author}.", "")

    refs_note = []
    if want_ref:
        refs_note.append("画风")
    if use_asset_refs:
        refs_note.extend(["资产主体"] * len(asset_refs))
    if len(refs_note) > 1:
        # 只写「第 N 张为 X 参考」模型不知道该怎么用，得把**分工**说清楚：
        # 画风图只学画法、资产图照抄主体。否则两张图会互相干扰
        # （实测：风格图 + 松鼠角色图 → 出来一只猫）。
        n_style = sum(1 for x in refs_note if x == "画风")
        n_asset = len(refs_note) - n_style
        parts = []
        if n_style:
            parts.append("第 1 张是**画风参考**：只学它的画法（线条、笔触、材质、色彩倾向），"
                         "不要抄它画的主体")
        if n_asset:
            parts.append(f"第 {n_style + 1} 张起共 {n_asset} 张是**资产主体参考**："
                         "画面里的主体**必须照它画**，外形、配色、服装、随身物件全部沿用")
        send_zh += "\n【参考图分工】" + "；".join(parts) + "。"

        en_parts = []
        if n_style:
            en_parts.append("the 1st is the STYLE reference — take only its rendering method "
                            "(linework, brushwork, material, color tendencies), not its subject")
        if n_asset:
            en_parts.append(f"images {n_style + 1} onward ({n_asset}) are ASSET SUBJECT references — "
                            "the subject in the output MUST be drawn after them, keeping their shape, "
                            "palette, outfit and carried items")
        send_en += "\n[Reference roles] " + "; ".join(en_parts) + "."
    # 隔离约束**只对画风图生效**。
    #
    # 2026-11-14 实测出的问题：原来这里无条件加 REF_ISOLATION，
    # 而那段写的是「所附图片仅用于参考画风……不要使用参考图里的任何主体、人物、动物、服装」。
    # 结果连第 2 张资产图也被要求「不要复制」——
    # 用户选了松鼠角色，出图却变成一只猫，因为模型优先听了「不要复制动物」。
    #
    # 正确语义：画风图要隔离，资产图**必须照抄**。两段指令要分开说，且顺序上
    # 把「哪些图只学画风」限定到具体张数，避免波及资产图。
    if want_ref and use_asset_refs:
        # 有资产图时：隔离只针对第 1 张（画风），并明确指出资产图不适用隔离
        send_zh += (
            "\n【参考图使用约束】所附图片中，**只有第 1 张（画风参考图）**仅用于提取画风，"
            "例如线条、笔触、媒介、材质、色彩倾向和整体视觉语言；"
            "不要沿用第 1 张里的主体、人物、动物、服装、道具、动作、姿态、场景、背景、构图、布局、文字或故事。"
            "**第 2 张及之后的资产参考图不受此约束**，必须按【资产一致性】的要求照它画。"
        )
        send_en += (
            "\n[Reference image usage] Of the attached images, **only the 1st (style reference)** "
            "is for style extraction only — linework, brushwork, medium, material texture, color tendencies, "
            "overall visual language. Do not carry over any subject, person, animal, clothing, prop, action, pose, "
            "setting, background, composition, layout, text or story from the 1st image. "
            "**The 2nd and later asset references are NOT subject to this restriction** — "
            "follow [Asset consistency] and draw them as they are."
        )
    elif want_ref:
        # 只有画风图：用原来的完整隔离
        send_zh += "\n【参考图使用约束】" + REF_ISOLATION
        send_en += "\n" + REF_ISOLATION_EN

    if use_asset_refs:
        send_zh += "\n【资产一致性】" + asset_ref_text(asset_refs, "zh")
        send_en += "\n[Asset consistency] " + asset_ref_text(asset_refs, "en")

    return {"zh": zh, "en": en, "sendZh": send_zh, "sendEn": send_en,
            "refPath": ref_path if want_ref else "",
            # 风格自己声明了「别拿我这张图当垫图」。**必须报出来**：
            # 执行端有一道「要求垫图却没图就报错」的守卫，它只看 with_ref，
            # 不知道 style_no_ref 这回事 —— 不告诉它，CS-002 会以
            # 「风格没有解析到样图」失败（实际是**故意不垫**）。
            "styleNoRef": style_no_ref,
            "assetRefs": asset_refs if use_asset_refs else [],
            "style": st, "decision": decision, "mode": mode,
            "layoutId": layout_id or "", "colorId": color_id or ""}


# ── 模型配置 ─────────────────────────────────────────────────────────

def load_env(workspace):
    env = {}
    path = os.path.join(workspace, "aws.env")
    if not os.path.isfile(path):
        return env
    for line in io.open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def _api_key(workspace):
    """生图 Key：settings 表 → 环境变量 → aws.env。

    2026-11-13：原来只读 aws.env，界面改了不生效。
    """
    try:
        import sys as _sys, os as _os
        _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
        import appconfig
        v = appconfig.get_secret("imageModelKey")
        if v:
            return v
    except Exception:
        pass
    return load_env(workspace).get("IMAGE_MODEL_API_KEY", "")


# 两种渠道：
#   grsai   —— 默认。GRS AI 的私有异步接口（提交拿任务号 → 轮询取结果）
#   openai  —— OpenAI 兼容格式（一次请求直接返回图），市面上多数中转站都是这个
CHANNEL_GRSAI = "grsai"
CHANNEL_OPENAI = "openai"


def _retry_count():
    """生图重试次数（含首次）。默认 3 = 首发 + 2 次重试。

    并发出图会推高 429 概率，所以重试是并发功能的一部分，不是可选优化。
    读取优先级：环境变量 DSH_WORKBENCH_IMAGE_RETRIES > settings 表 > 3。
    夹在 1..6：1 等于不重试（保留这个出口给排障用），太高则失败要等很久才报出来。
    """
    raw = (os.environ.get("DSH_WORKBENCH_IMAGE_RETRIES") or "").strip()
    if not raw:
        try:
            import appconfig
            raw = str(appconfig.get("imageRetries", "") or "").strip()
        except Exception:
            raw = ""
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = 3
    return max(1, min(6, n))


def load_model_cfg(workspace):
    """模型名与渠道取自 .aws-article/config.yaml 的 image_model。

    渠道决定走哪套调用流程（见 generate_once），不是所有中转站都兼容
    GRS AI 的 /v1/api/generate 异步接口，所以这个必须能配。
    """
    model, size, quality, base = DEFAULT_MODEL, "1024x1024", "auto", ""
    # channel 必须先给初值：下面两处赋值都在 if / try 里，
    # 工作区没有 .aws-article/config.yaml 时（新装机就是这种）会一路跳过，
    # 到后面用 channel 时就 UnboundLocalError，生图整条链直接崩。
    # 2026-11-16 实测踩到：新装用户第一次点生图就失败。
    channel = ""
    cfg_path = os.path.join(workspace, ".aws-article", "config.yaml")
    if os.path.isfile(cfg_path):
        try:
            import yaml
            cfg = yaml.safe_load(io.open(cfg_path, encoding="utf-8").read()) or {}
            im = cfg.get("image_model") or {}
            model = (im.get("model") or model).strip()
            size = (im.get("default_size") or size).strip()
            quality = (im.get("default_quality") or quality).strip()
            base = (im.get("base_url") or "").strip()
            channel = (im.get("channel") or "").strip().lower()
        except Exception:
            pass
    # settings 表优先（设置页改了就生效）；config.yaml 作兜底
    try:
        import sys as _sys
        import os as _os
        _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
        import appconfig
        ch = (appconfig.get("imageChannel", "") or "").strip().lower()
        if ch:
            channel = ch
        bu = (appconfig.get("imageBaseUrl", "") or "").strip()
        if bu:
            base = bu
        md = (appconfig.get("imageModel", "") or "").strip()
        if md:
            model = md
    except Exception:
        pass

    key = _api_key(workspace)
    host = DEFAULT_HOST
    if base:
        p = urllib.parse.urlparse(base)
        if p.scheme and p.netloc:
            host = f"{p.scheme}://{p.netloc}"
    if base.endswith("/v1/api/generate"):
        host = base[: -len("/v1/api/generate")]
    host = os.environ.get("DSH_WORKBENCH_IMAGE_ENDPOINT") or host

    # 渠道**必须显式配**，不能靠 base_url 猜。
    #
    # 为什么不猜（2026-11-13 踩过）：
    #   config.yaml 里的 base_url 是技能自带的字段，写的是
    #   https://grsai.dakka.com.cn/v1/images/generations —— 那个地址并不存在
    #   （GRS AI 真正的接口是 /v1/api/generate）。照它猜会判成 openai，
    #   结果调用打到不存在的路径上。
    #
    # 所以：没配 channel 就按默认渠道 GRS AI 走，跟升级前行为一致。
    if not channel:
        channel = CHANNEL_GRSAI

    # openai 渠道：base_url 就是它的端点（可只填域名、可填完整路径）
    if channel == CHANNEL_OPENAI:
        if base.endswith("/images/generations"):
            oa_url = base
        elif base.endswith("/v1"):
            oa_url = base + "/images/generations"
        elif base:
            oa_url = base.rstrip("/") + "/v1/images/generations"
        else:
            oa_url = host.rstrip("/") + "/v1/images/generations"
    else:
        oa_url = ""

    return {"model": model, "size": size, "quality": quality, "key": key,
            "channel": channel,
            # 重试次数（含首次）：429/5xx/网络抖动时用，见 generate_once。
            # 从 settings 表读，读不到就用 3 次（1 次首发 + 2 次重试）。
            "retries": _retry_count(),
            "host": host.rstrip("/"),
            "submitUrl": host.rstrip("/") + "/v1/api/generate",
            "resultUrl": host.rstrip("/") + "/v1/api/result",
            "openaiUrl": oa_url}


# ── 调 API ───────────────────────────────────────────────────────────

def http(url, key, data=None, method="POST", timeout=HTTP_TIMEOUT):
    hdr = {"Authorization": f"Bearer {key}"}
    if data is not None:
        hdr["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return "ERR", f"{type(e).__name__}: {e}".encode()


def _generate_openai(cfg, prompt, images, size, quality):
    """OpenAI 兼容渠道：一次请求直接返回图片，没有任务号也没有轮询。

    请求体按 OpenAI Images API 的格式：
        {model, prompt, n, size, response_format}
    有参考图时走 /images/edits（multipart），但多数中转站对 edits 支持不一，
    所以这里用最保守的做法：有图就放进 image 字段（部分中转站认），
    不认时退回纯文生图。

    返回 (bytes, elapsed_s, result_url)。
    """
    t0 = time.time()
    size_str = _openai_size(size)

    # 有参考图：优先 multipart edits（标准做法）
    if images:
        boundary = "----dshworkbench" + str(int(time.time() * 1000))
        parts = []

        def add_field(name, value):
            parts.append(f"--{boundary}\r\n".encode())
            parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
            parts.append(str(value).encode("utf-8"))
            parts.append(b"\r\n")

        add_field("model", cfg["model"])
        add_field("prompt", prompt)
        add_field("n", "1")
        if size_str:
            add_field("size", size_str)

        for idx, b64 in enumerate([b for b in (images or []) if b]):
            try:
                import base64 as _b64
                raw = _b64.b64decode(b64)
            except Exception:
                continue
            parts.append(f"--{boundary}\r\n".encode())
            # 字段名用 image[]（OpenAI 多图编辑的标准写法）。
            #
            # 2026-11-14 实测这家中转站：
            #   单图 image   → 能用（那次 502 是服务端排队超时，不是字段问题）
            #   多图 image[] → 200 ✓  1.87MB
            #   多图 image 重复 → 200 ✓
            # 两种都通，但 image[] 是 OpenAI 官方多图参数名，按标准用这个。
            parts.append(
                f'Content-Disposition: form-data; name="image[]"; filename="ref{idx}.png"\r\n'.encode())
            parts.append(b"Content-Type: image/png\r\n\r\n")
            parts.append(raw)
            parts.append(b"\r\n")

        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        edit_url = cfg["openaiUrl"].replace("/images/generations", "/images/edits")
        headers = {
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        }
        st, raw = _http_raw(edit_url, cfg["key"], body, headers)
        if st == 200:
            return _openai_pick_image(raw, cfg, t0)
        # edits 不支持就退回纯文生图，别直接失败
        # （很多中转站只实现 generations）

    payload = {"model": cfg["model"], "prompt": prompt, "n": 1}
    if size_str:
        payload["size"] = size_str
    if quality and quality not in ("auto", ""):
        payload["quality"] = quality

    st, raw = http(cfg["openaiUrl"], cfg["key"], json.dumps(payload).encode())
    txt = raw.decode("utf-8", "replace")
    if st != 200:
        raise RuntimeError(_openai_hint(st, txt, cfg))
    return _openai_pick_image(raw, cfg, t0)


def _openai_size(size):
    """把我们的比例/像素值换成 OpenAI 认可的尺寸。

    OpenAI Images 只接受 1024x1024 / 1536x1024 / 1024x1536 这几种；
    给了别的值不少中转站会直接 400，所以统一映射到最接近的一档。
    """
    v = str(size or "").strip().lower()
    if "x" in v:
        try:
            w, h = [int(x) for x in v.split("x")[:2]]
            if w > h * 1.15:
                return "1536x1024"
            if h > w * 1.15:
                return "1024x1536"
            return "1024x1024"
        except Exception:
            pass
    # 比例写法
    if ":" in v:
        try:
            a, b = [float(x) for x in v.split(":")[:2]]
            if a > b * 1.15:
                return "1536x1024"
            if b > a * 1.15:
                return "1024x1536"
        except Exception:
            pass
    return "1024x1024"


def _openai_pick_image(raw, cfg, t0):
    """从 OpenAI 格式的响应里取图：可能是 b64_json，也可能是 url。"""
    txt = raw.decode("utf-8", "replace")
    try:
        j = json.loads(txt)
    except Exception:
        raise RuntimeError(f"返回不是 JSON：{txt[:200]}")
    items = j.get("data") or []
    if not items:
        # 有的中转站把错误塞在 200 里
        msg = j.get("error") or j.get("message") or txt[:200]
        raise RuntimeError(f"没有返回图片：{msg}")
    first = items[0] or {}
    if first.get("b64_json"):
        import base64 as _b64
        return _b64.b64decode(first["b64_json"]), time.time() - t0, "(base64)"
    url = first.get("url") or ""
    if not url:
        raise RuntimeError(f"结果里既没有 b64_json 也没有 url：{txt[:200]}")
    st, blob = _http_raw(url, "", None, {})
    if st != 200 or len(blob) < 1000:
        raise RuntimeError(f"下载图片失败 HTTP {st}")
    return blob, time.time() - t0, url


def _openai_hint(st, txt, cfg):
    """把常见错误翻译成能指导用户的说法。"""
    low = txt.lower()
    if st == 404:
        return (f"404 找不到接口。当前地址是 {cfg['openaiUrl']}\n"
                f"    这个中转站可能不支持 OpenAI 格式，检查地址是否应为 /v1/images/generations")
    if st == 401 or "invalid api key" in low or "unauthorized" in low:
        return "401 密钥无效。检查「生图 · API Key」是否正确"
    if st == 429:
        return "429 请求过于频繁或余额不足"
    if "model" in low and ("not found" in low or "not exist" in low or "unsupported" in low):
        return f"模型名 {cfg['model']} 不被该中转站支持，换一个试试"
    return f"HTTP {st}: {txt[:300]}"


def _http_raw(url, key, data, headers):
    """带自定义头的原始请求（multipart 用）。返回 (status, bytes)。"""
    import urllib.request
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    req.add_header("User-Agent", "QoderWork/1.0")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()


def generate_once(cfg, prompt, images, size, quality):
    """按渠道分流。**带退避重试**（2026-11-16 加，为并发出图准备）。

    为什么重试必须放在这一层：并发出图时 429（请求过于频繁）的概率会显著上升，
    而原来这里一遇 429 就直接抛错，整个分镜判失败 —— 等于把并发收益又吐回去。
    库里 27 次历史失败中已有 5 次是 429，串行都会撞上，并发只会更频繁。

    只重试**明确可重试**的错误，不可重试的立刻抛出：
      可重试  429（限流）、5xx（服务端抖动）、网络层 ERR（连接中断/超时）
      不可重试 400/401/403/404（提示词违规、密钥错、模型不存在 —— 重试只是白烧配额）
              以及任务状态 violation（内容违规，重试同样违规）

    退避用 2s/4s/8s 三档，每档加随机抖动，避免多线程同时重试再次撞上限流。
    """
    attempts = max(1, int(cfg.get("retries") or 3))
    last = None
    for i in range(attempts):
        try:
            if cfg.get("channel") == CHANNEL_OPENAI:
                return _generate_openai(cfg, prompt, images, size, quality)
            return _generate_grsai(cfg, prompt, images, size, quality)
        except Exception as e:
            last = e
            msg = str(e)
            if not _is_retryable(msg) or i == attempts - 1:
                raise
            wait = (2 ** (i + 1)) + random.uniform(0, 1.2)
            print(f"  ↻ 可重试错误（第 {i + 1}/{attempts - 1} 次重试，等 {wait:.1f}s）：{msg[:120]}",
                  flush=True)
            time.sleep(wait)
    raise last


def _is_retryable(msg):
    """判断错误是否值得重试。**宁可少重试，不可重试违规类错误**。

    违规（violation / 400 内容相似性）重试必然还是违规，只会白烧配额和时间；
    而 429 与网络抖动是瞬时的，重试大概率成功。
    """
    low = (msg or "").lower()
    # 明确不可重试的优先判定（否则下面的 400 规则会漏掉 violation 里的其他数字）
    if "violation" in low or "violat" in low:
        return False
    if "没有解析到" in msg or "没有结果" in msg or "未返回任务" in msg:
        return False
    if "401" in msg or "403" in msg or "404" in msg:
        return False
    if "400" in msg:
        return False
    # 可重试
    if "429" in msg:
        return True
    if "超时" in msg or "timeout" in low or "timed out" in low:
        return True
    if "err" in low and "http err" in low:
        return True
    for code in ("500", "502", "503", "504"):
        if code in msg:
            return True
    if "connection" in low or "reset" in low or "eof" in low or "urlopen" in low:
        return True
    return False


def _generate_grsai(cfg, prompt, images, size, quality):
    """一次生成 = 一次计费。images 是 base64 列表（0–2 张：画风参考、资产参考）。

    接口实测支持 1–6 张参考图，所以画风垫图与资产垫图可以同时给。
    返回 (bytes, elapsed_s, result_url)。
    """
    payload = {"model": cfg["model"], "prompt": prompt,
               "images": [b for b in (images or []) if b],
               "aspectRatio": size or cfg["size"], "quality": quality or cfg["quality"],
               "replyType": "async"}
    t0 = time.time()
    st, raw = http(cfg["submitUrl"], cfg["key"], json.dumps(payload).encode())
    txt = raw.decode("utf-8", "replace")
    if st != 200:
        raise RuntimeError(f"提交失败 HTTP {st}: {txt[:300]}")
    j = json.loads(txt)
    task_id = j.get("id")
    if not task_id:
        raise RuntimeError(f"未返回任务 id: {txt[:300]}")
    status = str(j.get("status", "")).lower()
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        if status == "succeeded":
            break
        if status in ("failed", "violation", "cancelled", "canceled"):
            raise RuntimeError(f"任务 {status}: {json.dumps(j, ensure_ascii=False)[:300]}")
        time.sleep(POLL_INTERVAL)
        st2, raw2 = http(f"{cfg['resultUrl']}?id={task_id}", cfg["key"], method="GET", timeout=60)
        if st2 != 200:
            continue
        try:
            j = json.loads(raw2.decode("utf-8", "replace"))
        except Exception:
            continue
        status = str(j.get("status", "")).lower()
    else:
        raise RuntimeError(f"轮询超时（最后状态 {status}）")
    urls = [it.get("url") for it in (j.get("results") or [])
            if isinstance(it, dict) and it.get("url")]
    if not urls:
        raise RuntimeError("任务成功但没有结果 url")
    st3, blob = http(urls[0], cfg["key"], method="GET", timeout=180)
    if st3 != 200 or len(blob) < 1000:
        raise RuntimeError(f"下载图片失败 HTTP {st3}")
    return blob, time.time() - t0, urls[0]


def png_size(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        try:
            w, h = struct.unpack(">II", data[16:24])
            return w, h
        except Exception:
            return None, None
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        # VP8X / VP8 / VP8L 三种块，尺寸位置不同
        try:
            chunk = data[12:16]
            if chunk == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return w & 0x3FFF, h & 0x3FFF
            if chunk == b"VP8L":
                b = data[21:25]
                bits = struct.unpack("<I", b)[0]
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            if chunk == b"VP8X":
                w = int.from_bytes(data[24:27], "little") + 1
                h = int.from_bytes(data[27:30], "little") + 1
                return w, h
        except Exception:
            return None, None
    if data[:2] == b"\xff\xd8":
        i = 2
        try:
            while i < len(data) - 9:
                if data[i] != 0xFF:
                    i += 1
                    continue
                mk = data[i + 1]
                if mk in (0xC0, 0xC1, 0xC2):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return w, h
                seg = struct.unpack(">H", data[i + 2:i + 4])[0]
                i += 2 + seg
        except Exception:
            return None, None
    return None, None


def image_ext(data):
    """按**真实字节**判图片后缀。上游同一批任务里 PNG / WEBP 会混着返回，
    一律按 .png 存会让下游（PIL、拼版、公众号上传）在很远的报错点炸掉。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:2] == b"\xff\xd8":
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return "png"


# ── 文本模型配置 ────────────────────────────────────────────────
#
# 三个通道，按顺序降级：
#   ① textModel = "openai" → 用设置页配的外部服务（**不限 GRS AI**，任何 OpenAI 兼容站）
#   ② textModel = "dsh"    → 走 DSH 主对话的模型（默认）
#   ③ 前两条都不可用        → 回退中转站 + TEXT_MODEL
#
# 字段对应关系（2026-11-13 改成三字段结构）：
#   textModel        通道：dsh / openai
#   textModelBaseUrl 接口地址（openai 通道）
#   textModelModel   模型名（openai 通道）
#   textModelKey     API Key（openai 通道）



def ref_to_b64(path):
    """参考图统一转 PNG 再 base64。

    为什么统一转 PNG：网关对 webp 上传的兼容性未知，PNG 已验证可用。
    另外缩到 1024 以内，避免大图把请求体撑爆。
    """
    try:
        from PIL import Image
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((1024, 1024))
            buf = io.BytesIO()
            im.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        # 打不开就原样读 —— 让上游自己去报错，别在这里静默改成空
        return base64.b64encode(io.open(path, "rb").read()).decode("ascii")


def _cfg(key, env_name=""):
    """统一读配置：settings 表优先 → 环境变量兜底。

    走 appconfig，它的顺序是 settings → 环境变量 → aws.env → 注册表。
    这样设置页改了立刻生效，不用重启进程。
    """
    try:
        import appconfig
        v = (appconfig.get(key) or "").strip()
        if v:
            return v
    except Exception:
        pass
    return (os.environ.get(env_name) or "").strip() if env_name else ""


def _text_channel():
    """文本模型通道。目前只有 openai（OpenAI 兼容服务）。

    2026-11-16 移除了 dsh 通道，但**保留这个函数** ——
    以后要加别的协议（如 Anthropic messages），在这里加个分支就行。

    注意：这里**不再把 'dsh' 当成合法值返回**。
    以前它原样返回 'dsh'，调用方再报「不支持的通道」，
    于是老安装（库里还存着 dsh）每次润色/分镜都直接失败，
    而界面上又看不出原因 —— 属于自己给自己留的坑。
    现在一律归到 openai：配置项本来就还在库里，
    归一之后老用户不用重填就能继续用。
    """
    v = (_cfg("textModel", "") or "").strip().lower()
    if v == "openai":
        return "openai"
    # 旧值 'dsh'、或历史遗留的模型名，统统按 openai 处理
    return "openai"


def _text_model_name():
    """openai 通道用哪个模型名。

    优先 textModelModel（新字段）；兼容旧配置时用 textModel 里那个值；最后兜底。
    """
    explicit = (_cfg("textModelModel", "") or "").strip()
    if explicit:
        return explicit
    v = (_cfg("textModel", "") or "").strip()
    if v and v.lower() not in ("dsh", "openai"):
        return v
    return "gemini-2.5-flash"


def _text_base_url():
    """openai 通道的接口地址。

    支持两种填法：
      · 完整端点 https://xxx/v1/chat/completions  → 直接用
      · 只填域名   https://xxx                    → 补 /v1/chat/completions
    留空则用生图中转站域名拼。
    """
    v = (_cfg("textModelBaseUrl", "") or "").strip()
    if not v:
        host = (_cfg("imageBaseUrl", "") or "").strip() or "https://grsai.dakka.com.cn"
        # imageBaseUrl 可能是完整图片端点，取域名部分
        m = re.match(r"^(https?://[^/]+)", host)
        host = m.group(1) if m else host
        return host.rstrip("/") + "/v1/chat/completions"
    v = v.rstrip("/")
    if v.endswith("/chat/completions"):
        return v
    if v.endswith("/v1"):
        return v + "/chat/completions"
    return v + "/v1/chat/completions"


def _text_key():
    """openai 通道的 API Key。

    优先级：textModelKey（文本模型专用）→ imageModelKey（生图那个）。
    回退是刻意的：很多人文本和生图用同一家中转站、同一个 Key，省一次填写。
    但**只有接口地址也指向同一家时回退才安全** —— 这点由 _text_cfg_ready() 兜住。
    """
    return (_cfg("textModelKey", "") or _cfg("imageModelKey", "IMAGE_MODEL_API_KEY") or "")


def _text_key_is_explicit():
    """文本模型是否配了自己的 Key（不是从生图那边借的）。"""
    return bool((_cfg("textModelKey", "") or "").strip())


def _text_cfg_ready():
    """openai 通道是否真的可用，返回 (可用?, 原因)。

    **有意不降级**：只要用户把通道选成了 openai，配置不全就在①返回明确错误，
    而不是悄悄切到 DSH。理由：用户选了 openai 就是想用外部服务，
    悄悄切走会让他以为配置生效了，实际却在用 DSH —— 这种"静默成功"最难排查。

    判据：
      · 模型名必须有（_text_model_name 的有兜底值，所以这里单独看 textModelModel）
      · 接口地址必须有
      · Key 必须有 —— 借用生图 Key 时，**地址必须和生图同源**，
        否则等于拿 A 家的钥匙开 B 家的门，一定失败。
    """
    explicit_model = (_cfg("textModelModel", "") or "").strip()
    legacy_model = (_cfg("textModel", "") or "").strip()
    has_model = bool(explicit_model) or (legacy_model and legacy_model.lower() not in ("dsh", "openai"))
    url = _text_base_url()
    key = _text_key()

    if not has_model:
        return False, "没填「文本模型 · 模型名称」"
    if not url:
        return False, "没填「文本模型 · API 地址」"
    if not key:
        return False, "没有任何可用的 Key（「文本模型 · API Key」和「生图 · API Key」都空）"
    if _text_key_is_explicit():
        return True, ""
    # Key 是借生图的 —— 地址必须同源
    import urllib.parse as _up
    try:
        a = _up.urlparse(url).netloc
        b = _up.urlparse((_cfg("imageBaseUrl", "") or "")).netloc
    except Exception:
        return True, ""   # 解析不了就不拦，交给实际请求报错
    if a and b and a != b:
        return False, "接口地址和生图不是同一家，请单独填「文本模型 API Key」"
    return True, ""


TEXT_MODEL = "gemini-2.5-flash"


def _extract_json(text):
    """从模型返回里抠出 JSON。模型常在前后带解释、markdown 代码块或思考过程。

    2026-11-15 实测：deepseek 会把 reasoning 和正文一起吐出来，
    直接 json.loads 会报 Extra data / Expecting value。
    这里按优先级尝试：```
```json 块 → 第一个 [ 或 { 到最后一个 ] 或 } → 原文
    """
    import re as _re
    if not text:
        return None
    t = text.strip()

    # 1) markdown 代码块
    m = _re.search(r"```(?:json)?\s*([\s\S]*?)```", t)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except Exception:
            pass

    # 2) 尝试原文
    try:
        return json.loads(t)
    except Exception:
        pass

    # 3) 抠数组：第一个 [ 到最后一个 ]
    i, j = t.find("["), t.rfind("]")
    if i >= 0 and j > i:
        try:
            return json.loads(t[i:j + 1])
        except Exception:
            pass

    # 4) 抠对象
    i, j = t.find("{"), t.rfind("}")
    if i >= 0 and j > i:
        try:
            return json.loads(t[i:j + 1])
        except Exception:
            pass

    return None


def text_chat(system, user, workspace=WORKSPACE, max_tokens=800, temperature=None):
    """一次文本模型调用。**只走 OpenAI 兼容 API**。

    2026-11-16 移除了 DSH 通道：它返回带 reasoning 的无结构内容，
    要在 node 侧额外过滤才能用，链路长、故障点多。
    统一走 API 更简单可靠 —— 任何 OpenAI 兼容服务都能填。

    配置项（生图工作台 → 设置）：
      textModel        模型 id，如 deepseek-v4.1-flash-sg
      textModelBaseUrl 接口地址，填域名或完整端点都行
      textModelKey     API Key（留空则借用生图的 Key）
    """
    channel = _text_channel()
    if channel != "openai":
        return {"ok": False, "via": channel,
                "error": "不支持的文本模型通道：%s（当前只支持 OpenAI 兼容）" % channel}

    model = _text_model_name()
    url = _text_base_url()
    key = _text_key()

    if not model:
        return {"ok": False, "via": "api",
                "error": "没填「文本模型」。请在生图工作台「设置」里填写模型 id"}
    if not url:
        return {"ok": False, "via": "api",
                "error": "没填「文本模型接口地址」。请在生图工作台「设置」里填写"}
    if not key:
        return {"ok": False, "via": "api",
                "error": "没有可用的 API Key。请在「设置」里填文本模型 API Key，或配好生图 Key"}

    payload = {"model": model,
               "messages": [{"role": "system", "content": system},
                            {"role": "user", "content": user}],
               "max_tokens": max_tokens}
    if temperature is not None:
        payload["temperature"] = temperature

    try:
        st, raw = http(url, key, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       timeout=180)
    except Exception as e:
        return {"ok": False, "via": "api",
                "error": "请求异常（%s）：%s" % (type(e).__name__, str(e)[:200])}

    body_txt = (raw or b"").decode("utf-8", "replace")
    if st != 200:
        return {"ok": False, "via": "api",
                "error": "HTTP %s：%s" % (st, body_txt[:300])}
    if not body_txt.strip():
        return {"ok": False, "via": "api", "error": "接口返回空响应（HTTP 200 但没有 body）"}

    try:
        d = json.loads(body_txt)
    except Exception:
        return {"ok": False, "via": "api",
                "error": "接口返回的不是 JSON（前 300 字）：" + body_txt[:300]}

    if d.get("error"):
        msg = d["error"].get("message") if isinstance(d["error"], dict) else d["error"]
        return {"ok": False, "via": "api", "error": "接口报错：%s" % str(msg)[:200]}

    txt = (((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
    if not txt:
        return {"ok": False, "via": "api",
                "error": "返回里没有 choices 内容：" + body_txt[:200]}
    return {"ok": True, "text": txt, "model": model, "via": "api"}

# 润色用的系统提示词。
#
# 2026-11-17 修：这段常量原先**只有引用没有定义**（1846 行用了它，全文件找不到赋值），
# 所以点「帮我润色主题」必然抛 NameError: name 'POLISH_SYSTEM' is not defined，
# 而且错误一路冒到界面上就是个看不懂的 toast。补在这里，紧挨着唯一使用它的函数。
#
# 要点和 SPLIT_SYSTEM 的区别：分镜是拆成多格，润色是**改写成一句画面描述**，
# 不改用户的意图、不加原文没有的事实，只把「需求口吻」换成「可画的口吻」。
POLISH_SYSTEM = (
    "你是公众号配图的画面描述编辑。用户给你一段「需求式」的主题或一句话，"
    "你把它改写成**一句可以直接拿去生图的画面描述**。"
    "输出格式是硬性要求，违反就没法用："
    "1) **只输出那一句话本身**。不要解释、不要评论、不要编号、不要引号、"
    "不要 markdown、不要换行、不要「这句话说得很好」「适合……」这类读后感；"
    "2) 保留原意，**不新增**原文没有的事实、数字、人名、机构、时间；"
    "3) 把抽象需求落成可拍的具体画面：谁、在哪、做什么、什么景别、什么光；"
    "4) 不写情绪形容词，用动作和物件代替（「他很失落」→「他坐在床边，鞋没脱」）；"
    "5) 不出现文字要求（要写什么字、什么标题），那是另一个字段的事；"
    "6) 长度控制在 20 到 60 字；"
    "7) 原文已经是画面描述、没什么可改的，就原样返回，不要为了显得有用而改。"
    "\n示例 —— 输入「他很失落」→ 输出「他坐在床边，鞋没脱，屋里没开灯」。"
    "\n示例 —— 输入「想写就打开，不想写就关掉」→ 输出「一个人坐在书桌前，"
    "手边摊着没合上的本子，窗外天刚亮」。"
    "\n示例 —— 输入「秋天的夕阳，一个人坐在河堤上看远处亮起的路灯」→ 输出"
    "「秋天的夕阳把河面染成橘色，一个人坐在河堤上，看对岸的路灯一盏盏亮起来」。"
    "\n注意：输入常常是一整段文章或一句抽象观点，**不要复述它、不要评论它、"
    "不要给建议**，只把它转成一个能拍的画面。"
)


def _strip_commentary(text):
    """砍掉模型顺手补的「读后感」尾巴，保留画面描述本身。

    实测（gemini-2.5-flash）即使提示词写了「只输出一句话」，它仍会补一句评论：
      「河堤上吹着风，对岸的路灯一盏一盏亮起来……。适合发呆，也适合想点心事。」
    这类尾巴会直接进生图提示词，把画面带跑偏。

    为什么不用「只留第一句」：画面描述本身常是两句
    （「天色是慢慢暗下去的。河堤上坐着一个人，看着对岸的路灯。」），
    硬截会把主体砍掉。所以只砍**明显是评价/建议**的句子：
    以「适合 / 这 / 所以 / 建议 / 可以 / 值得」开头，且不含画面动作的，才丢。
    """
    s = (text or "").strip()
    if not s:
        return s
    # 按句末标点切成句子，保留标点
    parts, buf = [], ""
    for ch in s:
        buf += ch
        if ch in "。！？!?":
            parts.append(buf.strip())
            buf = ""
    if buf.strip():
        parts.append(buf.strip())
    if len(parts) <= 1:
        return s

    # 明显的评论性开头
    COMMENTARY = ("适合", "这年头", "所以", "建议", "可以当", "值得", "不得不",
                  "说起来", "总之", "换句话", "与之相比", "相比之下", "最难得",
                  "这样", "这般", "那一刻", "想想", "毕竟", "到底", "说实话")
    # 明显的评论性**收尾**：这些词出现在句末，基本就是读后感而不是画面
    TAIL = ("也挺好", "也很好", "挺好", "很舒服", "很美", "很治愈", "很暖",
            "很真实", "很实在", "已是难得", "够了", "真好", "不错", "有点意思")
    kept = []
    for i, p in enumerate(parts):
        head = p.lstrip("“”\"' 　")
        if i > 0 and any(head.startswith(k) for k in COMMENTARY):
            break            # 从第一句评论开始，后面全丢
        if i > 0 and any(p.rstrip("。！？!?").endswith(k) for k in TAIL):
            break            # 收尾是评价的，同样丢掉
        kept.append(p)
    out = "".join(kept).strip()
    return out or s


def _looks_like_caption(text):
    """判断一段输出是不是「一句画面描述」，而不是点评/教程/列表。

    实测 gemini-2.5-flash 面对长段落时会彻底跑偏：把它当成一篇待点评的文字，
    回一篇带编号、带引用块、还反问「你是想当口号还是产品文案？」的评论。
    这类输出直接当生图提示词是灾难，所以宁可多花一次调用重试，也不放它过去。

    判定只看**结构特征**，不猜语义：
      · 太长（>120 字）—— 画面描述不会这么长
      · 有换行 / 编号 / markdown 记号 —— 一定是结构化输出
      · 带问句 —— 在跟我对话，不是在描述画面
    """
    s = (text or "").strip()
    if not s:
        return False
    if len(s) > 120:
        return False
    if "\n" in s:
        return False
    if any(k in s for k in ("1.", "2.", "3.", "**", ">", "：\n", "- ", "？")):
        return False
    # 第二人称对话腔 —— 模型跑成「跟你聊天」的典型标志。
    # 实测「他很失落」会被它理解成情感咨询，回一句「听起来他现在很难过。你可以先陪着他……」
    # 长度没超标、也没换行，只靠上面的规则会漏过去，所以单列一条。
    for k in ("你可以", "你可以先", "建议你", "听起来", "希望你", "要不要我",
              "如果它", "想被", "往往更有用", "试试", "不妨"):
        if k in s:
            return False
    return True


def _strip_prefix(text):
    """去掉模型爱加的开头标签：「一句话画面：」「画面描述：」「输出：」等。

    这些不是内容，留着会跟着进生图提示词，模型会把「一句话画面」当画面内容理解。
    """
    s = (text or "").strip()
    for p in ("一句话画面：", "一句画面：", "画面描述：", "画面：", "描述：",
              "输出：", "改写后：", "润色后：", "画面内容：", "画面内容:",
              "一句话画面:", "画面描述:", "一张俯拍画面：", "俯拍画面：",
              "一张画面：", "一幅画面：", "图片描述：", "图像描述："):
        if s.startswith(p):
            s = s[len(p):].strip()
            break
    # 兜底：以「一张/一幅/一个……画面/封面/插图/配图：」这类通用标签开头的也去掉
    m = re.match(r"^(?:一张|一幅|一个|这句)?[^，。：:]{0,10}(?:画面|封面|插图|配图|图片|图像)[：:]\s*", s)
    if m and m.end() < len(s):
        s = s[m.end():].strip()
    return s


def polish_theme(theme, workspace=WORKSPACE):
    """把主题改写成画面描述。

    **只返回建议，绝不自动替换** —— 调用方必须让用户看过再决定。
    自动替换等于把用户写的东西悄悄改掉，那比不润色更糟（用户会以为模型理解错了）。
    """
    src = (theme or "").strip()
    if not src:
        return {"ok": False, "error": "theme required"}
    r = text_chat(POLISH_SYSTEM, src, workspace, 400)
    if not r.get("ok"):
        return r
    # 模型偶尔会加引号或换行，清掉；但**不改内容**
    out = r["text"].strip().strip('"').strip("“”").replace("\n", " ").strip()
    # 只砍「读后感」尾巴，不按句号硬截 —— 实测按第一句截会把画面主体砍掉
    # （「天色是慢慢暗下去的。河堤上坐着一个人……」→ 只剩前半句）。
    out = _strip_commentary(out)
    out = _strip_prefix(out)

    # 一次重试：结构不对（跑成点评/教程/反问）就换个问法再要一遍。
    # 提示词已经写得很硬了还是压不住长段落，靠校验兜底比继续加形容词有效。
    if not _looks_like_caption(out):
        r2 = text_chat(
            "你只输出一句中文画面描述，20 到 60 字，不解释不评论不反问不提建议。",
            "把下面这段文字转成一个能拍的画面，只回一句话：\n" + src,
            workspace, 200, temperature=0.3)
        if r2.get("ok"):
            out2 = r2["text"].strip().strip('"').strip("“”")
            out2 = out2.replace("\n", " ").strip()
            out2 = _strip_commentary(out2)
            out2 = _strip_prefix(out2)
            if _looks_like_caption(out2):
                out = out2
            else:
                # 两次都不合格：**截到第一句**当最后手段，总比把一篇评论塞进提示词好
                for i, ch in enumerate(out):
                    if ch in "。！？!?":
                        out = out[:i + 1].strip()
                        break
    if not out:
        return {"ok": False, "error": "模型返回了空内容"}
    return {"ok": True, "original": src, "polished": out, "model": TEXT_MODEL,
            "changed": out != src}


# ── 文章拆解（封面 / 配图）────────────────────────────────────────────
#
# 绘图工作台多了「选一篇文章」入口之后，需要两种拆解：
#   · 封面 —— 读**整篇**，提炼一句封面画面描述（COVER_SYSTEM）。
#     和 POLISH_SYSTEM 不是一回事：润色是「用户已经写了主题，改成可画的口吻」，
#     20–60 字、只看那一句；封面是「从一篇文章里无中生有」，15–30 字、要通读全文。
#     所以**不能复用** POLISH_SYSTEM，也不能 alias 成同一个常量。
#   · 配图 —— 读整篇，拆成 N 个分镜（沿用 SPLIT_SYSTEM 的语义拆镜，只是把整篇当文案喂进去）。
#
# 两种拆解都**只产出文字**：拆出来直接写进「画面主题与内容」框，
# 由用户看过再决定要不要出图。**不自动花掉一次出图**，也不自动替换用户已写的内容 ——
# 拆解是「给素材」，出图是「花钱」，两件事不能合并成一个按钮。
COVER_SYSTEM = (
    "你是一名插画师。给你一篇文章，你要为它想封面。"
    "\n\n"
    "**只给一句是不够的** —— 同一篇文章可以有完全不同的封面切法，"
    "编辑需要看到几种再挑一个。所以你要给 3 个候选，各走一个不同角度。"
    "\n\n"
    "3 个候选的角度分别固定为：\n"
    "1) **主体动作**：文中最有戏的那个人/那双手，正在做什么；\n"
    "2) **物件特写**：最能代表全文的那个东西，放大到近景，背景虚化；\n"
    "3) **环境全景**：一个能装下全文信息的场景，人物小、空间大。\n"
    "\n\n"
    "每句写法：只写画面里看得见的东西 —— 谁、在哪、做什么、什么景别、什么光。"
    "15 到 30 个字。"
    "\n\n"
    "参考这几句的样子：\n"
    "· 一个人蹲在堆满纸箱的旧屋里，手里攥着一把断掉的数据线\n"
    "· 深夜的办公桌前，三块屏幕同时亮着，人仰靠在椅背上闭着眼\n"
    "· 一只手把最后一块零件按进拼图，桌面上散着十几个小零件\n"
    "\n\n"
    "**不是**这样写的（这是文章总结，不是画面）：\n"
    "· 这篇文章讲了三条理念，分别是…… （✗ 复述内容，不可画）\n"
    "· 这篇我读完了，写得挺实在 （✗ 评价，不可画）\n"
    "· 初心、理念、改版说明 （✗ 关键词罗列，没有画面）\n"
    "\n\n"
    "输出格式是硬性要求，违反就没法用：\n"
    "只输出一个 JSON 数组，三行，形如\n"
    '["第一句画面描述", "第二句画面描述", "第三句画面描述"]\n'
    "不要解释、不要编号、不要 markdown、不要加粗、不要引号之外的任何字符。"
    "\n\n"
    "内容要求：\n"
    "1) **看整篇，不要只看标题**：文章的落点常在结尾，封面抓的是全文主张，不是开头那件事；"
    "2) 每一句都要能一眼看懂、缩略图尺寸下成立，不要一句里塞并列的多件事；"
    "3) 不写情绪形容词，用动作和物件代替（「他很焦虑」→「他把报表推到桌角，杯里的水在晃」）；"
    "4) **绝不在画面里写字**：不提标题字、不提大字、不提任何文字元素，封面一律纯画面；"
    "5) 不新增原文没有的事实、数字、人名、机构、时间。"
)

# 封面拆解只读这么多字：一篇 3000 字文章通读一遍足够，再多也只是浪费 token 和钱。
# 截断策略是**头重脚轻**（见 article_brief 里 _head_tail）：开头交代背景，结尾交代落点，
# 中间是最容易重复的论证段 —— 砍中间比砍结尾更不容易丢掉全文主张。
COVER_READ_CHARS = 3500


def _head_tail(text, limit):
    """把长文压到 limit 字以内：保开头保结尾，砍中间。

    不能简单 text[:limit] —— 公众号文章的落点几乎总在结尾，
    只取开头会得到「开头那件事」当封面，那正是现在配图不贴主题的老毛病。
    """
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    head = int(limit * 0.45)
    tail = limit - head
    return s[:head] + "\n\n……（中间省略）……\n\n" + s[-tail:]


def _looks_like_cover(out, src):
    """封面描述的结构校验：像不像一句能画的画面。

    实测（2026-11-17，v39 全文）：模型有一次直接回「这篇我读完了，写得挺实在」——
    12 字、不含写字段、也没撞 _strip_commentary 的前缀表，于是被当成画面描述放进主题框。
    主题框里出现评价文字，出图模型只会照着画一个「在读书的人」。
    所以这里按**必须有画面名词**来筛，不靠"看起来不像点评"这种模糊判断。
    """
    s = (out or "").strip()
    if len(s) < 8:
        return False
    if any(w in s for w in WRITE_IN_COVER) or any(w in s for w in WRITE_WORDS_COVER):
        return False
    # 必须有具体的画面元素：人/物/景/动作任一类词出现
    return any(w in s for w in COVER_SCENE_WORDS)


# 封面里**绝对不能出现**的写作类词（一旦出现就是在要求写字）
WRITE_WORDS_COVER = ("写着", "写上", "写字", "文字", "大字", "字体", "标题字",
                     "文案", "汉字", "标语", "字样")

# 只属于「读后感 / 评价」的说法，出现即判不合格
WRITE_IN_COVER = ("这篇", "读完", "写得", "文笔", "文章讲", "作者", "建议", "适合",
                  "很好", "不错", "可以说", "值得一提", "经验", "打底", "捏合",
                  "但", "却", "改一下", "润色", "优点", "缺点", "整体", "节奏")

# 画面上真能看见的东西：人物、物件、自然、动作。用来确认这不是一句空话。
COVER_SCENE_WORDS = (
    "一个人", "男人", "女人", "老人", "孩子", "少年", "背影", "侧脸", "双手", "手指",
    "桌", "椅", "窗", "门", "灯", "杯", "碗", "书", "纸", "笔", "手机", "屏",
    "车", "路", "桥", "河", "海", "山", "树", "草", "花", "云", "天", "雨", "雪",
    "街", "屋", "房", "墙", "楼", "阳", "光", "影", "床", "箱", "包", "衣",
    "站", "坐", "躺", "走", "跑", "看", "拿", "放", "推", "握", "靠", "俯", "仰",
)


def _flatten_cover_items(arr):
    """JSON 数组 → 纯字符串句子列表。

    模型有两种合法退化形状，都要吃掉：
      ["一句", "一句"]                          ← 期望的
      [{"angle": "主体动作", "description": "…"}]  ← 实测出现过（v24）
    第二种若只取 isinstance(x, str)，会把整个 dict 转成带花括号的串塞进主题框 ——
    出图模型会照着画「一个叫 angle 的标签」，界面里也是一坨 JSON。
    """
    out = []
    for x in (arr or []):
        if isinstance(x, str):
            t = x.strip()
            if t:
                out.append(t)
        elif isinstance(x, dict):
            # 按常见键名找那句描述，找不到就把所有字符串值拼起来当兜底
            for k in ("description", "desc", "scene", "prompt", "text", "brief", "sentence"):
                v = x.get(k)
                if isinstance(v, str) and v.strip():
                    out.append(v.strip())
                    break
            else:
                vals = [v.strip() for v in x.values()
                        if isinstance(v, str) and v.strip()]
                if vals:
                    # 最长的那句通常就是描述（angle/name 之类都很短）
                    out.append(max(vals, key=len))
    return out


def _clean_cover_options(raw):
    """模型回的封面候选 → 干净的句子列表。

    入口是脏的：可能套着 JSON 数组、可能是 markdown 列表、可能带编号、
    也可能干脆退化成一段话。**每种都要能吃掉**，吃不下就返回空列表交给重试，
    不能在这里抛异常 —— 上层是界面按钮，炸了用户只看到一个看不懂的 toast。
    """
    s = (raw or "").strip()
    if not s:
        return []
    items = []
    # 首选 JSON 数组
    data = _extract_json(s)
    if isinstance(data, list):
        items = _flatten_cover_items(data)
    elif isinstance(data, dict):
        # 模型偶尔包一层 {"options": [...]} 或 {"covers": [...]}
        for k in ("options", "covers", "candidates", "list"):
            if isinstance(data.get(k), list):
                items = _flatten_cover_items(data[k])
                break
    if not items:
        # 退回逐行：剥掉 - / * / 1. / 1) / 「」/ " " 这些壳
        for ln in s.splitlines():
            t = ln.strip()
            if not t or t.startswith("```") or t in ("[", "]"):
                continue
            t = re.sub(r"^\s*(?:[-*·]|\d+[.、)．])\s*", "", t)
            t = t.strip().strip('"').strip("“”").strip("「」").rstrip(",")
            if t:
                items.append(t)
    out = []
    for it in items:
        t = _strip_prefix(_strip_commentary(it.strip().strip('"').strip("“”")
                                            .replace("\n", " ").strip()))
        # 一句就是一句：模型偶尔在一个候选里补第二句
        for i, ch in enumerate(t):
            if ch in "。！？!?" and i >= 8:
                t = t[:i].strip()
                break
        if not t or not _looks_like_cover(t, ""):
            continue
        if t in out:                  # 去重：三个角度容易写出同一句
            continue
        out.append(t)
        if len(out) >= 3:
            break
    return out


def article_brief(text, workspace=WORKSPACE):
    """读一整篇文章，产出一句封面画面描述。

    只返回建议文本，**不改任何草稿文件、不出图** —— 调用方把它写进主题框，
    由用户看过再决定。和 polish_theme 一样是「给建议」的定位。
    """
    src = (text or "").strip()
    if not src:
        return {"ok": False, "error": "text required（先选一篇文章）"}
    body = _head_tail(src, COVER_READ_CHARS)
    # 为什么加这段包装：直接把正文丢给模型，它会默认进入「总结这篇文章」的模式 ——
    # 实测（2026-11-17，v39）三次都回了文章摘要或点评，哪怕系统提示词已经写了
    # 「只输出一句画面描述」。把「这是素材，不是待处理的任务」写进 user 消息里，
    # 才是模型真正看清自己要交什么的地方。
    user = ("下面是一篇文章的全文。**不要总结它、不要评价它**。\n"
            "你要交付的是 3 个不同角度的封面画面描述（主体动作 / 物件特写 / 环境全景）。\n"
            "现在直接输出那个 JSON 数组。\n\n"
            "【文章全文开始】\n" + body + "\n【文章全文结束】\n\n"
            "3 个封面画面（JSON 数组，每句 15 到 30 字，只写看得见的东西）：")
    r = text_chat(COVER_SYSTEM, user, workspace, 400, temperature=0.7)
    if not r.get("ok"):
        return r
    opts = _clean_cover_options(r.get("text") or "")
    # 一个合格的都没有：换个问法再要一遍（跟 polish_theme 同一思路 ——
    # 提示词已经写硬了还压不住，靠校验兜底比继续加形容词有效）。
    if not opts:
        r2 = text_chat(
            "给这篇文章想 3 个不同角度的封面画面，各一句话、15 到 30 字，"
            "只写看得见的东西：谁、在哪、做什么。不评价文章，不写字，不加引号。"
            "只输出 JSON 数组，如 [\"…\", \"…\", \"…\"]。",
            "【文章全文】\n" + body, workspace, 300, temperature=0.8)
        if r2.get("ok"):
            opts = _clean_cover_options(r2.get("text") or "")
    if not opts:
        return {"ok": False,
                "error": "模型没给出可用的封面画面（拿到的是点评式回复），再点一次试试",
                "raw": (r.get("text") or "")[:200]}
    # brief 保留成第一句，兼容老的调用方；options 是这次真正要给界面用的
    return {"ok": True, "options": opts, "brief": opts[0],
            "chars": len(opts[0]), "model": TEXT_MODEL}


# ── 智能分镜（语义拆解）──────────────────────────────────────────────
#
# 与 split_panels 的**分工**，两者都保留：
#   · split_panels —— 确定性，按段落/句子机械合并。快、免费、可复现，
#     但只在已有句子边界上切，请求镜数多于句子数时凑不出来（meta.short）。
#   · smart_split  —— 让模型理解内容后重新组织画面。能处理「一句话要拍五格」，
#     代价是一次文本调用。产出的每一格是**画面描述**而不是原文摘抄 ——
#     因为它要直接当出图提示词用。
SPLIT_SYSTEM = (
    "你是漫画分镜师。用户给你一段文案或主题，你把它拆成若干分镜。"
    "第一步先读懂剧情：谁认识谁、谁不知道什么、每句话的潜台词是什么。"
    "**对白是剧情信息，不是噪声** —— 一段对白往往决定了人物的表情、距离和视线，"
    "读漏了就会把熟人画成陌生人。先把它读懂，再决定落在哪一格的画面里。"
    "第二步按下面的格式输出每个分镜："
    "1) 只输出一个 JSON 对象，形如 "
    "{\"cast\": [{\"name\": \"人物名\", \"desc\": \"固定外形\"}], "
    "\"panels\": [{\"scene\": \"画面描述\", \"dialogue\": \"画内文字\", "
    "\"note\": \"后期要求\"}]}；"
    "不要解释、不要 markdown 代码块、不要编号；"
    "1.1) cast 是**全片固定的**人物外形：每个人一个发型、脸型、年龄感、"
    "服装与随身特征，写具体（如「寸头、圆脸、28 岁、灰卫衣」），"
    "不要写情绪和动作 —— 它要一字不改地出现在每一格，用来锁住长相。"
    "正文里出现过的每个有名字、有戏份的人都列上；没人的话给空数组；"
    "2) scene 是这一格画什么：一句话 20 到 40 字，写清谁、在哪、做什么、什么景别；"
    "**不要**在 scene 里重复 cast 的外形描述 —— 它每格都会自动带上；"
    "3) dialogue 是这一格里**要显示在画面上的字**：原文有对白就保留原话（可精简，不改意思），"
    "没有对白就给空字符串；不要自己编对白，也不要丢对白；"
    "4) 保留原文的含义与顺序，不要新增原文没有的事实、数字、人名、机构；"
    "5) 相邻格之间要有画面变化（景别、地点、动作、时间），不要几格画同一个场景；"
    "6) 第一格交代场景与主角，最后一格收尾；"
    "7) **同一个动作出现几次就保留几次**。重复往往就是笑点或节奏本身"
    "（比如「老板三次放屁、三次有人抢着认领」），合并或省掉一次等于把结构拆了。"
    "静态画面画不出的事件（放屁、响声、气味），用**人物的反应**来表现，"
    "但分镜文字里要把**事件**写出来，后期配音和音效才有落点；"
    "8) 原文里若写了「拍摄建议」「后期要求」这类内容，把它放进对应那一格的 "
    "note 字段（重复几遍、滤镜、语速、配乐等），**不要丢、也不要塞进 scene** "
    "—— scene 只描述画面。"
)


def smart_split(text, want=0, workspace=WORKSPACE):
    """用文本模型把内容拆成分镜。返回 {ok, panels, meta}。

    解析策略分三层，**顺序不能换**：
      1) 正常要 JSON，`_extract_json` 四级抠取；
      2) 抠不出就带着「格式纠正」再问一次 —— 这才是治本的：模型走偏的形式
         是**无穷的**（markdown 脚本、方框流程图、表格、编号清单……都实测出现过），
         逐种写兜底解析永远追不完，而一句「只回 JSON」+ 原文重发能一次纠正；
      3) 还不行才用 markdown 兜底抢救（它确实能救回一部分，且不花钱）。
    """
    src = (text or "").strip()
    if not src:
        return {"ok": False, "error": "text required"}
    want = max(0, min(int(want or 0), 24))
    ask = (f"拆成恰好 {want} 格。" if want > 0 else "根据内容决定格数，控制在 2 到 8 格之间。")
    # 温度压低：实测同一段文本在默认温度下会拆出 6 格或 7 格两种结果，
    # 用户按上次的格数做连贯漫画时对不上。分镜要的是稳定，不是随机发挥。
    r = text_chat(SPLIT_SYSTEM, ask + "\n\n文案：\n" + src, workspace, 2000,
                  temperature=0.3)
    if not r.get("ok"):
        return r
    raw = r["text"].strip()
    # 用 _extract_json 统一处理：它按「代码块 → 原文 → 抠数组 → 抠对象」四级尝试。
    # 原来这里自己写的正则 `[{[].*[}]]` 是**贪婪匹配**，会从第一个 [ 一直吃到最后一个 ]，
    # 模型后面若还有重复内容就会整段带上 → 报 Extra data（实测踩过）。
    data = _extract_json(raw)
    if data is None:
        # ── 第 2 层：格式纠正重试（预填充法）──
        # 实测模型换着花样走偏：markdown 脚本、方框流程图、编号提纲、表格……
        # **每补一种解析器它就换一种**，这条路追不完。
        # 这层不再"请求它回 JSON"，而是**把 JSON 的开头塞给它当上下文**，
        # 让它只能往下续写 —— 比任何措辞约束都硬（等于替它写完了第一个字符）。
        fix = text_chat(
            "你只输出 JSON，不要任何其他字符。不要 markdown、不要代码块围栏、"
            "不要表格、不要编号清单、不要流程图、不要解释、不要总结句。",
            ask + "\n\n文案：\n" + src +
            '\n\n直接从这里续写，不要重复开头：\n{"cast": [], "panels": [{"scene": "',
            workspace, 2000, temperature=0.1)
        if fix.get("ok"):
            # 补回被预填吃掉的 JSON 头部再解析
            glued = '{"cast": [], "panels": [{"scene": "' + fix["text"].strip()
            data = _extract_json(glued) or _extract_json(fix["text"].strip())
            if data is not None:
                raw = glued
    if data is None:
        # ── 第 3 层：兜底抢救 ──
        # 模型走偏的形状是**开放的**：实测出现过 markdown 脚本、方框流程图、
        # 编号提纲三种。这里按「信息最全 → 最差」的顺序各试一次，
        # 救回来的都标记 source，用户看得出这批是降级的、可以点重拆。
        for rescuer, tag in ((_rescue_markdown_panels, "markdown-fallback"),
                             (_rescue_table_panels, "table-fallback"),
                             (_rescue_numbered_panels, "numbered-fallback"),
                             (_rescue_box_panels, "box-fallback")):
            rescued = (rescuer(raw, want) if rescuer is _rescue_markdown_panels
                       else rescuer(raw))
            if rescued:
                return {"ok": True, "panels": [x["scene"] for x in rescued],
                        "dialogues": [x["dialogue"] for x in rescued],
                        "notes": [x["note"] for x in rescued],
                        "cast": [], "items": rescued,
                        "meta": {"requested": want, "produced": len(rescued),
                                 "withDialogue": sum(1 for x in rescued if x["dialogue"]),
                                 "withNotes": sum(1 for x in rescued if x["note"]),
                                 "castCount": 0,
                                 "short": want > 0 and len(rescued) < want,
                                 "source": tag, "splitter": tag.split("-")[0],
                                 "auto": want <= 0}}
        return {"ok": False, "error": "模型返回里找不到合法 JSON", "raw": raw[:400]}

    # 形状兼容：新格式是 {cast, panels} 对象，旧格式（以及模型偶发退化）
    # 是纯数组。两种都收，不因为形状变化就整段失败。
    cast = []
    if isinstance(data, dict):
        panels = data.get("panels")
        for c in (data.get("cast") or []):
            if isinstance(c, dict):
                nm = str(c.get("name") or "").strip()
                ds = str(c.get("desc") or "").strip()
                if nm and ds:
                    cast.append({"name": nm, "desc": ds})
    else:
        panels = data
    if not isinstance(panels, list):
        return {"ok": False, "error": "模型没返回 JSON 数组", "raw": raw[:300]}
    # 归一成 {scene, dialogue}。**兼容纯字符串**：旧版提示词与模型偶发退化
    # 都会给出字符串数组，那时 scene=该串、dialogue 为空，而不是整段报错。
    norm = []
    for it in panels:
        if isinstance(it, dict):
            scene = str(it.get("scene") or it.get("画面") or "").strip()
            dlg = str(it.get("dialogue") or it.get("台词") or "").strip()
            note = str(it.get("note") or it.get("备注") or "").strip()
        else:
            scene, dlg, note = str(it).strip(), "", ""
        if scene or dlg:
            norm.append({"scene": scene, "dialogue": dlg, "note": note})
    norm = norm[:24]
    if not norm:
        return {"ok": False, "error": "模型返回了空分镜", "raw": raw[:300]}
    has_dlg = sum(1 for x in norm if x["dialogue"])
    return {"ok": True,
            # panels 仍是字符串数组（画面描述）——调用方（路由/界面）按这个用；
            # dialogues 与它**同长度同顺序**，两条信息分开存，谁也不挤谁。
            "panels": [x["scene"] for x in norm],
            "dialogues": [x["dialogue"] for x in norm],
            # 后期备注：原文写了拍摄建议时，它会落在对应格上。
            # 这一项**不进出图提示词** —— 滤镜、语速、配乐都不是画面内容。
            "notes": [x["note"] for x in norm],
            # 全片固定的人物外形。调用方把它并进系列 constraint，逐格复用。
            "cast": cast,
            "items": norm,
            "meta": {"requested": want, "produced": len(norm),
                     "withDialogue": has_dlg,
                     "withNotes": sum(1 for x in norm if x["note"]),
                     "castCount": len(cast),
                     "short": want > 0 and len(norm) < want,
                     "source": "ai", "splitter": "ai", "auto": want <= 0}}


def _rescue_table_panels(raw):
    """从 markdown 表格里抢救分镜（实测出现过的第五种形状）。

        | 格数 | 画面 | 文案 | 作用 |
        |---|---|---|---|
        | 1 | 加油机付款屏特写，金额被手指挡住一半 | 新闻说油价跌回8元了… | 开场抛出反差 |

    「画面」列就是要的 scene，「文案」列当 dialogue。列名不定，
    所以按表头猜：含「画面/场景/分镜」的列当 scene，含「文案/台词/对白」的当 dialogue。
    猜不出来就退回「第二列当画面」—— 表格里第一列几乎总是编号。
    """
    rows = []
    for ln in (raw or "").splitlines():
        t = ln.strip()
        if not t.startswith("|") or not t.endswith("|"):
            continue
        cells = [c.strip() for c in t.strip("|").split("|")]
        if not cells:
            continue
        # 分隔行 |---|---|
        if all(re.fullmatch(r":?-{2,}:?", c or "-") for c in cells if c):
            continue
        rows.append(cells)
    if len(rows) < 2:
        return []

    header = rows[0]
    def find(keys, dflt):
        for i, h in enumerate(header):
            if any(k in h for k in keys):
                return i
        return dflt
    i_scene = find(("画面", "场景", "分镜", "内容"), 1 if len(header) > 1 else 0)
    i_dlg = find(("文案", "台词", "对白", "文字"), -1)

    out = []
    for cells in rows[1:]:
        if not any(c for c in cells):
            continue
        scene = cells[i_scene] if i_scene < len(cells) else ""
        dlg = cells[i_dlg] if 0 <= i_dlg < len(cells) else ""
        scene = re.sub(r"\*\*|__", "", scene).strip()
        dlg = re.sub(r"\*\*|__", "", dlg).strip()
        if scene or dlg:
            out.append({"scene": scene or dlg, "dialogue": dlg if scene else "", "note": ""})
    out = out[:24]
    return out if len(out) >= 2 else []


def _rescue_numbered_panels(raw):
    """从「1. **标题**：描述」这种编号列表里抢救分镜。

    实测（2026-11-17，整篇 2380 字）这是模型**最常走的偏路**，两次调用都是这个形状：

        下面按内容节奏切成 8 格。
        1. **封面：加满一箱，钱没变**
           文案：新闻说油价跌回8元……
        2. **算账：该省的25块5去哪了**
           文案：50升，每升降五毛一……

    它把「拆分镜」理解成「写提纲」，但每一格的画面信息和文案都在，
    标题本身往往就是一句不错的画面描述。救回来比让用户白等强。
    """
    lines = (raw or "").splitlines()
    head_re = re.compile(r"^\s*(\d{1,2})[.、）)]\s+(.*)$")
    kv_re = re.compile(r"^\s*(?:文案|画面|旁白|台词|描述)\s*[：:]\s*(.*)$")
    groups, cur = [], None
    for ln in lines:
        t = ln.rstrip()
        if not t.strip() or t.strip().startswith("```"):
            continue
        m = head_re.match(t)
        if m:
            if cur:
                groups.append(cur)
            cur = {"head": m.group(2).strip(), "body": []}
            continue
        if cur is None:
            continue
        k = kv_re.match(t.strip())
        if k:
            cur["body"].append(k.group(1).strip())
        elif cur["body"] or len(t.strip()) < 120:
            # 续行：优先当画面/文案补充
            cur["body"].append(t.strip())
    if cur:
        groups.append(cur)

    out = []
    for g in groups:
        head = re.sub(r"\*\*|__", "", g["head"]).strip()
        # 去掉「封面：」「收尾：」这类栏目名，保留后面的画面词
        head = re.sub(r"^(?:封面|收尾|开头|结尾|标题)\s*[：:]\s*", "", head)
        body = "，".join(x for x in g["body"] if x)
        body = re.sub(r"\*\*|__", "", body).strip()
        scene = (head + ("，" + body if body else "")).strip("， ")
        scene = re.sub(r"\s+", " ", scene).strip()
        if scene:
            out.append({"scene": scene, "dialogue": "", "note": ""})
    out = out[:24]
    return out if len(out) >= 2 else []


def _rescue_box_panels(raw):
    """从方框流程图里抢救分镜。

    实测（2026-11-17，整篇 2380 字）模型交过这种：

        ┌─────────────────────┐
        │ ① 加完油：数字没变   │
        │ 「跌回8元」却没省25块 │
        └──────────┬──────────┘
                   ▼
        ┌─────────────────────┐
        │ ② 22轮：14涨6跌2搁浅 │
        ...

    它在「表达结构」上是对的（每格一个框、顺序清楚），只是不是 JSON。
    框里的文字是**标题式短语**，不是完整画面描述 —— 所以救回来的东西
    质量不如 JSON，但比「报错让用户白等」好。上层会用 source 标记它，
    用户能看出这批分镜是降级的、可以重拆。
    """
    lines = (raw or "").splitlines()
    # 找出所有「框内内容行」：以 │ 或 | 开头结尾
    inner = []
    for ln in lines:
        t = ln.strip()
        if not t:
            continue
        # 方框竖线（多种 unicode 变体）
        if re.match(r"^[│┃|].*[│┃|]$", t):
            body = t[1:-1].strip()
            if body:
                inner.append(body)
    if not inner:
        return []
    # 按编号聚合成格：① ② / 1. 2. / 第1格
    num_re = re.compile(r"^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫]|\d{1,2}[.、）)]|第\s*\d{1,2}\s*格)\s*")
    groups, cur = [], None
    for body in inner:
        if num_re.match(body):
            if cur:
                groups.append(cur)
            cur = [num_re.sub("", body).strip()]
        elif cur is not None:
            cur.append(body)
    if cur:
        groups.append(cur)
    out = []
    for parts in groups:
        scene = "，".join(p for p in parts if p).strip()
        scene = re.sub(r"\s+", " ", scene).strip()
        if scene:
            out.append({"scene": scene, "dialogue": "", "note": ""})
    out = out[:24]
    return out if len(out) >= 2 else []


def _rescue_markdown_panels(raw, want=0):
    """从 markdown 分镜脚本里抢救出分镜：不是 JSON，但信息是全的。

    实测（2026-11-17，用整篇文章拆分镜）模型交的是这种：

        # 8格漫画脚本
        **格1｜加油站近景** 或 **格1｜加油站近景**
        一个人站在加油机前低头看付款屏幕……
        旁白：油价跌回8元了。可这箱油的钱……
        **格2｜账本特写**
        ……

    能救就救，因为画面描述和台词都在里面，报错只让用户白等一次；
    但**救不了就老实返回空**，绝不硬凑 —— 拼错的分镜比没分镜更糟。
    """
    lines = (raw or "").splitlines()
    # 分镜起始行：**格1｜xxx** / 格1｜xxx / **第1格** / 1. xxx（带「格」或景别词）
    head_re = re.compile(
        r"^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:格|第)\s*(\d{1,2})\s*(?:格)?"
        r"\s*(?:[｜|:：]\s*)?(.*?)\s*(?:\*\*)?\s*$")
    dlg_re = re.compile(r"^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:旁白|台词|对白|画内文字)"
                        r"\s*(?:[｜|:：])\s*(.*?)\s*(?:\*\*)?\s*$")
    items = []
    cur = None
    for ln in lines:
        t = ln.rstrip()
        if not t.strip() or t.strip().startswith("#"):
            continue
        m = head_re.match(t)
        # 只认「明确的格子标题」：光有数字不算，得带「格」或后面有景别/画面词
        if m and ("格" in t.split("｜")[0] or "格" in t.split("|")[0]
                  or re.search(r"[｜|]", t) or len(m.group(2)) <= 20):
            if cur:
                items.append(cur)
            label = (m.group(2) or "").strip().strip("*").strip()
            cur = {"scene": [], "label": label, "dialogue": "", "note": ""}
            continue
        if cur is None:
            continue
        d = dlg_re.match(t)
        if d:
            cur["dialogue"] = (cur["dialogue"] + " " + d.group(1).strip()).strip()
            continue
        # 其余行当画面描述（去掉 markdown 粗体符号）
        cur["scene"].append(t.strip().strip("*").strip())
    if cur:
        items.append(cur)

    out = []
    for it in items:
        # 景别标签（「加油站近景」）本身是有效画面信息，拼在描述前面
        parts = [it["label"]] if it["label"] else []
        parts += [s for s in it["scene"] if s]
        scene = "，".join(p for p in parts if p).strip()
        scene = re.sub(r"\s+", " ", scene).strip()
        if not scene and not it["dialogue"]:
            continue
        out.append({"scene": scene, "dialogue": it["dialogue"], "note": it["note"]})
    out = out[:24]
    # 少于 2 格说明没真识别出结构，宁可返回空让上层报错
    return out if len(out) >= 2 else []


# ── 数据层读写 ───────────────────────────────────────────────────────

def db_api(payload):
    """唯一的写入通道：转调 image-db.py api（保持单写者）。

    请求体走 stdin，不拼命令行 —— Windows 命令行上限 32767 字符，
    base64 还会把体积放大 4/3，多镜分镜一次下发就能超（10 镜 × 1000 字 ≈ 41k）。
    超限时 libuv 抛 spawn ENAMETOOLONG，进程根本没起来，现场什么日志都没有。
    """
    body = json.dumps(payload, ensure_ascii=False)
    out = subprocess.run([sys.executable, "-X", "utf8", DB_SCRIPT, "api"],
                         input=body, capture_output=True, text=True, encoding="utf-8")
    line = (out.stdout or "").strip().split("\n")[-1]
    try:
        return json.loads(line)
    except Exception:
        raise RuntimeError(f"数据层调用失败: {out.stdout} {out.stderr}")


def write_back_illustrations(draft_id, workspace=WORKSPACE):
    """把某个系列已出的插图写回草稿：imgs/img-01..N → finalize.py 替换占位符。

    为什么不复用封面那条：封面是**一张图覆盖一个固定文件名**，
    插图是**一组图按顺序对应正文里的 N 个占位符**。后者要对齐、要够数、要重排版，
    finalize.py 已经把这件事做完了（占位符 → imgs/img-NN、数量不等就停），
    这里只负责把系列产出按 panel_index 摆放成它认识的命名。

    三条硬约束（来自 finalize.py:131）：
      · 图片文件名必须以 img- 开头，否则它当「非正文图」过滤掉；
      · 数量必须与正文占位符**严格相等**，否则它直接停下不排版；
      · 封面不进正文（占位符里带「封面」字样的会被置空）。
    所以这里先数占位符，多了少了都明确报错，不猜。
    """
    did = str(draft_id or "").strip()
    if not did:
        return {"ok": False, "error": "draftId missing"}
    wb_script = os.path.join(HERE, "workbench-db.py")
    listed = _wb_api(wb_script, {"op": "list-drafts"})
    if not listed.get("ok"):
        return {"ok": False, "error": "查草稿失败：" + str(listed.get("error") or "")[:160]}
    draft = None
    for d in (listed.get("drafts") or []):
        if str(d.get("id")) == did:
            draft = d
            break
    if draft is None:
        return {"ok": False, "error": f"草稿 #{did} 不存在"}
    rel_dir = (draft.get("path") or "").strip().replace("\\", "/").strip("/")
    if not rel_dir:
        return {"ok": False, "error": f"草稿 #{did} 没有目录"}
    abs_dir = os.path.abspath(os.path.join(workspace, rel_dir))
    root = os.path.abspath(workspace)
    if abs_dir != root and not abs_dir.startswith(root + os.sep):
        return {"ok": False, "error": "草稿目录越界，拒绝写入"}

    # 1) 找出这篇对应的插图任务：params_json 里写了 draftId 且 role=article-illustration
    jobs = (db_api({"op": "image-list-jobs", "limit": 400}).get("jobs") or [])
    mine = []
    for j in jobs:
        try:
            p = json.loads(j.get("params_json") or "{}")
        except Exception:
            p = {}
        if str(p.get("draftId") or "") != did:
            continue
        if p.get("illustrationWriteBack") or p.get("role") == "article-illustration":
            mine.append((j, p))
    if not mine:
        return {"ok": False, "error": "这篇文章还没有配图任务"}

    # 2) 按 panel_index 排序取已完成的图。同一 panel 重跑过就取最新那张。
    by_panel = {}
    for j, p in mine:
        if j.get("status") != "done":
            continue
        rows = db_api({"op": "image-list-assets", "jobId": j["id"], "limit": 8}).get("assets") or []
        if not rows:
            continue
        idx = int(j.get("panel_index") or 0) or (len(by_panel) + 1)
        # assets 是倒序（最新在前），取第一条
        by_panel[idx] = rows[0]
    if not by_panel:
        return {"ok": False, "error": "配图还没出完（没有任何已完成的图）"}

    # 3) 数正文占位符（封面除外）—— 与 finalize.py 的算法一致
    md_path = os.path.join(abs_dir, "draft.md")
    if not os.path.isfile(md_path):
        return {"ok": False, "error": "这篇还没有 draft.md"}
    with io.open(md_path, encoding="utf-8") as f:
        text = f.read()
    marks = re.findall(r"!\[([^\]]+)\]\(placeholder\)", text)
    want = [m for m in marks if not m.startswith("封面")]
    got = len(by_panel)
    if want and got != len(want):
        return {"ok": False,
                "error": f"图数({got}) 与正文图位({len(want)}) 不一致，先补齐/删掉多余分镜再回写"}
    if not want:
        return {"ok": False, "error": "正文里没有图片占位符（先把图位插进正文）"}

    # 4) 摆放成 finalize.py 认识的 img-NN 命名。先清掉旧的 img-*，
    #    否则上一轮留下的图会让「图片数 ≠ 图位数」直接把它拦住。
    img_dir = os.path.join(abs_dir, "imgs")
    os.makedirs(img_dir, exist_ok=True)
    for old in os.listdir(img_dir):
        if old.startswith("img-") and os.path.splitext(old)[1].lower() in (
                ".png", ".webp", ".jpg", ".jpeg"):
            try:
                os.remove(os.path.join(img_dir, old))
            except Exception:
                pass
    placed = []
    for n, idx in enumerate(sorted(by_panel), 1):
        src = by_panel[idx].get("path")
        if not src or not os.path.isfile(src):
            return {"ok": False, "error": f"第 {idx} 镜的图文件找不到了：{src}"}
        ext = os.path.splitext(src)[1].lower() or ".png"
        dst = os.path.join(img_dir, f"img-{n:02d}{ext}")
        try:
            with open(src, "rb") as a, open(dst, "wb") as b:
                b.write(a.read())
        except Exception as e:
            return {"ok": False, "error": f"第 {n} 张图落盘失败：{e}"}
        placed.append(os.path.basename(dst))

    # 5) 跑 finalize：占位符替换 + 重排版（它自己会做引号修正、去引用、排版、校验）
    try:
        r = subprocess.run([sys.executable, "-X", "utf8", FINALIZE_SCRIPT, abs_dir],
                           capture_output=True, text=True, encoding="utf-8",
                           cwd=workspace, timeout=180)
    except Exception as e:
        return {"ok": False, "error": f"排版失败：{e}"}
    if r.returncode != 0:
        tail = ((r.stdout or "") + (r.stderr or "")).strip().split("\n")[-3:]
        return {"ok": False, "error": "finalize 失败：" + " / ".join(tail)[:300]}
    return {"ok": True, "inserted": len(placed), "files": placed}


def _wb_api(script, payload):
    """转调 workbench-db.py api（草稿在那个库，不在 image-db.py）。

    返回 {ok:False, error} 而不是抛异常 —— 调用方（封面回写）是「尽力而为」的路径，
    回写失败不该把整个出图任务判 failed：图已经出来了、钱已经花了。
    """
    body = json.dumps(payload, ensure_ascii=False)
    try:
        out = subprocess.run([sys.executable, "-X", "utf8", script, "api"],
                             input=body, capture_output=True, text=True,
                             encoding="utf-8", cwd=WORKSPACE)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    line = (out.stdout or "").strip().split("\n")[-1]
    try:
        return json.loads(line)
    except Exception:
        return {"ok": False,
                "error": f"数据层返回无法解析：{(out.stdout or '')[:160]} {(out.stderr or '')[:160]}"}


def read_job(job_id):
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM image_jobs WHERE id=?", (job_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ── run ──────────────────────────────────────────────────────────────

def run_job(job_id, workspace=WORKSPACE, log_prefix=""):
    job = read_job(job_id)
    if job is None:
        raise SystemExit(f"任务不存在：#{job_id}")
    db_api({"op": "image-take", "jobId": job_id})

    out_dir = os.path.join(OUT_ROOT, str(job_id))
    os.makedirs(out_dir, exist_ok=True)
    log_path = os.path.join(out_dir, "generation.log")
    logf = io.open(log_path, "a", encoding="utf-8")
    log_lock = threading.Lock()      # 同一任务内 arms 也可能并发，日志行不能交错

    def log(msg):
        # 并发跑漫画流时，多镜的日志会同时往一个 generation.log 里写。
        # 加 log_prefix（如 "[镜3]"）才能一眼分清哪行是哪一镜，否则交错成一团没法查。
        line = f"[{time.strftime('%H:%M:%S')}] {log_prefix}{msg}"
        with log_lock:
            print(line, flush=True)
            logf.write(line + "\n")
            logf.flush()

    try:
        cfg = load_model_cfg(workspace)
        if not cfg["key"]:
            raise RuntimeError("未配置 IMAGE_MODEL_API_KEY（见工作区 aws.env）")
        with_ref = bool(job.get("with_ref"))
        # 资产垫图存的是 JSON 数组（可多选角色/道具/场景）；兼容早期的单路径写法
        raw_assets = job.get("asset_ref_path") or ""
        if raw_assets:
            try:
                asset_refs = [p for p in json.loads(raw_assets) if p]
            except Exception:
                asset_refs = [raw_assets]
        else:
            asset_refs = []
        try:
            params = json.loads(job.get("params_json") or "{}")
        except Exception:
            params = {}
        # 风格融合走独立拼装路径（技能里本就是独立技能，不是给普通提示词加几行）
        if params.get("noStyle"):
            # 角色/道具/场景基准图：不依赖风格库
            built = build_bare_prompt(job.get("theme"), job.get("layout_id"),
                                      params.get("ratio") or "", job.get("color_id"),
                                      params.get("constraint") or "")
            built["assetRefs"] = asset_refs
            if asset_refs:
                built["sendZh"] = built["zh"] + "\n\n【资产一致性】" + asset_ref_text(asset_refs, "zh")
                built["sendEn"] = built["en"] + "\n\n[Asset consistency] " + asset_ref_text(asset_refs, "en")
        elif params.get("fusionOn"):
            built = build_fusion_prompt(job.get("style_id"), params.get("sceneStyle") or "",
                                        job.get("theme"), job.get("color_id"),
                                        job.get("layout_id"), params.get("ratio") or "",
                                        params.get("mood") or "",
                                        asset_refs=asset_refs, model=cfg["model"])
        else:
            built = build_prompt(job.get("style_id"), job.get("theme"),
                                 job.get("color_id"), job.get("layout_id"), with_ref,
                                 asset_refs=asset_refs, model=cfg["model"],
                                 mode=params.get("mode") or "pure-image",
                                 ratio=params.get("ratio") or "",
                                 whitespace=params.get("whitespace") or "",
                                 mood=params.get("mood") or "",
                                 subject=params.get("subject") or "",
                                 text_req=params.get("textReq") or "",
                                 constraint=params.get("constraint") or "",
                                 text_layout=params.get("textLayout") or "",
                                 redraw=bool(params.get("redraw")))
        dec = built.get("decision") or {}
        # 画幅 → 接口尺寸：不给尺寸就按画幅换算，换算不出才退回配置默认。
        # 这一步不能省：否则提示词写 3:4、实际按 1:1 出图，而且没有任何报错。
        # 融合模式没给画幅时技能规定默认 3:4，所以用 built 里的实际画幅而不是原始参数。
        eff_ratio = built.get("ratio") or params.get("ratio") or ""
        size = job.get("size") or size_for_ratio(eff_ratio) or cfg["size"]
        log(f"任务 #{job_id} 风格 {job.get('style_id')} 模型 {cfg['model']} 端点 {cfg['submitUrl']}")
        if built.get("fusion"):
            log(f"风格融合：角色 {job.get('style_id')} × 场景 {params.get('sceneStyle')}")
        log(f"画幅 {eff_ratio or '未指定'} → 接口尺寸 {size}")
        log(f"能力判定 {dec.get('activation_source')}（name={dec.get('name_activation')} "
            f"traits={dec.get('traits_activation')}）")
        log(f"模式 {built.get('mode')}｜画风垫图 {'有' if built['refPath'] else '无'}｜"
            f"资产垫图 {len(built.get('assetRefs') or [])} 张")

        ref_b64 = ref_to_b64(built["refPath"]) if built["refPath"] else ""
        asset_b64 = [ref_to_b64(p) for p in (built.get("assetRefs") or [])]
        arms = job.get("arms") or "ref"
        todo = ["text", "ref"] if arms == "both" else [arms]

        assets = []
        # arms=both 时两条道（垫图 / 纯文字）互不依赖，**并发跑**：
        # 一次任务两图，串行等于把等待翻倍。结果仍按 todo 顺序收集，文件名按 arm 区分不冲突。
        arm_results = {}
        if len(todo) > 1:
            with ThreadPoolExecutor(max_workers=len(todo)) as pool:
                futs = {}
                for arm in todo:
                    futs[pool.submit(
                        _run_arm, arm, job, built, cfg, ref_b64, asset_b64,
                        size, out_dir, job_id, log)] = arm
                for fut in as_completed(futs):
                    arm = futs[fut]
                    arm_results[arm] = fut.result()
        else:
            arm = todo[0]
            arm_results[arm] = _run_arm(arm, job, built, cfg, ref_b64, asset_b64,
                                        size, out_dir, job_id, log)
        for arm in todo:                 # 按 todo 顺序收，保证 asset 行序稳定
            assets.append(arm_results[arm])

        db_api({"op": "image-finish", "jobId": job_id, "assets": assets,
                "calls": len(assets), "model": cfg["model"], "endpoint": cfg["submitUrl"],
                "promptZh": built["zh"], "promptEn": built["en"],
                "usageNote": f"任务 #{job_id}"})
        log(f"完成：{len(assets)} 张（计费 {len(assets)} 次）")
        # 封面自动回写：**在 image-finish 之后**，图已经入库、账已经记上，
        # 回写即使出问题也不该影响「这张图算不算出成功」。
        wb = _write_back_from_job(job, assets, log)
        out = {"ok": True, "jobId": job_id, "assets": assets}
        if wb is not None:
            out["coverWriteBack"] = wb
        return out
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        log(f"失败：{msg}")
        try:
            db_api({"op": "image-fail", "jobId": job_id, "error": msg})
        except Exception:
            pass
        return {"ok": False, "jobId": job_id, "error": msg}
    finally:
        logf.close()


# ── 封面回写 ─────────────────────────────────────────────────────────
#
# 绘图工作台里选「文章封面 + 某篇文章」出的图，出完要**自动回写到那篇文章**：
# 落到 <草稿目录>/imgs/cover.png，并把 drafts.cover 指向它。
#
# 三个决定：
#   · 路径固定 imgs/cover.png —— check-cover.py:206 只认这一个文件名，
#     发布链路上传封面也按它找。改成像 img-01.png 那样编号就整条链路断了。
#   · 先备份 cover.png.bak 再覆盖 —— 用户重出一张封面，旧的那张不能凭空消失。
#   · 回写失败**不算任务失败**。图已经出来了、钱已经花了，
#     因为一个路径问题把整个任务判 failed，用户会以为图也没了。
#     所以这条路径吞异常，把结果放进返回值，界面按需提示。
def write_back_cover(asset_path, draft_id, workspace=WORKSPACE):
    """把出好的封面写回草稿。返回 {ok, cover, backup, error}。

    注意：草稿在**另一个库**（workbench-db.py），不是 image-db.py。
    db_api() 走的是 image-db.py，拿它查草稿只会得到 unknown op: list-drafts。
    """
    did = str(draft_id or "").strip()
    if not did:
        return {"ok": False, "error": "draftId missing"}
    if not asset_path or not os.path.isfile(asset_path):
        return {"ok": False, "error": f"封面文件不存在：{asset_path}"}
    wb_script = os.path.join(HERE, "workbench-db.py")
    listed = _wb_api(wb_script, {"op": "list-drafts"})
    if not listed.get("ok"):
        return {"ok": False, "error": "查草稿失败：" + str(listed.get("error") or "")[:160]}
    draft = None
    for d in (listed.get("drafts") or []):
        # id 是整数，draft_id 从 params_json 回来是字符串 —— 两边都按字符串比
        if str(d.get("id")) == did:
            draft = d
            break
    if draft is None:
        return {"ok": False, "error": f"草稿 #{did} 不存在"}
    rel_dir = (draft.get("path") or "").strip().replace("\\", "/").strip("/")
    if not rel_dir:
        return {"ok": False, "error": f"草稿 #{did} 没有目录"}
    # 目录越界守卫：path 是库里的数据，但库也可能被手改过
    abs_dir = os.path.abspath(os.path.join(workspace, rel_dir))
    root = os.path.abspath(workspace)
    if abs_dir != root and not abs_dir.startswith(root + os.sep):
        return {"ok": False, "error": "草稿目录越界，拒绝写入"}
    os.makedirs(os.path.join(abs_dir, "imgs"), exist_ok=True)
    dst = os.path.join(abs_dir, "imgs", "cover.png")
    backup = ""
    if os.path.isfile(dst):
        bak = dst + ".bak"
        try:
            if os.path.isfile(bak):
                os.remove(bak)
            os.replace(dst, bak)
            backup = os.path.relpath(bak, workspace).replace("\\", "/")
        except Exception as e:
            return {"ok": False, "error": f"备份旧封面失败：{e}"}
    try:
        with open(asset_path, "rb") as src, open(dst, "wb") as out:
            out.write(src.read())
    except Exception as e:
        return {"ok": False, "error": f"写封面失败：{e}"}
    cover_rel = os.path.relpath(dst, workspace).replace("\\", "/")
    upd = _wb_api(wb_script, {"op": "set-draft", "id": did, "cover": cover_rel})
    if not upd.get("ok"):
        return {"ok": False, "cover": cover_rel, "backup": backup,
                "error": f"封面已落盘，但库里的 cover 字段没更新：{upd.get('error')}"}
    return {"ok": True, "cover": cover_rel, "backup": backup}


def _write_back_from_job(job, assets, log):
    """按任务参数决定要不要回写封面，并对每一张都写（arms=both 时后一张覆盖前一张）。

    这么处理 arms=both 是**故意的**：两张都出了，无法替用户选哪张才是最终封面。
    按 todo 顺序（text 在前）收，所以留下来的是 ref 那张 —— 有风格垫图的那张。
    """
    try:
        params = json.loads(job.get("params_json") or "{}")
    except Exception:
        params = {}
    did = params.get("draftId")
    if not did or not params.get("coverWriteBack"):
        return None
    last = None
    for a in assets:
        r = write_back_cover(a.get("path"), did)
        log(f"封面回写 {did}：{'成功 → ' + r['cover'] if r.get('ok') else '失败（' + str(r.get('error')) + '）'}")
        last = r
    return last


# ── 漫画流：批量跑 ───────────────────────────────────────────────────

DEFAULT_CONCURRENCY = 3      # 并发出图默认路数，见 series_concurrency()


def _run_arm(arm, job, built, cfg, ref_b64, asset_b64, size, out_dir, job_id, log):
    """跑一条道（ref 垫图 / text 纯文字），返回一条 asset 记录。

    从 run_job 的循环体里抽出来，为的是 arms=both 时两条道能并发跑
    （见 run_job 里的 ThreadPoolExecutor）。抽出来也让"一条道失败"的语义更清楚：
    抛异常 → 整个任务判失败（image-finish 拿不到完整 assets），与原来一致。
    """
    use_ref = (arm == "ref")
    # **实发提示词**：图文模式下可复制版不含隔离块，但真发出去的那份要含
    prompt = built["sendZh"] if use_ref else built["zh"]
    # 融合路径**本来就不垫编号参考图**（技能契约是靠文字把两套风格完整展开），
    # 所以「没有参考图」对它来说是正常状态，不是错误 —— 之前这里一刀切地要求必须有图，
    # 结果融合任务自己把自己拦死了（RuntimeError: 任务要求垫图，但没有解析到任何参考图）。
    # 同理还有两类：基准图（bare）与**风格自己声明不垫**（styleNoRef，如 CS-002）——
    # 后者是「故意不垫」，不是「解析不到」，不能按错误处理。
    # 非融合路径下用户明确选了「垫入参考图」却解析不到图，那才是真错误（例如该风格没有样图）。
    if use_ref and not ref_b64 and not asset_b64 and not built.get("fusion") \
            and not built.get("bare") and not built.get("styleNoRef"):
        raise RuntimeError(
            f"任务要求垫入参考图，但风格 {job.get('style_id')} 没有解析到样图；"
            "请改用「只给文字」，或换一个带样图的风格")
    # 顺序必须与提示词里写的一致：先画风、后资产
    imgs = (([ref_b64] if ref_b64 else []) + asset_b64) if use_ref else []
    blob, dt, url = generate_once(cfg, prompt, imgs, size, job.get("quality"))
    w, h = png_size(blob)
    # 后缀按**真实字节**定，不能一律写 .png。
    #
    # 2026-11-17 实测：同一个接口同一批任务，#417 返回的是 WEBP 而其余是 PNG。
    # 存成 xxx.png 后 PIL 报「extension declares image/png but the bytes use a different
    # image format」，下游看图、拼版、公众号上传全都会断，而且报错点离真因很远。
    ext = image_ext(blob)
    name = f"{job_id}-{arm}.{ext}"
    path = os.path.join(out_dir, name)
    with open(path, "wb") as f:
        f.write(blob)
    rel = os.path.relpath(path, WORKSPACE).replace("\\", "/")
    log(f"  {arm} 出图成功 {w}x{h} {len(blob)}B 用时 {dt:.0f}s")
    return {"arm": arm, "path": path, "relPath": rel, "bytes": len(blob),
            "width": w, "height": h, "model": cfg["model"],
            "elapsedMs": int(dt * 1000), "styleId": job.get("style_id"),
            "theme": job.get("theme")}


def series_concurrency():
    """漫画流并发出图的路数。**默认 3**，可用设置页 / 环境变量调。

    为什么默认 3 而不是「越多越好」：
      - 单张出图本身是网络等待（提交后每 3 秒轮询一次），所以并发的收益
        几乎全部来自「多张同时在等」，3 路就能吃掉大部分等待；
      - 接口会限流（429），路数越高撞限流概率越大，而重试会吃掉收益；
      - 每路是一个线程 + 一次完整读盘，再高对单机也是负担。

    读取优先级：环境变量 DSH_WORKBENCH_IMAGE_CONCURRENCY > settings 表 > 默认 3。
    上限 8、下限 1：0 或负数会让整个漫画流卡死，必须夹住。
    """
    raw = (os.environ.get("DSH_WORKBENCH_IMAGE_CONCURRENCY") or "").strip()
    if not raw:
        try:
            import appconfig
            raw = str(appconfig.get("imageConcurrency", "") or "").strip()
        except Exception:
            raw = ""
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = DEFAULT_CONCURRENCY
    return max(1, min(8, n))


def run_series(series_id, workspace=WORKSPACE):
    """跑完一个漫画流的所有待跑分镜。**多镜并发出图**（2026-11-16 改）。

    原来这里是 `for j in jobs: run_job(...)` 严格串行 —— 一个 6 镜的漫画流
    要等 6 次「提交 → 每 3 秒轮询 → 下载」，而每张图实际耗时中位数 43 秒，
    其中绝大部分是轮询空转。并发后多镜同时等，墙钟时间大幅下降。

    为什么是线程池而不是多进程：单张出图的瓶颈是网络等待（`time.sleep` 轮询），
    Python 的 GIL 在 IO 等待时会释放，线程池足够；而多进程要各自重新加载风格索引、
    逐个读盘解析，反而更慢，还会让日志分裂成 N 个文件。

    并发路数见 series_concurrency()，默认 3。**结果仍按镜序输出**：
    虽然完成顺序是乱的，但汇总时按 panel_index 排序，报错信息也带镜号。
    """
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        s = conn.execute("SELECT * FROM image_series WHERE id=?", (series_id,)).fetchone()
        if s is None:
            raise SystemExit(f"漫画流不存在：#{series_id}")
        jobs = conn.execute(
            "SELECT id, panel_index FROM image_jobs WHERE series_id=? AND status IN ('queued','running') "
            "ORDER BY panel_index", (series_id,)).fetchall()
    finally:
        conn.close()

    db_api({"op": "series-update", "seriesId": series_id, "status": "running", "error": None})
    total = len(jobs)
    workers = min(series_concurrency(), total) if total else 1
    print(f"漫画流 #{series_id}：{total} 镜，并发 {workers} 路", flush=True)

    results = {}
    if total:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {}
            for j in jobs:
                # 镜号从 1 数起更符合人的习惯（库里 panel_index 从 0 开始）
                label = f"[镜{j['panel_index'] + 1}] "
                futs[pool.submit(run_job, j["id"], workspace, label)] = j
            for fut in as_completed(futs):
                j = futs[fut]
                try:
                    results[j["id"]] = fut.result()
                except Exception as e:
                    # run_job 自己会吞异常并标 image-fail，走到这里说明是更外层的意外
                    results[j["id"]] = {"ok": False, "jobId": j["id"],
                                        "error": f"{type(e).__name__}: {e}"}

    # 按镜序汇总（完成顺序是乱的，报错要按镜号读才顺）
    done = sum(1 for j in jobs if (results.get(j["id"]) or {}).get("ok"))
    failed = [f"镜{j['panel_index'] + 1}" for j in jobs
              if not (results.get(j["id"]) or {}).get("ok")]
    ok = total > 0 and done == total
    # 「没有待跑的分镜」不是失败 —— 这一组可能早就全出完了，只是又来跑一次。
    # 原来 ok 对 total==0 恒为 false，于是自动回写被误判成「有镜失败、图上不齐」而跳过，
    # 表现就是「点重跑/再跑一次，文章里的图没更新」（实测踩到）。
    all_done = (total == 0) or (done == total)
    db_api({"op": "series-update", "seriesId": series_id,
            "status": "done" if (done > 0 or total == 0) else "failed",
            "error": None if ok else (None if total == 0
                                      else f"{total - done}/{total} 镜失败（{'、'.join(failed)}）")})
    out = {"ok": all_done, "seriesId": series_id, "total": total, "done": done,
           "workers": workers, "failed": failed}

    # ── 文章配图：整组出完**自动回写正文**（2026-11-18 加）──
    #
    # 为什么放在这里而不是让用户点按钮：配图这个动作的语义就是「把图放进文章」，
    # 出完再让人手工点一次「写回正文」是多余的一步 —— 实测反馈「图生成了但没回写」。
    # 放在 run_series 末尾而不是每个 run_job 里：逐镜回写会反复改写 article.md、
    # 反复重排版 N 次，而且中间态图数不齐，finalize 会直接拒绝（数量必须与图位相等）。
    #
    # **只在整组都成功时回写**：部分失败时图上不齐，硬写进去会得到一篇图位对不上的文章。
    # 失败不算任务失败 —— 图已经出来了，钱已经花了，回写是附加动作。
    try:
        conn2 = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        conn2.row_factory = sqlite3.Row
        try:
            prow = conn2.execute(
                "SELECT params_json FROM image_jobs WHERE series_id=? "
                "AND params_json IS NOT NULL LIMIT 1", (series_id,)).fetchone()
        finally:
            conn2.close()
        sp = json.loads((prow["params_json"] if prow else "") or "{}")
        did = sp.get("draftId")
        if did and sp.get("illustrationWriteBack"):
            if not all_done:
                out["writeBack"] = {"ok": False, "skipped": True,
                                    "error": f"有 {total - done} 镜没出成功，图上不齐，暂不回写"}
            else:
                wb = write_back_illustrations(did, workspace)
                out["writeBack"] = wb
                print(f"自动回写 #{did}："
                      + (f"成功，替换 {wb.get('inserted')} 张" if wb.get("ok")
                         else "失败（" + str(wb.get("error")) + "）"), flush=True)
    except Exception as e:
        out["writeBack"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}

    return out



def main():
    ap = argparse.ArgumentParser(description="生图工作台 · 生成执行器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("catalog", help="输出归一化索引（界面用）")

    p = sub.add_parser("layout", help="一个图型的完整资料（中英原文 + 实际会追加的后缀）")
    p.add_argument("--id", required=True)
    p.add_argument("--workspace", default=WORKSPACE)

    p = sub.add_parser("decision", help="能力判定：该风格在该模型下要不要特征词 / 要不要垫图")
    p.add_argument("--style", required=True)
    p.add_argument("--model", help="默认取配置里的模型")
    p.add_argument("--workspace", default=WORKSPACE)

    p = sub.add_parser("split", help="把内容拆成分镜（默认确定性切分；--smart 走语义拆解）")
    p.add_argument("--text", required=True)
    p.add_argument("--count", type=int, default=0, help="0 = 自动（确定性按段落数；smart 按内容判断）")
    p.add_argument("--smart", action="store_true", help="用文本模型做语义分镜：理解内容后重新组织每一格的画面（一次文本调用）")
    p.add_argument("--workspace", default=WORKSPACE)

    p = sub.add_parser("run-series", help="跑完一个漫画流的所有待跑分镜（一个进程跑完）")
    p.add_argument("--series", type=int, required=True)
    p.add_argument("--workspace", default=WORKSPACE)

    p = sub.add_parser("polish", help="把「需求式」主题改写成「画面描述」（只给建议，绝不自动替换）")
    p.add_argument("--theme", required=True)
    p.add_argument("--workspace", default=WORKSPACE)

    p = sub.add_parser("article-brief",
                       help="读一整篇文章，产出一句封面画面描述（只给建议，不出图不改稿）")
    p.add_argument("--text", required=True,
                   help="文章全文；也可以传 @相对路径 让脚本自己读（长文走文件，避开命令行长度上限）")
    p.add_argument("--workspace", default=WORKSPACE)

    p = sub.add_parser("illustrate-writeback",
                       help="把某篇文章已出的插图写回正文（占位符替换 + 重排版）")
    p.add_argument("--draft", required=True, help="草稿 id")
    p.add_argument("--workspace", default=WORKSPACE)

    p = sub.add_parser("preview", help="只组提示词，不调 API")
    p.add_argument("--theme", required=True)
    p.add_argument("--style")
    p.add_argument("--color")
    p.add_argument("--layout")
    p.add_argument("--asset-ref", action="append", help="资产垫图绝对路径，可重复（角色/道具/场景）")
    p.add_argument("--mode", choices=("pure-image", "graphic-text"), default="pure-image")
    p.add_argument("--ratio", help="画幅，如 3:4")
    p.add_argument("--whitespace", help="留白：正常/适中/多")
    p.add_argument("--mood", help="情绪，顿号分隔")
    p.add_argument("--subject", help="主体限制")
    p.add_argument("--text", help="文字要求")
    p.add_argument("--constraint", help="构图要求（出图模式带出的场景约束）")
    p.add_argument("--text-layout", help="文字排布（附带约束；技能无此参数，见 README）")
    p.add_argument("--scene-style", help="风格融合的「场景风格」（编号或名称如 写实）；给了就走融合路径")
    p.add_argument("--no-style", action="store_true",
                   help="不依赖风格库的最小拼装（角色/道具/场景基准图用）")
    p.add_argument("--redraw", action="store_true", help="改图：追加固定重绘指令")
    p.add_argument("--model", help="目标模型，决定能力判定；默认取配置里的模型")
    p.add_argument("--with-ref", type=int, default=1)
    p.add_argument("--workspace", default=WORKSPACE)

    p = sub.add_parser("run", help="按库里的任务执行一次生成")
    p.add_argument("--job", type=int, required=True)
    p.add_argument("--workspace", default=WORKSPACE)

    sub.add_parser("assets", help="资产库全貌（角色/道具/场景 + 图库目录状态）")

    p = sub.add_parser("asset-init", help="初始化 / 挂载自建图库目录")
    p.add_argument("--path", required=True)

    p = sub.add_parser("asset-save", help="把一张图存入资产库")
    p.add_argument("--category", required=True, choices=["characters", "props", "scenes"])
    p.add_argument("--name", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--tags", help="逗号分隔")

    p = sub.add_parser("asset-delete", help="从资产库删除一个资产（复用技能的 delete_asset）")
    p.add_argument("--id", required=True, help="资产编号，如 CH-002")

    args = ap.parse_args()
    if args.cmd == "polish":
        print(json.dumps(polish_theme(args.theme, args.workspace), ensure_ascii=False))
        return 0
    if args.cmd == "article-brief":
        src = args.text
        # @路径 写法：整篇正文动辄几千字，直接塞 argv 会撞 Windows 32767 字符上限。
        # 传文件的相对路径（相对 workspace）比 base64 好排查 —— 出错时看得出是哪篇。
        if src.startswith("@"):
            # 去掉开头的斜杠再 join —— os.path.join(root, "/drafts/x") 会把 root 整个丢掉，
            # 变成 C:/drafts/x（Windows 上还会跑到盘根），报错却是「读不到文章」。
            relp = src[1:].lstrip("/\\")
            fp = os.path.join(args.workspace, relp)
            try:
                with io.open(fp, encoding="utf-8") as f:
                    src = f.read()
            except Exception as e:
                print(json.dumps({"ok": False, "error": f"读不到文章：{e}"},
                                 ensure_ascii=False))
                return 0
        print(json.dumps(article_brief(src, args.workspace), ensure_ascii=False))
        return 0
    if args.cmd == "illustrate-writeback":
        print(json.dumps(write_back_illustrations(args.draft, args.workspace),
                         ensure_ascii=False))
        return 0
    if args.cmd == "catalog":
        print(json.dumps(build_catalog(), ensure_ascii=False))
        return 0
    if args.cmd == "layout":
        d = layout_detail(args.id)
        d["ok"] = d["exists"]
        if not d["exists"]:
            d["error"] = f"图型不存在：{args.id}"
        print(json.dumps(d, ensure_ascii=False))
        return 0 if d["exists"] else 1
    if args.cmd == "decision":
        cfg = load_model_cfg(args.workspace)
        model = args.model or cfg["model"]
        d = dict(style_decision(model, args.style))
        d["model"] = model
        d["ok"] = "error" not in d
        print(json.dumps(d, ensure_ascii=False))
        return 0 if d["ok"] else 1
    if args.cmd == "split":
        if args.smart:
            r = smart_split(args.text, args.count, args.workspace)
            print(json.dumps(r, ensure_ascii=False))
            return 0 if r.get("ok") else 1
        panels, meta = split_panels(args.text, args.count)
        # 与 smart_split 输出**同形状**：panels/dialogues/notes 都在顶层。
        # 两条路结构不一致的话，界面就得写两套渲染，迟早漏一处。
        print(json.dumps({"ok": True, "panels": panels,
                          "dialogues": meta.pop("dialogues", []),
                          "notes": meta.pop("notes", []),
                          "meta": meta}, ensure_ascii=False))
        return 0
    if args.cmd == "run-series":
        r = run_series(args.series, args.workspace)
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("ok") else 1
    if args.cmd == "preview":
        cfg = load_model_cfg(args.workspace)
        if args.no_style:
            # 角色/道具/场景基准图：不依赖风格库（见 build_bare_prompt 的说明）
            b = build_bare_prompt(args.theme, args.layout, args.ratio or "",
                                  args.color, args.constraint or "")
        elif args.scene_style:
            # 风格融合是独立技能、独立拼装路径（不是给普通提示词加几行）
            b = build_fusion_prompt(args.style, args.scene_style, args.theme, args.color,
                                    args.layout, args.ratio or "", args.mood or "",
                                    asset_refs=args.asset_ref, model=args.model or cfg["model"])
        else:
            b = build_prompt(args.style, args.theme, args.color, args.layout,
                             bool(args.with_ref), asset_refs=args.asset_ref,
                             model=args.model or cfg["model"], mode=args.mode,
                             ratio=args.ratio or "", whitespace=args.whitespace or "",
                             mood=args.mood or "", subject=args.subject or "",
                             text_req=args.text or "", redraw=bool(args.redraw),
                             constraint=args.constraint or "",
                             text_layout=args.text_layout or "")
        # 必须单行输出：调用方（node 半）按「最后一行」解析 JSON
        print(json.dumps({"ok": True, "promptZh": b["zh"], "promptEn": b["en"],
                          "sendZh": b["sendZh"], "mode": b["mode"],
                          "fusion": bool(b.get("fusion")),
                          "decision": b["decision"],
                          "refPath": b["refPath"], "assetRefs": b["assetRefs"],
                          "style": b["style"],
                          "model": cfg["model"],
                          # 实际会用的接口尺寸（按画幅换算，换算不出才是配置默认）
                          # 融合模式没给画幅时技能规定默认 3:4，这里要跟着走，否则又是「提示词说 3:4、实际 1:1」
                          "size": size_for_ratio(b.get("ratio") or args.ratio or "") or cfg["size"],
                          "ratioToSize": RATIO_TO_SIZE,
                          "quality": cfg["quality"], "endpoint": cfg["submitUrl"]},
                         ensure_ascii=False))
        return 0
    if args.cmd == "run":
        r = run_job(args.job, args.workspace)
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("ok") else 1
    if args.cmd == "assets":
        print(json.dumps(asset_library(), ensure_ascii=False))
        return 0
    if args.cmd == "asset-init":
        try:
            r = asset_manager().init_or_attach_library(args.path)
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
            return 1
        # init_or_attach_library 的返回值里可能有 Path，统一转字符串
        print(json.dumps({"ok": True, "result": r}, ensure_ascii=False, default=str))
        return 0
    if args.cmd == "asset-save":
        tags = [t.strip() for t in (args.tags or "").split(",") if t.strip()] or None
        try:
            entry = asset_manager().save_asset(args.category, args.name, args.image, tags)
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
            return 1
        print(json.dumps({"ok": True, "entry": entry}, ensure_ascii=False, default=str))
        return 0
    if args.cmd == "asset-delete":
        # 直接复用技能自带的 delete_asset（它会同步 library.json、镜像与画廊），不重造。
        try:
            out = asset_manager().delete_asset(args.id)
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
            return 1
        print(json.dumps({"ok": True, "removed": out}, ensure_ascii=False, default=str))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
