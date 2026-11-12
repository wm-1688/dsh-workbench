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
import re
import sqlite3
import ssl
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
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
        _DECISION_CACHE[key] = d
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
    _DECISION_CACHE[key] = d
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
    _FUSION_CACHE = {"zh": coexist(blocks[0], zh_mark), "en": coexist(blocks[1], en_mark)}
    return _FUSION_CACHE


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
                f"{others} are PRODUCT/PROP references. If any person appears, they MUST be the same "
                "person as the character reference (same face, hair and outfit) — do not invent a "
                "different model. Where the character appears is governed by the scene description above. "
                "Follow the product/prop references' shape, proportions, palette and key features without "
                "redesigning them.")
    if not chars:
        return ASSET_REF
    return (f"所附资产参考图共 {len(norm)} 张：其中 {chars} 张是**人物参考**，{others} 张是**商品/道具参考**。"
            "画面中若出现人物，必须与人物参考图是**同一个人**（同一张脸、同一发型、同一套服装），"
            "不要另造一个模特；人物是否出现、出现在哪里，以本提示词的画面要求为准。"
            "商品/道具参考则沿用其外形、比例、配色与关键特征，不要重新设计。")


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
    refs_note = []
    if want_ref:
        refs_note.append("画风")
    if use_asset_refs:
        refs_note.extend(["资产主体"] * len(asset_refs))
    if len(refs_note) > 1:
        send_zh += "\n所附图片：" + "、".join(
            f"第 {i + 1} 张为{('画风参考' if n == '画风' else '资产主体参考')}"
            for i, n in enumerate(refs_note)) + "。"
        send_en += ("\nAttached images: " + ", ".join(
            f"the {i + 1} is the {'style' if n == '画风' else 'asset subject'} reference"
            for i, n in enumerate(refs_note)) + ".")
    if want_ref:
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


def load_model_cfg(workspace):
    """模型名取自 .aws-article/config.yaml 的 image_model；端点固定走已实测的异步接口。"""
    model, size, quality, base = DEFAULT_MODEL, "1024x1024", "auto", ""
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
        except Exception:
            pass
    key = load_env(workspace).get("IMAGE_MODEL_API_KEY", "")
    host = DEFAULT_HOST
    if base:
        p = urllib.parse.urlparse(base)
        if p.scheme and p.netloc:
            host = f"{p.scheme}://{p.netloc}"
    if base.endswith("/v1/api/generate"):
        host = base[: -len("/v1/api/generate")]
    host = os.environ.get("DSH_WORKBENCH_IMAGE_ENDPOINT") or host
    return {"model": model, "size": size, "quality": quality, "key": key,
            "host": host.rstrip("/"),
            "submitUrl": host.rstrip("/") + "/v1/api/generate",
            "resultUrl": host.rstrip("/") + "/v1/api/result"}


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


def generate_once(cfg, prompt, images, size, quality):
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
    return None, None


def ref_to_b64(path):
    """参考图统一转 PNG 再 base64（网关对 webp 上传的兼容性未知，PNG 已验证可用）。"""
    try:
        from PIL import Image
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((1024, 1024))
            buf = io.BytesIO()
            im.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return base64.b64encode(io.open(path, "rb").read()).decode("ascii")


# ── 主题润色 ─────────────────────────────────────────────────────────

# 出图那家聚合商的文本模型。**实测过**：同一个 IMAGE_MODEL_API_KEY
# 在 /v1/chat/completions 上只有 gemini-2.5-flash 可用
# （gpt-4o / gpt-4.1 / gpt-5 / deepseek-chat / claude / qwen / glm 都返回 model not found）。
TEXT_MODEL = os.environ.get("DSH_WORKBENCH_TEXT_MODEL") or "gemini-2.5-flash"

POLISH_SYSTEM = (
    "你是 AI 绘画的提示词助手。用户输入的是要交给绘画模型的「主题」。"
    "如果它写成了需求说明（例如出现「受众:」「业务场景:」「用途:」「目的:」这类字段，"
    "或只说了要做什么而没说画面里有什么），把它改写成**具体、可视化的画面描述**；"
    "如果它本身已经是画面描述，只做轻微润色。"
    "硬要求："
    "1) 只输出改写后的主题本身，不要解释、不要加引号、不要换行、不要编号；"
    "2) 保留用户的原始意图与关键信息（人物、场合、情绪、文字内容）；"
    "3) 40 字以内，写成一句；"
    "4) 用中文；"
    "5) 不要发明用户没提过的事实（具体品牌、真实人名、具体数字）。"
)


def text_chat(system, user, workspace=WORKSPACE, max_tokens=800, temperature=None):
    """一次文本模型调用。**密钥与端点与出图共用一份** ——
    同一个 IMAGE_MODEL_API_KEY 实测可用（见 TEXT_MODEL 的说明），不额外要求配置。

    抽出来是因为润色与智能分镜都要它：两处各写一遍，迟早有一处忘了改端点或超时。
    """
    env = load_env(workspace)
    key = env.get("WRITING_MODEL_API_KEY") or env.get("IMAGE_MODEL_API_KEY") or ""
    if not key:
        return {"ok": False, "error": "没有可用的文本模型密钥（aws.env 里的 WRITING_MODEL_API_KEY / IMAGE_MODEL_API_KEY 都是空的）"}
    host = os.environ.get("DSH_WORKBENCH_TEXT_ENDPOINT") or "https://grsai.dakka.com.cn"
    url = host.rstrip("/") + "/v1/chat/completions"
    payload = {"model": TEXT_MODEL,
               "messages": [{"role": "system", "content": system},
                            {"role": "user", "content": user}],
               "max_tokens": max_tokens}
    if temperature is not None:
        payload["temperature"] = temperature
    try:
        st, raw = http(url, key, json.dumps(payload).encode(), timeout=90)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if st != 200:
        return {"ok": False, "error": f"HTTP {st}: {raw.decode('utf-8', 'replace')[:220]}"}
    try:
        j = json.loads(raw.decode("utf-8", "replace"))
        out = (j["choices"][0]["message"]["content"] or "").strip()
    except Exception as e:
        return {"ok": False, "error": f"响应解析失败：{type(e).__name__}: {e}"}
    return {"ok": True, "text": out}


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
    if not out:
        return {"ok": False, "error": "模型返回了空内容"}
    return {"ok": True, "original": src, "polished": out, "model": TEXT_MODEL,
            "changed": out != src}


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
    """用文本模型把内容拆成分镜。返回 {ok, panels, meta}。"""
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
    # 模型常把 JSON 包在 ``` 里：先剥外壳，剥不掉再从整段里抠第一个数组
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw).strip()
    data = None
    try:
        data = json.loads(raw)
    except Exception:
        m = re.search(r"[\{\[].*[\}\]]", raw, re.S)
        if m:
            try:
                data = json.loads(m.group(0))
            except Exception as e:
                return {"ok": False, "error": f"JSON 解析失败：{e}", "raw": raw[:300]}

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


# ── 数据层读写 ───────────────────────────────────────────────────────

def db_api(payload):
    """唯一的写入通道：转调 image-db.py api（保持单写者）。"""
    b = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode()
    out = subprocess.run([sys.executable, "-X", "utf8", DB_SCRIPT, "api", "--payload", b],
                         capture_output=True, text=True, encoding="utf-8")
    line = (out.stdout or "").strip().split("\n")[-1]
    try:
        return json.loads(line)
    except Exception:
        raise RuntimeError(f"数据层调用失败: {out.stdout} {out.stderr}")


def read_job(job_id):
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM image_jobs WHERE id=?", (job_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ── run ──────────────────────────────────────────────────────────────

def run_job(job_id, workspace=WORKSPACE):
    job = read_job(job_id)
    if job is None:
        raise SystemExit(f"任务不存在：#{job_id}")
    db_api({"op": "image-take", "jobId": job_id})

    out_dir = os.path.join(OUT_ROOT, str(job_id))
    os.makedirs(out_dir, exist_ok=True)
    log_path = os.path.join(out_dir, "generation.log")
    logf = io.open(log_path, "a", encoding="utf-8")

    def log(msg):
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
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
        for arm in todo:
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
            blob, dt, url = generate_once(cfg, prompt, imgs,
                                          size, job.get("quality"))
            w, h = png_size(blob)
            name = f"{job_id}-{arm}.png"
            path = os.path.join(out_dir, name)
            with open(path, "wb") as f:
                f.write(blob)
            rel = os.path.relpath(path, WORKSPACE).replace("\\", "/")
            assets.append({"arm": arm, "path": path, "relPath": rel, "bytes": len(blob),
                           "width": w, "height": h, "model": cfg["model"],
                           "elapsedMs": int(dt * 1000), "styleId": job.get("style_id"),
                           "theme": job.get("theme")})
            log(f"  {arm} 出图成功 {w}x{h} {len(blob)}B 用时 {dt:.0f}s")

        db_api({"op": "image-finish", "jobId": job_id, "assets": assets,
                "calls": len(assets), "model": cfg["model"], "endpoint": cfg["submitUrl"],
                "promptZh": built["zh"], "promptEn": built["en"],
                "usageNote": f"任务 #{job_id}"})
        log(f"完成：{len(assets)} 张（计费 {len(assets)} 次）")
        return {"ok": True, "jobId": job_id, "assets": assets}
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


# ── 漫画流：批量跑 ───────────────────────────────────────────────────

def run_series(series_id, workspace=WORKSPACE):
    """按顺序跑完一个漫画流的所有待跑分镜。

    **一个进程跑完整组**：N 个分镜不该 spawn N 个进程（每个都要重新加载索引、
    逐一读盘解析），而且串行能让日志按镜序连成一条，出问题好查。
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
    done = 0
    for j in jobs:
        r = run_job(j["id"], workspace)
        if r.get("ok"):
            done += 1
    ok = total > 0 and done == total
    # 部分成功也要如实标出来，但不能因为一镜失败就把整组标成失败
    db_api({"op": "series-update", "seriesId": series_id,
            "status": "done" if done > 0 else "failed",
            "error": None if ok else f"{total - done}/{total} 镜失败"})
    return {"ok": ok, "seriesId": series_id, "total": total, "done": done}



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
