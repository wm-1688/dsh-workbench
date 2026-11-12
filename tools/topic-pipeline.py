#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从素材生成选题 · 统一四步流程（4 个入口共用）。

    python tools/topic-pipeline.py --date 2026-11-08      # 每日自动：10 素材 × 2 选题
    python tools/topic-pipeline.py --job 12               # 单条队列任务
    python tools/topic-pipeline.py --material "标题" --platform 抖音   # 手工单条

为什么要有这个脚本（2026-11-08 重构）：
    原来 4 个入口产出质量天差地别：
      · 自动分析靠关键词模板（「从『一个具体的人算了一笔账』切进去」这种套话）
      · 手工入口靠 Agent 自由发挥（每次不一样）
    而且「赵丽颖哄自己上班」这种娱乐话题会被套上「家长/学生/上班族 + 查官方数字」——
    赛道判错就全错。

    改造：4 条路跑同一套四步流程，由 Agent 执行（不直接调 LLM API）。

四步：
    ① 补全素材 —— 标题信息量不够就去搜原文
    ② 拆解素材 —— 有什么事实 / 缺什么 / 能提炼哪些公共命题
    ③ 定方向   —— 同一素材出多个**方向不同**的选题（差异化）
    ④ 出选题   —— 每个选题带齐读者三问 + 四维评分

差异化怎么落地（用户定义）：
    同一素材的 2 个选题**方向必须不同**，不能都写成「打工人共鸣」。
    比如「赵丽颖哄自己上班」：
      方向 A：职场共鸣 —— 哄自己上班是成年人的日常自救
      方向 B：文化观察 —— 明星的「接地气」是不是也是一种表演
    两个方向对同一批事实的解读完全不同，这才叫差异化。

输出：写进 topics 表，并落一份 _tmp/topics-prompt-<id>.md 给 Agent 读。
"""
import argparse
import io
import json
import os
import sqlite3
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import ws_path  # noqa: E402

WORKSPACE = ws_path.ensure_workspace(PLUGIN)
DB = os.path.join(WORKSPACE, "workbench", "workbench.db")
SNAPSHOT = os.path.join(PLUGIN, "lib", "materials.snapshot.json")


# ── 方向池：同一素材必须从**不同**方向切 ─────────────────────────────
# 这是差异化的落地方式。每个方向代表一种完全不同的解读视角，
# 不是「换个说法」，而是「看这件事的另一种方式」。
# 方向 → 推荐结构（教程 03 的六种结构）
# 选题阶段就定结构，不是写到一半才想。出骨架时可以改。
DIRECTION_STRUCTURE = {
    "共情": "story",      # 故事→观点：读者代入需要具体场景
    "拆解": "problem",    # 问题→拆解答案：拆解本质是回答问题
    "反差": "counter",    # 现象→反直觉判断：反差就是反直觉
    "代价": "story",      # 故事→观点：代价靠人物承担来体现
    "时间": "timeline",   # 时间线→落点
    "旁观": "contrast",   # 对比→分栏：旁观靠拉开距离对比
}

DIRECTIONS = {
    "共情": {
        "desc": "读者的同类处境。写「我也这样」，不写「你应该这样」。",
        "reader": "有同样处境的人",
    },
    "拆解": {
        "desc": "把现象拆成结构。读者看完会想「原来是这么回事」。",
        "reader": "想知道为什么的人",
    },
    "反差": {
        "desc": "找出和常识相反的那一面。读者会想「居然是这样」。",
        "reader": "喜欢意外感的人",
    },
    "代价": {
        "desc": "谁在为这件事付出什么。读者会想「原来有人要承担」。",
        "reader": "关心后果的人",
    },
    "时间": {
        "desc": "放在更长的时间线上看。读者会想「原来这不是新鲜事」。",
        "reader": "关心变化的人",
    },
    "旁观": {
        "desc": "站在局外看这件事本身为什么值得讨论。读者会想「这确实有点意思」。",
        "reader": "喜欢看热闹也看门道的人",
    },
}

# 每个素材出 2 个选题，方向必须不同。这里给组合，保证不撞。
DIRECTION_PAIRS = [
    ("共情", "拆解"),
    ("反差", "代价"),
    ("时间", "旁观"),
    ("拆解", "反差"),
    ("共情", "时间"),
]


# ── ① 补全素材 ───────────────────────────────────────────────────────
def needs_enrich(title):
    """标题信息量够不够。不够就去搜原文。

    判据：少于 15 字、或只有情绪没有事实（无数字/无主体/无动作），
    都算「不够」。
    """
    t = (title or "").strip()
    if len(t) < 15:
        return True
    has_num = any(c.isdigit() for c in t)
    has_action = any(k in t for k in ("宣布", "回应", "称", "表示", "发布", "调整",
                                      "涨", "跌", "亏", "罚", "禁", "起诉", "曝光"))
    if not has_num and not has_action:
        return True
    return False


def build_enrich_hint(title, platform):
    """生成「去搜原文」的指令，交给 Agent 执行。"""
    return (
        f"标题信息量不足，需要先搜原文补全事实。\n"
        f"搜索词建议：{title}\n"
        f"来源平台：{platform}\n"
        f"要拿到：时间、地点、当事人原话、具体数字、事情经过。"
    )


# ── ②③④ 的 prompt 生成（交给 Agent 执行）────────────────────────────
def guess_track(title):
    """按标题粗判赛道。只用于给 Agent 一个提示，不是硬分类。

    判错不要紧——Agent 会读素材自己判断，这里只是减少歧义。
    """
    # 顺序有讲究：政策/教育类关键词必须先判。
    # 实测「多地官宣调整中小学上学时间」被判成「娱乐与情感」——
    # 因为「官宣」命中了娱乐规则。这类词跨赛道，不能放在前面。
    # 人名与赛事：标题里只有名字没有「明星」「运动员」这类字眼，
    # 靠关键词判不出来。这两类单独前置判。
    SPORTS_NAME = ("王楚钦", "孙颖莎", "樊振东", "马龙", "张本", "温瑞博",
                   "国乒", "国足", "林诗栋", "蒯曼", "陈熠", "早田", "雨果")
    if any(k in title for k in SPORTS_NAME) or any(
            k in title for k in ("WTT", "亚锦赛", "世界杯", "奥运", "中甲", "中超")):
        return "体育与健康"

    ENT_NAME = ("赵丽颖", "杨幂", "李娜", "杨紫", "迪丽热巴", "王一博",
                "肖战", "易烊千玺", "刘亦菲", "汪苏泷", "许飞", "厉娜")
    if any(k in title for k in ENT_NAME):
        return "娱乐与情感"

    RULES = [
        ("教育与职场", ("上学", "入学", "学校", "老师", "教师", "招生", "考试",
                         "招聘", "职场", "加班", "裁员", "校招", "学位")),
        ("AI 与科技", ("AI", "大模型", "芯片", "算法", "机器人", "大模型")),
        ("体育与健康", ("比赛", "夺冠", "球队", "运动员", "健身", "健康", "医院",
                         "确诊", "医生", "体检")),
        ("财经与商业", ("股", "基金", "房价", "工资", "薪", "亏", "赚", "利率",
                         "存款", "贷款", "消费")),
        ("国际与时事", ("美国", "日本", "俄罗斯", "外交", "总统", "以色列",
                         "乌克兰", "欧盟")),
        ("社会民生", ("家长", "老人", "社区", "物业", "纠纷", "通报", "维权")),
        # 娱乐放最后：「官宣」「明星」这类词常被其他赛道借用
        ("娱乐与情感", ("明星", "恋情", "离婚", "综艺", "演员", "歌手",
                         "塌房", "绯闻", "粉丝")),
    ]
    for name, kws in RULES:
        if any(k in title for k in kws):
            return name
    return "文化与生活"


def build_analysis_prompt(material, directions):
    """生成给 Agent 的四步加工指令。"""
    title = material.get("title", "")
    platform = material.get("platform", "")
    # URL 砍掉查询串：热榜链接带一长串追踪参数，喂给 Agent 只是噪音
    url = (material.get("url") or "").split("?")[0]
    track = material.get("track", "") or guess_track(title)
    # 素材 key 要写进指令，让 Agent 在产出 JSON 时原样带回，
    # 否则落库时来源会丢失（2026-11-10 踩过：全库 source_key 都是 agent）。
    source_key = material.get("source_key", "") or ""
    if not source_key:
        # 兜底：没有 key 就用平台+标题拼一个，至少能看出从哪来
        source_key = f"{platform or '未知'}@{title[:20]}"

    STRUCT_NAME = {"story": "故事→观点", "problem": "问题→拆解答案",
                   "counter": "现象→反直觉判断", "list": "逐条清单→归纳",
                   "timeline": "时间线→落点", "contrast": "对比→分栏"}
    dir_text = "\n".join(
        f"  · **{d}** —— {DIRECTIONS[d]['desc']}"
        f"　推荐结构：{STRUCT_NAME.get(DIRECTION_STRUCTURE.get(d, ''), '自选')}"
        for d in directions
    )

    need_search = needs_enrich(title)
    search_step = ""
    if need_search:
        search_step = f"""
### ① 补全素材（必做）

这条标题信息量不足，**先用 web_search 搜原文**，拿到：
- 具体时间、地点
- 当事人原话
- 具体数字
- 事情经过

搜索词：`{title}`
"""

    return f"""# 选题加工任务

## 素材

- 标题：{title}
- 平台：{platform}
- 赛道：{track}
- 原文：{url or '（无）'}
- 素材 key：{source_key}

**必须原样记住上面五项。** 产出 JSON 时在 material 段里逐字带回
（见文末输出格式），选题落库后靠它回溯到原始热榜条目。
不要改写 key，不要留空，不要用 agent 代替。
{search_step}
### ② 拆解素材

把素材拆成三部分，**不要概括，要具体**：

1. **已知事实**：时间、人物、数字、原话、动作。逐条列。
2. **缺口**：写作前还必须补什么？（找不到就明说缺）
3. **公共命题**：这条素材能触达哪些**更大的命题**？
   给 2-3 个候选，每个一句话。
   例：「赵丽颖哄自己上班」→ ① 上班的普遍痛苦 ② 成年人靠自我哄骗维持运转 ③ 明星的接地气也是表演

### ③ 定方向（差异化在这里）

从上面的命题里，挑 **{len(directions)} 个方向不同**的做选题：

{dir_text}

**硬要求：两个方向必须对同一批事实给出不同解读。**
如果两个选题读起来是同一个调性、只是换了措辞，就是没做到差异化，重写。

### ④ 出选题：先定观点，再配标题

**观点是选题的核心，不是可选项。**

一个没有观点的选题，写成文章必然是「资讯整理」：把相关事实摆一摆，加两句评论。
每一节都能自圆其说，但连起来没有方向——读者读完不知道你想说什么。

所以顺序是：**先写作者观点，再配标题。**

#### 作者观点（viewpoint）：必填，选题的核心

用**一句判断句**说清这篇文章要让读者记住什么。四个条件，缺一不可：

**1. 是判断句，不是短语**
- ✗「季节性健康建议」—— 这是主题（名词短语）
- ✗「立冬之后应该早睡」—— 这是常识（没人反对，等于没说）
- ✓「冬天早上起不来不是懒，但也别硬起」—— 这是主张

**2. 能被反驳**
写完自问：谁会跳出来说「不对」？
说得出反对者，才算观点。说不上来，说明这是常识或废话。

**3. 指向一个动作或立场**
读者读完知道「那我该怎么办」，或「那我该怎么看」。两者至少占一个。

**4. 不含空泛词**
「值得」「应该」「很重要」「需要重视」「不容忽视」——这些是主题词，不是主张。
出现了就重写。

**终检**：把这句话单独给一个没看过文章的人看。
他能不能说出「所以这篇文章大概在讲什么，作者站哪边」？说不出就是不合格。

#### 切入角度（angle）：必填，独立于「读者为什么点」

**从谁的视角、从哪个场景进入这篇文章。** 这是「怎么写」，不是「读者为什么点」。

- ✗ 和「读者为什么点」写成同一句（那等于没设计角度）
- ✓「从我早上按了三次闹钟那一刻开始」
- ✓「从医生的三条建议逐条拆开」

#### 其余字段

| 项 | 要求 |
|---|---|
| 标题 | 3 个候选，混合风格（数字/对比/原话/悬念）。**标题必须能承载观点，不能大于观点** |
| 公共命题 | 这条素材触达的更大命题（是话题范畴，不是主张） |
| 方向 | 共情 / 拆解 / 反差 / 代价 / 时间 / 旁观 |
| 读者为什么点 | **具体到内心独白**，不要「想了解」这种空话 |
| 读完多知道什么 | 不能是「知道了这件事」，要「理解了什么」。**必须和 viewpoint 呼应，不能各说各的** |
| 为什么会转发 | 转发时他会说什么话 |
| 四维评分 | 情绪势能 / 差异化 / 受众基数 / 时效窗口，各 0-5 分 |

**评分的及格线**（教程标准）：
- 及格 = 情绪势能 ≥3 **或** 受众基数 ≥3
- 优秀 = 及格 **且** 差异化 ≥3

## 输出格式

严格按下面的 JSON 输出，不要加解释文字：

```json
{{
  "material": {{
    "source_key": "原样带回上方「素材 key」",
    "platform": "原样带回上方「平台」",
    "url": "原样带回上方「原文」，没有就空串",
    "title": "原样带回上方「标题」",
    "facts": ["事实1", "事实2"],
    "missing": ["缺口1"],
    "themes": ["命题1", "命题2"]
  }},
  "topics": [
    {{
      "title": "首选标题",
      "viewpoint": "作者观点：一句判断句主张，必须能被反驳、指向动作或立场",
      "angle": "切入角度：从谁的视角或哪个场景进入",
      "titles": [
        {{"title": "候选1", "style": "数字"}},
        {{"title": "候选2", "style": "对比"}},
        {{"title": "候选3", "style": "悬念"}}
      ],
      "public_theme": "这条触达的公共命题",
      "direction": "共情",
      "structure_type": "story",
      "reader_why_click": "读者内心独白",
      "reader_what_get": "读完理解了什么",
      "reader_why_share": "转发时他会说什么",
      "digest": "摘要，能独立成立",
      "outline": [
        {{"heading": "开头", "words": 250, "gist": "..."}}
      ],
      "word_count": 1800,
      "scores": {{
        "emotion": 4,
        "difference": 3,
        "audience": 4,
        "window": 2
      }}
    }}
  ]
}}
```
"""


# ── 落库 ─────────────────────────────────────────────────────────────

def clean_url(u):
    """去掉追踪参数。头条/百度那类链接带一长串 log_pb、impr_id，既难看又易失效。"""
    if not u:
        return ""
    try:
        from urllib.parse import urlsplit, urlunsplit
        p = urlsplit(u)
        keep = []
        for kv in p.query.split("&"):
            if not kv:
                continue
            k = kv.split("=")[0]
            if k in ("id", "vid", "wid", "topic_id", "s"):
                keep.append(kv)
        return urlunsplit((p.scheme, p.netloc, p.path, "&".join(keep), ""))
    except Exception:
        return str(u).split("?")[0]


def find_source_url(source_key):
    """按 source_key（形如「知乎@2026-11-08#2」）去素材快照里找原始链接。

    找不到返回空串——宁可没有链接，也不要拼一个假的。
    """
    try:
        m = re.match(r"(.+?)@(\d{4}-\d{2}-\d{2})#(\d+)", str(source_key or ""))
        if not m:
            return ""
        platform, date, rank = m.group(1), m.group(2), int(m.group(3))
        j = json.load(io.open(SNAPSHOT, encoding="utf-8"))
        for r in j.get("byDate", {}).get(date, []):
            if r.get("platform") == platform and int(r.get("rank") or -1) == rank:
                return clean_url(r.get("url") or "")
    except Exception:
        return ""
    return ""


def save_topics(conn, material, data, job_id=None):
    """把 Agent 返回的结构写进 topics 表。"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    mat = data.get("material", {})
    saved = []

    for t in data.get("topics", []):
        scores = t.get("scores", {})
        cur = conn.execute(
            """INSERT INTO topics
               (job_id, source_key, title, track, skill, persona, kind,
                angle, hook, payoff, titles_json, best_title, digests_json,
                outline_json, word_count, needs_material, status, created_at,
                source_type, material_facts, material_missing, public_theme,
                topic_role, reader_why_click, reader_what_get, reader_why_share,
                score_emotion, score_difference, score_audience, score_window,
                structure_type, source_url, source_platform, viewpoint)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                job_id,
                material.get("source_key", ""),
                t.get("title", ""),
                material.get("track", ""),
                "topic-pipeline",
                # persona：用什么身份说话。优先取观点里隐含的立场，退回落到「普通人」
                t.get("persona", "") or "一个普通人",
                "hot",
                # angle：切入角度。以前和 hook 填同一个值（注释写「暂用」），
                # 等于角度从来没有被真正设计过。现在独立。
                t.get("angle", ""),
                # hook：读者为什么点（读者的内心独白，不是作者的立场）
                t.get("reader_why_click", ""),
                t.get("reader_what_get", ""),    # payoff
                json.dumps(t.get("titles", []), ensure_ascii=False),
                t.get("title", ""),
                json.dumps([t.get("digest", "")], ensure_ascii=False),
                json.dumps(t.get("outline", []), ensure_ascii=False),
                t.get("word_count", 1800),
                1,
                "candidate",
                now,
                material.get("source_type", "hot"),
                json.dumps(mat.get("facts", []), ensure_ascii=False),
                json.dumps(mat.get("missing", []), ensure_ascii=False),
                t.get("public_theme", ""),
                t.get("direction", ""),
                t.get("reader_why_click", ""),
                t.get("reader_what_get", ""),
                t.get("reader_why_share", ""),
                scores.get("emotion", 0),
                scores.get("difference", 0),
                scores.get("audience", 0),
                scores.get("window", 0),
                t.get("structure_type", "") or DIRECTION_STRUCTURE.get(t.get("direction", ""), ""),
                material.get("source_url", "") or "",
                material.get("platform", "") or "",
                # 作者观点：选题的核心。写文章时它就是全文的主论点。
                t.get("viewpoint", "") or "",
            ))
        saved.append(cur.lastrowid)

    conn.commit()
    return saved


# ── 主流程 ───────────────────────────────────────────────────────────
def pick_daily_materials(date, count=10):
    """从当天素材里挑 count 条有爆文潜力的。

    这是「① 同步热点后自动分析」入口用的。
    只做粗筛（排除明显不行的），精细判断交给 Agent。
    """
    j = json.load(io.open(SNAPSHOT, encoding="utf-8"))
    rows = j.get("byDate", {}).get(date, [])
    if not rows:
        return []

    # 粗筛：标题长度合理、不是纯时政口号
    SKIP = ("习近平", "总书记", "政治局", "国务院", "外交部", "国防部",
            "导弹", "空袭", "战争", "以色列", "伊朗", "乌克兰")
    cand = []
    for r in rows:
        t = (r.get("title") or "").strip()
        if not (8 <= len(t) <= 60):
            continue
        if any(k in t for k in SKIP):
            continue
        cand.append(r)

    # 多平台共振优先（同一件事多个平台都在榜 = 真热点）
    freq = {}
    for r in cand:
        freq[r["title"]] = freq.get(r["title"], 0) + 1

    def rank(r):
        return (-freq.get(r["title"], 1), r.get("rank") or 99)

    cand.sort(key=rank)

    # 去重同题，取前 count
    seen, out = set(), []
    for r in cand:
        t = r["title"]
        if t in seen:
            continue
        seen.add(t)
        out.append(r)
        if len(out) >= count:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None, help="每日自动分析")
    ap.add_argument("--job", type=int, default=None, help="单条队列任务")
    ap.add_argument("--material", default=None, help="手工单条素材标题")
    ap.add_argument("--platform", default="手工", help="素材来源平台")
    ap.add_argument("--track", default="", help="赛道")
    ap.add_argument("--count", type=int, default=10, help="每日取几条素材")
    ap.add_argument("--save", action="store_true", help="把 Agent 结果落库")
    ap.add_argument("--json", default=None, help="Agent 返回的 JSON 文件")
    args = ap.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    # 模式 0：落库（Agent 跑完返回 JSON，这里写进 topics 表）
    if args.save and args.json:
        if not os.path.isfile(args.json):
            print(f"  ❌ 找不到 {args.json}")
            conn.close()
            return 1
        data = json.loads(io.open(args.json, encoding="utf-8").read())

        # 来源信息优先级（2026-11-10 修）：
        #   JSON 里的 material 段 > 命令行参数 > 兜底 "agent"
        # 之前只取命令行，而批量生成时不传 --material，
        # 结果所有选题的 source_key 都是 "agent"、平台 url 全空，
        # 界面上「来源热点」永远显示「无来源」。
        jm = data.get("material") or {}
        src_key = (jm.get("source_key") or "").strip() or (args.material or "").strip()
        src_platform = (jm.get("platform") or "").strip() or \
            ((args.platform or "") if args.material else "").strip()
        src_url = (jm.get("url") or "").strip()
        src_title = (jm.get("title") or "").strip()

        material = {
            "source_key": src_key or "agent",
            "platform": src_platform,
            "url": src_url,
            "title": src_title,
            "track": args.track or "",
            "source_type": "manual" if args.material else "hot",
        }
        if src_key and src_key != "agent":
            print(f"  来源：{src_platform or '?'} · {src_key}"
                  + (f"　{src_url[:58]}" if src_url else ""))
        else:
            print("  ⚠️ JSON 里没有 source_key，来源会记成 agent——"
                  "界面上会显示「无来源」。")
        ids = save_topics(conn, material, data, job_id=args.job)
        print(f"  ✅ 写入 {len(ids)} 个选题: {ids}")
        # 打印及格情况
        for t in data.get("topics", []):
            sc = t.get("scores", {})
            ok = (sc.get("emotion", 0) >= 3 or sc.get("audience", 0) >= 3)
            good = ok and sc.get("difference", 0) >= 3
            mark = "优秀" if good else ("及格" if ok else "不合格")
            print(f"     [{mark}] [{t.get('direction','')}] {t.get('title','')[:34]}")
            print(f"            情绪{sc.get('emotion',0)} 差异{sc.get('difference',0)} 受众{sc.get('audience',0)} 时效{sc.get('window',0)}")
        conn.close()
        return 0

    # 模式 1：每日自动分析
    if args.date:
        date = args.date
        mats = pick_daily_materials(date, args.count)
        if not mats:
            print(f"  ❌ {date} 没有可用素材")
            return 1
        print(f"  {date} 选出 {len(mats)} 条素材（各出 2 个方向不同的选题）")
        outdir = os.path.join(WORKSPACE, "_tmp", "topic-prompts")
        os.makedirs(outdir, exist_ok=True)
        for i, m in enumerate(mats, 1):
            pair = DIRECTION_PAIRS[(i - 1) % len(DIRECTION_PAIRS)]
            material = {
                "title": m.get("title", ""),
                "platform": m.get("platform", ""),
                "url": m.get("url", ""),
                "track": "",
                "source_key": f"{m.get('platform')}@{date}#{m.get('rank')}",
                "source_type": "hot",
            }
            prompt = build_analysis_prompt(material, pair)
            p = os.path.join(outdir, f"material-{i:02d}.md")
            io.open(p, "w", encoding="utf-8").write(prompt)
            print(f"    {i:>2}. [{pair[0]}/{pair[1]}] {m.get('title', '')[:44]}")
        print()
        print(f"  ✅ {len(mats)} 份加工指令已写到 {outdir}")
        print(f"     交给 Agent 逐份执行，产出的 JSON 用 --save --json <文件> 落库")
        conn.close()
        return 0

    # 模式 2/3：单条（job 或手工）
    material = None
    if args.job:
        r = conn.execute("SELECT * FROM topic_jobs WHERE id=?", (args.job,)).fetchone()
        if not r:
            print(f"  ❌ job #{args.job} 不存在")
            conn.close()
            return 1
        material = {
            "title": r["title"], "platform": r["platform"] or "",
            "url": r["url"] or "", "track": r["track"] or "",
            "source_key": r["source_key"] or "", "source_type": "hot",
        }
    elif args.material:
        material = {
            "title": args.material, "platform": args.platform,
            "url": "", "track": args.track,
            "source_key": f"manual@{datetime.now().strftime('%Y-%m-%d')}",
            "source_type": "manual",
        }
    else:
        ap.print_help()
        conn.close()
        return 1

    pair = DIRECTION_PAIRS[0]
    prompt = build_analysis_prompt(material, pair)
    outdir = os.path.join(WORKSPACE, "_tmp", "topic-prompts")
    os.makedirs(outdir, exist_ok=True)
    p = os.path.join(outdir, "single.md")
    io.open(p, "w", encoding="utf-8").write(prompt)
    print(f"  素材：{material['title']}")
    print(f"  方向：{pair[0]} / {pair[1]}")
    print(f"  ✅ 加工指令 → {p}")
    print(f"     交给 Agent 执行，产出的 JSON 用 --save --json <文件> 落库")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
