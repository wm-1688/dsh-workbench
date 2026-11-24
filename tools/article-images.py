#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章配图 · 分段与提示词落盘。

为什么要有这个脚本（2026-11-17）
--------------------------------
实测发现配图链路断在中间：`composeImagesPrompt` 只跟 Agent 说「读配图路线.md、
按 styleCode 定策略、生成封面和正文图」，**从来没把图位描述传给 Agent**。
Agent 只能拿整篇文章当 theme 去出图 —— 实测 #39 的 image_jobs.theme 是 2912 字全文，
模型面对一篇议论文抓不到画面，只能吐通用素材图（快递纸箱、抽象立方体）。

同一个根因还带出两个次生问题：
  1. `imgs/prompts/` 全空。18 篇已配图草稿无一例外。SKILL.md 第 147 行明写
     「每张正文图各有一个 prompts/*.md，先落 prompt 再生成，不许反过来」——
     没有 prompt 就没有复现，想只重跑一张也做不到。
  2. 正文图不进 image_jobs，`check-image-log.py` 永远报「无日志」。

所以这里把三件事变成确定的代码行为，不再指望 Agent 自觉：
  plan    按图位切段（段落边界对齐，不切半句），算出每张图该看哪段正文
  write   把 Agent 提炼出的画面描述写成 prompts/img-0N.md + cover.md
  check   校验前缀合规、prompt 齐全
  style-log  全局风格流水（跨篇防重复，不是每篇一份）
  generate   **一条命令把整组图并发跑完**（2026-11-18 加）

为什么加 generate（真实问题）
-----------------------------
用户在创作台点「配图」，期望是整组图一起出。实测发现实际是**一张张排队**跑的。

根因：原来的提示词在第六步只写了「批量时并发跑（run-series 默认 3 路），不要一张张等」，
**但没有任何机制保证**。Agent 实际执行的是 `image-gen.py run`（单张），
于是 4 张图串行跑，每张 40 秒以上，用户等了快三分钟。

并发机制本身是好的（run_series 用线程池，按 panel_index 排序输出），
只是创作台这条路径没走进去 —— 它靠 Agent 自己拼命令行，而 Agent 选了最简单的单张 run。

所以这里把「整组并发」也变成确定的代码行为：
一次建 series + N 个 job，然后调 run_series 并发执行。
Agent 只需要跑一条命令，没得选。

用法：
    python tools/article-images.py plan  drafts/xxx
    python tools/article-images.py write drafts/xxx --spec spec.json
    python tools/article-images.py check drafts/xxx
    python tools/article-images.py style-log --recent 3
    python tools/article-images.py style-log --append 20261117-slug FI-009 场景实拍
    python tools/article-images.py generate drafts/xxx --style FC-029 --draft-id 9007
"""
import argparse
import datetime
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
WORKSPACE = os.path.dirname(PLUGIN)
# 全局一份：规则是「同一风格别连续用三篇」，每篇存一份的话跨篇根本查不了。
STYLE_LOG = os.path.join(PLUGIN, "style-log.md")

# generate 要用的两个外部脚本。走子进程而不是 import：
# image-gen.py 和 image-db.py 都是独立可跑的 CLI，import 会把它们的
# 模块级初始化（连库、读配置）带进本进程，反而更容易出问题。
IMAGE_GEN = os.path.join(HERE, "image-gen.py")
IMAGE_DB = os.path.join(HERE, "image-db.py")

# 比例 → 像素。和 image-gen.py 的 RATIO_TO_SIZE 保持一致；
# 这里单独放一份是因为 generate 要在入队前就把 size 定好。
RATIO_TO_SIZE = {
    "2.35:1": "1456x624",
    "16:9": "1280x720",
    "1:1": "1024x1024",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "9:16": "720x1280",
}


def _run_py(script, args, payload=None, timeout=600):
    """跑一个同目录的 python 脚本，返回解析后的 JSON。"""
    import subprocess
    cmd = [sys.executable, "-X", "utf8", script] + list(args)
    try:
        r = subprocess.run(cmd, input=json.dumps(payload, ensure_ascii=False) if payload else None,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, cwd=WORKSPACE)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "超时（%ss）：%s" % (timeout, script)}
    out = (r.stdout or "").strip()
    # 有的脚本会先打日志再打 JSON，取最后一个能解析的 JSON 行
    for line in reversed(out.split("\n")):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:
                continue
    return {"ok": False, "error": (r.stderr or out or "无输出")[:500]}


def db_image(payload):
    """调 image-db.py 的 api 入口（单写者纪律：所有写都走它）。"""
    return _run_py(IMAGE_DB, ["api"], payload)


def image_gen(args, timeout=1800):
    """调 image-gen.py。出图慢，默认给 30 分钟。"""
    return _run_py(IMAGE_GEN, args, timeout=timeout)


# 目标段长。实测 4 篇 21 个图位，段落天然切出来是 280-470 字，中位数约 400。
TARGET_CHARS = 400
MIN_CHARS = 150          # 低于这个就往后借段落，否则模型信息不够
MAX_CHARS = 700          # 高于这个从前面砍，越靠近图位越相关

# 固定前缀 → 内容形态。前缀写错不是小事：它决定走摄影还是走插画/图表，
# 写错了出来的东西跟正文对不上，所以这里做成硬规则而不是建议。
#
# 「氛围」占实测 102 个图位里的 66 个（65%），是事实上的主流写法，必须收。
# 「收束」删掉了（用户 2026-11-17 决定）：它表达的是位置不是形态，
# 想画结尾场景就写「场景：」，别让前缀兼职表示位置。
FORMS = {
    "场景": {"form": "场景还原", "hint": "一个具体时刻，写清在哪、有谁、在做什么"},
    "氛围": {"form": "场景还原", "hint": "强调光线与情绪，可以不出现人"},
    "对比": {"form": "对比两栏", "hint": "A 与 B 并置，差异要能一眼看出来"},
    "图表": {"form": "数据图表", "hint": "数字要逐字来自正文，不编造"},
    "概念": {"form": "概念隐喻", "hint": "绑定文章的核心张力，不是绑定主题词"},
    "流程": {"form": "流程步骤", "hint": "先做什么后做什么，顺序要清楚"},
    "清单": {"form": "清单要点", "hint": "并列要点，条目化呈现"},
    "结构": {"form": "结构分层", "hint": "层级与边界要分明"},
}
BANNED_PREFIX = {
    "收束": "「收束」表示位置不是形态。要画结尾场景请写「场景：」",
    "总结": "「总结」不是形态。按内容选：场景/氛围/对比/图表/概念/流程/清单/结构",
    "配图": "「配图」太笼统。要说明这张图是什么形态",
    "插画": "「插画」是媒介不是形态。形态按内容选，媒介由风格决定",
}
PH_RE = re.compile(r"!\[([^\]]+)\]\(placeholder\)")

# 正文里出现这些词，就等于在让模型往画面上写字。
# 只用来在「声明了不加字」时报警，不追求穷尽 —— 漏一个的下场是那张封面多出几个字，
# 看图时一眼能发现；而误报会把正常描述当成错误，反而让 Agent 不敢写画面。
WRITE_WORDS = ("写着", "写上", "写字", "文字", "大字", "字体", "标题字",
               "文案", "汉字", "标语", "字样", "粗体", "黑体", "宋体")


def rd(p):
    return io.open(p, encoding="utf-8").read()


def wr(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)


def zh_len(s):
    return len(re.findall(r"[\u4e00-\u9fff]", s))


def parse_prefix(desc):
    """拆出「形态前缀：画面描述」。返回 (prefix, body, error)。"""
    m = re.match(r"^\s*([^：:]{1,6})[：:]\s*(.+)$", desc)
    if not m:
        return None, desc, "缺形态前缀。写成「场景：……」，前缀见 FORMS"
    pre, body = m.group(1).strip(), m.group(2).strip()
    if pre in FORMS:
        return pre, body, None
    if pre in BANNED_PREFIX:
        return pre, body, BANNED_PREFIX[pre]
    # 老写法里有一批是「国家地理纪实风格摄影：」「MUJI 风格摄影：」——
    # 那是把媒介当成了前缀。新规则下要改成形态前缀，媒介交给风格 ID。
    if any(k in pre for k in ("风格", "摄影", "打印稿", "手绘")):
        return pre, body, ("「%s」是媒介不是形态。前缀用形态（场景/氛围/对比/图表/"
                           "概念/流程/清单/结构），媒介交给风格 ID" % pre)
    return pre, body, "「%s」不是合法前缀。可用：%s" % (pre, "/".join(FORMS))


def blocks_of(text):
    """把正文切成块：段落 or 图位行，各自独立。

    图位必须独占一块 —— 它可能紧贴段落末尾，也可能前后空行，
    按空行切会把图位和相邻段落粘在一起。
    """
    out, buf = [], []
    for ln in text.split("\n"):
        if "](placeholder)" in ln:
            if buf:
                out.append(("p", "\n".join(buf)))
                buf = []
            out.append(("img", ln.strip()))
        elif not ln.strip():
            if buf:
                out.append(("p", "\n".join(buf)))
                buf = []
        else:
            buf.append(ln)
    if buf:
        out.append(("p", "\n".join(buf)))
    return out


def segment_for(blocks, img_idx):
    """取第 img_idx 个图位对应的正文段。

    规则（用户 2026-11-17 定）：不用 H2 —— 实测 27 篇里 7 篇根本没标题。
    以图位为锚，**向前**收集完整段落（图位属于它上文的内容），
    段落整段取，绝不切半句；不够 MIN 就往后借，超过 MAX 从最前面丢。
    """
    # 向前：从上一个图位之后到本图位之前的段落
    start = 0
    seen = 0
    for i, (k, _) in enumerate(blocks):
        if k == "img":
            if seen == img_idx:
                start = i
                break
            seen += 1
    before = []
    j = start - 1
    while j >= 0 and blocks[j][0] == "p":
        before.insert(0, blocks[j][1])
        j -= 1
        if zh_len("\n".join(before)) >= TARGET_CHARS:
            break

    # 从尾部往前凑到 TARGET：靠近图位的那几段最相关
    picked = []
    for para in reversed(before):
        picked.insert(0, para)
        if zh_len("\n".join(picked)) >= TARGET_CHARS:
            break

    # 太短：往后借（图位之后的段落），保证模型有足够信息
    if zh_len("\n".join(picked)) < MIN_CHARS:
        k = start + 1
        while k < len(blocks) and blocks[k][0] == "p":
            picked.append(blocks[k][1])
            k += 1
            if zh_len("\n".join(picked)) >= MIN_CHARS:
                break

    # 太长：从最前面丢（最靠前的离图位最远）
    while len(picked) > 1 and zh_len("\n".join(picked)) > MAX_CHARS:
        picked.pop(0)

    return "\n\n".join(picked)


def cmd_plan(d):
    draft = os.path.join(d, "draft.md")
    if not os.path.isfile(draft):
        return {"ok": False, "error": "没有 draft.md：%s" % draft}
    text = rd(draft)
    blocks = blocks_of(text)
    imgs = [x for k, x in blocks if k == "img"]
    body = [x for x in imgs if not PH_RE.match(x).group(1).startswith("封面")]
    has_cover = len(body) != len(imgs)

    items = []
    # 封面永远需要，不管 draft.md 里有没有「封面」图位。
    # 第一版只在发现 `![封面：…]` 时才生成封面项，结果 v38 这类没有封面图位的稿子
    # 就不出 cover.md —— 但封面是每篇都要的（微信上传封面图），跟正文图位无关。
    items.append({"kind": "cover", "desc": "", "prompt": "imgs/prompts/cover.md",
                  "note": "封面看整篇，不是某一段"})

    # 正文图位按出现顺序编号；封面的位置单独记（它在 # 行之前）
    n = 0
    img_seq = 0          # 这是第几个图位（含封面），segment_for 按它定位
    for kind, raw in blocks:
        if kind != "img":
            continue
        desc = PH_RE.match(raw).group(1)
        if desc.startswith("封面"):
            # 有封面图位的，把它的描述补进封面项，但封面项已经在上面建好了
            items[0]["desc"] = desc
            img_seq += 1
            continue
        n += 1
        pre, pbody, err = parse_prefix(desc)
        seg = segment_for(blocks, img_seq)
        img_seq += 1
        items.append({
            "kind": "body", "index": n,
            "prefix": pre, "form": (FORMS.get(pre) or {}).get("form"),
            "hint": (FORMS.get(pre) or {}).get("hint"),
            "desc": pbody, "raw": desc,
            "segment": seg, "segmentChars": zh_len(seg),
            "prompt": "imgs/prompts/img-%02d.md" % n,
            "error": err,
        })

    errs = [x["error"] for x in items if x.get("error")]
    return {"ok": not errs, "dir": d, "hasCover": has_cover,
            "count": n, "items": items,
            "prefixes": sorted(FORMS), "targetChars": TARGET_CHARS,
            "error": ("%d 个图位前缀不合规" % len(errs)) if errs else None}


def cmd_write(d, spec_path):
    """把 Agent 提炼好的画面描述落成 prompt 文件。

    **不接受 Agent 自己手写文件**：frontmatter、aspect 引号、文件命名
    都由代码控制。让模型手写 YAML 的下场是 `aspect: 16:9` 没加引号被
    YAML 解析成整数（SKILL.md 第 108 行专门记了这个坑）。
    """
    plan = cmd_plan(d)
    if not plan.get("items"):
        return {"ok": False, "error": plan.get("error") or "没有图位"}
    try:
        spec = json.loads(rd(spec_path))
    except Exception as e:
        return {"ok": False, "error": "读不了 spec：%s" % e}

    # 前缀不合规就整批拒绝落盘。
    # 落盘之后再报错等于「错的东西已经写进仓库了」，下一篇 Agent 照着抄，
    # 错误会被复制传播。宁可这里失败，让 Agent 回去改图位描述。
    bad = [it for it in plan["items"] if it.get("error")]
    if bad:
        return {"ok": False,
                "error": "有 %d 个图位前缀不合规，先改 draft.md 的图位描述再落盘"
                         % len(bad),
                "bad": [{"prompt": b["prompt"], "raw": b.get("raw"),
                         "error": b["error"]} for b in bad]}

    got = {str(x.get("index")): x for x in (spec.get("items") or [])}

    # 先把每一项都算成 (路径, 内容)，全部齐了再落盘。
    # 第一版是一边校验一边写，结果「缺封面」时 4 张正文 prompt 已经写进仓库了 ——
    # 半批落盘比全不落更糟：目录看着像做完了，实际缺一张，而 check 才会发现。
    pending, missing = [], []
    for it in plan["items"]:
        if it["kind"] == "cover":
            c = spec.get("cover") or {}
            prompt = (c.get("prompt") or "").strip()
            if not prompt:
                missing.append("cover")
                continue
            # 封面一律不写字（用户 2026-11-17 决定）。要压字走别的功能，不在生图里做。
            # 实测过：指定了字模型能画准（#424「规矩一次填清楚」六个字全对），
            # 但那是另一条产品线的事；配图只负责出干净画面。
            # 这里留一道防呆：prompt 里带写字指令就拦下，否则模型会自己编字，
            # 实测编出过英文「Keep Going」（#261）和俄文（#259）。
            hits = [w for w in WRITE_WORDS if w in prompt]
            if hits:
                return {"ok": False, "written": [], "missing": ["cover"],
                        "error": "封面 prompt 里出现了写字指令「%s」。封面一律不写字，"
                                 "要压字走别的功能。把写字的句子删掉再落盘" % hits[0]}
            pending.append((
                it["prompt"],
                "---\naspect: \"2.35:1\"\noutMode: article-cover\n---\n\n" + prompt + "\n",
                {"kind": "cover", "path": it["prompt"], "chars": zh_len(prompt)}))
            continue
        k = str(it["index"])
        if k not in got:
            missing.append(it["prompt"])
            continue
        prompt = (got[k].get("prompt") or "").strip()
        if not prompt:
            missing.append(it["prompt"])
            continue
        pending.append((
            it["prompt"],
            "---\naspect: \"16:9\"\nform: %s\nprefix: %s\n---\n\n%s\n"
            % (it["form"] or "", it["prefix"] or "", prompt),
            {"kind": "body", "index": it["index"], "path": it["prompt"],
             "form": it["form"], "chars": zh_len(prompt)}))

    if missing:
        return {"ok": False, "written": [], "missing": missing,
                "error": "缺 %d 项画面描述：%s（一项没给齐就整批不落盘，避免半批残留）"
                         % (len(missing), ", ".join(missing))}

    written = []
    for rel, content, rec in pending:
        wr(os.path.join(d, rel), content)
        written.append(rec)

    return {"ok": True, "written": written, "missing": [],
            "error": None}


def cmd_check(d):
    plan = cmd_plan(d)
    problems = []
    for it in plan.get("items") or []:
        if it.get("error"):
            problems.append("%s 前缀不合规：%s" % (it.get("prompt"), it["error"]))
            continue
        p = os.path.join(d, it["prompt"])
        if not os.path.isfile(p):
            problems.append("缺 prompt 文件：%s（先落 prompt 再生成，不许反过来）" % it["prompt"])
            continue
        body = rd(p)
        if zh_len(body) < 20:
            problems.append("%s 内容太短（%d 字），提示词写不清画面"
                            % (it["prompt"], zh_len(body)))
        # 封面一律不写字：prompt 里带写字指令，模型就会自己编字（实测编出英文和俄文）
        if it["kind"] == "cover":
            text = re.sub(r"^---.*?---\s*", "", body, count=1, flags=re.S)
            hits = [w for w in WRITE_WORDS if w in text]
            if hits:
                problems.append("%s 有写字指令「%s」。封面一律不写字，"
                                "要压字走别的功能" % (it["prompt"], hits[0]))
    if plan.get("count", 0) == 0:
        problems.append("一个正文图位都没有")
    return {"ok": not problems, "dir": d, "count": plan.get("count"),
            "problems": problems,
            "error": ("%d 个问题" % len(problems)) if problems else None}


def read_style_log():
    """读全局风格流水。返回 [{date, slug, style, medium}]。"""
    if not os.path.isfile(STYLE_LOG):
        return []
    rows = []
    for ln in rd(STYLE_LOG).split("\n"):
        # style 列既要能吃 `FA-013`，也要能吃 `FA-013 Bold Flat Everyday Satire`
        # （记风格名比只记编号有用得多，下次挑风格时能直接看出上次用了什么调性）。
        m = re.match(r"^\|\s*(\d{8})\s*\|\s*([^|]+?)\s*\|\s*([A-Z]{2}-\d+[^|]*?)\s*\|\s*([^|]*?)\s*\|",
                     ln)
        if m:
            rows.append({"date": m.group(1), "slug": m.group(2),
                         "style": m.group(3), "medium": m.group(4)})
    return rows


def cmd_style_log(recent=0, append=None):
    rows = read_style_log()
    if append:
        slug, style, medium = (list(append) + ["", ""])[:3]
        date = (slug or "")[:8]
        # 草稿目录有两种命名：新的是 `20261117-slug`，老的是 `v39-slug`。
        # 不能因为目录名不带日期就拒绝记账 —— 那等于把老稿子排除在「别连续用同一风格」
        # 这条规则之外，而规则本来是看**时间**的。拿不到日期就用当天。
        if not re.match(r"^\d{8}$", date):
            date = datetime.date.today().strftime("%Y%m%d")
        if not style:
            return {"ok": False,
                    "error": "用法：--append 20261117-moyu FI-009 场景实拍"
                             "（slug 前 8 位是日期；不是日期则用当天）"}
        if not os.path.isfile(STYLE_LOG):
            wr(STYLE_LOG, "# 配图风格流水（全局）\n\n"
                          "为什么是全局一份：规则是「同一风格别连续用三篇」，"
                          "每篇存一份的话跨篇根本查不了。\n\n"
                          "| 日期 | 草稿 | 风格 | 媒介 |\n|---|---|---|---|\n")
        with io.open(STYLE_LOG, "a", encoding="utf-8", newline="\n") as f:
            f.write("| %s | %s | %s | %s |\n" % (date, slug, style, medium))
        return {"ok": True, "appended": {"date": date, "slug": slug,
                                         "style": style, "medium": medium},
                "path": STYLE_LOG}

    tail = rows[-int(recent):] if recent else rows
    # 连续三篇同风格就该换：把最近 3 条的 style 都列出来让 Agent 自己避开
    streak = {}
    for r in rows[-3:]:
        streak[r["style"]] = streak.get(r["style"], 0) + 1
    return {"ok": True, "path": STYLE_LOG, "total": len(rows),
            "recent": tail,
            "avoid": [s for s, c in streak.items() if c >= 2],
            "note": "avoid 里的风格最近三篇用过两次以上，换一个"}


def cmd_generate(d, style_code, draft_id=None, quality=None):
    """**一条命令把整组图并发跑完**（2026-11-18 加）。

    为什么要这个命令（真实问题）
    ---------------------------
    用户在创作台点「配图」，期望整组图一起出。实测是**一张张排队**跑：4 张图
    串行，每张 40 秒以上，等了快三分钟。

    根因不是并发机制不好（`run_series` 已经用线程池，按 panel_index 排序输出），
    而是**创作台那条路径没走进并发**：提示词只说「批量时并发跑」，Agent 自己
    拼命令行时选了最简单的单张 `run`，结果变成串行。

    所以这里把「整组并发」做成确定的代码行为：一次建 series + N 个 job，
    然后调 `run_series`。Agent 只跑一条命令，没得选。

    读什么：`imgs/prompts/*.md` 的 frontmatter（aspect）和正文（画面描述）。
    **不重新提炼 prompt** —— 那是 write 那一步的事，这里只管提交和跑。
    """
    # 1. 从 prompts/*.md 读出所有待生成的图
    plan = cmd_plan(d)
    if not plan.get("items"):
        return {"ok": False, "error": plan.get("error") or "没有图位"}

    prompt_dir = os.path.join(d, "imgs", "prompts")
    if not os.path.isdir(prompt_dir):
        return {"ok": False, "error": "imgs/prompts/ 不存在，先跑 write 落 prompt"}

    jobs_spec = []
    missing = []
    for it in plan["items"]:
        p = os.path.join(d, it["prompt"])
        if not os.path.isfile(p):
            missing.append(it["prompt"])
            continue
        raw = rd(p)
        m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", raw, re.S)
        if not m:
            missing.append(it["prompt"] + "（frontmatter 缺失）")
            continue
        front, body = m.group(1), m.group(2).strip()
        if not body:
            missing.append(it["prompt"] + "（画面描述为空）")
            continue
        aspect = "16:9"
        am = re.search(r'aspect:\s*"?([\d.]+:[\d.]+)"?', front)
        if am:
            aspect = am.group(1)
        jobs_spec.append({
            "index": 0 if it["kind"] == "cover" else it["index"],
            "kind": it["kind"],
            "prompt": body,
            "aspect": aspect,
            "file": it["prompt"],
        })

    if missing:
        return {"ok": False,
                "error": "有 %d 个 prompt 缺失或为空，先补齐再生成" % len(missing),
                "missing": missing}

    # 2. 建 series（一次创作 = 一个数据对象，和绘图工作台一致）
    title = os.path.basename(d.rstrip("/\\"))
    created = db_image({"op": "series-create",
                        "title": title,
                        "sourceText": "\n\n".join(x["prompt"] for x in jobs_spec),
                        "panelTotal": len(jobs_spec),
                        "splitMeta": {"from": "article-images.generate",
                                      "style": style_code,
                                      "draftId": draft_id}})
    if not created.get("ok"):
        return {"ok": False, "error": "series 创建失败：%s" % created.get("error")}
    sid = created["series"]["id"]

    # 3. 逐个入队。**必须带 seriesId + panelIndex** —— run_series 靠这两个字段
    #    找到这一批任务并按镜序输出，漏了就变成「0 镜」，一张都不生成。
    enq_err = []
    for x in jobs_spec:
        r = db_image({
            "op": "image-enqueue",
            "seriesId": sid,
            "panelIndex": x["index"],
            "theme": x["prompt"],
            "styleId": style_code,
            "size": RATIO_TO_SIZE.get(x["aspect"], "1280x720"),
            "quality": quality or "",
            "params": {
                "ratio": x["aspect"],
                "mode": "article-illustration",
                "whitespace": "",
                "mood": "",
                "text": "",
                "draftId": draft_id,
                "role": "article-cover" if x["kind"] == "cover" else "article-illustration",
                "promptFile": x["file"],
            },
        })
        if not r.get("ok"):
            enq_err.append({"index": x["index"], "error": r.get("error")})

    if enq_err:
        return {"ok": False, "seriesId": sid,
                "error": "%d 个入队失败" % len(enq_err), "failed": enq_err}

    # 4. 并发跑（run_series 内部用线程池，路数见 series_concurrency）
    run = image_gen(["run-series", "--series", str(sid)], timeout=1800)

    return {"ok": bool(run.get("ok")),
            "seriesId": sid,
            "count": len(jobs_spec),
            "cover": any(x["kind"] == "cover" for x in jobs_spec),
            "body": len([x for x in jobs_spec if x["kind"] == "body"]),
            "style": style_code,
            "run": run}


def main():
    ap = argparse.ArgumentParser(description="文章配图 · 分段与提示词落盘")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("plan", help="按图位切段，给出每张图该看哪段正文")
    p.add_argument("dir")

    p = sub.add_parser("write", help="把提炼好的画面描述写成 prompts/*.md")
    p.add_argument("dir")
    p.add_argument("--spec", required=True, help="JSON：{cover:{prompt},items:[{index,prompt}]}")

    p = sub.add_parser("check", help="校验前缀与 prompt 是否齐全")
    p.add_argument("dir")

    p = sub.add_parser("style-log", help="全局风格流水")
    p.add_argument("--recent", type=int, default=0)
    p.add_argument("--append", nargs=3, metavar=("SLUG", "STYLE", "MEDIUM"),
                   help="记一篇：--append 20261117-moyu FI-009 场景实拍（日期从 slug 前 8 位取）")

    p = sub.add_parser("generate", help="一条命令把整组图并发跑完（封面 + 正文图）")
    p.add_argument("dir")
    p.add_argument("--style", required=True, help="画风 ID，如 FC-029。整篇共用同一个")
    p.add_argument("--draft-id", default=None, help="草稿 id，用于出图后回写正文")
    p.add_argument("--quality", default=None, help="可选：high / medium / low")

    a = ap.parse_args()
    if a.cmd == "plan":
        r = cmd_plan(a.dir)
    elif a.cmd == "write":
        r = cmd_write(a.dir, a.spec)
    elif a.cmd == "check":
        r = cmd_check(a.dir)
    elif a.cmd == "style-log":
        r = cmd_style_log(a.recent, a.append)
    elif a.cmd == "generate":
        r = cmd_generate(a.dir, a.style, a.draft_id, a.quality)
    else:
        r = {"ok": False, "error": "unknown cmd"}
    print(json.dumps(r, ensure_ascii=False))
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
