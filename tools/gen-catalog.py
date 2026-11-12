#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从磁盘扫描已装技能，生成「工作台技能包」快照，注入 lib/client.js。

用法：
    DSH_HOME=C:/Users/<你>/.dsh python tools/gen-catalog.py

设计要点
  · 技能包属于某个工作台（gzh / video / cross），不是顶层技能库
  · 公众号技能包按**流水线阶段**分组，每段标注「调用方式」与「具体调什么」
    （对应创作流水线 11 段：发现热点 → 发布）
  · 只收录公众号创作链路上的技能；leader / neat-freak / storage-analyzer 等不收录

扩展方式：往 STAGES 里加一组，或往某组的 members 里加技能名，然后重跑本脚本。
未在磁盘找到的技能会被跳过并提示，方便你先写清单后装技能。
"""

import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)

ROOTS = [
    (os.path.join(os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh")), "skills"), "global"),
    (os.path.join(PLUGIN, "..", ".dsh", "skills"), "project"),
    # 红狐技能包（115 个）。**故意不放 .dsh/skills/**——那是 DSH 的全局扫描目录，
    # 放进去等于每个会话不管在做什么都把 115 个技能读进系统提示（实测从 40 涨到 155）。
    # 工作台有自己的技能库，且流程是直接调脚本的，不需要 DSH 当技能加载。
    (os.path.join(PLUGIN, "..", ".dsh", "redfox-skills"), "redfox"),
]

# 公众号创作流水线：与之前那张 11 段表一一对应
GZH_STAGES = [
    {"name": "1 发现热点", "mode": "脚本",
     "note": "hot-topics 的 60s API；或 collect-source-material list toutiao（50 条）",
     "members": ["hot-topics", "aihot", "trending-hub", "trending-hub-top10", "weibo-hot-search", "douyin-hot-trend", "toutiao-search", "global-ai-news-brief"]},
    {"name": "2 采集与补素材", "mode": "脚本",
     "note": "collect-source-material fetch <url>",
     "members": ["collect-source-material", "hv-analysis", "wechat-search", "cn-last30days", "deepseek-websearch", "doubao-websearch", "kimi-websearch"]},
    {"name": "3 选材与选题", "mode": "Agent + 技能",
     "note": "select-entertaining-materials / bigpeng-hot-gzh / aws-wechat-article-topics",
     "members": ["select-entertaining-materials", "bigpeng-hot-gzh", "aws-wechat-article-topics", "wechat-10w-hot", "wechat-original-hot", "wechat-fastest-growing", "douyin-daily-hot", "xiaohongshu-dailytop", "xiaohongshu-lowtop"]},
    {"name": "4 定角度", "mode": "Agent + 技能",
     "note": "develop-entertainment-article-angles",
     "members": ["develop-entertainment-article-angles", "wechat-similar-account", "wechat-top-account", "wechat-account-analyzer"]},
    {"name": "5 写正文", "mode": "Agent + 技能（按赛道配置）",
     "note": "write-entertainment-… / aws-…-writing / khazix-writer 三选一",
     "members": ["aws-wechat-article-writing", "write-entertainment-wechat-articles", "khazix-writer", "wechat-write", "wechat-rewrite", "multi-copywrite-alchemy", "visual-ops-writer", "multi-rewrite"]},
    {"name": "6 打磨", "mode": "Agent + 技能",
     "note": "lieflat-less-ai-tone：白名单式，11 条规则逐条比对 + 文末验收清单 + 信息守恒。"
             "没命中规则的句子必须逐字保留（写死在 SKILL.md 的硬性边界里）。"
             "打磨后跑 tools/check-draft.py 按写作技能复核 L1（A 类=aws 配额，B 类=卡兹克规则）",
     "members": ["lieflat-less-ai-tone"]},
    {"name": "7 自检", "mode": "脚本",
     "note": "write.py check（本阶段无独立技能，由 aws-wechat-article-writing 自带脚本执行）",
     "members": []},
    {"name": "8 审稿定稿", "mode": "Agent + 技能 + 脚本",
     "note": "aws-wechat-article-review + write.py strip-citations",
     "members": ["aws-wechat-article-review", "wechat-prohibited-word", "multi-wordcheck"]},
    {"name": "9 配图", "mode": "脚本（Agent 写 prompt）",
     "note": "image_create.py generate / batch",
     "members": ["aws-wechat-article-images", "aws-wechat-sticker", "wechat-cover"]},
    {"name": "10 排版", "mode": "脚本",
     "note": "format.py",
     "members": ["aws-wechat-article-formatting"]},
    {"name": "11 发布", "mode": "脚本",
     "note": "publish.py full（需微信凭证）",
     "members": ["aws-wechat-article-publish"]},
    {"name": "总控与资产", "mode": "Agent + 技能",
     "note": "一条龙总控入口 + 业务资料库与预设包",
     "members": ["aws-wechat-article-main", "aws-wechat-article-assets"]},
]

# 生图工作台：以 handraw-style 的风格库为起点，出图后可直接进公众号配图链路
IMAGE_STAGES = [
    {"name": "1 选风格/图型/色卡", "mode": "界面",
     "note": "风格库 324 风格 / 161 图型 / 36 主题色，与 handraw-style 画廊同一份 references/*.json",
     "members": ["handdraw-style-prompter"]},
    {"name": "2 组提示词", "mode": "脚本",
     "note": "image-gen.py preview（提示词只组一次，预览与实际出图共用，避免两套模板）",
     "members": []},
    {"name": "3 垫图出图", "mode": "脚本",
     "note": "image-gen.py run → POST /v1/api/generate，编号参考图走 images 数组（实测形状）",
     "members": []},
    {"name": "4 归档与计费", "mode": "脚本",
     "note": "image-db.py（image_assets 资产库 + image_usage 计费账本；接口没有配额端点）",
     "members": []},
    {"name": "5 用到公众号", "mode": "Agent + 技能",
     "note": "出好的图可直接进配图 / 贴图链路",
     "members": ["aws-wechat-article-images", "aws-wechat-sticker"]},
]

PACKS = {
    "gzh": {"title": "公众号创作技能包", "stages": GZH_STAGES},
    "image": {"title": "生图技能包", "stages": IMAGE_STAGES},
}

# 少数技能的中文短名（其余从 description 首段提取）
TITLES = {
    "hot-topics": "热榜抓取",
    "collect-source-material": "素材采集",
    "aihot": "AI 资讯",
    "bigpeng-hot-gzh": "爆款选题标题",
    "khazix-writer": "卡兹克长文",
    "humanizer-zh": "去 AI 味",
    "hv-analysis": "横纵深度分析",
    "select-entertaining-materials": "娱乐选材",
    "develop-entertainment-article-angles": "娱乐定角度",
    "write-entertainment-wechat-articles": "娱乐成稿",
    "aws-wechat-article-main": "一条龙总控",
    "aws-wechat-article-assets": "素材与预设包",
    "aws-wechat-sticker": "公众号贴图",
    "handdraw-style-prompter": "手绘风格提示词",
}


def parse_frontmatter(text):
    m = re.match(r"---\r?\n(.*?)\r?\n---", text, re.S)
    if not m:
        return {}
    fm = m.group(1)
    name = re.search(r"(?m)^name:\s*(.+)$", fm)
    desc = None
    dm = re.search(r"(?m)^description:\s*(.*)$", fm)
    if dm:
        raw = dm.group(1).strip()
        if raw in (">", ">-", ">+", "|", "|-", "|+"):
            block = re.search(r"(?ms)^description:\s*[>|][-+]?\s*\n((?:[ \t]+.*\n?)+)", fm)
            if block:
                desc = " ".join(l.strip() for l in block.group(1).splitlines() if l.strip())
        else:
            desc = raw.strip("\"'")
    return {
        "name": name.group(1).strip() if name else None,
        "desc": re.sub(r"\s+", " ", desc or "").strip(),
    }


def short_title(name, desc):
    if name in TITLES:
        return TITLES[name]
    for sep in ("｜", "：", "，", "、", "—", "|", ":", ",", "。", "；", ";"):
        if sep in desc:
            head = desc.split(sep)[0].strip()
            if 2 <= len(head) <= 12:
                return head
    # 没有可用的分隔符时**不能直接 desc[:8]** —— 那是按字数硬切，
    # 会切出「管理自建图库（角」「Add a na」这种半个词。改成截到 12 字、
    # 英文回退到词边界，再加省略号表示这只是一段开头。
    head = desc.strip() or name
    if len(head) <= 12:
        return head
    cut = head[:12]
    if " " in cut and re.search(r"[A-Za-z0-9]$", cut):
        cut = cut[:cut.rfind(" ")]
    return cut.rstrip("（(「“ ") + "…"


def scan():
    """扫一层：<root>/<dir>/SKILL.md。

    注意「目录名 ≠ 声明名」是常态：handraw-style 包根的 SKILL.md 声明的是
    `name: handdraw-style-prompter`，所以技能库里看到的是声明名。按目录名找技能会找不到。
    技能的实际元数据一律以 SKILL.md 的 frontmatter 为准，目录名只作兜底。
    """
    found = {}
    for root, kind in ROOTS:
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            continue
        for d in sorted(os.listdir(root)):
            skill_md = os.path.join(root, d, "SKILL.md")
            if not os.path.exists(skill_md):
                continue
            fm = parse_frontmatter(io.open(skill_md, encoding="utf-8").read())
            name = fm["name"] or d
            if name in found:      # 项目级优先
                continue
            found[name] = {
                "name": name,
                "title": short_title(name, fm["desc"]),
                "desc": fm["desc"][:320],
                "scripts": os.path.isdir(os.path.join(root, d, "scripts")),
                "root": kind,
                "path": skill_md,
            }
        # 第二层：<root>/<dir>/skills/<sub>/SKILL.md
        # 为什么必须扫：handraw-style 这类「技能包」把自己的子技能放在 skills/ 下，
        # 里面每个都能独立调用（风格导入、视频总控、配音、剪映……）。
        # 只扫一层会让「系统里装了什么」这个视图长期缺掉一整个子系统 ——
        # 上游这次加了 4 个视频技能，界面上一个都看不见。
        for d in sorted(os.listdir(root)):
            sub = os.path.join(root, d, "skills")
            if not os.path.isdir(sub):
                continue
            for sd in sorted(os.listdir(sub)):
                skill_md = os.path.join(sub, sd, "SKILL.md")
                if not os.path.exists(skill_md):
                    continue
                fm = parse_frontmatter(io.open(skill_md, encoding="utf-8").read())
                name = fm["name"] or sd
                if name in found:      # 顶层同名优先，别让子技能顶掉正式入口
                    continue
                found[name] = {
                    "name": name,
                    "title": short_title(name, fm["desc"]),
                    "desc": fm["desc"][:320],
                    "scripts": os.path.isdir(os.path.join(sub, sd, "scripts")),
                    "root": kind,
                    "path": skill_md,
                    "parent": d,       # 归属的技能包目录名，界面用来分组
                }
    return found


def main():
    on_disk = scan()
    packs = {}
    missing = []
    # 技能被哪些工作台的哪个阶段引用（反向索引，供顶层技能库用）
    used_by = {name: [] for name in on_disk}
    for key, pack in PACKS.items():
        stages = []
        skills = []
        for st in pack["stages"]:
            for member in st["members"]:
                if member not in on_disk:
                    missing.append(member)
                    continue
                entry = dict(on_disk[member])
                entry["stage"] = st["name"]
                skills.append(entry)
                used_by.setdefault(member, []).append(
                    {"pack": key, "packTitle": pack["title"], "stage": st["name"]})
            stages.append({"name": st["name"], "mode": st["mode"], "note": st["note"]})
        packs[key] = {"title": pack["title"], "stages": stages, "skills": skills}

    # 顶层技能库：系统里装了什么（单一来源），以及各自被哪些流水线引用。
    # 工作台里的技能包是「引用视图」，这里是「资产视图」——同一份技能元数据，两处呈现。
    registry = {
        "skills": [
            dict(on_disk[name], usedBy=used_by.get(name, []))
            for name in sorted(on_disk)
        ],
        "packs": [{"key": k, "title": v["title"], "count": len(v["skills"])} for k, v in packs.items()],
    }

    template = io.open(os.path.join(PLUGIN, "lib", "client.template.js"), encoding="utf-8").read()
    out = template.replace("__PACKS_JSON__", json.dumps(packs, ensure_ascii=False, indent=1))
    out = out.replace("__REGISTRY_JSON__", json.dumps(registry, ensure_ascii=False, indent=1))

    # 素材快照（由 gen-materials.py 抓取）；不存在就注入空结构
    snap_path = os.path.join(PLUGIN, "lib", "materials.snapshot.json")
    if os.path.exists(snap_path):
        materials = json.load(io.open(snap_path, encoding="utf-8"))
    else:
        materials = {"fetchedAt": "", "date": "", "platforms": [], "rows": []}
    out = out.replace("__MATERIALS_JSON__", json.dumps(materials, ensure_ascii=False, indent=1))

    # SQLite 快照（由 workbench-db.py export 产出）；服务器 API 做好前，界面靠它看到真数据
    db_path = os.path.join(PLUGIN, "lib", "db.snapshot.json")
    if os.path.exists(db_path):
        db = json.load(io.open(db_path, encoding="utf-8"))
    else:
        db = {"exportedAt": "", "counts": {"topics": 0, "drafts": 0, "publishes": 0},
              "topics": [], "drafts": [], "publishes": []}
    out = out.replace("__DB_JSON__", json.dumps(db, ensure_ascii=False, indent=1))

    io.open(os.path.join(PLUGIN, "lib", "client.js"), "w", encoding="utf-8", newline="\n").write(out)

    gzh = packs["gzh"]
    unused = [s["name"] for s in registry["skills"] if not s["usedBy"]]
    print(f"技能库快照写入 lib/client.js：安装 {len(registry['skills'])} 个技能；"
          f"公众号包 {len(gzh['skills'])} 个 / {len(gzh['stages'])} 个阶段")
    if unused:
        print(f"  未挂流水线（顶层技能库里可查）：{'、'.join(unused)}")
    for st in gzh["stages"]:
        members = [s["name"] for s in gzh["skills"] if s["stage"] == st["name"]]
        mark = "" if members else "   （本阶段无独立技能）"
        print(f"  {st['name']:<14} [{st['mode']}] {', '.join(members)}{mark}")
    total = sum(len(v) for v in (materials.get("byDate") or {}).values())
    print(f"素材归档：{len(materials.get('dates') or [])} 天 / {total} 条 / "
          f"{len(materials.get('platforms') or [])} 平台"
          + ("" if total else "（跑 tools/gen-materials.py 抓取）"))
    c = db.get("counts") or {}
    print(f"数据库快照：选题 {c.get('topics', 0)} / 创作 {c.get('drafts', 0)} / 发布 {c.get('publishes', 0)}"
          + ("" if c.get("topics") else "（跑 tools/workbench-db.py export）"))
    if missing:
        print(f"\n注意：以下技能未在磁盘找到，已跳过 —— {', '.join(sorted(set(missing)))}")


if __name__ == "__main__":
    sys.exit(main())
