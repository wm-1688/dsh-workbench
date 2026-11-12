#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""创作工作台 · SQLite 数据层（Agent 侧）

用法：
    python tools/workbench-db.py init
    python tools/workbench-db.py import-hot --date 2026-10-05 --platform 今日头条 --limit 3
    python tools/workbench-db.py add-topic --title "..." [--platform --hot --url --note]
    python tools/workbench-db.py list-topics [--status candidate]
    python tools/workbench-db.py set-topic --id 1 --status selected
    python tools/workbench-db.py add-draft --topic-id 1 --title "..." --skill khazix-writer --track 社会文化观察
    python tools/workbench-db.py list-drafts
    python tools/workbench-db.py add-publish --draft-id 1 --method draft --account 吾墨
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
    _migrate_source_key_with_date(conn)
    _migrate_track_to_genre(conn)
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
       j.title AS source_title, j.platform AS source_platform
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
       d.track  AS track,
       d.skill  AS skill,
       t.source_key AS topic_source_key,
       j.title      AS source_title,
       j.platform   AS source_platform
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
        # 存相对路径：快照会随包分发，不能把作者本机的绝对路径写进去
        "dbPath": os.path.join("workbench", "workbench.db"),
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
            requirement = req.get("requirement") or ""
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
            sql = ("""SELECT d.*, t.title AS topic_title, t.source_key AS topic_source_key,
                             j.title AS source_title, j.platform AS source_platform
                      FROM drafts d
                      LEFT JOIN topics t ON t.id = d.topic_id
                      LEFT JOIN topic_jobs j ON j.source_key = t.source_key""")
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
    ap = argparse.ArgumentParser(description="创作工作台 SQLite 数据层")
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


if __name__ == "__main__":
    main()
