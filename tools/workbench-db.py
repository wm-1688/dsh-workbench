#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""墨鱼创作工作台 · SQLite 数据层（Agent 侧）

用法：
    python tools/workbench-db.py init
    python tools/workbench-db.py import-hot --date 2026-10-05 --platform 今日头条 --limit 3
    python tools/workbench-db.py add-topic --title "..." [--platform --hot --url --note]
    python tools/workbench-db.py list-topics [--status candidate]
    python tools/workbench-db.py set-topic --id 1 --status selected
    python tools/workbench-db.py add-draft --topic-id 1 --title "..." --skill khazix-writer --track 社会文化观察
    python tools/workbench-db.py list-drafts
    python tools/workbench-db.py add-publish --draft-id 1 --method draft --account 你的公众号名
    python tools/workbench-db.py list-publishes
    python tools/workbench-db.py export          # 导出 UI 快照（服务器 API 做好前的桥）

三层职责（与 2026-10-05 的定案一致）：
    存 = 这个文件（SQLite）      传 = 暂用导出快照，后续换官方 Remote      写 = Agent 直接调此 CLI
"""

import argparse
import datetime
import io
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
import ws_path as _ws
# 工作区解析：开发环境用 PLUGIN/..，安装环境用 PLUGIN 自己。
# 详见 ws_path.py 顶部说明（2026-11-08 打包验证时修）。
WORKSPACE = _ws.ensure_workspace(PLUGIN)
DATA_DIR = os.path.join(WORKSPACE, "workbench")
DB_PATH = os.path.join(DATA_DIR, "workbench.db")
EXPORT_PATH = os.path.join(PLUGIN, "lib", "db.snapshot.json")
MATERIALS_PATH = os.path.join(PLUGIN, "lib", "materials.snapshot.json")

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 待分析队列：素材库点【入选题库】产生的一条任务
--   两段式的第一段。UI 只能写这里；分析由 Agent 跑选题 skill 完成。
CREATE TABLE IF NOT EXISTS topic_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key    TEXT    UNIQUE,          -- 去重键，如 "今日头条#1"
  title         TEXT    NOT NULL,        -- 热点标题
  platform      TEXT,
  hot           TEXT,
  url           TEXT,
  material_date TEXT,
  track         TEXT,                    -- 赛道，决定路由到哪个选题 skill
  skill         TEXT,                    -- 实际用的选题 skill（分析时回填）
  preset_json   TEXT,                    -- 单次预设：{count, angle, exclude, viewpoint, kind, words}
  status        TEXT    NOT NULL DEFAULT 'pending',
                                         -- pending | running | done | failed
  error         TEXT,
  note          TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT
);

-- 选题库：一个「选题方案」（不是一条标题）
--   一个 job 可产出多个方案（默认 3 个角度）。
--   字段按选题 skill 的实际产出定义：
--     aws-wechat-article-topics → 角度/标题候选/大纲/摘要/工作量/需额外素材
--     bigpeng-hot-gzh           → 方向/公式化标题/为何可能点/兑现/首选
CREATE TABLE IF NOT EXISTS topics (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER REFERENCES topic_jobs(id) ON DELETE SET NULL,
  source_key     TEXT,                   -- 溯源到素材
  title          TEXT    NOT NULL,       -- 方案名（选题名 / 方向名）
  track          TEXT,                   -- 赛道
  skill          TEXT,                   -- 用了哪个选题 skill
  persona        TEXT,                   -- 角色/视角（打工人/家长/从业者…）
  kind           TEXT,                   -- hot 🔥 | evergreen 🌲 | series 📚
  angle          TEXT,                   -- 切入角度
  hook           TEXT,                   -- 为何可能点（bigpeng）
  payoff         TEXT,                   -- 兑现：正文必须提供什么
  titles_json    TEXT,                   -- 候选标题 [{title,style,formula,chars,payoff,best}]
  best_title     TEXT,                   -- 首选标题
  digests_json   TEXT,                   -- 摘要候选（80-128 字）
  outline_json   TEXT,                   -- 大纲 [{heading,words,gist}]
  word_count     INTEGER,                -- 预计字数
  effort         TEXT,                   -- 工作量，如 "⭐⭐⭐ 约3小时"
  needs_material INTEGER DEFAULT 0,      -- 是否需要额外素材
  viewpoint      TEXT,                   -- 作者观点/立场（从预设带入，要一路传到写作与审稿）
  status         TEXT    NOT NULL DEFAULT 'candidate',
                                         -- candidate | selected | writing | done | dropped
  created_at     TEXT    NOT NULL,
  updated_at     TEXT
);

-- 创作库：一篇稿子
--   状态机对应流水线 5→11：queued(待写) → draft(初稿) → polished(打磨)
--                            → reviewed(审稿) → formatted(排版) → illustrated(配图) → published
CREATE TABLE IF NOT EXISTS drafts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id      INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  title         TEXT,
  digest        TEXT,                    -- 摘要（80-128 字，发布必需）
  viewpoint     TEXT,                    -- 观点，从选题方案带过来，一路传到审稿
  track         TEXT,                    -- 赛道
  skill         TEXT,                    -- 写作技能
  skill_class   TEXT,                    -- A | B —— 决定下游能否自动跑
  status        TEXT NOT NULL DEFAULT 'queued',
  word_count    INTEGER,
  path          TEXT,                    -- 草稿目录
  cover         TEXT,                    -- 封面图路径
  images_count  INTEGER DEFAULT 0,       -- 配图数
  review_issues INTEGER DEFAULT 0,       -- 审稿问题数
  started_at    TEXT,                    -- 进入当前阶段的时间（用于卡死检测）
  theme         TEXT,                    -- 创作主题（用户输入原文，不加工）
  materials     TEXT,                    -- 参考素材（粘贴正文，最多 5000 字）
  requirement   TEXT,                    -- 用户要求（观点/风格/角度）
  config_json   TEXT,                    -- 其余配置：{words, tone, skillManual, genre}
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- 发布管理：一次发布动作
CREATE TABLE IF NOT EXISTS publishes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id        INTEGER REFERENCES drafts(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL DEFAULT 'wechat',
  account         TEXT,
  method          TEXT NOT NULL DEFAULT 'draft',   -- draft | published
  wechat_media_id TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | uploaded | published | failed
  note            TEXT,
  published_at    TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_status   ON topics(status);
CREATE INDEX IF NOT EXISTS idx_topics_job      ON topics(job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status     ON topic_jobs(status);
CREATE INDEX IF NOT EXISTS idx_drafts_topic    ON drafts(topic_id);
CREATE INDEX IF NOT EXISTS idx_publishes_draft ON publishes(draft_id);

-- ── 文字风格库 ─────────────────────────────────────────────────────
-- 为什么单独一张表：`drafts.skill` 指的是**写作技能**（aws / 卡兹克 / 娱乐套件，
-- 决定走哪套硬规则），而「风格」是**同一技能下的语气变体**（哄睡体 / 划重点体）。
-- 两者是不同维度：一个草稿 = 一个 skill + 一个 style。
--
-- ⚠️ 2026-11-05 重构：**整份风格就是一段 Markdown**（body_md），不再拆成
-- profile_json / lexicons_json / canon_json / metrics_json 等十几个字段。
-- 理由：
--   1. 风格提示词的最终消费者是写作模型，它读的就是一段文本。拆成字段存、
--      用的时候再拼回去，中间每一步都可能丢信息，且拼装顺序本身就是个隐藏设计。
--   2. 用户要能直接看到、直接改、直接复制走。Markdown 天然满足，结构化字段不满足。
--   3. 一份提示词从 5 行到 50 行都可能，字段化的表单会逼用户按格子填。
-- 旧列（metrics_json/profile_json/...）保留不删——SQLite 删列代价高且已有数据，
-- 但代码不再读写它们；新数据一律进 body_md。
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    kind        TEXT,
    label       TEXT,
    hint        TEXT,
    group_key   TEXT,          -- 归属工作台：image=生图 / gzh=公众号 / ''=通用
    updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS writing_styles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,   -- 短代号，如 MS-001，草稿 config_json 里引用它
  name          TEXT    NOT NULL,          -- 显示名，如「民生科普 · 哄睡体」
  kind          TEXT    NOT NULL DEFAULT 'personal',
                                           -- personal 个人（自建）| system 系统（内置）
  desc          TEXT,                      -- 一句话说明（卡片副标题）
  track         TEXT,                      -- 适用赛道，空 = 通用
  body_md       TEXT,                      -- **整份风格提示词正文（Markdown）** —— 唯一的真源
  source_json   TEXT,                      -- 只存溯源元数据：样本清单/日期/生成方式
  version       INTEGER NOT NULL DEFAULT 1,
  upvotes       INTEGER NOT NULL DEFAULT 0,
  downvotes     INTEGER NOT NULL DEFAULT 0,
  used_count    INTEGER NOT NULL DEFAULT 0, -- 被多少篇草稿用过，用于排序
  status        TEXT    NOT NULL DEFAULT 'active',  -- active | archived
  created_at    TEXT    NOT NULL,
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_styles_kind   ON writing_styles(kind, status);
CREATE INDEX IF NOT EXISTS idx_styles_track  ON writing_styles(track);
"""

# 风格表 2026-11-05 重构：整份风格改成一段 Markdown（body_md）。
# 加列不加表（加表会破 check-docs 的「N 张业务表」断言）。
STYLE_NEW_COLUMNS = [
    ("body_md", "TEXT"),          # 整份风格提示词正文（Markdown）—— 唯一真源
]


# 写作技能路由：按赛道选写作 skill，并标出 A/B 类。
# A 类输出遵守 aws 套件配额（导语 80-128 字、加粗频率、金句格式），下游机器门禁能过；
# B 类（娱乐套件、卡兹克）保留文风但过不了那些门禁——结构冲突，配置解决不了。
# 所以 skill_class 必须入库，界面上才能看出「这篇能不能自动跑下游」。
WRITING_ROUTES = [
    (("娱乐", "情感", "八卦", "明星", "婚姻", "猎奇"), "write-entertainment-wechat-articles", "B"),
    # AI/科技 与 个人成长/职场：用卡兹克的长文语感（2026-10-11 由用户指定）。
    # 关键词只覆盖这两个赛道，不会误伤别的：
    #   「科技」只出现在「AI 与科技」；「教育」「职场」「成长」只出现在「教育与职场」。
    (("AI 与科技", "AI与科技", "科技", "教育与职场", "教育", "职场", "个人成长", "成长"),
     "khazix-writer", "B"),
]
DEFAULT_WRITING = ("aws-wechat-article-writing", "A")


def route_writing(track):
    t = (track or "").lower()
    for keys, skill, klass in WRITING_ROUTES:
        if any(k.lower() in t for k in keys):
            return skill, klass
    return DEFAULT_WRITING


def _style_row(r):
    """把 writing_styles 的一行变成前端对象。

    2026-11-05 起风格正文只存 `body_md` 一列，其余都是元数据或旧的 JSON 列。
    旧 JSON 列（metrics_json 等）**不再解析**——它们是重构前的遗留，
    数据已迁进 body_md；留着只是为了不丢历史，代码不再依赖。
    """
    if r is None:
        return None
    d = dict(r)
    d["body_md"] = d.get("body_md") or ""
    raw = d.pop("source_json", None)
    try:
        d["source"] = json.loads(raw) if raw else {}
    except Exception:
        d["source"] = {}
    return d


# ── 内置风格种子 ──────────────────────────────────────────────────
# 为什么要有种子：空风格库打开是一片空白，用户不知道该填什么指标。
# 这几个是**从本项目已实测的数据**定出来的（见 style-fingerprint 的三版对照：
# 中性资讯平均句长 32 字 / 卡兹克口语 18 字 / 说明书清单 13 字），
# 不是拍脑袋的行业通用值。指标区间就是可验收的那把尺子。
SEED_STYLES = [
    {
        "code": "MS-001",
        "name": "民生科普 · 哄睡体",
        "kind": "system",
        "desc": "短句、第二人称、像跟人聊天，适合手机端一口气读完",
        "track": "社会民生",
        "source": {"type": "measured",
                   "basis": "本项目三版风格指纹实测（中性 32 字 / 口语 18 字 / 清单 13 字）"},
        "body_md": """## 人格定位

一个在广州生活的普通人，把你当朋友而不是读者。用「我刚搞明白，告诉你」的姿态写，不端着。

## 语言特征

- **句式节奏**：句子短，平均 18 字左右（区间 16-22）。敢让一句话独立成段做节拍器。长句只用在必须交代清楚条件的地方。
- **用词倾向**：口语为主。专业词保留，但立刻用大白话解释一遍。不用网络黑话，不用书面连词。
- **标点习惯**：几乎不用冒号和破折号。问号用来替读者发问，不用来设问。
- **情绪表达**：克制。情绪靠事实落差传达，不靠形容词。

## 口语词组库

> 必须从原文逐字提取，禁止编造或归纳改写。

- **转场过渡**：说回来，还有个事，但这里要拐一下
- **表达判断**：说白了就是，我看这事，真正的坑在
- **承认自嘲**：我也不确定，我一开始也想错了
- **情绪表达**：这就有点离谱了，属实没想到
- **拉近读者**：你大概也遇到过，换你是你怎么办，你看看

## 写法特征

- **开篇方式**：直接上场景，或直接抛一个读者心里已经有的疑问。
- **论述推进**：先给结论，再回头补为什么。一层比一层具体，不重复。
- **知识引入**：随手嵌进叙事里，不单独开段讲课。
- **论述打破**：会在中间插一句自嘲或吐槽打断节奏，再拉回来。
- **收束方式**：落到一句可转述的话。不升华，不喊口号。

## 禁忌清单

- 不用「首先其次最后」三段式
- 不用设问句开头
- 不在结尾强行升华或喊口号
- 不堆四字短语
- 不用「近年来」「随着…的发展」

## 可测量指标

| 指标 | 区间 | 说明 |
|---|---|---|
| 平均句长 | 16-22 | 最灵敏的一个数，先卡这个 |
| 段落句数 | 2-4 | 超过 5 句就拆 |
| 第二人称密度 | 8-15 /千字 | 低于 8 就变成资讯稿了 |
| 口语密度 | 6-10 /千字 | 高于 15 会变油 |
| 加粗密度 | 0-3 /千字 | 只标关键数字 |

## 范文摘录

> 从原文逐字摘录，不可改写。

你在广州缴职工医保，你妈在湖北缴居民医保。

你卡里躺着两万块，她做胃镜得自己掏现金。

十月十六号起，这两件事能接上了。
""",
    },
    {
        "code": "MS-002",
        "name": "民生科普 · 划重点体",
        "kind": "system",
        "desc": "中长句、少人称、信息密度高，像有人替你在文件上划了重点",
        "track": "社会民生",
        "source": {"type": "measured",
                   "basis": "本项目中性资讯体实测（平均句长 32.1 字、零口语词）"},
        "body_md": """## 人格定位

一个把文件替你读完、把重点替你划出来的人。姿态是服务，不是表演。信任来自准确，不来自热情。

## 语言特征

- **句式节奏**：句子中长，平均 30 字（区间 26-34）。信息密度高，一句里塞得下条件、范围、时间。
- **用词倾向**：书面为主。专业术语照用不解释——读者是来查准确信息的。零口语词。
- **标点习惯**：只用最基本的句号逗号。不炫技。
- **情绪表达**：极克制，近乎没有。紧张感靠「哪一项还不适用」制造。

## 口语词组库

- **转场过渡**：需要说明的是，这里要分清
- **表达判断**：官方口径是，按现行规定
- **拉近读者**：你如果属于这一类

> 承认自嘲、情绪表达两组留空。这个风格不示弱、不抒情，硬凑会破坏一致性。

## 写法特征

- **开篇方式**：先给时间与主体，一句话交代清楚发生了什么。
- **论述推进**：分层。先是什么，再是谁受影响，最后哪条还没实现。
- **知识引入**：停下来专门解释，因为准确性比流畅重要。
- **论述打破**：不打破。这个风格不解构。
- **收束方式**：留一句可执行的动作，或一句边界提醒。

## 禁忌清单

- 不用第二人称套近乎
- 不用感叹号
- 不写情绪化标题句
- 不用「家人们」「姐妹们」
- 不在正文里插科打诨

## 可测量指标

| 指标 | 区间 | 说明 |
|---|---|---|
| 平均句长 | 26-34 | 低于 26 说明写得太口语了 |
| 段落句数 | 3-5 | 段太碎会失去论证感 |
| 第二人称密度 | 0-4 /千字 | 只能出现在举例时 |
| 口语密度 | 0-3 /千字 | 接近零才对 |
| 加粗密度 | 3-6 /千字 | 用于标关键数字 |

## 范文摘录

2026 年 10 月 19 日，国家医保局宣布，医保钱包迭代升级到 2.0 版。

从 10 月 16 日起，各省、自治区、直辖市以及新疆生产建设兵团已全部上线运行。
""",
    },
    {
        "code": "MS-003",
        "name": "民生科普 · 清单体",
        "kind": "system",
        "desc": "极短句、编号与表格、零人称，适合查阅不适合线性阅读",
        "track": "社会民生",
        "source": {"type": "measured",
                   "basis": "本项目说明书体实测（平均句长 12.9 字、表格 2 张）"},
        "body_md": """## 人格定位

一个只负责把事实排列整齐的人。没有人格，没有态度。读者来这里查东西，不希望被打扰。

## 语言特征

- **句式节奏**：极短句，平均 13 字（区间 10-16）。一句一个信息点，宁可断开也不连缀。
- **用词倾向**：名词和动词为主，几乎不用形容词。零人称代词。
- **标点习惯**：冒号用得多（标签式）。不用破折号。
- **情绪表达**：无。

## 口语词组库

五组全部留空。

> 这不是遗漏。说明书体本来就没有口语词——空着比编造诚实。

## 写法特征

- **开篇方式**：直接上标签——对象、时间、范围。
- **论述推进**：并列推进，不分主次，不设过渡。
- **知识引入**：全部显式列出，不做叙事化处理。
- **论述打破**：不打破。
- **收束方式**：以「待办」或「不适用条件」收尾。

## 禁忌清单

- 不用第二人称
- 不用比喻和类比
- 不写过渡句
- 不写观点和判断
- 不用情绪词
- 不在正文里提问

## 可测量指标

| 指标 | 区间 | 说明 |
|---|---|---|
| 平均句长 | 10-16 | 超过 20 就不是清单体了 |
| 段落句数 | 1-2 | 一段只放一个点 |
| 第二人称密度 | 0-2 /千字 | 基本不用 |
| 口语密度 | 0-1 /千字 | 接近零 |
| 加粗密度 | 4-8 /千字 | 标签式加粗是特征 |

## 范文摘录

**生效时间**：2026 年 10 月 16 日

**覆盖范围**：31 个省级行政区 + 新疆生产建设兵团

**功能边界**：额度跨省绑定已实现；参保省以外使用未实现
""",
    },

    # ── 以下三条都是系统内置风格，但来源不同 ──
    # MS-006 卡兹克体、MS-007 娱乐叙事体：从依赖技能里提取（source.type=skill-extracted），
    #   分别对应 khazix-writer 与 write-entertainment-wechat-articles，随技能成套使用。
    # MS-008 人格叙事体：不依赖任何技能，是「语言质感与文气」方法论（video-04）的直接落地，
    #   source.type 写的是 video-04。它被 check-draft.py / check-texture.py 当作
    #   「克制风格」的判定依据（选了它就跳过 aws 配额，改跑质感检查）。
    #
    # 为什么必须内置：client.template.js 的 WRITING_SKILLS 给
    #   write-entertainment-wechat-articles 写了 defaultStyle='MS-007'、
    #   khazix-writer 写了 defaultStyle='MS-006'，
    #   check-draft.py 还会按 MS-006 / MS-008 切换检查器。
    # 这几条原先只存在于开发机数据库里，没进种子，所以用户装完风格库只有 3 条，
    # 技能联动全部失效（styleList 里找不到 code 就静默跳过）。
    # 种子必须自带，否则「装完即可用」不成立。
    {
        "code": "MS-006",
        "name": "卡兹克体",
        "kind": "system",
        "desc": "亲自下场、聊着聊着顺手掏知识、敢下判断。长文一口气顺下来不加小标题",
        "track": "AI 与科技",
        "source": {"type": "skill-extracted", "skill": "khazix-writer", "files": ["SKILL.md 的风格内核17条", "SKILL.md 的绝对禁区", "SKILL.md 的推荐口语化词组6组", "references/style_examples.md 的19类手法"], "date": "2026-11-05"},
        "body_md": """## 人格定位

一个真的去做了那件事、然后回来跟你说的人。不是隔空评论的观察者，是亲自下场的当事人。姿态是「我踩过坑，我把看到的告诉你」，跟读者是同行者，不是老师。信任来自他敢说「我自己也还没跑通」，不来自他假装全知。

## 语言特征

- **句式节奏**：像跟朋友聊天，不像写报告。句子时长时短，大量用逗号制造口语化的停顿感。经常一句话自成一段来制造重点。段落要短，很多时候一句话就是一段。
- **用词倾向**：口语为主，工具名必须具体（说 Claude Code、Codex、Seedance 2.0、Deepresearch、Clawbot，不说「AI 工具」「某个模型」）。阿拉伯数字比汉字数字更口语（用 2 小时不用两小时）。
- **标点习惯**：不用冒号，不用破折号，不用任何双引号。引用或强调用「」或直接不加引号。用「。。。」表示语气拖长、震惊、无语、遗憾；用「？？？」表示极度惊讶；用「= =」表示无语吐槽。这些标点不是语法工具，是情绪的具象化。
- **情绪表达**：敢直接表达兴奋、震撼、无语。会自嘲（愚钝如我、老阴逼、十级懒癌晚期），会承认脆弱（看着自己拼命搭建的一切化为泡影，那种感觉你才懂）。克制不是这个风格的美德。

## 口语词组库

> 出自 khazix-writer 的推荐词组表，可直接使用。

- **转场过渡**：坦率的讲，说真的，我是真的觉得，反正我觉得，怎么说呢，其实吧，你想想看，我跟你说，回到 xxx 这块，这块需要注意一下，顺着上面的再聊聊
- **表达判断**：我有时候觉得，我一直觉得，这话听着有点刺耳但，不是说 xxx 不行而是说，我自己的感受是，我始终坚信，我觉得还是挺重要的
- **承认自嘲**：说实话我也不确定，我自己也还在摸索，可能有些想法还不成熟，这个事儿我也踩过坑，愚钝如我，我说「理论上」是因为我自己还没完全跑通，说实话我们还差得远
- **情绪表达**：这种感觉太爽了，我当时就愣住了，想想就觉得兴奋，我真的被震撼到了，搞得我现在还有点懵，太离谱了，给我一下子整不会了，一时间无语凝噎，鬼使神差的，你敢信？？？
- **拉近读者**：很多朋友可能不知道，可能有小伙伴纳闷，你如果关注这个领域的话，大家也都知道
- **口头禅口癖**：这玩意，不是哥们，我寻思了一下我没寻思明白，有个屁的 xxx，真的就是一声叹息，比较骚的事

## 写法特征

- **开篇方式**：永远从一个具体的、当下的事件或场景切入，绝不宏大叙事。四种必杀技——叙事启动（故事是这样的）、荒诞事实（直接抛一个让人？？？的事实）、热点破题（最近这两天被 xxx 刷屏了）、好奇心驱动（这两天刷到一张图，很有意思）。第一句要让读者产生「然后呢？」的冲动。
- **论述推进**：层层剥开，现象 → 表面解释 → 更深的追问 → 核心洞察，让读者参与思考而不是被动接收。涉及多产品对比时用逐一展示法，且排列遵循升番逻辑：最弱的放前面，最炸的留最后，每一轮比上一轮更夸张。
- **知识引入**：聊着聊着顺手掏出来，不是「下面我来给大家科普一下」。看起来像脑子里本来就有这些东西，正好跟眼前的事对上了。绝不是教科书式定义。
- **论述打破**：故意加入口语打断来破坏严谨性——重复强调（就是……就是……就是单纯的），中途叹息或打断，省略主语，刻意模糊（我就不说是谁了）。这些不是错误，是让文章像真人在说话的关键。
- **收束方式**：五种收法选其一——引用收尾（用别人的话作结）、哲思余韵（一个短句留白，如「时间。流逝的本身。」）、行动呼吁、信念宣言、回环呼应（回到开头的意象，但视角已不同）。不用论文式总结。

## 语言质感（书面规范，来自教程 04）

这一节**所有风格共用**，不随调性变化。上面几节定的是「用什么调性说话」，这一节定的是「话说得够不够实、够不够准」。风格可以换，这一节不换。

以下每条都是**动作要求**，不是原理说明。写完对着查，查不过就改。

### 一、画面优先：判断换成画面

**要做的动作**：写到情绪、性格、气氛时，先找一个能承载它的**动作**或**物件**，把抽象判断落下去。

- 「很伤心」→ 找一个动作：「蹲在楼下抽完一包烟」
- 「很紧张」→ 找一个部位和细节：「攥着纸，指节发白」
- 「很难过」→ 找一个动作：「又点了一支」

**动词自带场景**：它包含动作、时间、物件、力度。写「他摔了门」，读者听到了声音；写「他很愤怒」，读者什么都没看到。

**判据（不看词性，看画面）**：一句话写完，问自己——**读者眼前有没有东西**。

- 「她攥着纸，指节发白」：没有形容词，但是一幅画 → 通过
- 「悲伤的午后」：没有形容词错，但它也没落到画面上 → 不通过
- 「他推开门」：有动词，但读者只看到一个轮廓 → 补一个具体的：「他推开门，门轴响了一声」→ 通过

**什么该留**：用来**定性**的词要留，换成画面反而失准。长期的、偶发的、主要的、唯一的、首次、唯一一次——这类词是信息，不是修饰。

**什么该换**：用来**代替**画面的形容词。巨大的、深深的、无比的、令人震撼的、难以言说的——这类词在替读者下判断，读者看不到任何东西。

**名词和动词一样重要**：名词越具体，画面越清楚。「一把折叠椅」比「一个座位」具体，「搪瓷缸子」比「杯子」具体，「江阴」比「某地」具体。

### 二、细节：密度分区块，方向只服务一件事

**密度规则**（关键区分在哪）：
- **关键时刻要密**：人物的动作、场景的物件、对话的原话。这里是读者要停下来的地方，一个细节都不嫌多。
- **过渡处要疏**：时间推移、场景切换、背景交代。一句话带过，不要在这里铺细节。
- **全篇一样密 = 没有节奏**。密的地方要能被读者感觉到，靠的是别处够疏。

**方向规则**（每个细节必须有用途）：
- 写一个细节之前，先判断它在干什么：**营造氛围**，还是**暗示真相**。
- 两个都不干的，删掉，哪怕它很生动。
- 判据不是「这个细节真不真实」，而是「**这个细节在这个位置恰不恰当**」。真实的事情太多了，全写进去就是噪音。

**一句话记**：一个精准的细节，胜过十个别致的描写。宁可少写三个，把留下的那个写准。

### 三、情绪：写到最高点就停

**要做的动作**：
1. 找到全文情绪最高处——最痛、最反常、最意外的那一句。
2. **写到这里收住**。用一个极轻的动作带过，不要往下展开。
3. 只写那个瞬间发生了什么。判断留给读者，作者只呈现事实。

**禁令（这几类句子是硬性不合格）**：
- 不写「我很难过」「他很愤怒」「令人心痛」——**用动作替代**，不写情绪词本身
- 情绪最高点之后，**不加解释句**：不用「这不是要苛责」「客观来讲」「不必过度解读」「话虽如此」把刚升起的感受按下去
- 不用感叹号、不排比、不反复强调来加码

**替代写法示例**：
- 不写「我很难过」→ 写「那年冬天真冷」
- 不写「她终于撑不住了」→ 写「她把杯子放回桌上，放歪了，没扶正」

**为什么这样写**：读者被允许自己感受时，会自己把它填满；被作者强行引导时，会起防御。**空间留出来，读者才进得来。**

### 四、句子：长短交替，开口要换

**节奏规则**：
- 一个长句（铺陈、酝酿、交代条件）之后，**必须跟一个短句**收住。长句让读者进入氛围，短句把话钉住。
- 全篇一种长度 = 读者疲劳。每隔几段检查一次：最近 5 句是不是同一长度。

**开口规则**：
- **连续 2 段以同一个词开头**（尤其是「他」「她」「这」「那」），第三段必须换句首或换主语。
- 检查方法：只看每段第一个词，连着念下来。念着闷就是该换。

**具体动作**：
- 把状语提前：「那天下午，他……」
- 换成物件开头：「桌上那杯水，已经凉了」
- 换成时间开头：「十一点半，电话响了」

### 五、语言指纹：全篇一套，不混搭

**规则**：一篇文里，句式习惯、连接词、口语颗粒必须是**同一套**。不能前两段用口语，后两段换成书面腔。

**检查动作**：写完后挑 3 段，一段开头、一段中间、一段结尾，读一遍——**这三段像不像同一个人写的**。不像就是混搭了，统一成一种。

**关于「独特」**：不追求与众不同。每个人的说话方式本来就不一样，照自己平时说话的样子写，辨识度自然就在。刻意造个性反而假。

### 六、金句：按三步打磨，不硬憋

**三步操作**（按顺序做，不跳步）：
1. **先写一句正确的废话**——比如「人要为自己活」。这一步不要想着写好，只求把意思铺出来。
2. **给它加一个具体的参照系**——把抽象判断落到一个可指认的对象上。比如「前半辈子卖给了公司」。
3. **压缩，删掉所有虚词，只留骨架**——压完还觉得能再压，就继续压。

**判据**：金句是**用最少的词说出最大的共识，同时带着写作者的态度**。只满足「说得对」不叫金句，那叫废话。

**数量**：0-1 处。宁可没有，不要硬凑。硬凑的金句一眼能看出来。

### 七、修改：三遍，再加一遍删

**第一遍改结构**：信息有没有增量？结尾有没有动作？没有就重搭。

**第二遍改质感**：逐句查上面第一节——该有画面的地方有没有落到画面上；细节密度对不对。

**第三遍改文气**：**朗读一遍**。查三件事——顺不顺、有没有不像自己说话的句子、语气统不统一。

**最后一遍：删**。删掉所有**删了也不可惜**的句子。这是写作里最被低估的能力，比任何润色都有效。

**实操**：改完放一会儿再读。刚写完时读不出问题，隔一天能读出来一半。

## 禁忌清单

- 不用套话，禁用「首先……其次……最后」「综上所述」「值得注意的是」「不难发现」「让我们来看看」「接下来让我们」
- 不用小标题，全篇一口气顺下来，板块之间用口语化转场句衔接。只有「N 条心得」这种分条目结构才用数字编号，且不是正式 markdown 标题
- 不用 bullet point 罗列观点，不大量加粗。超过 2 行的连续加粗几乎肯定是过度结构化
- 不用冒号、破折号、任何双引号
- 绝对禁用「说白了」「意味着什么」「这意味着」「本质上」「换句话说」「不可否认」
- 不编造假设性例子。不写「比如有一次……」，要写「就像我今天正在搞的 xxx」。没有真实细节就明说没有
- 不用空泛工具名。不说「AI 工具」「某个模型」「相关技术」
- 不用教科书开头。「在当今 AI 快速发展的时代」「随着技术的不断进步」这类空话一律禁止

## 可测量指标

| 指标 | 区间 | 说明 |
|---|---|---|
| 全文字数 | 4000-8000 | 公众号长文 |
| 小标题数 | 0 | 极少数分条目结构可例外 |
| 冒号数 | 0 | 硬性，检查器会扫 |
| 破折号数 | 0 | 硬性，检查器会扫 |
| 双引号数 | 0 | 硬性，检查器会扫 |
| 禁用词命中 | 0 | 见禁忌清单，硬性 |
| 口语词组数 | 8-10 | 从上方词库中自然取用，不硬塞 |
| 一句话成段 | ≥3 处 | 制造重点与停顿 |

## 范文摘录

> 以下为 khazix-writer 的原文样本，逐字引用，不可改写。

故事是这样的。

我最近刷淘宝挺多，然后昨天，鬼使神差的，在淘宝上，搜了一下DeepSeek。

---

我可能，刚刚成为了哈基米的儿子。

至少，AI是这么认为的。

---

于是，我就下了单，付了款。

然后，对方给我发的东西，我差点以为我特么进平行宇宙了。

给我发了两个网址。

---

黑暗森林。

大时代啊，朋友们。

安全，安全，还是他妈的安全。

---

毕竟，我们不仅能看到噪点中的鹿，我们还能看到沉默中的爱，看到无常中的美。

还有，那时间。

流逝的本身。
""",
    },
    {
        "code": "MS-007",
        "name": "娱乐叙事体",
        "kind": "system",
        "desc": "七分冷静三分情绪，事实密度代替营销音量。适合娱乐情感题材",
        "track": "娱乐与情感",
        "source": {"type": "skill-extracted", "skill": "write-entertainment-wechat-articles", "files": ["核心目标", "第二步 观众参与冲动", "第四步 写强开头", "第八步 语言温度", "第九步 句子节奏", "第十步 章节", "第十二步 自然收尾", "常见失败诊断20条"], "date": "2026-11-05"},
        "body_md": """## 人格定位

一个把事实看清楚了再说话的人。姿态是观察者，不是裁判。跟读者是同行者，一起看清一件复杂的事，而不是替读者下道德结论。文章可以锋利，但不刻薄；可以好奇，但不窥私；可以有判断，但不扮演裁判。

## 语言特征

- **句式节奏**：以 10 到 35 字的短句和中句为主，必要时用较长句完成复杂关系。连续两三个短句后，用一个完整长句恢复叙述。同一种句式不要连续出现三次。写给手机屏幕阅读，但不要把文章切成口播字幕。
- **用词倾向**：优先具体名词和动作，减少「很、非常、极其、真正、深刻」等程度副词。抽象句写完后检查能否换成一个可见的人物动作或结果。不为了显得像真人而故意制造错句、方言、破句或生硬比喻。
- **标点习惯**：排比、反问和「不是……而是」只在真正需要强调时使用，相同修辞全篇不重复。语言温度默认七分冷静三分情绪，情绪出现后及时回到具体事实，不连续升级。
- **情绪表达**：情绪只在反常动作、人物代价和关键转折处升高。娱乐感来自反差、尴尬、荒诞和人物选择，不来自段子密度。严肃处境不写俏皮话，轻松素材不强行悲情。允许一处干净的冷幽默，不解释笑点，不连续抖包袱。

## 口语词组库

> 这一套是克制的，口语词组用得少而准。不用口语词堆出「活人感」。

- **转场过渡**：（本风格靠事实推进，极少用口语转场）
- **表达判断**：写具体判断而不是模糊口号
- **承认自嘲**：承认事情比最初判断更复杂，但不撤回主角度
- **情绪表达**：用事实和人物动作制造情绪，不用情绪词替素材喊叫
- **拉近读者**：不加「你怎么看」「评论区见」这类互动口令

## 写法特征

- **开篇方式**：前三段完成三个动作——第一段交付最异常的动作、结果、原话或画面；第二段补足人物与最低限度背景；第三段指出真正值得继续看的矛盾，但暂不解释完。五种优先手法：结果先行、小目标与大代价、原话先行、具体画面、身份反差。强开头依靠事实密度，不依靠营销音量。
- **论述推进**：一个段落只推进一个主要动作或判断。每段 1 到 4 句，根据语义自然分段。长段落超过 150 字时检查能否拆分。章节不是观点容器，每一节都需要发生变化：新事实、新转折、新关系，或对主角度更深入的一步。不能把同一判断换个说法分成五节。
- **知识引入**：不插入百科背景、网友热议或泛泛趋势来凑篇幅。需要背景时只给最低限度，且必须服务当前叙事。
- **论述打破**：不做口语打断式解构。保持叙述的完整与自然，不用破句硬造个性。
- **收束方式**：五种选其一——场景回扣（回到开头的动作、物件或原话）、后果停留（停在人物仍要承担的具体结果上）、画面定格（用一个真实可见的画面结束）、判断硬切（最后一句完成主判断后直接停止）、未答之问（留下素材本身尚未解决的问题）。好的结尾像把镜头停住，不像主持人宣布节目结束。结尾不负责重新总结全文，也不提醒读者点赞关注。

## 语言质感（书面规范，来自教程 04）

这一节**所有风格共用**，不随调性变化。上面几节定的是「用什么调性说话」，这一节定的是「话说得够不够实、够不够准」。风格可以换，这一节不换。

以下每条都是**动作要求**，不是原理说明。写完对着查，查不过就改。

### 一、画面优先：判断换成画面

**要做的动作**：写到情绪、性格、气氛时，先找一个能承载它的**动作**或**物件**，把抽象判断落下去。

- 「很伤心」→ 找一个动作：「蹲在楼下抽完一包烟」
- 「很紧张」→ 找一个部位和细节：「攥着纸，指节发白」
- 「很难过」→ 找一个动作：「又点了一支」

**动词自带场景**：它包含动作、时间、物件、力度。写「他摔了门」，读者听到了声音；写「他很愤怒」，读者什么都没看到。

**判据（不看词性，看画面）**：一句话写完，问自己——**读者眼前有没有东西**。

- 「她攥着纸，指节发白」：没有形容词，但是一幅画 → 通过
- 「悲伤的午后」：没有形容词错，但它也没落到画面上 → 不通过
- 「他推开门」：有动词，但读者只看到一个轮廓 → 补一个具体的：「他推开门，门轴响了一声」→ 通过

**什么该留**：用来**定性**的词要留，换成画面反而失准。长期的、偶发的、主要的、唯一的、首次、唯一一次——这类词是信息，不是修饰。

**什么该换**：用来**代替**画面的形容词。巨大的、深深的、无比的、令人震撼的、难以言说的——这类词在替读者下判断，读者看不到任何东西。

**名词和动词一样重要**：名词越具体，画面越清楚。「一把折叠椅」比「一个座位」具体，「搪瓷缸子」比「杯子」具体，「江阴」比「某地」具体。

### 二、细节：密度分区块，方向只服务一件事

**密度规则**（关键区分在哪）：
- **关键时刻要密**：人物的动作、场景的物件、对话的原话。这里是读者要停下来的地方，一个细节都不嫌多。
- **过渡处要疏**：时间推移、场景切换、背景交代。一句话带过，不要在这里铺细节。
- **全篇一样密 = 没有节奏**。密的地方要能被读者感觉到，靠的是别处够疏。

**方向规则**（每个细节必须有用途）：
- 写一个细节之前，先判断它在干什么：**营造氛围**，还是**暗示真相**。
- 两个都不干的，删掉，哪怕它很生动。
- 判据不是「这个细节真不真实」，而是「**这个细节在这个位置恰不恰当**」。真实的事情太多了，全写进去就是噪音。

**一句话记**：一个精准的细节，胜过十个别致的描写。宁可少写三个，把留下的那个写准。

### 三、情绪：写到最高点就停

**要做的动作**：
1. 找到全文情绪最高处——最痛、最反常、最意外的那一句。
2. **写到这里收住**。用一个极轻的动作带过，不要往下展开。
3. 只写那个瞬间发生了什么。判断留给读者，作者只呈现事实。

**禁令（这几类句子是硬性不合格）**：
- 不写「我很难过」「他很愤怒」「令人心痛」——**用动作替代**，不写情绪词本身
- 情绪最高点之后，**不加解释句**：不用「这不是要苛责」「客观来讲」「不必过度解读」「话虽如此」把刚升起的感受按下去
- 不用感叹号、不排比、不反复强调来加码

**替代写法示例**：
- 不写「我很难过」→ 写「那年冬天真冷」
- 不写「她终于撑不住了」→ 写「她把杯子放回桌上，放歪了，没扶正」

**为什么这样写**：读者被允许自己感受时，会自己把它填满；被作者强行引导时，会起防御。**空间留出来，读者才进得来。**

### 四、句子：长短交替，开口要换

**节奏规则**：
- 一个长句（铺陈、酝酿、交代条件）之后，**必须跟一个短句**收住。长句让读者进入氛围，短句把话钉住。
- 全篇一种长度 = 读者疲劳。每隔几段检查一次：最近 5 句是不是同一长度。

**开口规则**：
- **连续 2 段以同一个词开头**（尤其是「他」「她」「这」「那」），第三段必须换句首或换主语。
- 检查方法：只看每段第一个词，连着念下来。念着闷就是该换。

**具体动作**：
- 把状语提前：「那天下午，他……」
- 换成物件开头：「桌上那杯水，已经凉了」
- 换成时间开头：「十一点半，电话响了」

### 五、语言指纹：全篇一套，不混搭

**规则**：一篇文里，句式习惯、连接词、口语颗粒必须是**同一套**。不能前两段用口语，后两段换成书面腔。

**检查动作**：写完后挑 3 段，一段开头、一段中间、一段结尾，读一遍——**这三段像不像同一个人写的**。不像就是混搭了，统一成一种。

**关于「独特」**：不追求与众不同。每个人的说话方式本来就不一样，照自己平时说话的样子写，辨识度自然就在。刻意造个性反而假。

### 六、金句：按三步打磨，不硬憋

**三步操作**（按顺序做，不跳步）：
1. **先写一句正确的废话**——比如「人要为自己活」。这一步不要想着写好，只求把意思铺出来。
2. **给它加一个具体的参照系**——把抽象判断落到一个可指认的对象上。比如「前半辈子卖给了公司」。
3. **压缩，删掉所有虚词，只留骨架**——压完还觉得能再压，就继续压。

**判据**：金句是**用最少的词说出最大的共识，同时带着写作者的态度**。只满足「说得对」不叫金句，那叫废话。

**数量**：0-1 处。宁可没有，不要硬凑。硬凑的金句一眼能看出来。

### 七、修改：三遍，再加一遍删

**第一遍改结构**：信息有没有增量？结尾有没有动作？没有就重搭。

**第二遍改质感**：逐句查上面第一节——该有画面的地方有没有落到画面上；细节密度对不对。

**第三遍改文气**：**朗读一遍**。查三件事——顺不顺、有没有不像自己说话的句子、语气统不统一。

**最后一遍：删**。删掉所有**删了也不可惜**的句子。这是写作里最被低估的能力，比任何润色都有效。

**实操**：改完放一会儿再读。刚写完时读不出问题，隔一天能读出来一半。

## 禁忌清单

- 不用「最近有一件事引发了广泛关注」「今天我们来聊聊」这类开头
- 不用「你敢相信吗」「万万没想到」「震惊所有人」「先别急着划走」「一定要看到最后」
- 不故意隐去人物和事件，只写空悬念
- 第一段不直接宣布时代、社会或人性出了问题
- 不用「总之」「综上所述」和回顾全文
- 不用「这件事告诉我们」「值得每个人深思」「时代的一粒灰」「雪崩时没有一片雪花无辜」
- 不用「未来如何让我们拭目以待」「你怎么看」「评论区见」「欢迎转发」
- 不在结尾再提出一个与全文无关的新观点
- 不替人物诊断心理，不把人当展品，不通过站队制造高潮
- 不为了凑篇幅添加百科背景、网友热议或泛泛趋势
- 不把待核验传闻写成确定事实

## 可测量指标

| 指标 | 区间 | 说明 |
|---|---|---|
| 句长 | 10-35 字为主 | 短句和中句为主，长句只用于复杂关系 |
| 段落句数 | 1-4 句 | 一段只推进一个动作或判断 |
| 段落字数 | ≤150 字 | 超过就检查能否拆 |
| H1 标题 | 1 个 | 必须 |
| H2 章节 | 3-5 个 | 默认用一、二、三中文序号 |
| H3 / 分割线 | 0 | 默认不用 |
| 句式重复 | ≤2 次 | 同一种句式不连续三次 |
| 冷幽默 | ≤1 处 | 不解释笑点 |
| 情绪升级 | 不连续 | 升高后必须回到事实 |

## 范文摘录

> 这一套没有附带原文样本，以下按规范自述其结构特征，供对照：

素材提供热闹。
角度提供理解。
文笔提供距离、节奏和余味。

---

开头前三段的节奏是：先给最异常的那一个动作或结果，再补人物与背景，最后指出矛盾但先不解释完。

结尾像把镜头停住，不像主持人宣布节目结束。
""",
    },
    {
        "code": "MS-008",
        "name": "人格叙事体",
        "kind": "system",
        "desc": "基于「语言质感与文气」方法论：文气不是文采，是人格的投影。核心是克制与画面感，不依赖任何 skill。",
        "track": "社会民生",
        "source": {"source": "video-04", "note": "教程 04 方法论直接落地，不依赖 skill"},
        "body_md": '''## 人格定位

**一个有文化的痞子。**

见过世面，读过点书，也在街面上混过。说话不端，不装，不会跟你打官腔。但他知道分寸在哪，知道什么话该说、什么话说出来就掉价了。

**糙在语气，不糙在教养。** 他可以说扯淡、瞎搞、这事儿不对劲，但他不会骂人，不会拿别人的短处开涮，不会为了显得接地气就故意说错别字。

**人格设定里最重要的一条：他是真的下场干了这件事的人。** 不是隔空评述的旁观者，是亲自趟过水的。写的时候有呼吸、有停顿、有犹豫。读者读完会觉得，这个人是真的这么想的，而不是这个人在完成一篇稿子。

他敢说愚钝如我、我压根没整明白、这事儿我也翻过车。信任不是来自他假装全知，是来自他愿意承认自己也没跑通。

**文气这事得单说一句。**

文气不是文采。文采是局部的一个漂亮比喻，文气是整体的生命力——是写作者的人格在字里行间的投影。所以这一套的目标不是写得漂亮，是写得像一个人。

一个具体的人，有口音、有脾气、有自己那套词。不是标准普通话播报员，也不是网上那种千篇一律的亲切感。

## 语言特征

- **堆砌的形容词，换成能产生画面的动词和具体名词**：不是不用形容词，是**不用形容词去代替画面**。形容词传递的是判断（模糊的），动词传递的是画面（具体的）。「很伤心」是判断，读者不知道有多伤心；「蹲在楼下抽完一包烟」是画面，读者自己就懂了。
  - **动词是场景化的**。它自带动作、时间、物件、力度。写「他摔了门」比写「他很愤怒」多给了读者一个声音。
  - **换的标准不是词性，是这句话有没有落到画面上**。写「她攥着纸，指节发白」，里面没有形容词，但它是一幅画。写「悲伤的午后」，没有动词，但它也没落到画面上。所以判据是：**这句话读完，读者眼前有没有东西**。
  - **该留的形容词要留**。用来定性的词（长期的、偶发的、主要的、唯一）不该换，换成画面反而失准。要换的是那些用来**代替**画面的——巨大的、深深的、无比的、令人震撼的这类。
  - **具体名词和动词一样重要**。写「一把折叠椅」比写「一个座位」具体，写「搪瓷缸子」比写「杯子」具体。名词越具体，画面越清楚。
- **具体优先于抽象**：抽象句写完后，检查能否换成一个可见的人物动作或结果。写不出来，说明这句还停在判断层，没落到画面。
- **句子节奏**：长句适合铺陈、酝酿、推进；短句适合强调、转折、收束。长句让读者进入氛围，短句把话钉住。全篇一律的长句或一律的短句都闷。
- **句子开口**：连续几段都以「他」「她」「这」开头，节奏会很闷。适当换主语、换句首，句子就活起来。
- **情绪表达**：不替读者喊叫。情绪只在反常动作、人物代价和关键转折处升高，升高后立刻回到具体事实，不连续升级。

## 口语词组库（痞子腔）

**这一节定的是「用什么人话说话」。** 人格设定是一个有文化的痞子——见过世面、读过点书，但在街面上混过。说话不端着，也不low。

**糙在语气，不糙在教养。** 这是全节的底线。

### 三条硬规则（先看这个，再看词表）

**1. 糙话只用在两个位置：转场、吐槽。**
- 叙述段、讲道理段、写人的段落，**保持克制，不用糙词**。
- 铺满全文，痞子就变混混了。

**2. 一篇最多 8-12 处。**
- 密度太高读者会觉得这人在演。
- 合适的节奏是每 250-300 字出现一处。

**3. 到「扯淡、瞎搞、什么玩意儿」为止，不再上一个台阶。**
- 不出现身体器官、性、亲属称谓的脏话。
- 不用含脏字的词（特么、妈的、操蛋、狗日的这类，一个都不许）。
- **判据**：这句话念给家里六十岁的长辈听，会不会觉得不体面。会，就换。

### 转场过渡（糙话主要用在这里）

说回来，这事儿得从头说，咱先不说这个，你别急听我说完，话扯远了，这就得说回去了，咱掰扯掰扯，甭管别的先说这个，回到 xxx 这块，顺着上面再聊聊

### 表达判断（书卷气在这一类）

我寻思着，这事儿不对劲，你细品，这就有意思了，我琢磨了一下，说出来你可能不信，这里头有讲究，不是那么回事，这话搁以前没人信，我看这事八成是

### 吐槽与不屑（糙话最重的一类）

扯淡，瞎搞，净扯，什么玩意儿，屁大点事，整不明白，糊弄鬼呢，这算哪门子事，不靠谱，净整些没用的，说得比唱得好听，一脑袋浆糊

### 北方通用土话（中老年读者最熟）

搁那儿，咋整，整，稀里糊涂，没辙，犯不上，得亏，甭提了，赶巧，愣是，老鼻子了，麻溜儿，磨叽，膈应，糟心，憋屈，上赶着，门儿清，门儿都没有，就那么回事

### 承认与自嘲（痞子也认怂）

愚钝如我，我压根没整明白，这事儿我也翻过车，我寻思了半天没寻思明白，我这人反应慢，说实话我也心虚，我当时就傻了，别学我

### 拉近读者（称呼与共感）

老几位，咱，你想想，你信不信，换你你也这样，过来人都懂，咱们这种人，很多朋友可能不知道，你如果关注这个领域的话

### 口头禅口癖（让文字有「这个人」的味道）

这玩意儿，就那么个事儿，真就是一声叹息，我不说是谁，你懂的，有个屁的 xxx，比较骚的事，给我一下子整不会了，你敢信？？？

### 反向清单：这些词一个都不许用

它们是典型的 AI 味词，或者被网络用滥了，用上去等于自曝。**与卡兹克体的禁用清单保持一致。**

说白了，意味着什么，这意味着，本质上，换句话说，不可否认，值得注意的是，不难发现，众所周知，综上所述，让我们来看看，接下来让我们

⁻ 另外，不必非得说「首先、其次、最后」，那是有文化没痞气的写法。要分条就用口语，一二三四，或者干脆不分。

"""

## 克制（本风格的核心）

**要做的动作**：
1. 找到全文情绪最高处——最痛、最反常、最意外的那一句。
2. **写到这里收住**。用一个极轻的动作带过，不往下展开。
3. 只写那个瞬间发生了什么。判断留给读者，作者只呈现事实。

**禁令（出现即不合格）**：
- 不写「我很难过」「他很愤怒」「令人心痛」——**用动作替代**，不写情绪词本身
- 情绪最高点之后，**不加解释句**。不用「这不是要苛责」「客观来讲」「不必过度解读」「话虽如此」把刚升起的感受按下去
- 不用感叹号、不排比、不反复强调来加码

**替代写法（照这个改）**：
- 不写「我很难过」→ 写「那年冬天真冷」
- 不写「她终于撑不住了」→ 写「她把杯子放回桌上，放歪了，没扶正」
- 不写「他很震惊」→ 写「他把手机放下，又拿起来看了一遍」

**判据**：把全篇最扎人的那句找出来，看它**后面紧跟着什么**。如果跟的是一句解释、一句缓和、一句评论，就是把它按下去了，删掉那句。

**为什么这样写**：读者被允许自己感受时会自己填满；被作者强行引导时会起防御。空间留出来，读者才进得来。

## 细节的密度与方向

**密度规则（区分区块）**：
- **关键时刻要密**：人物的动作、场景的物件、对话的原话。这里是读者要停下来的地方，一个细节都不嫌多。
- **过渡处要疏**：时间推移、场景切换、背景交代。一句话带过，不要在这里铺细节。
- **全篇一样密 = 没有节奏**。密的地方要能被读者感觉到，靠的是别处够疏。

**方向规则（每个细节必须有用途）**：
- 写一个细节之前先判断它在干什么：**营造氛围**，还是**暗示真相**。
- 两个都不干的，删掉，哪怕它很生动。
- 判据不是「这个细节真不真实」，而是「**这个细节在这个位置恰不恰当**」。真实的事情太多了，全写进去就是噪音。

**一句话记**：一个精准的细节胜过十个别致的描写。宁可少写三个，把留下的那个写准。

## 开篇方式

开头三秒拼的不是文采，是信息的效率。要在最短时间内让读者明确：读下去对我有好处。

三种经过验证的手法：

1. **具体场景开场**：一上来就是一个可见的画面，让读者瞬间进入。比「近年来」强一百倍。
2. **反常识判断开场**：第一句话就抛一个跟主流相反的观念，让人想知道你凭什么这么说。
3. **真问题开场**：问题要精准踩中读者的处境，让他心里说「对，这正是我想要问的」。

## 金句的打磨

**三步操作（按顺序做，不跳步）**：
1. **先写一句正确的废话**——比如「人要为自己活」。这一步不要想着写好，只求把意思铺出来。
2. **给它加一个具体的参照系**——把抽象判断落到一个可指认的对象上。比如「前半辈子卖给了公司」。
3. **压缩，删掉所有虚词，只留骨架**——压完还觉得能再压，就继续压。

**判据**：金句是**用最少的词说出最大的共识，同时带着写作者的态度**。只满足「说得对」不叫金句，那叫废话。

**数量**：0-1 处。宁可没有，不要硬凑。硬凑的一眼能看出来。

**空转检查**：「就是这件事本身」「说到底还是那个道理」「本质就是这样」——这类指向不了任何具体对象的，是空转，重写。

## 禁忌清单

- 不用形容词堆情绪（**不是禁用形容词**）：「深深的」「巨大的」「无比的」「令人震撼的」——这些词在替读者下判断，读者看不到任何东西
- 不用程度副词代替画面：「非常」「极其」「十分」「特别」
- 不在最痛的地方用力：不加感叹号、不排比、不反复强调
- 不用「众所周知」「近年来」「随着」「在当今」「不可否认」开头
- 不用「总之」「综上」「所以说」「总结一下」收尾
- 不用「你敢相信吗」「万万没想到」「震惊所有人」「先别急着划走」
- **不许为了痞而痞**：故意造错句、破句、乱加语气词，读起来像在演，比端着还假。土话可以自然地用，但不能通篇都是
- **不许用含脏字的词**：特么、妈的、操蛋、狗日的、龟儿子这类，一个都不许。糙到「扯淡、瞎搞、什么玩意儿」为止，不再上一个台阶
- **糙话不许出现在叙述段和讲道理的段**：只准用在转场和吐槽两个位置。撒满全文，痞子就变混混了
- 不用 AI 味词：说白了、意味着什么、这意味着、本质上、换句话说、不可否认、值得注意的是、不难发现、众所周知、综上所述
- 不在结尾求转发、不提醒点赞关注

## 可测量指标

| 指标 | 区间 | 说明 |
|---|---|---|
| 句长 | 长短结合 | 长句铺陈，短句收束；不要全篇一个节奏 |
| 连续同主语开头 | ≤2 段 | 超过就换句首 |
| 代替画面的形容词 | 尽量为 0 | 不是禁形容词，是禁「用形容词代替画面」；定性用的形容词该留就留 |
| 程度副词 | 少 | 「很/非常/极其/十分」能不写就不写 |
| 细节密度 | 关键处密、过渡处疏 | 全篇一样密 = 没有节奏 |
| 冷幽默 | ≤1 处 | 不解释笑点 |
| 情绪升级 | 不连续 | 升高后必须回到事实 |
| 金句 | 0-1 处 | 打磨过的，不是硬凑的 |
| **口语词组** | **8-12 处** | 从「口语词组库（痞子腔）」取用。少于 8 处痞气不够，多于 12 处像在演 |
| 糙话位置 | 只在转场、吐槽 | 叙述段和讲理段不许出现糙词 |
| 含脏字的词 | 0 | 硬性。出现即不合格 |

## 三遍修改法

**第一遍改结构**：信息有没有增量？结尾有没有动作？没有就重搭。

**第二遍改质感**：逐句查——该有画面的地方有没有落到画面上；细节密度对不对；情绪最高点后面有没有多余的解释句。

**第三遍改文气**：**朗读一遍**。查三件事——顺不顺、有没有不像自己说话的句子、语气统不统一。

**最后一遍：删**。删掉所有**删了也不可惜**的句子。这是写作里最被低估的能力，比任何润色都有效。

**实操**：改完放一会儿再读。刚写完时读不出问题，隔一天能读出来一半。
## 适用场景

- 需要「人味」的叙事与评论
- 民生话题里涉及具体人的处境
- 观点输出（靠克制和事实说话，不靠音量）
- 不适合：需要强情绪煽动的题材、需要密集信息罗列的清单体
''',
    },
]


def seed_styles(conn):
    """插入内置风格。**幂等**：已存在同 code 就跳过，不覆盖用户改过的内容。"""
    n = 0
    for s in SEED_STYLES:
        exist = conn.execute("SELECT id FROM writing_styles WHERE code=?", (s["code"],)).fetchone()
        if exist:
            continue
        conn.execute(
            """INSERT INTO writing_styles (code, name, kind, desc, track, body_md,
                                          source_json, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (s["code"], s["name"], s["kind"], s["desc"], s["track"],
             s.get("body_md") or "",
             json.dumps(s["source"], ensure_ascii=False),
             now(), now()))
        n += 1
    conn.commit()
    return n


def backfill_seed_styles(conn):
    """给老库里的内置风格补 `body_md`（幂等）。

    2026-11-05 之前建的内置风格只有结构化字段、没有 body_md。
    这里把 SEED_STYLES 里的 Markdown 正文补进去——**只补空的，不覆盖**，
    因为用户可能已经改过那几条。
    """
    n = 0
    for s in SEED_STYLES:
        row = conn.execute(
            "SELECT id, body_md FROM writing_styles WHERE code=?", (s["code"],)).fetchone()
        if not row or (row["body_md"] or "").strip():
            continue
        conn.execute(
            "UPDATE writing_styles SET body_md=?, updated_at=? WHERE id=?",
            (s.get("body_md") or "", now(), row["id"]))
        n += 1
    conn.commit()
    return n


def _add_column_if_missing(conn, table, column, decl):
    """已有的库不会因 CREATE TABLE IF NOT EXISTS 获得新列，所以要单独 ALTER。"""
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        return True
    return False


def ensure_schema(conn):
    """建表 + 迁移。

    顺序很重要：旧版 `topics` 是「一行 = 一条热点」，新版是「一行 = 一个选题方案」。
    必须先判断并改名旧表，再跑 SCHEMA —— 否则 CREATE TABLE IF NOT EXISTS 会跳过，
    旧结构就被当成了新表。
    """
    legacy = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='topics'").fetchone()
    renamed = False
    if legacy is not None:
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(topics)")]
        if "persona" not in cols:            # 旧结构
            # ⚠️ 必须关掉 legacy_alter_table 的重写行为：
            # 默认情况下 ALTER TABLE topics RENAME 会把 drafts/publishes 里
            # REFERENCES topics(id) 一并改写成 topics_legacy，之后删掉旧表就变成悬空外键，
            # 插草稿时会报 "no such table: main.topics_legacy"。
            conn.executescript(
                "PRAGMA legacy_alter_table = ON;\n"
                "ALTER TABLE topics RENAME TO topics_legacy;\n"
                "PRAGMA legacy_alter_table = OFF;")
            renamed = True
    # 修复历史迁移留下的悬空外键（早期版本没有上面的 PRAGMA，已经写坏了）
    dangling = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%topics_legacy%'")]
    for tname in dangling:
        cnt = conn.execute(f"SELECT COUNT(*) c FROM {tname}").fetchone()["c"]
        if cnt == 0:
            conn.execute(f"DROP TABLE {tname}")     # 空表：删掉，交给 SCHEMA 重建
            print(f"workbench-db: 重建空表 {tname}（修复悬空外键）", file=sys.stderr)
        else:
            print(f"workbench-db: ⚠️ 表 {tname} 外键悬空且含 {cnt} 行，需手工迁移",
                  file=sys.stderr)
    conn.executescript(SCHEMA)
    if renamed:
        # 旧行搬进待分析队列：它们本来就是「未分析的热点」，不是选题方案
        conn.execute("""
            INSERT OR IGNORE INTO topic_jobs
              (source_key, title, platform, hot, url, material_date, status, note, created_at)
            SELECT source_key, title, platform, hot, url, material_date, 'pending', note, created_at
            FROM topics_legacy""")
        conn.execute("DROP TABLE topics_legacy")
    # 列级迁移（给已存在的库补新列）
    _add_column_if_missing(conn, "topic_jobs", "preset_json", "TEXT")
    _add_column_if_missing(conn, "topics", "viewpoint", "TEXT")
    for col, decl in [("digest", "TEXT"), ("viewpoint", "TEXT"), ("skill_class", "TEXT"),
                      ("cover", "TEXT"), ("images_count", "INTEGER DEFAULT 0"),
                      ("review_issues", "INTEGER DEFAULT 0"), ("started_at", "TEXT"),
                      # 创作配置（2026-10-25）：主题/素材/要求原样存，供写作 skill 读取
                      ("theme", "TEXT"), ("materials", "TEXT"),
                      ("requirement", "TEXT"), ("config_json", "TEXT")]:
        _add_column_if_missing(conn, "drafts", col, decl)
    # 风格表三层扩展（2026-11-05）：定性画像 / 口语词库 / 范文摘录
    for col, decl in STYLE_NEW_COLUMNS:
        _add_column_if_missing(conn, "writing_styles", col, decl)
    # 选题四步流程列（topic-pipeline.py --save 依赖）。
    # SCHEMA 里的 topics 仍是旧版 22 列，而 topic-pipeline.py 按 34 列 INSERT，
    # 缺列时报 "table topics has no column named source_type"，整批落库全失败。
    for col, decl in [
            ("source_type", "TEXT"), ("material_facts", "TEXT"),
            ("material_missing", "TEXT"), ("public_theme", "TEXT"),
            ("topic_role", "TEXT"),
            ("reader_why_click", "TEXT"), ("reader_what_get", "TEXT"),
            ("reader_why_share", "TEXT"),
            ("score_emotion", "INTEGER"), ("score_difference", "INTEGER"),
            ("score_audience", "INTEGER"), ("score_window", "INTEGER"),
            ("structure_type", "TEXT"), ("source_url", "TEXT"),
            ("source_platform", "TEXT")]:
        _add_column_if_missing(conn, "topics", col, decl)
    _migrate_source_key_with_date(conn)
    _migrate_track_to_genre(conn)
    # 2026-11-13：设置项归属工作台，生图台只看自己的那几项
    _add_column_if_missing(conn, "settings", "group_key", "TEXT")
    conn.commit()


# 历史 track 值 → 现行 8 赛道 的映射（幂等）。
# 两段历史：
#   1) 2026-10-09 前，track 存的是 config.yaml 的 article_category（账号定位「社会文化观察」），
#      于是 route_writing 拿它去匹配 B 类关键词永远匹配不上，所有题材都落到默认 A 类。
#   2) 2026-10-09 当天，临时用过 6 类词表（社会与文化 / 体育 / 商业与消费）。
# 现行词表 8 类，由平台分类体系的 43 个分类归并而来。
TRACK_FIX = {
    # 账号定位值
    "社会文化观察": "社会民生",
    # 6 类旧词表 → 8 类新词表
    "社会与文化": "文化与生活",
    "社会文化": "文化与生活",
    "常青": "文化与生活",
    "体育": "体育与健康",
    "商业与消费": "财经与商业",
    # 更早的赛道关键词写法
    "爆款流量": "AI 与科技",
    "AI工具": "AI 与科技",
    "效率": "AI 与科技",
    "娱乐": "娱乐与情感",
    "情感": "娱乐与情感",
    "八卦": "娱乐与情感",
}


def _migrate_track_to_genre(conn):
    """把 track 里残留的「账号定位」值换成「题材」值。幂等。"""
    changed = 0
    for table in ("topic_jobs", "topics", "drafts"):
        for old, new in TRACK_FIX.items():
            cur = conn.execute(f"UPDATE {table} SET track=? WHERE track=?", (new, old))
            changed += cur.rowcount or 0
    if changed:
        print(f"workbench-db: track 改为题材值 {changed} 处"
              f"（原存账号定位，会让写作技能路由永远走默认）", file=sys.stderr)
    return changed


def _migrate_source_key_with_date(conn):
    """老 source_key 是「平台#排名」，**没有日期** → 不同天的同一排名会串号。

    症状（2026-10-08 用户发现）：素材库今天的第 1 条显示「已出选题」——
    因为 10-05 的第 1 条出过选题，两者 key 都是 `今日头条#1`，状态被共用，
    按钮甚至被禁用，当天素材进不了选题库。

    修法：补成 `平台@日期#排名`（日期取 topic_jobs.material_date）。
    幂等：已含 `@` 的跳过。topics 表跟着改，保持与 jobs 的关联。
    """
    rows = [r for r in conn.execute(
        "SELECT id, source_key, material_date FROM topic_jobs "
        "WHERE source_key IS NOT NULL AND source_key NOT LIKE '%@%'")]
    mapping = {}
    for r in rows:
        sk, d = r["source_key"], r["material_date"]
        if not sk or not d or "#" not in sk:
            continue
        platform, _, rank = sk.rpartition("#")
        new = f"{platform}@{d}#{rank}"
        exists = conn.execute("SELECT 1 FROM topic_jobs WHERE source_key=?", (new,)).fetchone()
        if exists:
            continue                       # 已有同日同排名的记录，跳过避免撞 UNIQUE
        conn.execute("UPDATE topic_jobs SET source_key=? WHERE id=?", (new, r["id"]))
        mapping[sk] = new
    for old, new in mapping.items():
        conn.execute("UPDATE topics SET source_key=? WHERE source_key=?", (new, old))
    if mapping:
        print(f"workbench-db: source_key 补日期 {len(mapping)} 处"
              f"（把不同天的同排名区分开）", file=sys.stderr)
    return len(mapping)


def now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def cmd_init(args):
    conn = connect()
    ensure_schema(conn)
    conn.commit()
    seeded = seed_styles(conn)
    backfilled = backfill_seed_styles(conn)
    tables = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    print(f"数据库就绪：{DB_PATH}")
    print(f"  表：{', '.join(tables)}")
    if seeded:
        print(f"  内置风格：新插入 {seeded} 条")
    if backfilled:
        print(f"  内置风格：补齐三层字段 {backfilled} 条")
    conn.close()


def cmd_import_hot(args):
    """从素材归档里把某天某平台的热点导入选题库（等价于界面上的【入选题库】）。"""
    if not os.path.exists(MATERIALS_PATH):
        print("缺少素材归档，先跑 tools/gen-materials.py")
        return 1
    arch = json.load(io.open(MATERIALS_PATH, encoding="utf-8"))
    day = args.date or arch.get("today")
    rows = (arch.get("byDate") or {}).get(day, [])
    if not rows:
        print(f"{day} 没有素材记录；可选日期：{', '.join(arch.get('dates', []))}")
        return 1
    pool = [r for r in rows if (not args.platform or r["platform"] == args.platform)]
    if args.limit:
        pool = pool[:args.limit]
    conn = connect()
    ensure_schema(conn)
    added = skipped = 0
    for r in pool:
        key = r.get("key") or f"{r['platform']}#{r['rank']}"
        try:
            conn.execute(
                """INSERT INTO topic_jobs
                     (source_key, title, platform, hot, url, material_date, status, note, created_at)
                   VALUES (?,?,?,?,?,?, 'pending', ?, ?)""",
                (key, r["title"], r["platform"], r.get("hot") or "", r.get("url") or "",
                 r.get("date") or day, f"来自{day} {r['platform']} 热榜", now()))
            added += 1
        except sqlite3.IntegrityError:
            skipped += 1
    conn.commit()
    conn.close()
    print(f"导入 {day} / {args.platform or '全平台'}"
          + (f" / 前 {args.limit} 条" if args.limit else "")
          + f"：新增 {added} 条，跳过重复 {skipped} 条")
    return 0


def cmd_add_topic(args):
    conn = connect()
    ensure_schema(conn)
    conn.execute(
        """INSERT INTO topics (title, track, skill, persona, kind, angle, best_title, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (args.title, getattr(args, "track", "") or "", getattr(args, "skill", "") or "",
         getattr(args, "persona", "") or "", getattr(args, "kind", "") or "",
         getattr(args, "angle", "") or "", getattr(args, "best_title", "") or "",
         args.status, now()))
    conn.commit()
    rid = conn.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]
    conn.close()
    print(f"已加入选题库：id={rid}  {args.title}")
    return 0


# 选题列表带来源：LEFT JOIN topic_jobs 取出来源热点标题/平台/热度/日期。
# source_key 在 topic_jobs 里是 UNIQUE，所以不会放大行数。
TOPIC_SELECT = """
SELECT t.*,
       j.title         AS source_title,
       j.platform      AS source_platform,
       j.hot           AS source_hot,
       j.material_date AS source_date,
       j.url           AS source_url
FROM topics t
LEFT JOIN topic_jobs j ON j.source_key = t.source_key
"""


def cmd_list_topics(args):
    conn = connect()
    ensure_schema(conn)
    sql = TOPIC_SELECT
    params = []
    if args.status:
        sql += " WHERE t.status=?"
        params.append(args.status)
    sql += " ORDER BY t.id DESC"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    if not rows:
        print("（选题库为空）")
        return 0
    print(f"{'id':>4} {'状态':<10} {'类型':<6} {'角色':<12} 方案名")
    for r in rows:
        print(f"{r['id']:>4} {r['status']:<10} {(r['kind'] or '-'):<6} "
              f"{(r['persona'] or '-')[:10]:<12} {r['title'][:34]}")
        src = r["source_title"] or "（无来源）"
        plat = r["source_platform"] or "-"
        print(f"       来源[{plat}] {src[:44]}"
              + (f"   首选：{r['best_title'][:22]}" if r["best_title"] else ""))
    print(f"共 {len(rows)} 条")
    return 0


def cmd_list_jobs(args):
    conn = connect()
    ensure_schema(conn)
    sql = "SELECT * FROM topic_jobs"
    params = []
    if args.status:
        sql += " WHERE status=?"
        params.append(args.status)
    sql += " ORDER BY id DESC"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    if not rows:
        print("（待分析队列为空）")
        return 0
    print(f"{'id':>4} {'状态':<9} {'平台':<8} 热点标题")
    for r in rows:
        print(f"{r['id']:>4} {r['status']:<9} {(r['platform'] or '-'):<8} {r['title'][:44]}")
    print(f"共 {len(rows)} 条")
    return 0


def cmd_set_topic(args):
    conn = connect()
    conn.execute("UPDATE topics SET status=?, updated_at=? WHERE id=?",
                 (args.status, now(), args.id))
    conn.commit()
    n = conn.total_changes
    conn.close()
    print(f"已更新 {n} 条：id={args.id} → {args.status}")
    return 0 if n else 1


def cmd_add_draft(args):
    conn = connect()
    ensure_schema(conn)
    conn.execute(
        """INSERT INTO drafts (topic_id, title, skill, track, path, word_count, status, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (args.topic_id, args.title, args.skill or "", args.track or "",
         args.path or "", args.words or None, args.status, now()))
    conn.commit()
    rid = conn.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]
    if args.topic_id:
        conn.execute("UPDATE topics SET status='writing', updated_at=? WHERE id=?",
                     (now(), args.topic_id))
        conn.commit()
    conn.close()
    print(f"已建草稿：id={rid}  {args.title}")
    return 0


DRAFT_SELECT = """
SELECT d.*, t.title AS topic_title, t.source_key AS topic_source_key,
       j.title AS source_title, j.platform AS source_platform,
       -- 与发布管理同一套回退：草稿多数没挂采集素材，
       -- 只认 j.title 会让「来源」列大面积空白。
       COALESCE(NULLIF(j.title, ''), NULLIF(t.title, ''), NULLIF(d.theme, '')) AS source_display,
       CASE
         WHEN NULLIF(j.title, '') IS NOT NULL THEN 'material'
         WHEN NULLIF(t.title, '') IS NOT NULL THEN 'topic'
         WHEN NULLIF(d.theme, '') IS NOT NULL THEN 'theme'
         ELSE ''
       END AS source_kind
FROM drafts d
LEFT JOIN topics t ON t.id = d.topic_id
LEFT JOIN topic_jobs j ON j.source_key = t.source_key
"""


def cmd_list_drafts(args):
    conn = connect()
    ensure_schema(conn)
    sql = DRAFT_SELECT
    params = []
    if getattr(args, "status", None):
        sql += " WHERE d.status=?"
        params.append(args.status)
    sql += " ORDER BY d.id DESC"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    if not rows:
        print("（创作库为空）")
        return 0
    print(f"{'id':>4} {'状态':<11} {'类别':<5} {'字数':>6} 标题")
    for r in rows:
        print(f"{r['id']:>4} {r['status']:<11} {(r['skill_class'] or '-'):<5} "
              f"{(r['word_count'] or 0):>6} {(r['title'] or '')[:36]}")
        print(f"       技能 {r['skill'] or '-'}  ｜ 来源 {(r['source_title'] or '（无）')[:32]}"
              + (f"  ｜ {r['path']}" if r["path"] else ""))
    print(f"共 {len(rows)} 条")
    return 0


def cmd_add_publish(args):
    conn = connect()
    ensure_schema(conn)
    conn.execute(
        """INSERT INTO publishes (draft_id, channel, account, method, wechat_media_id, status, note, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (args.draft_id, args.channel, args.account or "", args.method,
         getattr(args, "media_id", "") or "", args.status, args.note or "", now()))
    conn.commit()
    rid = conn.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]
    conn.close()
    print(f"已建发布记录：id={rid}  draft={args.draft_id}  方式={args.method}  状态={args.status}")
    return 0


PUBLISH_SELECT = """
SELECT p.*,
       d.title  AS draft_title,
       d.theme  AS draft_theme,
       d.track  AS track,
       d.skill  AS skill,
       t.source_key AS topic_source_key,
       t.title      AS topic_title,
       j.title      AS job_title,
       j.platform   AS source_platform,
       -- 三级回退：采集素材 > 选题标题 > 草稿主题。
       -- 大部分选题由 Agent 直接产出，没有对应 topic_jobs，
       -- 只 join 素材表会导致「来源」大面积空白。
       COALESCE(NULLIF(j.title, ''), NULLIF(t.title, ''), NULLIF(d.theme, '')) AS source_title,
       CASE
         WHEN NULLIF(j.title, '')  IS NOT NULL THEN 'material'
         WHEN NULLIF(t.title, '')  IS NOT NULL THEN 'topic'
         WHEN NULLIF(d.theme, '')  IS NOT NULL THEN 'theme'
         ELSE ''
       END AS source_kind,
       t.public_theme AS source_public_theme
FROM publishes p
LEFT JOIN drafts d ON d.id = p.draft_id
LEFT JOIN topics t ON t.id = d.topic_id
LEFT JOIN topic_jobs j ON j.source_key = t.source_key
"""


def cmd_list_publishes(args):
    conn = connect()
    ensure_schema(conn)
    rows = conn.execute(PUBLISH_SELECT + " ORDER BY p.id DESC").fetchall()
    conn.close()
    if not rows:
        print("（发布管理为空）")
        return 0
    print(f"{'id':>4} {'状态':<11} {'方式':<9} {'账号':<8} 标题")
    for r in rows:
        print(f"{r['id']:>4} {r['status']:<11} {r['method']:<9} {(r['account'] or '-'):<8} "
              f"{(r['draft_title'] or '')[:36]}")
        print(f"       来源 {(r['source_title'] or '（无）')[:34]}  ｜ {r['created_at']}"
              + (f"  ｜ media {r['wechat_media_id'][:18]}…" if r["wechat_media_id"] else ""))
    print(f"共 {len(rows)} 条")
    return 0


def cmd_export(args):
    """把三张表导成 UI 快照。服务器 API 做好前，这是界面看到真实数据的桥。"""
    conn = connect()
    ensure_schema(conn)
    topics = [dict(r) for r in conn.execute("SELECT * FROM topics ORDER BY id DESC")]
    drafts = [dict(r) for r in conn.execute("SELECT * FROM drafts ORDER BY id DESC")]
    publishes = [dict(r) for r in conn.execute("SELECT * FROM publishes ORDER BY id DESC")]
    conn.close()
    payload = {
        "dbPath": DB_PATH,
        "exportedAt": now(),
        "counts": {"topics": len(topics), "drafts": len(drafts), "publishes": len(publishes)},
        "topics": topics,
        "drafts": drafts,
        "publishes": publishes,
    }
    io.open(EXPORT_PATH, "w", encoding="utf-8", newline="\n").write(
        json.dumps(payload, ensure_ascii=False, indent=1))
    print(f"UI 快照导出：{os.path.relpath(EXPORT_PATH, PLUGIN)}  "
          f"选题 {len(topics)} / 创作 {len(drafts)} / 发布 {len(publishes)}")
    return 0


def cmd_api(args):
    """给 node 半用的 JSON 入口：stdin 读一个请求，stdout 写一个响应。

    请求：{"op": "list-topics"}
          {"op": "add-topic", "title": "...", "platform": "...", ...}
    响应：{"ok": true, "topics": [...]}  /  {"ok": false, "error": "..."}
    """
    raw = ""
    if getattr(args, "payload", None):
        import base64
        try:
            raw = base64.b64decode(args.payload).decode("utf-8")
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"bad payload: {e}"}))
            return 1
    else:
        raw = sys.stdin.read() or "{}"
    try:
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad json: {e}"}))
        return 1

    op = req.get("op")
    conn = connect()
    try:
        ensure_schema(conn)
        if op == "list-topics":
            status = req.get("status")
            sql = TOPIC_SELECT
            params = []
            if status:
                sql += " WHERE t.status=?"
                params.append(status)
            sql += " ORDER BY t.id DESC"
            out = {"ok": True, "topics": [dict(r) for r in conn.execute(sql, params)]}
        elif op == "enqueue-job":
            # 素材库点【入选题库】→ 进待分析队列（两段式的第一段）
            title = (req.get("title") or "").strip()
            if not title:
                out = {"ok": False, "error": "title required"}
            else:
                key = req.get("sourceKey")
                preset = req.get("preset") or {}
                try:
                    conn.execute(
                        """INSERT INTO topic_jobs
                             (source_key, title, platform, hot, url, material_date, track,
                              preset_json, status, note, created_at)
                           VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)""",
                        (key, title, req.get("platform") or "", req.get("hot") or "",
                         req.get("url") or "", req.get("materialDate") or "",
                         req.get("track") or "",
                         json.dumps(preset, ensure_ascii=False) if preset else None,
                         req.get("note") or "", now()))
                    conn.commit()
                    out = {"ok": True, "id": conn.execute(
                        "SELECT last_insert_rowid() AS i").fetchone()["i"],
                        "queued": True}
                except sqlite3.IntegrityError:
                    # 已存在：如果还没分析（pending），就用新的预设覆盖——
                    # 否则用户重新点一次改参数会被静默丢弃。
                    exist = conn.execute(
                        "SELECT id, status FROM topic_jobs WHERE source_key=?", (key,)).fetchone()
                    if exist is not None and exist["status"] == "pending":
                        conn.execute(
                            """UPDATE topic_jobs
                                  SET title=?, preset_json=?, track=?, note=?, updated_at=?
                                WHERE id=?""",
                            (title,
                             json.dumps(preset, ensure_ascii=False) if preset else None,
                             req.get("track") or "", req.get("note") or "",
                             now(), exist["id"]))
                        conn.commit()
                        out = {"ok": True, "id": exist["id"], "updated": True,
                               "note": "这条已在队列里，预设已更新"}
                    else:
                        out = {"ok": True, "duplicate": True,
                               "id": exist["id"] if exist else None,
                               "status": exist["status"] if exist else None,
                               "note": "这条已经分析过了，不再重复入队"}
        elif op == "list-jobs":
            status = req.get("status")
            sql = "SELECT * FROM topic_jobs"
            params = []
            if status:
                sql += " WHERE status=?"
                params.append(status)
            sql += " ORDER BY id DESC"
            out = {"ok": True, "jobs": [dict(r) for r in conn.execute(sql, params)]}
        elif op == "take-job":
            # 取一条待分析任务。给 id 就精确取那条（用户在界面上点的那条），否则 FIFO。
            jid = req.get("id")
            if jid:
                row = conn.execute(
                    "SELECT * FROM topic_jobs WHERE id=? AND status='pending'", (jid,)).fetchone()
            else:
                row = conn.execute(
                    "SELECT * FROM topic_jobs WHERE status='pending' ORDER BY id LIMIT 1").fetchone()
            if row is None:
                out = {"ok": True, "job": None}
            else:
                conn.execute("UPDATE topic_jobs SET status='running', updated_at=? WHERE id=?",
                             (now(), row["id"]))
                conn.commit()
                out = {"ok": True, "job": dict(row)}
        elif op == "fail-job":
            conn.execute("UPDATE topic_jobs SET status='failed', error=?, updated_at=? WHERE id=?",
                         (req.get("error") or "", now(), req.get("id")))
            conn.commit()
            out = {"ok": True}
        elif op == "save-plans":
            # Agent 跑完选题 skill → 回写方案（一个 job 可多个），并把 job 标 done
            job_id = req.get("jobId")
            plans = req.get("plans") or []
            if not plans:
                out = {"ok": False, "error": "plans required"}
            else:
                # source_key 以 job 表为准，不看调用方传的——否则传错就断了来源关联
                src_key = req.get("sourceKey")
                job_row = None
                if job_id:
                    job_row = conn.execute(
                        "SELECT * FROM topic_jobs WHERE id=?", (job_id,)).fetchone()
                    if job_row is not None:
                        src_key = job_row["source_key"]
                if not src_key:
                    out = {"ok": False,
                           "error": f"无法确定来源：job #{job_id} 不存在，且没传 sourceKey"}
                    conn.close()
                    print(json.dumps(out, ensure_ascii=False))
                    return 1
                ids = []
                for p in plans:
                    conn.execute(
                        """INSERT INTO topics
                             (job_id, source_key, title, track, skill, persona, kind, angle, hook, payoff,
                              titles_json, best_title, digests_json, outline_json, word_count, effort,
                              needs_material, viewpoint, status, created_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'candidate', ?)""",
                        (job_id, src_key, p.get("title") or "（未命名）",
                         p.get("track") or "", p.get("skill") or "", p.get("persona") or "",
                         p.get("kind") or "", p.get("angle") or "", p.get("hook") or "",
                         p.get("payoff") or "",
                         json.dumps(p.get("titles") or [], ensure_ascii=False),
                         p.get("bestTitle") or "",
                         json.dumps(p.get("digests") or [], ensure_ascii=False),
                         json.dumps(p.get("outline") or [], ensure_ascii=False),
                         p.get("wordCount"), p.get("effort") or "",
                         1 if p.get("needsMaterial") else 0,
                         p.get("viewpoint") or req.get("viewpoint") or "", now()))
                    ids.append(conn.execute("SELECT last_insert_rowid() AS i").fetchone()["i"])
                if job_id:
                    conn.execute("UPDATE topic_jobs SET status='done', skill=?, updated_at=? WHERE id=?",
                                 (req.get("skill") or "", now(), job_id))
                conn.commit()
                out = {"ok": True, "ids": ids, "count": len(ids)}
        elif op == "add-topic":
            title = (req.get("title") or "").strip()
            if not title:
                out = {"ok": False, "error": "title required"}
            else:
                try:
                    conn.execute(
                        """INSERT INTO topics (title, track, skill, persona, kind, angle,
                                               best_title, status, created_at)
                           VALUES (?,?,?,?,?,?,?,?,?)""",
                        (title, req.get("track") or "", req.get("skill") or "",
                         req.get("persona") or "", req.get("kind") or "",
                         req.get("angle") or "", req.get("bestTitle") or "",
                         req.get("status") or "candidate", now()))
                    conn.commit()
                    out = {"ok": True, "id": conn.execute(
                        "SELECT last_insert_rowid() AS i").fetchone()["i"]}
                except sqlite3.IntegrityError:
                    out = {"ok": False, "error": "duplicate", "duplicate": True}
        elif op == "set-topic":
            conn.execute("UPDATE topics SET status=?, updated_at=? WHERE id=?",
                         (req.get("status"), now(), req.get("id")))
            conn.commit()
            out = {"ok": True}
        elif op == "delete-topic":
            conn.execute("DELETE FROM topics WHERE id=?", (req.get("id"),))
            conn.commit()
            out = {"ok": True}
        elif op == "create-draft":
            # 从选题方案建草稿（选题库点「选为写作」）。写作技能按赛道自动路由。
            topic_id = req.get("topicId")
            topic = None
            if topic_id:
                topic = conn.execute("SELECT * FROM topics WHERE id=?", (topic_id,)).fetchone()
                if topic is None:
                    out = {"ok": False, "error": f"选题方案 #{topic_id} 不存在"}
                    conn.close()
                    print(json.dumps(out, ensure_ascii=False))
                    return 1
            track = req.get("track") or (topic["track"] if topic else "") or ""
            title = req.get("title") or (topic["best_title"] if topic else "") \
                or (topic["title"] if topic else "") or "（未命名）"
            viewpoint = req.get("viewpoint") or (topic["viewpoint"] if topic else "") or ""
            digest = req.get("digest") or ""
            if not digest and topic is not None:
                ds = json.loads(topic["digests_json"] or "[]")
                if ds:
                    digest = ds[0] if isinstance(ds[0], str) else ds[0].get("text", "")
            skill = req.get("skill") or ""
            klass = req.get("skillClass") or ""
            if not skill:
                skill, klass = route_writing(track)
            theme = req.get("theme") or ""
            materials = req.get("materials") or ""
            # ── 从选题组装完整素材（2026-11-08 加）──
            # 以前只存 req 里的 materials，选题加工拆出的素材事实、缺口、
            # 读者三问、公共命题、结构类型全部丢失，Agent 拿到空素材只能编。
            if topic is not None and not materials:
                _parts = []
                try:
                    _facts = json.loads(topic["material_facts"] or "[]")
                except Exception:
                    _facts = []
                if _facts:
                    _parts.append("【素材事实】（逐条列出，写作时只能用这些，不许新增数字）\n"
                                  + "\n".join("- " + str(x) for x in _facts))
                try:
                    _miss = json.loads(topic["material_missing"] or "[]")
                except Exception:
                    _miss = []
                if _miss:
                    _parts.append("【素材缺口】（报道没给的信息，写作时避开或明说「报道未提」）\n"
                                  + "\n".join("- " + str(x) for x in _miss))
                if digest:
                    _parts.append("【摘要】" + digest)
                _col = {}
                try:
                    _col = {k: topic[k] for k in topic.keys()}
                except Exception:
                    _col = {}
                if _col.get("public_theme"):
                    _parts.append("【公共命题】" + _col["public_theme"])
                if _col.get("topic_role"):
                    _parts.append("【选题方向】" + _col["topic_role"])
                if _col.get("reader_why_click"):
                    _parts.append("【读者为什么点】" + _col["reader_why_click"])
                if _col.get("reader_what_get"):
                    _parts.append("【读完得到什么】" + _col["reader_what_get"])
                if _col.get("reader_why_share"):
                    _parts.append("【为什么会转发】" + _col["reader_why_share"])
                materials = "\n\n".join(_parts)
            requirement = req.get("requirement") or ""
            # 核心角度优先取选题的公共命题（它是可验证的命题，viewpoint 常为空）
            if topic is not None and not requirement:
                try:
                    requirement = (topic["public_theme"] or "") or requirement
                except Exception:
                    pass
            # config_json 只存结构化配置，正文类字段（theme/materials/requirement）单独存，
            # 否则前端要解析 JSON 才能显示，出错时整块配置都读不出来。
            cfg = req.get("config") or {}
            if not isinstance(cfg, dict):
                cfg = {}
            config_json = json.dumps(cfg, ensure_ascii=False) if cfg else ""
            conn.execute(
                """INSERT INTO drafts (topic_id, title, digest, viewpoint, track, skill, skill_class,
                                       theme, materials, requirement, config_json,
                                       status, started_at, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?, 'queued', ?, ?)""",
                (topic_id, title, digest, viewpoint, track, skill, klass,
                 theme, materials, requirement, config_json, now(), now()))
            rid = conn.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]
            if topic_id:
                conn.execute("UPDATE topics SET status='writing', updated_at=? WHERE id=?",
                             (now(), topic_id))
            conn.commit()
            out = {"ok": True, "id": rid, "skill": skill, "skillClass": klass,
                   "title": title, "track": track, "theme": theme}
        elif op == "get-settings":
            # 密钥类只回打码值：界面只需要知道「配没配」，不需要明文。
            grp = (req.get("group") or "").strip()

            # 个别 channel 类型字段的下拉选项和生图那两个不一样，这里按 key 指定。
            # 文本模型通道要「DSH / OpenAI 兼容」，不能套生图的「GRS AI / OpenAI 兼容」。
            # 2026-11-16 移除 dsh 通道：它返回带 reasoning 的无结构内容，
            # 要在 node 侧额外过滤才能用，链路长、故障点多。统一走 OpenAI 兼容 API。
            CHANNEL_OPTIONS = {
                "textModel": [
                    {"value": "openai", "label": "OpenAI 兼容（第三方服务）"},
                ],
            }
            if grp:
                rows = conn.execute(
                    "SELECT key, value, kind, label, hint, group_key, updated_at FROM settings "
                    "WHERE group_key=? ORDER BY key", (grp,)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT key, value, kind, label, hint, group_key, updated_at FROM settings ORDER BY key"
                ).fetchall()
            items = []
            for r in rows:
                v = r["value"] or ""
                if r["kind"] == "secret":
                    shown = (v[:6] + "…" + v[-4:]) if len(v) > 12 else ("已配置" if v else "")
                    items.append({"key": r["key"], "kind": r["kind"], "label": r["label"],
                                  "hint": r["hint"], "group": r["group_key"] or "",
                                  "options": CHANNEL_OPTIONS.get(r["key"]),
                                  "hasValue": bool(v),
                                  "masked": shown, "updatedAt": r["updated_at"]})
                else:
                    items.append({"key": r["key"], "kind": r["kind"], "label": r["label"],
                                  "hint": r["hint"], "group": r["group_key"] or "",
                                  "options": CHANNEL_OPTIONS.get(r["key"]),
                                  "hasValue": bool(v),
                                  "value": v, "updatedAt": r["updated_at"]})
            out = {"ok": True, "settings": items}
        elif op == "set-settings":
            # 批量写。**空值跳过不覆盖**（界面上「没填」不等于「要清空」）。
            patch = req.get("values") or {}
            n, skipped = 0, []
            for k, v in patch.items():
                row = conn.execute("SELECT key FROM settings WHERE key=?", (k,)).fetchone()
                if not row:
                    continue
                sv = str(v).strip()
                if sv == "":
                    skipped.append(k)
                    continue
                if sv == "__CLEAR__":
                    sv = ""
                conn.execute("UPDATE settings SET value=?, updated_at=? WHERE key=?",
                             (sv, now(), k))
                n += 1
            conn.commit()
            # 密钥要同步回 aws.env：publish.py / image-gen.py 读的是文件，不是数据库。
            synced = _sync_env_file(conn, patch)
            out = {"ok": True, "updated": n, "skipped": skipped, "envSynced": synced}
        elif op == "reset-draft":
            # 重新生成前的重置：清产出、退回 queued。
            # 保留配置（主题/素材/观点/技能/风格），只清「写出来的东西」。
            #
            # 为什么要 copy 而不是 move：
            #   move 之后如果 Agent 那边失败，稿子只剩 _prev 里那一份，
            #   用户看到的是空目录。copy 保留完整快照，随时能整目录还原。
            did = req.get("id")
            if not did:
                out = {"ok": False, "error": "id required"}
            else:
                row = conn.execute(
                    "SELECT id, status, path, config_json FROM drafts WHERE id=?",
                    (did,)).fetchone()
                if not row:
                    out = {"ok": False, "error": f"草稿 #{did} 不存在"}
                else:
                    saved, prev_rel, prev_name = [], "", ""
                    abort = False
                    dpath = (row["path"] or "").strip()
                    if dpath:
                        import os as _os, shutil as _shutil, time as _time
                        src = _os.path.join(WORKSPACE, dpath)
                        if _os.path.isdir(src):
                            stamp = _time.strftime("%Y%m%d-%H%M%S")
                            dst = _os.path.join(src, "_prev", stamp)
                            _os.makedirs(dst, exist_ok=True)
                            # ① 先整份复制（不删原件）
                            for name in ("draft.md", "draft-stripped.md",
                                         "article.md", "article.html",
                                         "draft.md.bak", "cover.png"):
                                f = _os.path.join(src, name)
                                if _os.path.isfile(f):
                                    try:
                                        _shutil.copy2(f, _os.path.join(dst, name))
                                        saved.append(name)
                                    except Exception:
                                        pass
                            imgs = _os.path.join(src, "imgs")
                            if _os.path.isdir(imgs):
                                try:
                                    _shutil.copytree(imgs, _os.path.join(dst, "imgs"),
                                                     dirs_exist_ok=True)
                                    saved.append("imgs/")
                                except Exception:
                                    pass
                            prev_rel = dpath + "_prev/" + stamp
                            prev_name = stamp
                            # ② 不删，改成改名归档在目录里。
                            #    draft.old.md 不是 Agent 认的正文名，所以不会被读到；
                            #    但文件还在，任何失败都能手工捞回来。
                            if "draft.md" in saved:
                                for name in ("draft-stripped.md", "article.md",
                                             "article.html", "draft.md.bak", "cover.png"):
                                    f = _os.path.join(src, name)
                                    if _os.path.isfile(f):
                                        try:
                                            _os.remove(f)
                                        except Exception:
                                            pass
                                old_md = _os.path.join(src, "draft.md")
                                bak_md = _os.path.join(src, "draft.old.md")
                                if _os.path.isfile(old_md):
                                    try:
                                        if _os.path.isfile(bak_md):
                                            _os.remove(bak_md)
                                        _os.rename(old_md, bak_md)
                                    except Exception:
                                        pass
                                imgs = _os.path.join(src, "imgs")
                                if _os.path.isdir(imgs):
                                    try:
                                        _shutil.move(imgs, _os.path.join(dst, "imgs"))
                                    except Exception:
                                        pass
                            else:
                                # 备份没成功就整个放弃，别动原件
                                out = {"ok": False,
                                       "error": "备份旧稿失败，已取消重置（原稿未动）"}
                                try:
                                    _os.rmdir(dst)
                                except Exception:
                                    pass
                                conn.rollback()
                                abort = True

                    # ③ 把 prev 位置写进 config_json，供回滚用
                    cfg = {}
                    try:
                        import json as _json
                        cfg = _json.loads(row["config_json"] or "{}")
                    except Exception:
                        cfg = {}
                    if abort:
                        pass    # out 已在上面设成失败，不动库也不动状态
                    else:
                        if prev_rel:
                            cfg["prevDir"] = prev_rel
                            cfg["prevAt"] = prev_name

                        conn.execute(
                            """UPDATE drafts SET
                                 status='queued', word_count=NULL, digest=NULL,
                                 cover=NULL, images_count=0, review_issues=0,
                                 started_at=NULL, updated_at=?, config_json=?
                               WHERE id=?""",
                            (now(), json.dumps(cfg, ensure_ascii=False), did))
                        conn.commit()
                        out = {"ok": True, "id": did, "from": row["status"],
                               "to": "queued", "backedUp": saved, "prevDir": prev_rel}

        elif op == "restore-prev":
            # 回滚：把 _prev 里最近一次快照整个还原回来。
            # 用途：重新生成时 Agent 挂了、或者用户后悔了。
            did = req.get("id")
            snap = req.get("stamp")   # 可选，不传就用 config_json 里记的
            if not did:
                out = {"ok": False, "error": "id required"}
            else:
                row = conn.execute(
                    "SELECT id, path, config_json FROM drafts WHERE id=?", (did,)).fetchone()
                if not row:
                    out = {"ok": False, "error": f"草稿 #{did} 不存在"}
                else:
                    dpath = (row["path"] or "").strip()
                    cfg = {}
                    try:
                        cfg = json.loads(row["config_json"] or "{}")
                    except Exception:
                        cfg = {}
                    stamp = snap or cfg.get("prevAt") or ""
                    if not dpath or not stamp:
                        out = {"ok": False, "error": "没有可还原的快照"}
                    else:
                        import os as _os, shutil as _shutil
                        src = _os.path.join(WORKSPACE, dpath, "_prev", stamp)
                        dst = _os.path.join(WORKSPACE, dpath)
                        if not _os.path.isdir(src):
                            out = {"ok": False, "error": f"快照不存在：{stamp}"}
                        else:
                            restored = []
                            # 如果当前是改名后的 draft.old.md，先清掉，避免两份并存
                            cur_old = _os.path.join(dst, "draft.old.md")
                            if _os.path.isfile(cur_old):
                                try:
                                    _os.remove(cur_old)
                                except Exception:
                                    pass
                            for name in ("draft.md", "draft-stripped.md",
                                         "article.md", "article.html",
                                         "draft.md.bak", "cover.png"):
                                f = _os.path.join(src, name)
                                if _os.path.isfile(f):
                                    try:
                                        _shutil.copy2(f, _os.path.join(dst, name))
                                        restored.append(name)
                                    except Exception:
                                        pass
                            simgs = _os.path.join(src, "imgs")
                            if _os.path.isdir(simgs):
                                try:
                                    _shutil.copytree(simgs, _os.path.join(dst, "imgs"),
                                                     dirs_exist_ok=True)
                                    restored.append("imgs/")
                                except Exception:
                                    pass
                            out = {"ok": True, "id": did, "stamp": stamp,
                                   "restored": restored}

        elif op == "set-draft":
            # 回写草稿：状态推进、正文完成、封面、审稿结果…都走这里
            colmap = {"words": "word_count", "imagesCount": "images_count",
                      "reviewIssues": "review_issues", "skillClass": "skill_class",
                      "configJson": "config_json"}
            fields, params = [], []
            # theme / materials / requirement / configJson：待写草稿允许改配置，
            # 改了之后重新点「开始创作」即可按新配置写，不必删了重建。
            for k in ("title", "digest", "viewpoint", "track", "skill", "skillClass",
                      "status", "words", "path", "cover", "imagesCount", "reviewIssues",
                      "theme", "materials", "requirement", "configJson"):
                if k in req and req[k] is not None:
                    fields.append(f"{colmap.get(k, k)}=?")
                    params.append(req[k])
            if not fields:
                out = {"ok": False, "error": "没有要更新的字段"}
            else:
                if "status" in req:
                    fields.append("started_at=?")
                    params.append(now())
                fields.append("updated_at=?")
                params.append(now())
                params.append(req.get("id"))
                conn.execute(f"UPDATE drafts SET {', '.join(fields)} WHERE id=?", params)
                conn.commit()
                row = conn.execute("SELECT * FROM drafts WHERE id=?", (req.get("id"),)).fetchone()
                out = {"ok": True, "draft": dict(row) if row else None}
        elif op == "delete-draft":
            conn.execute("DELETE FROM drafts WHERE id=?", (req.get("id"),))
            conn.commit()
            out = {"ok": True}
        elif op == "list-drafts":
            status = req.get("status")
            # 复用模块级常量，别在这里再写一份 SQL ——
            # 写两份的话改了一处另一处不会跟着变（这次来源为空就是这么漏的）。
            sql = DRAFT_SELECT
            params = []
            if status:
                sql += " WHERE d.status=?"
                params.append(status)
            sql += " ORDER BY d.id DESC"
            out = {"ok": True, "drafts": [dict(r) for r in conn.execute(sql, params)]}
        elif op == "list-publishes":
            out = {"ok": True, "publishes": [dict(r) for r in conn.execute(
                PUBLISH_SELECT + " ORDER BY p.id DESC")]}
        # ── 文字风格库 CRUD ─────────────────────────────────────────
        # 风格与写作技能是**两个维度**：skill 决定走哪套硬规则，style 决定同一套规则下
        # 的语气变体。所以草稿侧只把 styleCode 存进 config_json，不新增外键列。
        elif op == "list-styles":
            kind = req.get("kind")
            sql = "SELECT * FROM writing_styles WHERE status='active'"
            params = []
            if kind and kind != "all":
                sql += " AND kind=?"
                params.append(kind)
            sql += (" ORDER BY used_count DESC, upvotes DESC, id ASC")
            out = {"ok": True, "styles": [_style_row(r) for r in conn.execute(sql, params)]}
        elif op == "get-style":
            row = conn.execute("SELECT * FROM writing_styles WHERE code=?",
                               (req.get("code"),)).fetchone()
            out = {"ok": True, "style": _style_row(row) if row else None}
        elif op == "save-style":
            # 新建（无 code）或更新（有 code）。code 一旦生成不再变，草稿靠它引用。
            code = (req.get("code") or "").strip()
            now_s = now()
            payload = {
                "name": (req.get("name") or "").strip(),
                "kind": req.get("kind") or "personal",
                "desc": req.get("desc") or "",
                "track": req.get("track") or "",
                # 2026-11-05 起：整份风格就是一段 Markdown，唯一的真源。
                # 其它列都是元数据（名称/归类/溯源/统计），不再存风格内容。
                "body_md": req.get("bodyMd") or "",
                "source_json": json.dumps(req.get("source") or {}, ensure_ascii=False),
            }
            if not payload["name"]:
                out = {"ok": False, "error": "name required"}
            elif code:
                row = conn.execute("SELECT id FROM writing_styles WHERE code=?", (code,)).fetchone()
                if not row:
                    out = {"ok": False, "error": f"风格 {code} 不存在"}
                else:
                    sets = ", ".join(f"{k}=?" for k in payload)
                    conn.execute(
                        f"UPDATE writing_styles SET {sets}, version=version+1, updated_at=? WHERE code=?",
                        tuple(payload.values()) + (now_s, code))
                    conn.commit()
                    out = {"ok": True, "code": code, "updated": True}
            else:
                # 生成 code：MS-001 递增。取现有最大序号 +1，避免删除后撞号。
                n = 0
                for r in conn.execute("SELECT code FROM writing_styles WHERE code LIKE 'MS-%'"):
                    try:
                        n = max(n, int(str(r["code"]).split("-")[1]))
                    except Exception:
                        pass
                code = f"MS-{n + 1:03d}"
                cols = ", ".join(payload)
                qs = ", ".join("?" * len(payload))
                conn.execute(
                    f"INSERT INTO writing_styles (code, {cols}, created_at) VALUES (?, {qs}, ?)",
                    (code,) + tuple(payload.values()) + (now_s,))
                conn.commit()
                out = {"ok": True, "code": code, "created": True}
        elif op == "delete-style":
            conn.execute("UPDATE writing_styles SET status='archived', updated_at=? WHERE code=?",
                         (now(), req.get("code")))
            conn.commit()
            out = {"ok": True}
        elif op == "vote-style":
            # 点赞/点踩：只做排序信号，不做淘汰判断（淘汰靠 used_count 和人工归档）
            delta = 1 if req.get("up") else -1
            col = "upvotes" if delta > 0 else "downvotes"
            conn.execute(f"UPDATE writing_styles SET {col}={col}+1, updated_at=? WHERE code=?",
                         (now(), req.get("code")))
            conn.commit()
            out = {"ok": True}
        elif op == "use-style":
            conn.execute("UPDATE writing_styles SET used_count=used_count+1, updated_at=? WHERE code=?",
                         (now(), req.get("code")))
            conn.commit()
            out = {"ok": True}
        elif op == "counts":
            out = {"ok": True, "counts": {
                "topics": conn.execute("SELECT COUNT(*) c FROM topics").fetchone()["c"],
                "drafts": conn.execute("SELECT COUNT(*) c FROM drafts").fetchone()["c"],
                "publishes": conn.execute("SELECT COUNT(*) c FROM publishes").fetchone()["c"],
                "jobs_pending": conn.execute(
                    "SELECT COUNT(*) c FROM topic_jobs WHERE status='pending'").fetchone()["c"],
                "jobs_total": conn.execute("SELECT COUNT(*) c FROM topic_jobs").fetchone()["c"],
            }}
        else:
            out = {"ok": False, "error": f"unknown op: {op}"}
    except Exception as e:
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        conn.close()
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


def main():
    ap = argparse.ArgumentParser(description="墨鱼创作工作台 SQLite 数据层")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init").set_defaults(func=cmd_init)

    p = sub.add_parser("import-hot", help="从素材归档导入选题")
    p.add_argument("--date")
    p.add_argument("--platform")
    p.add_argument("--limit", type=int)
    p.set_defaults(func=cmd_import_hot)

    p = sub.add_parser("add-topic")
    p.add_argument("--title", required=True)
    p.add_argument("--track")
    p.add_argument("--skill")
    p.add_argument("--persona")
    p.add_argument("--kind")
    p.add_argument("--angle")
    p.add_argument("--best-title")
    p.add_argument("--status", default="candidate")
    p.set_defaults(func=cmd_add_topic)

    p = sub.add_parser("list-topics")
    p.add_argument("--status")
    p.set_defaults(func=cmd_list_topics)

    p = sub.add_parser("list-jobs", help="待分析队列")
    p.add_argument("--status")
    p.set_defaults(func=cmd_list_jobs)

    p = sub.add_parser("set-topic")
    p.add_argument("--id", type=int, required=True)
    p.add_argument("--status", required=True)
    p.set_defaults(func=cmd_set_topic)

    p = sub.add_parser("add-draft")
    p.add_argument("--topic-id", type=int)
    p.add_argument("--title", required=True)
    p.add_argument("--skill")
    p.add_argument("--track")
    p.add_argument("--path")
    p.add_argument("--words", type=int)
    p.add_argument("--status", default="draft")
    p.set_defaults(func=cmd_add_draft)

    p = sub.add_parser("list-drafts", help="创作库列表")
    p.add_argument("--status")
    p.set_defaults(func=cmd_list_drafts)

    p = sub.add_parser("add-publish")
    p.add_argument("--draft-id", type=int, required=True)
    p.add_argument("--channel", default="wechat")
    p.add_argument("--account")
    p.add_argument("--method", default="draft", choices=["draft", "published"])
    p.add_argument("--media-id", help="微信侧返回的 media_id（草稿或发布凭证）")
    p.add_argument("--status", default="pending")
    p.add_argument("--note")
    p.set_defaults(func=cmd_add_publish)

    sub.add_parser("list-publishes").set_defaults(func=cmd_list_publishes)
    sub.add_parser("export").set_defaults(func=cmd_export)
    p = sub.add_parser("api", help="node 半用的 JSON 入口（stdin 或 --payload，base64）")
    p.add_argument("--payload", help="base64 编码的 JSON 请求")
    p.set_defaults(func=cmd_api)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


# ═══════════════════════════════════════════════════════════
# 密钥双写：settings → aws.env
# ═══════════════════════════════════════════════════════════
# publish.py 和 image-gen.py 是技能脚本，读的是工作区的 aws.env，
# 不读我们的数据库。所以界面保存密钥时必须同时写文件，
# 否则会出现「界面改了不生效」——这个坑踩过一次。

ENV_KEY_MAP = {
    "wechat1AppId": "WECHAT_1_APPID",
    "wechat1AppSecret": "WECHAT_1_APPSECRET",
    "wechat2AppId": "WECHAT_2_APPID",
    "wechat2AppSecret": "WECHAT_2_APPSECRET",
    "wechat3AppId": "WECHAT_3_APPID",
    "wechat3AppSecret": "WECHAT_3_APPSECRET",
    "wechat4AppId": "WECHAT_4_APPID",
    "wechat4AppSecret": "WECHAT_4_APPSECRET",
    "wechat5AppId": "WECHAT_5_APPID",
    "wechat5AppSecret": "WECHAT_5_APPSECRET",
    "imageModelKey": "IMAGE_MODEL_API_KEY",
}


def _sync_env_file(conn, patch):
    """把改动的密钥写回工作区根目录的 aws.env。返回写了几个。"""
    import os as _os
    import re as _re

    targets = {}
    for k in patch:
        env_name = ENV_KEY_MAP.get(k)
        if not env_name:
            continue
        row = conn.execute("SELECT value FROM settings WHERE key=?", (k,)).fetchone()
        if row and (row["value"] or "").strip():
            targets[env_name] = row["value"].strip()

    if not targets:
        return 0

    # WORKSPACE 是模块级常量（脚本顶部已算好），直接用
    path = _os.path.join(WORKSPACE, "aws.env")
    # 文件不存在也要写：新用户机器上 aws.env 本来就没有（敏感文件，不入库）。
    # 早期这里直接 return 0，结果是「界面配好了密钥、settings 表也有值，
    # 但 publish.py / image-gen.py 读的 aws.env 从头到尾没被创建」——
    # 表现为发布时永远报「缺 AppID / AppSecret」，而界面上明明填了。
    if _os.path.isfile(path):
        lines = io.open(path, encoding="utf-8").read().split("\n")
    else:
        lines = []
    seen, out = set(), []
    for ln in lines:
        m = _re.match(r"^(\s*)([A-Z0-9_]+)\s*=", ln)
        if m and m.group(2) in targets:
            name = m.group(2)
            out.append(f"{name}={targets[name]}")
            seen.add(name)
        else:
            out.append(ln)
    for name, val in targets.items():
        if name not in seen:
            out.append(f"{name}={val}")

    io.open(path, "w", encoding="utf-8").write("\n".join(out))
    return len(targets)


if __name__ == "__main__":
    main()
