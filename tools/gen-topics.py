#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""选题生成：从当天素材里综合分析，挑 10 个热点，每个生成一个最可能爆的角度。

     python tools/gen-topics.py                 # 分析今天，产出 10 个选题
     python tools/gen-topics.py --date 2026-11-07
     python tools/gen-topics.py --dry           # 只打分不写库

为什么要有这一步（2026-11-07）：
    素材库每天抓 250 条热榜标题，但选题一直靠人肉翻。250 条里能做的可能就 10 条，
    靠人挑既慢又会漏。这里把「筛选」和「定角度」两件事拆开自动做：
      · 筛选靠可量化的打分（赛道匹配 / 可核实性 / 冲突强度 / 共鸣面）
      · 定角度靠规则模板（不同类型的热点用不同的角度公式）

设计原则：
    1. **只做能做的赛道**。用户已定三个内容块：广州政策×钱、广州生活知识、广府饮食文化。
       不在赛道内的一律低分，哪怕它很热。
    2. **必须可核实**。热榜只有标题没有正文，凡是需要数据支撑的角度都要标
       needs_material=1，提醒写作前先查证。
    3. **一个热点只出一个角度**。宁缺毋滥，不硬凑。
"""
import argparse
import io
import json
import os
import re
import sqlite3
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
WS = os.path.dirname(PLUGIN)
DB = os.path.join(WS, "workbench", "workbench.db")
SNAPSHOT = os.path.join(PLUGIN, "lib", "materials.snapshot.json")
OUT = os.path.join(PLUGIN, "lib", "topics.generated.json")


# ── 赛道判定（与 client.template.js 的 GENRES 一致）─────────────────────
# 系统原有 8 个通用赛道，不做地域限定、不做题材屏蔽。
# 每个赛道给一组判据词，命中越多分越高。
TRACKS = {
    "社会民生": {
        "kw": ["家长", "孩子", "老人", "市民", "乘客", "邻居", "社区", "小区",
               "上学", "学校", "教育", "老师", "医院", "就医", "社区", "物业",
               "骗", "诈", "坑", "维权", "投诉", "纠纷", "通报", "回应"],
    },
    "娱乐与情感": {
        "kw": ["明星", "恋情", "结婚", "离婚", "塌房", "绯闻", "综艺", "演员",
               "歌手", "夫妻", "婆媳", "情感", "网红", "直播", "出轨", "复合",
               "官宣", "影视", "剧", "动漫", "搞笑", "段子", "粉丝"],
    },
    "AI 与科技": {
        "kw": ["AI", "大模型", "芯片", "算法", "机器人", "算力", "开源", "编程",
               "开发者", "数码", "手机", "电脑", "科学", "航天", "量子", "Gemini",
               "GPT", "DeepSeek", "智能", "技术", "数据"],
    },
    "国际与时事": {
        "kw": ["美国", "日本", "俄罗斯", "乌克兰", "外交", "联合国", "欧洲",
               "中东", "总统", "以色列", "伊朗", "朝鲜", "军事", "对华",
               "特朗普", "普京", "欧盟", "北约", "停火"],
    },
    "财经与商业": {
        "kw": ["股", "基金", "房价", "楼市", "财报", "营收", "融资", "上市",
               "消费", "税率", "工资", "薪", "经济", "商业", "创业", "公司",
               "企业", "汽车", "新能源", "贷款", "利率", "存款", "亏", "赚"],
    },
    "文化与生活": {
        "kw": ["文化", "传统", "节气", "立冬", "冬至", "历史", "老字号", "非遗",
               "饮食", "吃", "菜", "汤", "茶", "食材", "做法", "家乡", "习俗",
               "电影", "书", "音乐", "旅行", "风景"],
    },
    "体育与健康": {
        "kw": ["球", "赛季", "夺冠", "奥运", "全运", "运动员", "冠军", "比赛",
               "健身", "养生", "健康", "医疗", "疾病", "药", "疫苗", "体检",
               "睡眠", "作息", "减肥", "运动", "跑步", "确诊", "医生"],
    },
    "教育与职场": {
        "kw": ["职场", "上班", "加班", "裁员", "求职", "跳槽", "副业", "成长",
               "自律", "效率", "时间管理", "考研", "高考", "招生", "教师",
               "校招", "年薪", "面试", "入职", "绩效"],
    },
}

# 不做任何题材屏蔽。用户明确要求「全不屏蔽」。
BLOCK = []

# 高分享潜力的信号词（与已确认的内容律一致：危害/避坑/钱）
# 爆点词只收「有情绪/有后果」的词。
# 不含「元/万/亿/%」这类纯单位——它们会被当成爆点写进 hook，
# 出现「关键在『元』这一层」这种废话（2026-11-08 修）。
BOOST = ["涨价", "降价", "亏", "省", "免费", "补贴", "退款", "罚", "禁", "骗",
         "坑", "误区", "致癌", "有毒", "危害", "千万别", "暴跌", "暴涨",
         "崩", "翻车", "爆冷", "确诊", "失算", "争议", "回应", "通报",
         "裁员", "欠", "断", "停", "封"]

# 时政硬新闻：不屏蔽（用户要求全不屏蔽），但降权。
# 理由：这类内容写不了也发不了，让它自然沉到后面，而不是硬排除。
# 用户明确选的是「降权不屏蔽」。
POLITICS_DOWNWEIGHT = ["总书记", "政治局", "常委会", "中央", "国务院", "人大",
                       "政协", "庄严", "投票", "选举", "全会", "讲话", "指示",
                       "批示", "考察", "调研", "会谈", "会见", "致辞"]


def load_materials(date):
    j = json.load(io.open(SNAPSHOT, encoding="utf-8"))
    rows = j.get("byDate", {}).get(date, [])
    return rows


def score(row):
    """返回 (总分, 命中赛道, 明细)。分数越高越值得做。"""
    title = (row.get("title") or "").strip()
    if not title:
        return -999, None, {}

    detail = {}

    # 不做题材屏蔽（用户要求全不屏蔽）

    # 1) 赛道匹配：命中词最多的那个赛道
    best_track, best_hits = None, []
    for name, cfg in TRACKS.items():
        hits = [k for k in cfg["kw"] if k in title]
        if len(hits) > len(best_hits):
            best_track, best_hits = name, hits

    if not best_hits:
        return -999, None, {"无赛道": title[:20]}

    detail["赛道"] = best_track
    detail["命中词"] = best_hits[:5]

    s = 0
    s += min(len(best_hits), 4) * 18          # 赛道相关，最多 72

    # 2) 爆文信号
    boosts = [b for b in BOOST if b in title]
    detail["爆点词"] = boosts[:5]
    s += min(len(boosts), 3) * 12

    # 3) 数字（有具体数字的更好写）
    if re.search(r"\d", title):
        s += 12
        detail["含数字"] = True

    # 4) 榜单位置（越靠前越热）
    rank = row.get("rank")
    if isinstance(rank, int) and rank <= 10:
        s += (11 - rank) * 4
        detail["榜单"] = f"第{rank}"

    # 5) 标题长度：太短信息不足，太长不像标题
    n = len(title)
    if 8 <= n <= 30:
        s += 8
    elif n > 45:
        s -= 10

    # 6) 时政硬新闻降权（不屏蔽）
    pol = [k for k in POLITICS_DOWNWEIGHT if k in title]
    if pol:
        s -= 45
        detail["时政降权"] = pol[:3]

    return s, best_track, detail


def cross_platform(rows):
    """统计每个标题出现在几个平台。同题多平台是强信号。"""
    seen = {}
    for r in rows:
        t = (r.get("title") or "").strip()
        if t:
            seen.setdefault(t, set()).add(r.get("platform"))
    return seen


def pick_angle(title, track):
    """按赛道 + 题材给角度公式。一个热点只出一个最能爆的角度。"""

    # 先按题材细分（跨赛道通用）
    if any(k in title for k in ["涨", "降", "利率", "价格", "存款", "贷款", "薪", "年薪"]):
        return ("从「一个具体的人算了一笔账」切进去。必须给出两个可核对的数字"
                "（变之前 / 变之后），算不清就别写。不写行情分析，写这笔钱对读者意味着什么。")
    if any(k in title for k in ["骗", "诈", "坑", "维权", "投诉"]):
        return ("从「骗子用的是哪个心理开关」切进去。拆解话术或套路的结构，"
                "给出三条能当场用的识别动作，而不是罗列「要提高警惕」。")
    if any(k in title for k in ["上学", "入学", "学位", "招生", "考试", "教师", "校招"]):
        return ("从「当事人明天要做的那个动作」切进去。落到能办的事：去哪办、要带什么、"
                "卡在哪一步。不写政策解读。")
    if any(k in title for k in ["确诊", "症状", "病", "医生", "医院", "药"]):
        return ("从「这个信号大多数人会忽略」切进去。说清什么情况下该去查、挂什么科、"
                "拖下去的代价。不做疾病科普通稿。")
    if any(k in title for k in ["节气", "立冬", "冬至", "进补", "习俗", "传统"]):
        return ("从「大多数人把这个节气过错了」切进去。先指出一个具体的错法，"
                "再说清正确做法和它背后的原因。不写民俗百科。")
    if any(k in title for k in ["吃", "菜", "汤", "茶", "食材", "饮食"]):
        return ("从「为什么是这样做」而不是「怎么做」切进去。给读者一个能讲给别人听的解释，"
                "落到气候、物产或历史。")
    if any(k in title for k in ["睡眠", "作息", "运动", "跑步", "健身", "养生"]):
        return ("从「大家羡慕或焦虑的到底是什么」切进去。多数人盯着那个具体动作，"
                "真正起作用的是背后那套能长期重复的结构。")
    if any(k in title for k in ["AI", "大模型", "芯片", "算法", "技术"]):
        return ("从「这个技术变化对普通人的具体影响」切进去。不写参数和跑分，"
                "写它改变了谁的什么行为，以及有什么代价。")
    if any(k in title for k in ["美国", "日本", "俄罗斯", "外交", "总统", "以色列"]):
        return ("从「这件事和普通人的哪根线连着」切进去。不做局势分析，"
                "写它对物价、就业、出行或安全的具体传导。")
    if any(k in title for k in ["明星", "恋情", "结婚", "离婚", "综艺", "演员"]):
        return ("从「公众在这个人身上投射了什么」切进去。不站队、不评价人品，"
                "写清这件事为什么让这么多人想说两句。")

    # 赛道兜底
    FALLBACK = {
        "社会民生": "从「一个具体的人遇到了什么」切进去，再指出这不是个例而是结构问题。",
        "娱乐与情感": "从「公众投射了什么」切进去，不站队、不评价人品。",
        "AI 与科技": "从「对普通人的具体影响」切进去，不写参数和跑分。",
        "国际与时事": "从「和普通人的哪根线连着」切进去，不做局势分析。",
        "财经与商业": "从「一笔算得清的账」切进去，给数字不给观点。",
        "文化与生活": "从「为什么是这样做」切进去，给一个能转述给别人的解释。",
        "体育与健康": "从「大多数人忽略的那个信号」切进去，给可执行的动作。",
        "教育与职场": "从「当事人明天要做的那个动作」切进去，落到能办的事。",
    }
    return FALLBACK.get(track, "从最反常的那个事实切进去，先给事实再给判断。")



# ── 选题内容生成（补齐 Job 路径有的字段）────────────────────────────────
PERSONA = {
    "社会民生": "关心身边事的普通读者",
    "娱乐与情感": "爱看娱乐话题的泛读者",
    "AI 与科技": "关注技术进展的从业者与爱好者",
    "国际与时事": "关心国际动态的读者",
    "财经与商业": "关心钱和资产的普通投资者",
    "文化与生活": "对生活方式与文化感兴趣的读者",
    "体育与健康": "看比赛 / 关心健康的普通读者",
    "教育与职场": "家长、学生与上班族",
}


def gen_titles(title, track, detail):
    """按题材生成候选标题，混合风格。

    硬要求：每条都必须是能读通的完整句子。
    上一版用「数字 + 逗号 + 原标题截断」拼，产出「11，如何看待 月 7 日…」
    这种断句，比没有更糟（2026-11-08 修）。宁可只出 2 条干净的。
    """
    out = []
    boosts = detail.get("爆点词") or []

    # 1) 直述型：去掉平台口吻的前缀（如何看待/如何评价/为何/为什么）
    t = re.sub(r"^(如何看待|如何评价|怎么看待|为何|为什么)\s*", "", title).strip()
    t = t.rstrip("？?。 ")
    if len(t) >= 8:
        out.append({"title": t, "style": "直述"})

    # 2) 数字型：只有当数字本身是「独立且有意义」的段首信息时才用。
    #    做法是把标题里的核心数字提到句首，后面接完整谓语，不做中间截断。
    m = re.match(r"^(.{4,40}?)[，,]\s*(.+)$", t)
    nums = re.findall(r"\d+(?:\.\d+)?\s*(?:万|亿|元|%|岁|年|天|小时|分钟)?", t)
    if nums and m:
        head, tail = m.group(1), m.group(2)
        # 数字在句首的，直接用原句；不在的，把数字作为前置话题，后面接完整后半句
        if not re.match(r"^\d", t):
            cand = f"{nums[0]}，{tail}"
            if len(cand) >= 10 and len(cand) <= 34:
                out.append({"title": cand, "style": "数字"})

    # 3) 悬念型：按赛道给「问句式」尾巴，但主语必须是完整短语
    tail_map = {
        "体育与健康": "问题出在哪",
        "AI 与科技": "对普通人意味着什么",
        "社会民生": "卡在哪一步",
        "财经与商业": "这笔账怎么算",
        "文化与生活": "为什么是这样",
        "娱乐与情感": "为什么这么多人想说两句",
        "国际与时事": "和普通人的哪根线连着",
        "教育与职场": "当事人明天该做什么",
    }
    tail = tail_map.get(track)
    # 取前 16 字做主语，且必须在标点或词边界处收尾，不硬切
    base = t
    if tail and len(base) > 6:
        short = base[:18]
        # 如果截断处落在数字/英文中间，退回到前一个标点
        if re.search(r"[0-9A-Za-z]$", short) or short != base and re.match(r"^[0-9A-Za-z]", base[len(short):len(short)+1] or ""):
            cut = max(short.rfind("，"), short.rfind(" "), short.rfind("、"))
            if cut > 6:
                short = short[:cut]
        # 截断处不能是悬空谓语（「被指」「涉嫌」「导致」后面缺宾语），
        # 否则会产出「美国家长起诉谷歌 Gemini 被指，卡在哪一步」这种残句。
        DANGLING = ("被指", "涉嫌", "导致", "引发", "称", "表示", "宣布", "回应",
                    "针对", "关于", "对于", "以及", "和", "与", "的")
        if not short.endswith(("，", "、", " ")) and not short.endswith(DANGLING):
            out.append({"title": f"{short}，{tail}", "style": "悬念"})

    # 4) 如果标题本身已经是问句，做一个陈述式改写
    if re.search(r"(如何看待|如何评价|为什么|为何)", title):
        decl = re.sub(r"^(如何看待|如何评价|怎么看待|为什么|为何)\s*", "", title)
        decl = decl.rstrip("？? ")
        if decl and decl != t and len(decl) >= 10:
            out.append({"title": decl + "，值得说清楚", "style": "直述"})

    # 去重 + 校验：每条 8-34 字，且不含连续标点
    seen, res = set(), []
    for x in out:
        ti = x["title"].strip()
        if ti in seen or not (8 <= len(ti) <= 34):
            continue
        if re.search(r"[，,]{2,}|^[，,]|[，,]$", ti):
            continue
        # 不能以单个数字或英文碎片结尾
        if re.search(r"\d$", ti) and not re.search(r"\d\s*(万|亿|元|%|岁|年|天)$", ti):
            continue
        seen.add(ti)
        res.append(x)
    return res[:4] if res else [{"title": title, "style": "直述"}]


def gen_digest(title, track, angle):
    """摘要候选：独立成立，不重复正文开头。"""
    tmpl = {
        "社会民生": "这条热榜背后涉及具体的人和具体的规则。写清楚发生了什么、规则是怎么定的、以及读者自己会不会遇上。",
        "娱乐与情感": "这件事之所以让人想说两句，不是因为当事人本身，而是它碰到了公众心里的某根线。",
        "AI 与科技": "这个变化的技术细节不是重点，重点是它改变了谁的什么行为，以及代价由谁承担。",
        "国际与时事": "这件事和普通人的连接不在局势本身，而在它传导到物价、就业或出行上的那一段。",
        "财经与商业": "这笔账可以算清楚：涉及多少金额、变化幅度多大、对普通人的实际影响是什么。",
        "文化与生活": "一个日常习惯背后往往有气候、物产或历史的原因。写清楚它为什么是这样。",
        "体育与健康": "这场比赛 / 这个健康说法值得拆开看，因为多数人只看到了结果，没看到过程里的关键节点。",
        "教育与职场": "这件事落到当事人身上是一个具体的动作：去哪办、要什么条件、卡在哪一步。",
    }
    base = tmpl.get(track, "这条热榜值得往下拆一层，看清它和普通人的关系。")
    # 不带「（选题：xxx）」这种后缀——摘要要能独立成立，
    # 挂在后台文章列表里给读者看，不是给自己做备注的。
    return base


def gen_outline(title, track, words=1800):
    """大纲预览：4-5 个推进节点，标注字数。"""
    w1 = int(words * 0.15)
    w2 = int(words * 0.28)
    w3 = int(words * 0.28)
    w4 = int(words * 0.18)
    w5 = words - w1 - w2 - w3 - w4

    nodes = {
        "体育与健康": [
            ("开头", w1, "先给最反常的那个事实或数字，制造反差"),
            ("过程拆解", w2, "逐段写清关键节点，谁在什么时候占了上风"),
            ("转折在哪", w3, "指出真正的分水岭，而不是笼统说发挥不好"),
            ("对照面", w4, "同一天 / 同类型事件的另一面，形成参照"),
            ("结尾", w5, "停在具体事实上，不做趋势判断"),
        ],
        "AI 与科技": [
            ("开头", w1, "抛出一个具体的数字或变化"),
            ("这东西是什么", w2, "最低限度背景，只讲理解后文需要的部分"),
            ("改变了什么", w3, "对具体人群的具体行为影响"),
            ("代价与边界", w4, "谁承担成本、什么情况下不成立"),
            ("结尾", w5, "停在一个可观察的事实上"),
        ],
        "社会民生": [
            ("开头", w1, "一个具体的人遇到的具体事"),
            ("规则是什么", w2, "把政策或流程讲清楚，给可核实的数字与门槛"),
            ("为什么卡住", w3, "指出真正的障碍在哪一步"),
            ("读者会不会遇上", w4, "落到读者自己的处境"),
            ("结尾", w5, "给一个能执行的动作"),
        ],
    }
    default = [
        ("开头", w1, "最反常的那个事实先出来"),
        ("背景", w2, "最低限度背景，只讲理解后文需要的"),
        ("核心", w3, "把主角度推到读者面前"),
        ("另一面", w4, "补一个反例或边界条件"),
        ("结尾", w5, "停在具体事实上"),
    ]
    picked = nodes.get(track, default)
    return [{"heading": h, "words": w, "gist": g} for h, w, g in picked]


def gen_effort(words):
    if words <= 1200:
        return "⭐ 约 1 小时"
    if words <= 1800:
        return "⭐⭐ 约 1.5 小时"
    return "⭐⭐⭐ 约 2-3 小时"



def build_topic(row, track, detail, score_val, platforms):
    title = (row.get("title") or "").strip()
    angle = pick_angle(title, track)

    words = 1800
    titles = gen_titles(title, track, detail)
    digest = gen_digest(title, track, angle)
    outline = gen_outline(title, track, words)

    # 钩子：不再拼接「标题（爆点：xx）」，改成一句能让人想往下看的判断
    boosts = detail.get("爆点词") or []
    if boosts:
        hook = f"标题只说了「{boosts[0]}」这个结果，没说它是怎么发生的。"
    else:
        hook = f"这条热榜值得往下拆一层：{title[:22]}。"

    return {
        "source_key": f"{row.get('platform')}@{row.get('date') or ''}#{row.get('rank')}",
        "title": title,
        "platform": row.get("platform"),
        "hot": row.get("hot") or "",
        "url": row.get("url") or "",
        "track": track,
        "content_block": track,
        "angle": angle,
        "hook": hook,
        "payoff": "写作前必须先查证：" + {
            "社会民生": "事件当事人的原话与官方回应，不要只凭热榜标题写",
            "娱乐与情感": "当事人的公开表态与时间线，区分已证实与传闻",
            "AI 与科技": "产品的官方说明与可核实的数字，不写参数猜测",
            "国际与时事": "权威媒体的原始报道，不用二手转述",
            "财经与商业": "具体金额、比例与时间点，算不清就别写",
            "文化与生活": "该习俗或做法的来源与地域依据",
            "体育与健康": "权威医学或机构说法，不要凭常识写",
            "教育与职场": "官方口径与具体数字（金额/比例/时间）",
        }.get(track, "该说法是否有权威来源支持"),
        "persona": PERSONA.get(track, "关心这个话题的普通读者"),
        "titles_json": titles,
        "best_title": titles[0]["title"] if titles else title,
        "digests_json": [digest],
        "outline_json": outline,
        "word_count": words,
        "effort": gen_effort(words),
        "score": score_val,
        "score_detail": detail,
        "platforms": platforms,
        "needs_material": 1,
        "status": "candidate",
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args()

    date = args.date or datetime.now().strftime("%Y-%m-%d")
    rows = load_materials(date)
    if not rows:
        print(f"  ❌ {date} 没有素材，先跑 gen-materials.py")
        return 1

    print(f"  分析 {date} 的 {len(rows)} 条素材")
    xplat = cross_platform(rows)

    blocked_reasons = {}
    scored = []
    for r in rows:
        s, track, detail = score(r)
        if track is None:            # 屏蔽
            why = detail.get("屏蔽", "?")
            blocked_reasons[why] = blocked_reasons.get(why, 0) + 1
            continue
        # 多平台共振加分
        t = (r.get("title") or "").strip()
        np_ = len(xplat.get(t, []))
        if np_ > 1:
            s += (np_ - 1) * 15
            detail["多平台"] = np_
        scored.append((s, r, track, detail))

    scored.sort(key=lambda x: -x[0])

    # 去重分两层：
    #   ① 同标题只留一条
    #   ② 同「主题簇」只留一条——10 个选题里 6 个是「立冬吃什么」的变体没有意义，
    #      爆文选题要覆盖不同方向，不是把同一件事写六遍。
    CLUSTERS = [
        ("立冬/节气", ["立冬", "冬至", "小雪", "大寒", "节气", "补冬", "进补"]),
        ("饮食/吃什么", ["吃什么", "饺子", "火锅", "菜", "汤", "茶", "食材", "饮食"]),
        ("养生/健康", ["养生", "健康", "体检", "医生", "病", "确诊", "症状"]),
        ("上学/教育", ["上学", "入学", "学位", "招生", "考试", "开学"]),
        ("钱/费用", ["涨价", "降价", "收费", "缴费", "补贴", "工资", "退休"]),
    ]

    def event_key(title):
        """抽事件指纹：英文词、数字、以及长度≥3的连续中文片段。
        同一件事在不同平台的标题措辞不同，但实体是重合的。"""
        toks = set()
        toks.update(re.findall(r"[A-Za-z]{3,}", title))          # OpenAI / Bloomberg
        toks.update(re.findall(r"\d+(?:\.\d+)?", title))         # 110 / 1.25
        # 中文里抽 2-3 字的高信息片段（去掉常见虚词）
        for seg in re.findall(r"[\u4e00-\u9fff]{2,}", title):
            if seg not in ("如何看待", "为什么", "什么", "如何", "这个", "这种", "为何"):
                toks.add(seg[:4])
        return toks

    def same_event(a, b):
        """两个标题的实体重叠超过阈值就判为同一件事。"""
        ka, kb = event_key(a), event_key(b)
        if not ka or not kb:
            return False
        inter = len(ka & kb)
        return inter >= 2 and inter / min(len(ka), len(kb)) >= 0.35

    def cluster_of(title):
        for name, kws in CLUSTERS:
            if any(k in title for k in kws):
                return name
        return None

    # 赛道配额：每赛道最多 MAX_PER，且尽量每个赛道都有。
    # 不加配额时 AI 与科技会占 7/10（AIHOT 两个频道每天固定 20 条高信息量新闻，
    # 打分天然高），其他赛道挤不进去，选题库就废了。
    MAX_PER = 3
    per_track = {}
    seen, seen_cluster, picked = set(), set(), []
    skipped_overflow = []

    for s, r, track, detail in scored:
        t = (r.get("title") or "").strip()
        if t in seen:
            continue
        cl = cluster_of(t)
        if cl and cl in seen_cluster:
            continue
        if per_track.get(track, 0) >= MAX_PER:
            skipped_overflow.append((s, r, track, detail))
            continue
        # 同事件判重：OpenAI 融资在 AI·热点和 AI·资讯各出现一次，
        # 标题措辞不同但讲的是同一件事，不该占两个名额。
        if any(same_event(t, x[1].get("title") or "") for x in picked):
            continue
        seen.add(t)
        if cl:
            seen_cluster.add(cl)
        per_track[track] = per_track.get(track, 0) + 1
        picked.append((s, r, track, detail))
        if len(picked) >= args.top:
            break

    # 配额没用满时，从被挤掉的里按分数补（不浪费素材）
    if len(picked) < args.top:
        for s, r, track, detail in skipped_overflow:
            t = (r.get("title") or "").strip()
            if t in seen:
                continue
            seen.add(t)
            picked.append((s, r, track, detail))
            if len(picked) >= args.top:
                break

    print(f"  赛道内候选 {len(scored)} 条，取前 {len(picked)} 个")
    print()
    print(f"  {'分数':>5}  {'内容块':<12} {'平台':<8} 标题")
    print("  " + "-" * 78)
    for s, r, track, detail in picked:
        plat = (r.get("platform") or "")[:6]
        print(f"  {s:>5}  {track:<12} {plat:<8} {(r.get('title') or '')[:42]}")

    topics = [build_topic(r, track, detail, s, sorted(xplat.get((r.get('title') or '').strip(), [])))
              for s, r, track, detail in picked]

    if args.dry:
        print()
        print("  [dry] 未写库")
        return 0

    io.open(OUT, "w", encoding="utf-8").write(
        json.dumps({"date": date, "count": len(topics), "topics": topics},
                   ensure_ascii=False, indent=1))

    # 写库
    conn = sqlite3.connect(DB)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    n = 0
    for t in topics:
        cur = conn.execute(
            "SELECT id FROM topics WHERE source_key=? AND status='candidate'",
            (t["source_key"],))
        if cur.fetchone():
            continue
        # 字段必须和 Job 路径（save-plans）产出一致，否则详情抽屉里
        # 自动生成的选题只有角度，没有候选标题/摘要/大纲/读者/工作量。
        conn.execute(
            """INSERT INTO topics
               (source_key, title, track, skill, kind, angle, hook, payoff,
                persona, titles_json, best_title, digests_json, outline_json,
                word_count, effort, needs_material, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (t["source_key"], t["title"], t["track"], "aws-wechat-article-topics",
             "hot", t["angle"], t["hook"], t["payoff"],
             t["persona"],
             json.dumps(t["titles_json"], ensure_ascii=False),
             t["best_title"],
             json.dumps(t["digests_json"], ensure_ascii=False),
             json.dumps(t["outline_json"], ensure_ascii=False),
             t["word_count"], t["effort"],
             t["needs_material"], "candidate", now))
        n += 1
    conn.commit()
    conn.close()

    print()
    print(f"  ✅ 写入 {n} 个选题（跳过重复 {len(topics)-n} 个）")
    print(f"     明细 → {OUT}")

    # 不足目标数时如实报，不硬凑。
    # 251 条素材里真正适合本赛道的可能只有 4 条，这是真实情况不是 bug。
    if len(picked) < args.top:
        print()
        print(f"  ⚠️ 只产出 {len(picked)} 个，未达目标 {args.top} 个。")
        print(f"     原因：{date} 的 {len(rows)} 条素材里，")
        print(f"     · 屏蔽项（时政/科技/外地/体育）已排除 {len(rows)-len(scored)} 条")
        print(f"     · 赛道内 {len(scored)} 条，主题簇去重后剩 {len(picked)} 条")
        print(f"     结论：今天素材不够，不硬凑。可等次日素材，或补常青层选题。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
