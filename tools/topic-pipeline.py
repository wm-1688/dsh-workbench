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


def _load_gt():
    """从 gen-topics.py 借两样东西：赛道词表 + 标题体检函数。

    为什么共用而不是各写一份：词表和标题规则本来就在 gen-topics 里维护，
    再抄一份到 pipeline 必然出现「这边改了、那边没改」的漂移 ——
    届时「生成说合规、检查说不合规」会让人完全不知道该信谁。

    导入失败返回 (空 dict, None)：订阅筛选退化成不筛、标题体检跳过，
    但整个流程不因此崩掉（宁可少一道检查，也不能让选题生成整个挂掉）。
    """
    try:
        import importlib.util as _ilu
        p = os.path.join(HERE, "gen-topics.py")
        spec = _ilu.spec_from_file_location("_gt_tracks", p)
        mod = _ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return dict(getattr(mod, "TRACKS", {}) or {}), getattr(mod, "title_lint", None)
    except Exception:
        return {}, None


TRACKS, _gt_title_lint = _load_gt()


def title_lint(text):
    """标题体检。gen-topics 里那份是唯一实现，这里只做兜底转发。"""
    if _gt_title_lint is None:
        return []
    try:
        return _gt_title_lint(text) or []
    except Exception:
        return []


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

# 自动批量时每个素材出 2 个选题，方向必须不同。这里给组合，保证不撞。
DIRECTION_PAIRS = [
    ("共情", "拆解"),
    ("反差", "代价"),
    ("时间", "旁观"),
    ("拆解", "反差"),
    ("共情", "时间"),
]

# 方向总数。手工生成时用户可填 1-6，超出这个数就夹住。
MAX_TOPICS_PER_MATERIAL = len(DIRECTIONS)


def pick_directions(n, seed=0):
    """取 n 个互不重复的方向。

    为什么要跨组取：DIRECTION_PAIRS 是给「出 2 个」设计的配对，
    用户要 3 个、4 个的时候不能只把第 0 组加长——那样会撞方向。
    这里按配对表的顺序轮着取，保证前几个方向不同。

    n=2 时结果和原来的 DIRECTION_PAIRS[seed % len] 完全一致，
    不影响自动批量的既有行为。
    """
    try:
        n = int(n)
    except (TypeError, ValueError):
        n = 2
    n = max(1, min(MAX_TOPICS_PER_MATERIAL, n))

    if n == 2:
        # 走老路径，保持自动批量的分组不变
        return list(DIRECTION_PAIRS[seed % len(DIRECTION_PAIRS)])

    out = []
    # 先按配对表顺序铺开，配对的顺序本身就是「差异最大」的排序
    for pair in DIRECTION_PAIRS:
        for d in pair:
            if d not in out:
                out.append(d)
            if len(out) >= n:
                return out
    # 兜底：把没铺到的方向补上（正常不会走到）
    for d in DIRECTIONS:
        if d not in out:
            out.append(d)
        if len(out) >= n:
            break
    return out


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
def guess_tracks(title, full_text="", top=3):
    """给一条素材**打多个候选赛道标签**（2026-11-19 改）。

    为什么从「返回单个赛道」改成「返回候选列表」
    ------------------------------------------------
    实测今天 188 条素材，旧的 guess_track 有 **153 条（81%）落到兜底赛道
    「文化与生活」** —— 单赛道判断基本失效。看几个典型：

        「普京和特朗普互动握手」             → 文化与生活（该是国际与时事）
        「养老保险缴15年就能坐等退休？假的」  → 文化与生活（该是社会民生）
        「黄金连续大跌是金融风暴前兆吗」       → 文化与生活（该是财经与商业）

    根因是旧规则「命中即返回」：一条素材只能贴一个赛道，命中不了就兜底。
    而兜底赛道没人订阅，下游 pick-daily 按订阅赛道筛，这些素材的选题全被丢掉。

    改成多候选后：每个赛道**独立打分**，给出前 N 个 + 各自命中的词。
    用户一眼能看出「这条大概能写哪几类」，选错也有备份。

    返回：[{"track": 赛道名, "score": 得分, "hits": [命中词]}]
    按得分降序，最多 top 个。**一个都没命中就返回空列表**，
    不返回兜底值 —— 兜底值混在候选里会让人以为真判出来了。
    """
    text = (title or "")
    # 全文优先：热榜标题短、缺主语，正文往往能把赛道定下来
    if full_text:
        text = (full_text + " " + text)
    if not text.strip():
        return []

    scores = {}

    def add(track, word, weight=1.0):
        if track not in scores:
            scores[track] = {"score": 0.0, "hits": []}
        scores[track]["score"] += weight
        if word not in scores[track]["hits"]:
            scores[track]["hits"].append(word)

    # ── 专名直判（权重高：名字出现基本就定了）──
    for w in ("习近平", "普京", "特朗普", "拜登", "李在明", "卡斯特", "辛鲍姆"):
        if w in text:
            add("国际与时事", w, 3.0)
    for w in ("APEC", "G20", "峰会", "外交部", "国台办", "大使"):
        if w in text:
            add("国际与时事", w, 2.0)

    for w in ("王楚钦", "孙颖莎", "樊振东", "马龙", "张本", "国乒", "国足",
              "林诗栋", "蒯曼", "陈熠", "早田", "雨果", "中超", "中甲"):
        if w in text:
            add("体育", w, 3.0)

    for w in ("赵丽颖", "杨幂", "杨紫", "迪丽热巴", "王一博", "肖战",
              "易烊千玺", "刘亦菲", "汪苏泷", "许飞", "厉娜"):
        if w in text:
            add("娱乐", w, 3.0)

    # ── 关键词规则（每个赛道独立打分，不再「命中即返回」）──
    RULES = {
        "体育": ("比赛", "夺冠", "球队", "运动员", "赛季", "奥运", "联赛",
                 "进球", "比分", "主帅", "球员"),
        "健康": ("健身", "健康", "医院", "确诊", "医生", "体检", "养生",
                 "疾病", "医保", "血管", "血压", "癌症", "睡眠", "养肾",
                 "睡觉", "心脏", "体质", "症状"),
        "亲子家庭": ("育儿", "带娃", "宝宝", "婴儿", "幼儿", "辅食", "二胎",
                     "亲子", "陪伴", "隔代", "月子", "产假", "孩子"),
        "情绪心理": ("焦虑", "抑郁", "内耗", "情绪", "心理", "自愈", "压力",
                     "崩溃", "失眠", "孤独", "破防"),
        "两性关系": ("恋爱", "爱情", "婚姻", "出轨", "复合", "分手", "相亲",
                     "彩礼", "婆媳", "两性", "亲密关系", "前任", "结婚"),
        "女性成长": ("女性", "女人", "全职太太", "性别", "女权", "剩女",
                     "产后", "大女主", "宝妈"),
        "教育": ("上学", "入学", "学校", "老师", "教师", "招生", "考试",
                 "高考", "考研", "学位", "课堂", "学生", "课程", "作业"),
        "职场": ("招聘", "职场", "加班", "校招", "求职", "跳槽", "面试",
                 "通勤", "打工人", "离职", "裁员"),
        "AI 与科技": ("AI", "大模型", "芯片", "算法", "机器人", "GPT", "OpenAI",
                      "英伟达", "智能", "算力", "模型", "自动驾驶",
                      "小米", "华为", "苹果", "手机", "曝光", "定档",
                      "科技", "Anthropic", "孙正义", "搜狐"),
        "财经与商业": ("股", "基金", "房价", "工资", "薪", "亏", "赚", "利率",
                       "存款", "贷款", "消费", "黄金", "经济", "投资", "市值",
                       "营收", "融资", "上市", "猪价", "牛肉", "茅台", "价格",
                       "抢购", "黄牛", "超市", "生意", "涨价", "跌到",
                       "铜", "钢", "铝", "油", "期货", "跌至", "下探",
                       "GDP", "通胀", "汇率", "债"),
        "国际与时事": ("美国", "日本", "俄罗斯", "外交", "总统", "以色列",
                       "乌克兰", "欧盟", "韩国", "朝鲜", "台海", "两岸",
                       "台湾", "菲律宾", "泰国", "荷兰", "专机", "元首",
                       "大使", "外长", "军事", "导弹", "外交部", "国台办",
                       "美媒", "俄美", "中俄", "亚太", "全世界", "各国",
                       "军人", "空军", "海军", "陆航", "战舰", "航母",
                       "边境", "制裁", "停火", "谈判", "条约"),
        "社会民生": ("家长", "老人", "社区", "物业", "纠纷", "通报", "维权",
                     "养老保险", "退休", "社保", "诈骗", "辟谣", "假的",
                     "新政", "政策", "补贴", "涨价", "油价", "公安机关",
                     "抓获", "九部门", "两高一部", "严惩", "偷走", "嫌疑人"),
        "娱乐": ("明星", "综艺", "演员", "歌手", "塌房", "绯闻", "粉丝",
                 "影视", "演唱会", "票房", "电影", "官宣", "出道", "走秀",
                 "过气", "霍建华", "蔡国庆", "陆毅", "董明珠", "何超琼"),
        "人生感悟": ("人生", "感悟", "中年", "释怀", "遗憾", "命运",
                     "珍惜", "放下", "随笔"),
        "文化与生活": ("美食", "旅游", "景区", "文化", "传统", "节日",
                       "习俗", "方言", "非遗", "博物馆", "冰箱", "赶海",
                       "年夜饭", "羽绒服", "服装", "走红", "出圈", "火爆",
                       "油车", "电车", "买车", "开车", "出行", "地铁",
                       "高铁", "机票", "酒店", "民宿"),
    }
    for track, kws in RULES.items():
        for kw in kws:
            if kw in text:
                add(track, kw, 1.0)

    out = [{"track": k, "score": round(v["score"], 1), "hits": v["hits"][:5]}
           for k, v in scores.items()]
    out.sort(key=lambda x: (-x["score"], -len(x["hits"])))
    return out[:top]


def guess_track(title, full_text=""):
    """单赛道判断（保留给旧调用点）。没有命中时返回「文化与生活」。"""
    cands = guess_tracks(title, full_text, top=1)
    return cands[0]["track"] if cands else "文化与生活"


def build_brief_block(brief):
    """用户在手填弹窗里写的要求，转成指令里的硬约束段。

    brief 可能为空（自动批量就没有）。为空时整段不出，不占篇幅。

    为什么单独成段而不是塞进标题里：这三项和「素材本身」是两回事，
    混在一起 Agent 容易当成素材信息，写进 facts 里。
    """
    if not brief:
        return ""

    angle = str(brief.get("angle") or "").strip()
    exclude = str(brief.get("exclude") or "").strip()
    viewpoint = str(brief.get("viewpoint") or "").strip()

    if not (angle or exclude or viewpoint):
        return ""

    lines = ["", "### 用户要求（硬约束，优先级高于下面的通用规则）", ""]
    lines.append("下面是用户在界面里填的，**必须照做**。做不到就说做不到，")
    lines.append("但不要忽略、不要改成你自己的想法。")
    lines.append("")

    if viewpoint:
        lines.append("**个人观点（选题的立场必须和它一致）**")
        lines.append(f"> {viewpoint}")
        lines.append("")
        lines.append("每个选题的 viewpoint 都要从这句话长出来。")
        lines.append("如果素材事实和这个观点有冲突，如实指出来，不要硬凑。")
        lines.append("")

    if angle:
        lines.append("**角度倾向（选题从哪个方向切）**")
        lines.append(f"> {angle}")
        lines.append("")
        lines.append("所有选题的切入角度都要落在这个范围内。")
        lines.append("下面的「方向」是叙事手法（共情/拆解/反差…），")
        lines.append("这里的角度是「写什么」，两者都要满足。")
        lines.append("")

    if exclude:
        lines.append("**排除项（这些一律不许出现）**")
        lines.append(f"> {exclude}")
        lines.append("")
        lines.append("选题的观点、标题、角度里都不许沾这几个方向。")
        lines.append("宁可少给一个选题，也不要凑一个踩红线的。")
        lines.append("")

    return chr(10).join(lines) + chr(10)


def build_analysis_prompt(material, directions, brief=None):
    """生成给 Agent 的四步加工指令。

    brief：用户手填的角度 / 观点 / 排除项。为空时行为与旧版一致。
    """
    title = material.get("title", "")
    platform = material.get("platform", "")
    # URL 砍掉查询串：热榜链接带一长串追踪参数，喂给 Agent 只是噪音
    url = (material.get("url") or "").split("?")[0]
    track = (material.get("track", "")
             or guess_track(title, material.get("desc") or ""))
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

    brief_block = build_brief_block(brief)

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
{search_step}{brief_block}
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

**硬要求：{len(directions)} 个选题必须对同一批事实给出不同解读。**
如果几个选题读起来是同一个调性、只是换了措辞，就是没做到差异化，重写。

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
| 标题 | 见下方「标题 10 条公式」——**按公式的结构写，不是按风格形容词写** |
| 公共命题 | 这条素材触达的更大命题（是话题范畴，不是主张） |
| 方向 | 共情 / 拆解 / 反差 / 代价 / 时间 / 旁观 |
| 读者为什么点 | **具体到内心独白**，不要「想了解」这种空话 |
| 读完多知道什么 | 不能是「知道了这件事」，要「理解了什么」。**必须和 viewpoint 呼应，不能各说各的** |
| 为什么会转发 | 转发时他会说什么话 |
| 四维评分 | 情绪势能 / 差异化 / 受众基数 / 时效窗口，各 0-5 分 |

**评分的及格线**（教程标准）：
- 及格 = 情绪势能 ≥3 **或** 受众基数 ≥3
- 优秀 = 及格 **且** 差异化 ≥3

### 标题 10 条公式（**必读，标题按这个写**）

来源：拆解 1 万篇 10W+ 文章的归纳。**10 条全部可用**，按素材特征选最贴合的 5 条。

分类维度不是修辞手法，是**读者能拿走什么**：

| # | 公式 | 读者拿走 | 结构要求 |
|---|---|---|---|
| 01 | 场景 + 现成话术 | 能直接说的话 | 前半句钉死那个场景（几秒钟的事），后半句给能说出口的话 |
| 02 | 数字 + 能拿走的东西 | 一份现成清单 | 开头就给数字（50个/10条/3步），让人知道进来能挑 |
| 03 | 熟悉事 + 意外结果 | 一个答案 | 前半句立「大家以为的」，后半句甩反常结果，**答案不说完** |
| 04 | 折磨人的小动作 + 说到心里的话 | 「对，我也这样」 | 写具体动作（洗澡时还在想怎么怼回去），**不要写「内耗」** |
| 05 | 羡慕状态 + 共同点 | 别人怎么做的 | 前半句立让人羡慕的状态，后半句「都有一个共性」，不给答案 |
| 06 | 熟悉物 + 没想过的问题 | 一个答案 | 问一个有点好笑又真把人问住的问题 |
| 07 | 普通人 + 不寻常结果 + 过程 | 过程细节 | 前半句给人+不寻常结果（带数字），「怎么做到的」留白 |
| 08 | 小钱 + 久困的麻烦 + 办法 | 一个解法 | 先点具体麻烦，再说几块钱解决了，**别一上来就夸产品** |
| 09 | 快到的日子 + 马上要用的东西 | 现成素材 | 日子写在前面（1月1日凌晨00:00），后面说要用的东西 |
| 10 | 大家都关心的事 + 一句干脆的判断 | 一个立场 | 一句话把立场说死（可以有人反对），但**必须跟一个具体例子** |

#### ⚠️ 每条公式的**适用判据**（先判素材，再选公式）

**这一步最容易错。** 公式名只是标签，套错标签的标题看着像那么回事，其实拿不走东西。
选公式前先问：这条素材**到底能给出什么**？对不上就别用那条公式。

| # | 只有素材满足这个条件才能用 | 典型错用 |
|---|---|---|
| 01 | 素材里有**可以直接复述的原话/应对句**（怎么回、怎么说、怎么拒绝） | 只给场景不给话术——读者拿不走东西 |
| 02 | 素材本身**能数出来**（3 个动作 / 5 个方法 / 10 条清单） | 数字是时间/尺寸（「10 秒」「45 度」）不算清单，那是 03/06 |
| 03 | 素材存在**「大家以为A、实际B」的反差**，且 B 是需要解释的 | 没有反差硬造——读者不觉得意外 |
| 04 | 素材是**心理/行为上的自我折磨**（反复复盘、忍不住看手机） | **身体自测/健康检查不属于这条**，那是 03 或 06 |
| 05 | 素材里有**一群做得好的人**，能归纳出行为差异 | 只有单个成功者——那是 07 |
| 06 | 素材是**天天用的东西/随口说的话**，从没人认真问过 | 问题是「怎么办」而不是「为什么/是什么」——那是 02 |
| 07 | 素材里有**具体某个人**做成了不寻常的事，且过程有细节 | 没有人、只有现象——那是 03 |
| 08 | 素材是**花钱买了个便宜东西**解决了麻烦 | **自测方法、免费技巧不属于这条**，那是 02 或 06 |
| 09 | 素材对应**明确的日历节点**（节日/开学/年终/月初） | 没有时间锚硬套——读者不觉得急 |
| 10 | 作者对这件事**有明确立场**，且能举出具体例子 | 只有立场没有例子——变成空喊口号 |

**判据的两个易混点（实测反复出错，这里说清楚）**：

- **数量词 ≠ 清单**。02 要的是「读者能照着做的 N 条」（3 个动作 / 5 个方法），
  不是「三国元首」「四个信号」这种**数量修饰**。后者数得出来但拿不走，
  按 02 写会变成通稿。
- **状态描述 ≠ 判断**。10 要的是能被反驳的立场（「谈崩的成本更大」），
  不是「终于愿意知道对方底线」这种**描述现状**。后者谁都不会反对，也就没人想点。

#### ⚠️ 5 条候选必须**角度不同**，不是同一件事换措辞

反例（实测踩过）：素材是「血管堵塞信号」，5 条候选全在讲「怎么自测」，
只是换了「两个动作 / 对镜子笑 / 平举双臂 / 抬腿」——这是**同一个角度换 5 种说法**，不是 5 个候选。

要求：5 条里至少覆盖 **3 种不同的读者收益**——
有的给方法（怎么测）、有的给认知（为什么会这样）、有的给判断（该不该担心）、有的给场景共鸣（我也这样）。

#### 选首选：按这个评分，不要按输出顺序

给 5 条各打 0-10 分，**选最高分当 `title`**（首选）：
- 公式用得对（真符合那条公式的适用判据）：**+4**
- 有具体数字或具体动作：**+3**
- 前 12 字里就有钩子（手机列表只显示这么宽）：**+2**
- 无硬禁问题：**+1**

**「具体数字或动作」这一项不算数的情况**（实测被刷过分，说清楚）：
- 数字是**数量修饰**而不是数据（「三国元首」「四个信号」「三个国家」）——这是泛指，不 +3
- 引号里的内容**不带矛盾**（「管控分歧」是官方话术，本身没有反差）——光有引号不 +3
  真正加分的引语是自带冲突的：「部分批次」「很少生气」这种一听就有问题的

同分时优先选**读者能拿走东西最多**的那条。

#### 硬禁（命中就重写）

那篇文章反复强调同一件事，四条公式、四段不同内容都在说：
> 「别让读者只记住『真诚沟通』四个字」
> 「最怕只剩『成年人不容易』『生活很累』」
> 「别最后只给出『心态好』『格局大』几个词」
> 「每样东西都『闭眼入』『绝绝子』，谁还信你真的用过」

所以：

- ❌ **抽象词收尾**：「本质」「格局」「心态」「认知」「逻辑」「意义」「价值」「算过账」「底层逻辑」
  —— 读者看完等于没看，换成具体的人/事/动作
- ❌ **结论式**：「不是X，是Y」——把答案说了，读者不需要点进去
- ❌ **纯抽象主语**：「可读性差不是…」「认知决定…」——没有具体的人或事，无法代入
- ❌ **三个以上并列事实**：顿号堆砌，没有一个「人」，读者记不住
- ❌ **空问句**：「为什么XX」后面必须跟具体对象，否则不知道在问什么
- ❌ **抽象隐喻**：「背后是两个不同的大脑」「是X个江湖」——把具体东西换成抽象名词，
  读者要猜，而好标题不需要猜
- ❌ **元叙述**：标题在**评价自己的内容**，而不是直接给内容。
  典型：「这四个字值得看清」「这事别不当回事」「这句话值得一说」「值得每个人想想」。
  这和上面「结论式」是同一类毛病的两面——结论式把答案说完了，元叙述则是**只吆喝不给货**。
  改法：把「值得看清」的那四个字直接摆出来，让读者自己判断值不值得看。
  例：❌「外交部写的是管控分歧，这四个字值得看清」
      ✅「外交部说『管控分歧』，可分歧到底在哪」

#### 自检（写完每条标题都过一遍）

- 有没有一个具体的人 / 一个**数据**（不是「三国」「四个」这种数量词）/ 一句引语？
  三样一个都没有 = 空转
- 前 12 字里有没有钩子？（手机列表只显示这么宽）
- 答案是不是说完了？说完了就没人点
- 有没有在**吆喝自己的内容**（「值得看清」「别不当回事」）？有就改成直接给内容

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
      "title": "首选标题（从下面 5 个里挑最符合公式结构的那条）",
      "viewpoint": "作者观点：一句判断句主张，必须能被反驳、指向动作或立场",
      "angle": "切入角度：从谁的视角或哪个场景进入",
      "titles": [
        {{"title": "候选1", "formula": "03", "formula_name": "熟悉事+意外结果"}},
        {{"title": "候选2", "formula": "07", "formula_name": "普通人+不寻常结果+过程"}},
        {{"title": "候选3", "formula": "06", "formula_name": "熟悉物+没想过的问题"}},
        {{"title": "候选4", "formula": "10", "formula_name": "一句干脆的判断"}},
        {{"title": "候选5", "formula": "05", "formula_name": "羡慕状态+共同点"}}
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


def _normalize_titles(raw):
    """把 Agent 给的标题候选规整成统一结构，并逐条跑体检。

    **为什么要这一层**：实测 Agent 会无视指令里的 10 条公式表，
    继续按老习惯输出 `[{title, style:'反差'}, {title, style:'对比'}, {title, style:'原话'}]`
    （#152-154 就是这样）。提示词约束不住的东西必须用代码兜底。

    这一层做三件事，都**不改变 Agent 写的句子**（改句子是 Agent 的事）：
      ① 统一结构：补上 formula / formula_name / chars / problems 字段
      ② 跑体检：每条标题过一遍 title_lint，问题记在 problems 里
      ③ 标记合规：problems 为空 = ok，界面据此显示警告

    输入兼容三种形状：
      · 新版 [{title, formula, formula_name}]
      · 旧版 [{title, style}]
      · 纯字符串 ["标题1", "标题2"]
    """
    out = []
    if not isinstance(raw, list):
        return out
    for x in raw:
        if isinstance(x, str):
            title, formula, fname = x.strip(), "", ""
        elif isinstance(x, dict):
            title = str(x.get("title") or "").strip()
            formula = str(x.get("formula") or "").strip()
            fname = str(x.get("formula_name") or x.get("style") or "").strip()
        else:
            continue
        if not title:
            continue
        probs = title_lint(title)
        out.append({
            "title": title,
            "formula": formula,
            "formula_name": fname,
            "chars": len(title),
            "problems": probs,
            "ok": not probs,
        })
    return out


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
                # 标题候选：**过一道机器校验再存**（2026-11-18 加）。
                #
                # 为什么不能直接存 Agent 给的东西：实测发现 Agent 会无视指令里
                # 的 10 条公式表，继续按老习惯输出 3 个 style='反差/对比/原话' 的标题
                # （#152-154 就是这样，formula 全是 None）。
                # 提示词约束不住的东西，必须用代码兜底 —— 否则「改了指令但没生效」
                # 会反复出现，而每次都要人肉去数据库里查才发现。
                json.dumps(_normalize_titles(t.get("titles", [])), ensure_ascii=False),
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

    # 回写队列状态：写完选题才算这条素材加工完了。
    # 不回写的话 job 永远停在 pending，下次还会被重新加工一遍。
    if job_id:
        try:
            st = "done" if saved else "failed"
            note = f"产出 {len(saved)} 个选题" if saved else "没有合格选题"
            conn.execute(
                "UPDATE topic_jobs SET status=?, note=?, updated_at=? WHERE id=?",
                (st, note, now, job_id))
            conn.commit()
        except Exception:
            # 回写失败不影响选题本身已落库
            pass

    return saved


# ── 主流程 ───────────────────────────────────────────────────────────
def pick_daily_materials(date, count=10, tracks=None):
    """从当天素材里挑 count 条有爆文潜力的。

    这是「① 同步热点后自动分析」入口用的。
    只做粗筛（排除明显不行的），精细判断交给 Agent。

    tracks：订阅赛道列表。给了就**只在这些赛道里挑**（2026-11-18 加）。
    素材本身没有赛道字段（只有标题/平台/热度），所以按标题关键词归类 ——
    词表复用 gen-topics.py 的 TRACKS，不另建一套，避免两份词表慢慢跑偏。
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

    # 赛道筛选：只在订阅的赛道里挑。
    # **匹配不上就丢掉**是这里唯一正确的做法 —— 用户订阅「AI 与科技」时，
    # 塞一条娱乐八卦给他等于没做筛选。词表覆盖不到所以宁可漏，不可错。
    want_tracks = [x for x in (tracks or []) if x]
    unknown_tracks = []
    if want_tracks:
        kws, known = [], []
        for name in want_tracks:
            cfg = TRACKS.get(name) or {}
            k = cfg.get("kw") or []
            if k:
                known.append(name)
                kws.extend(k)
            else:
                unknown_tracks.append(name)
        # **kws 为空也必须清空候选**（2026-11-18 修）：
        # 原来写成 `if kws:` 才筛，于是「订阅了一个不存在的赛道」时 kws 为空、
        # 整段筛选被跳过，全部素材原样放行 —— 用户以为筛了，其实什么都没筛。
        # 打错一个字就静默失去筛选，是最难发现的一类错。
        cand = ([r for r in cand
                 if any(k in (r.get("title") or "") for k in kws)]
                if kws else [])
        if unknown_tracks:
            print(f"  ⚠️ 这些赛道不在词表里，无法筛选：{'、'.join(unknown_tracks)}")
            print(f"     可用赛道：{'、'.join(sorted(TRACKS.keys()))}")

    # 多平台共振优先（同一件事多个平台都在榜 = 真热点）
    freq = {}
    for r in cand:
        freq[r["title"]] = freq.get(r["title"], 0) + 1

    # 「最值得写」的排序依据（2026-11-18 加）：
    #   · 共振数：多平台同时上榜，说明是全民热点，不是某个平台的口味
    #   · 榜位：越靠前越热
    #   · 标题信息量：带具体数字/当事人的比通稿口号更像「有故事的素材」
    #     —— 这是**粗排**，真正的「值不值得写」还是 Agent 判，它拿到的是这几条里最好的。
    import re as _re
    def info_score(t):
        s = 0
        if _re.search(r"\d", t):
            s += 1          # 有数字（金额/年龄/数量）通常更有细节
        if len(t) <= 30:
            s += 1          # 太长的多是政策通稿
        if any(k in t for k in ("？", "?", "为何", "为什么", "怎么")):
            s += 1          # 疑问式标题天然带钩子
        return s

    def rank(r):
        t = r.get("title") or ""
        return (-freq.get(t, 1), -info_score(t), r.get("rank") or 99)

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
    ap.add_argument("--tracks", default="",
                    help="订阅赛道，顿号或逗号分隔（每日自动分析用）：只在这些赛道里挑素材")
    ap.add_argument("--count", type=int, default=10, help="每日取几条素材")
    ap.add_argument("--per", type=int, default=2,
                    help="每条素材出几个选题（1-6）。自动批量固定 2，手工按用户填的数")
    ap.add_argument("--angle", default="", help="用户填的角度倾向（进指令，硬约束）")
    ap.add_argument("--exclude", default="", help="用户填的排除项（进指令，硬约束）")
    ap.add_argument("--viewpoint", default="", help="用户填的个人观点（进指令，硬约束）")
    ap.add_argument("--save", action="store_true", help="把 Agent 结果落库")
    ap.add_argument("--json", default=None, help="Agent 返回的 JSON 文件")
    args = ap.parse_args()

    # 用户在界面填的三项要求。有值就写进指令当硬约束，没值就整段不出。
    BRIEF = {
        "angle": (args.angle or "").strip(),
        "exclude": (args.exclude or "").strip(),
        "viewpoint": (args.viewpoint or "").strip(),
    }

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
        # 订阅赛道：顿号/逗号分隔。
        # **不能用空格分**：赛道名本身就带空格（「AI 与科技」「国际与时事」），
        # 按空格切会把它拆成「AI」「与科技」两段，两段都不是合法赛道名（实测踩到）。
        sub_tracks = [x.strip() for x in
                      (args.tracks or "").replace("，", "、").replace(",", "、")
                      .split("、") if x.strip()]
        mats = pick_daily_materials(date, args.count, sub_tracks)
        if not mats:
            if sub_tracks:
                print(f"  ❌ {date} 在订阅赛道（{'、'.join(sub_tracks)}）里没有可用素材")
                print("     要么今天这些赛道确实没热点，要么赛道关键词覆盖不到这些标题。")
            else:
                print(f"  ❌ {date} 没有可用素材")
            return 1
        print(f"  {date} 选出 {len(mats)} 条素材（各出 2 个方向不同的选题）")
        if sub_tracks:
            print(f"  已按订阅赛道筛选：{'、'.join(sub_tracks)}")
        outdir = os.path.join(WORKSPACE, "_tmp", "topic-prompts")
        os.makedirs(outdir, exist_ok=True)
        for i, m in enumerate(mats, 1):
            pair = DIRECTION_PAIRS[(i - 1) % len(DIRECTION_PAIRS)]
            material = {
                "title": m.get("title", ""),
                "platform": m.get("platform", ""),
                "url": m.get("url", ""),
                "track": "",
                "desc": (m.get("desc") or m.get("summary") or ""),
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

    # 手工入口：方向数量按用户填的 --per（1-6），不是固定 2 个。
    pair = pick_directions(args.per, seed=0)
    prompt = build_analysis_prompt(material, pair, brief=BRIEF)
    outdir = os.path.join(WORKSPACE, "_tmp", "topic-prompts")
    os.makedirs(outdir, exist_ok=True)
    p = os.path.join(outdir, "single.md")
    io.open(p, "w", encoding="utf-8").write(prompt)
    print(f"  素材：{material['title']}")
    print(f"  方向（{len(pair)} 个）：{' / '.join(pair)}")
    if any(BRIEF.values()):
        _b = [k for k, v in BRIEF.items() if v]
        print(f"  用户要求：{', '.join(_b)}")
    print(f"  ✅ 加工指令 → {p}")
    print(f"     交给 Agent 执行，产出的 JSON 用 --save --json <文件> 落库")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
