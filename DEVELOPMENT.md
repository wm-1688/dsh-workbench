# dsh-workbench · 开发文档

本文件面向**开发者与维护者**：表结构、路由、文件结构、命令速查、设计取舍与踩坑记录。

> **普通用户请先读 [README.md](./README.md)** —— 那里只有功能、安装、依赖与免责说明。

这里的内容会随代码变化，包含大量实现细节与历史决策。改动代码后请同步本文件，
`tools/check-docs.py` 会把本文档里的声明当断言与代码对账，不一致则构建中止。

---

## 一、已验证的完整链路

```
每日热榜（7 个平台 × 7 天归档）／爆文库（公众号 + 小红书）
   │  点【入选题库】→ 弹窗填预设 → 入队
   ▼
topic_jobs（待分析队列）── 触发 ──▶ Agent 跑选题 skill（按赛道路由）
   │                                    │
   │                                    ▼
   │                              topics（选题方案，一行=一个方案）
   │                                    │  点【选为写作】
   ▼                                    ▼
drafts（创作库）── 触发 ──▶ Agent 按 skill 阶段推进
   queued → draft → polished → reviewed → formatted → illustrated → draftbox → published
            写稿     打磨       审稿        排版        配图        入草稿箱     群发
             │        │          │           │           │
             ▼        ▼          ▼           ▼           ▼
          draft.md  review.md  article.md  article.html  imgs/*.png  + publishes 记录
```

**每一段的产物与验证状态**：

| 阶段 | 产物 | 验证 |
|---|---|---|
| 选题 | `topics` 表 N 个方案 | ✅ 真实跑了 13 个方案 |
| 写稿 | `drafts/…/draft.md` + `write.py check` | ✅ [OK] 硬性项达标 |
| 打磨 | humanizer-zh 改写后的同一文件 | ✅ |
| 审稿 | `review.md`（🔴/🟡/🟢 分级） | ✅ 🔴 0 项 |
| 定稿 | `article.md`（strip-citations 后） | ✅ |
| 排版 | `article.html`（资讯·藏青，全内联样式） | ✅ |
| 配图 | `imgs/cover.png` + 4 张正文图 | ✅ 5 张，含 1 张返工 |
| 发布 | 微信草稿箱 | ✅ 已确认可见 |

---

## 二、架构（三层，各管一件事）

| 层 | 文件 | 职责 |
|---|---|---|
| **client 半** | `lib/client.template.js` → 生成 `lib/client.js` | 界面：五个标签页、弹窗、抽屉、全文阅读。注册 `main` + `sidebar.panellist` 槽位 |
| **node 半** | `lib/index.js` | **带鉴权的 HTTP 路由**（`ctx.connection.fetch.register`）。界面与磁盘之间的桥 |
| **数据层** | `tools/workbench-db.py` | SQLite（9 张业务表）。Agent 直接调，node 半通过 `execFile` 调。4 张公众号 + 4 张生图 + 1 张文字风格库 |

**为什么 SQLite 访问要绕一层 Python**：给 Electron 编译 `better-sqlite3` 会有 ABI 问题；
Python 标准库 `sqlite3` 零依赖。代价是每次调用 ~100ms（桌面工具可接受）。

---

## 三、数据层（SQLite，`<workspace>/workbench/workbench.db`）

| 表 | 作用 | 关键状态机 |
|---|---|---|
| `topic_jobs` | 待分析队列 | `pending → running → done / failed` |
| `topics` | 选题库（**一行 = 一个选题方案**） | `candidate → selected → writing → done / dropped` |
| `drafts` | 创作库 | `queued → draft → polished → reviewed → formatted → illustrated → draftbox → published` |
| `publishes` | 发布动作记录 | `method: draft/published`；`status: pending/uploaded/published/failed` |
| `image_jobs` | 生图任务队列 | `queued → running → done / failed` |
| `image_assets` | 生成物（**一行 = 一张图**） | `arm: text/ref`；`rel_path` 供界面走资源路由 |
| `image_usage` | 生图计费账本 | 按张计次；接口没有配额端点，只能本地记 |
| `image_series` | 漫画流（**一次创作 = 一组分镜**） | `draft → queued → running → done / failed`；分镜是 `image_jobs` 里带 `series_id` 的行 |
| `writing_styles` | **文字风格库**（一行 = 一种语气） | `status: active/archived`；`kind: personal/system/sub`；指标存 `metrics_json`（区间，可机器验收） |

> **`writing_styles` 为什么是独立表**：`drafts.skill` 指的是**写作技能**
> （aws / 卡兹克 / 娱乐套件，决定走哪套硬规则），而「风格」是**同一技能下的语气变体**
> （哄睡体 / 划重点体 / 清单体）。一个草稿 = 一个 skill + 一个 style，两个维度。
> 草稿侧只把 `styleCode` 存进 `config_json`，不新增外键列——风格改名不影响已有草稿。
>
> **指标为什么存 JSON 而不是拆列**：不同风格要测的东西不一样（有的看句长、有的看表格数），
> 拆成固定列必然大量 NULL。区间（`[18,24]`）而不是单值，是因为风格是范围不是点。

`drafts` 表加了 4 个创作配置列（**加列不加表**，
`check-docs.py` 断言的是「9 张业务表」，加表会破闸门）：

| 列 | 内容 |
|---|---|
| `theme` | 创作主题（用户输入原文，不加工） |
| `materials` | 参考素材（粘贴的正文，≤5000 字） |
| `requirement` | 用户要求（观点/风格/角度） |
| `config_json` | 其余结构化配置：`{words, wordKey, styleTab, styleKey}` |

> 为什么 `config_json` 不把 theme/materials 也塞进去：那三段是**正文级原文**，
> 单独存才能直接显示、且某段坏掉不会连累整块配置读不出来。

> `drafts.status` 管**内容进度**，`publishes` 管**发布动作**——两个轴，不要混。
> `draftbox`（已入草稿箱）与 `published`（已群发）必须分开，否则界面会撒谎。

**三个易错点（都踩过）**：

1. **列级迁移**：`CREATE TABLE IF NOT EXISTS` 不会给已有表加列，必须 `ALTER TABLE ADD COLUMN`
   （见 `_add_column_if_missing`）。
2. **外键会被 RENAME 改写**：`ALTER TABLE topics RENAME` 会把 `drafts` 里 `REFERENCES topics(id)`
   一起改成 `topics_legacy`，删表后就悬空。迁移必须包 `PRAGMA legacy_alter_table = ON`。
   （现有库有自动修复逻辑，见 `ensure_schema`）
3. **`source_key` 由数据层自己查**：`save-plans` 只传 `jobId`，不要调用方编 `sourceKey`——
   编错会断掉「方案 → 热点」的来源关联。
4. **`source_key` 必须带日期**，格式是 `平台@日期#排名`（如 `今日头条@2026-10-08#1`）。
   **2026-10-08 踩的坑**：老格式是 `平台#排名`，于是**不同天的同一排名共用一个 key**——
   每日热榜今天的第 1 条显示「已出选题」（因为 10-05 的第 1 条出过选题），
   **按钮被禁用，当天素材根本进不了选题库**。
   生成端在 `gen-materials.py`（三处 `"key"` 都要带 `date`）；
   老数据由 `_migrate_source_key_with_date()` 补日期（幂等，已含 `@` 跳过），
   快照 `materials.snapshot.json` 里的 key 也要同步改写。
5. **`track` 是「赛道」（genre），不是「账号定位」**——两者是**不同的轴**，2026-10-09 才拆开。

   | 轴 | 在哪 | 取值范围 | 影响什么 |
   |---|---|---|---|
   | 账号定位 | `config.yaml` 的 `article_category` | 社会文化观察（全局固定） | 语气、读者预期、审稿尺度 |
   | **赛道** | **`topic_jobs.track` / `topics.track` / `drafts.track`** | 见下方 8 类 | **选哪个选题与写作技能** |

   **原来的错**：`track` 里存的是账号定位（「社会文化观察」），
   而 `route_writing(track)` 拿它去匹配 B 类关键词（娱乐/情感/八卦/…）——**一个都不含**，
   于是**所有赛道都落到默认 A 类，B 类写作技能的分流是从未执行过的死代码**。

   **现在**：入选题库弹窗多了「赛道」下拉，**按来源平台 + 标题关键词预填**（`guessGenre()`）。
   **填入即以此为准**：预填只是建议，用户改了就按用户填的走（已用临时库验证：来源 AI·热点、预填「AI 与科技」、手动改成「娱乐与情感」→ 落库与路由都按手动值走，落到 B 类）；
   `route_writing(赛道)` 决定写作技能；选题指令按赛道路由选题技能。
   老数据由 `_migrate_track_to_genre()` 映射（幂等）。**判据**：
   **赛道词表（8 类，2026-10-09 定）**：由平台分类体系的 **43 个分类归并**而来。
   归并判据有三条：

   1. **覆盖面**：8 类要装得下截图里所有分类，不留大块空白
   2. **路由**：只有「娱乐与情感」和「AI 与科技」会改变技能，其余 6 类走同一套
   3. **热门优先**：低频分类（壁纸头像、宠物、星座命理、文摘…）并入邻近赛道，不单列

   | 赛道 | 收纳的平台分类 | 选题技能 | 写作 |
   |---|---|---|---|
   | **娱乐与情感** | 娱乐、情感、影视、搞笑、星座命理、动漫、美妆时尚 | `select-entertaining-materials` → `develop-entertainment-article-angles` | **B 类** |
   | **AI 与科技** | 科技、AI、数码、开发者、科学、游戏 | `bigpeng-hot-gzh` | **B 类** |
   | 社会民生 | 民生、三农、法律、体制 | `aws-wechat-article-topics` | A 类 |
   | 国际与时事 | 军事国际、资讯热点、媒体 | 同上 | A 类 |
   | 财经与商业 | 财经、商业营销、房产、汽车 | 同上 | A 类 |
   | 文化与生活 | 文化、历史、生活、家居、美食、旅游、摄影、宠物、文摘 | 同上 | A 类 |
   | 体育与健康 | 体育健身、健康养生、医疗、育儿 | 同上 | A 类 |
   | 教育与职场 | 教育、职场、个人成长、文案 | 同上 | **B 类** |

   **写作技能已改为人工手选**（2026-10-25）：上面这套路由表**退化为兜底**——
   只在调用方没传 `skill` 时才生效（老选题兼容、Agent 直接调 `add-draft`）。
   界面上的正路是「创作配置」里手工挑，`skill` 与 `skillClass` 一起传，
   数据层不再按赛道猜。**为什么改**：自动路由把「想用卡兹克写民生」这种情况堵死了，
   而且 B 类技能过不了 A 类的 aws 配额门禁，猜错要到审稿阶段才暴露。

   **写作技能按「写作语法的根本差异」分，不按题材分**（2026-10-11 定）：

   | 写作技能 | 覆盖赛道 | 类 |
   |---|---|---|
   | `write-entertainment-wechat-articles` | 娱乐与情感 | B |
   | `khazix-writer` | AI 与科技、教育与职场 | B |
   | `aws-wechat-article-writing` | 其余 4 类 | A |

   **为什么 7 类里 4 类共用一个写手**：一个号应该只有一个声音。赛道影响的是
   「写什么、从哪个角度写」，不该影响「你是谁」——所以差异化放在**选题技能与大纲**上，
   不放在换写手上。只有写作语法根本不同的（娱乐套件的叙事代入、卡兹克的长文语感）
   才单独配写手。

   **⛔ `skill` 与 `skill_class` 是建草稿那刻写死的**，改了路由表不会自动更新已有草稿。
   所以有一道闸门 `tools/check-drafts.py`（`build.py` 会跑）：

   - `queued`（还没写）不一致 → **报错并中止构建**，因为照旧技能写出来会与赛道不符
   - 已开写的 → 只提示不改：稿件是在旧规则下写的，改了反而与记录不符
   - 修法：`python tools/check-drafts.py --fix`

   > 2026-10-11 实例：把 AI 与科技改挂 khazix-writer 后，界面刚建的 draft #6
   > 仍是 `aws-wechat-article-writing (A)`。闸门抓到并修正。

   > 改 khazix 那次踩过的点：**路由是子串匹配**（`k in track`），
   > 所以加关键词前必须确认它不会命中别的赛道。本次用的 `科技` 只出现在「AI 与科技」，
   > `教育` `职场` 只出现在「教育与职场」——已逐个验证。

   **不用做全部**：8 类里这个号实际只会用前几类，其余留着是为了「库里能筛选」
   和「Agent 知道该往哪个方向找角度」，不是为了逐个覆盖。

   `route_writing('娱乐与情感')` 必须返回 `('write-entertainment-wechat-articles','B')`。

### 创作骨架：七阶段，优先于任何 SKILL.md（2026-11-07）

**三个写作技能的步骤粒度不同，但阶段本质是同一套。**

| 骨架阶段 | aws | 卡兹克 | 娱乐叙事 |
|---|---|---|---|
| ① 准备 | 1-4 步 | 隐含 | 职责边界 |
| ② 吃透素材 | 5 步 | 第一步 | 第一步 |
| ③ 定角度 | **隐含** | 第一步 HKR | 第二、三步 |
| ④ 出骨架 | **隐含** | 结构模板 | 第七步 |
| ⑤ 写正文 | 6 步 | 第三步 | 第四至十步 |
| ⑥ 自检 | 7 步 | 第四步四层 | 第十三步三轮 |
| ⑦ 交付 | 8 步 | 隐含 | 隐含 |

**关键发现**：③定角度、④出骨架在两个技能里是**隐含**的（没写成步骤），
Agent 就跳过了。这是 11-05 / 11-06 两篇需要人工补事实、人工定角度的根因。

**所以由本项目定义唯一骨架，写死在写作指令里，任何 skill 都必须走完。**
skill 只负责第⑤步的语气与结构，不负责流程 —— 即 **skills 适配骨架**，不是反过来。
理由：skills 是外部依赖会更新，骨架是方法论资产应当稳定；适配成本也是单向的。

实现在 lib/client.template.js 的 SKELETON_STAGES + skeletonText()。
每个技能在 WRITING_SKILLS 里登记 covers（自带哪几步），
指令据此只强调它缺的阶段，避免把技能本来做对的事又覆盖一遍。

配套的输入要求（骨架②③④没料就空转）：

| 字段 | 要求 | 为什么 |
|---|---|---|
| 核心角度 | **必填** | 原来叫「个人观点（可选）」，问的是「你想要什么立场」，答的多是「这事挺有意思」，够不上②要的可验证命题 |
| 参考素材 | <300 字标黄提醒 | 素材不足时 Agent 只能编，或只能写空话 |
| 文章骨架 | 可留空 | 留空 = Agent 先出骨架等确认；已填 = 直接沿用 |

### 检查器按写作技能分发（2026-10-11）

**不同写作技能的硬性规则是互斥的，不能用同一把尺子。**

| 写作技能 | 尺子 | 查什么 |
|---|---|---|
| `aws-wechat-article-writing`（A 类） | `write.py check` | 导语 80-128 字、加粗密度、恰好一行金句 |
| `khazix-writer`（B 类） | `check-khazix.py` | 禁冒号/破折号、禁小标题、禁大量加粗、口语词密度 ≥8、一句话独立成段 ≥3、情绪标点 |
| `write-entertainment-wechat-articles`（B 类） | 暂无独立检查器 | 只有全局符号门禁兜底 |

**拿 A 类的配额去卡 B 类的稿子必然失败**——那不是稿子的问题，是用错了尺子。
（实测：把 `khazix-writer` 的尺子套到一篇 aws 稿子上，立刻报 6 项不通过。）

所以两个阶段都走同一个分发器，按 `drafts.skill` 自动选：

```bash
python tools/check-draft.py drafts/YYYYMMDD-slug          # 自动认技能
python tools/check-draft.py <目录> --skill khazix-writer   # 手动指定
```

- **打磨阶段**（`draft → polished`）：改完稿跑一次
- **定稿阶段**：`finalize.py` 的第 0 步会跑它，不通过就停下（`--skip-skill-check` 可跳）

> 2026-10-11 实例：`khazix-writer` 第一次运行时，我照 aws 的习惯写了 7 个 `##` 小标题，
> 而卡兹克明令不加小标题。**B 类没有 aws 配额兜底，没有机器检查就会漏过去**，
> 于是补了 `check-khazix.py`。

### 配图媒介：四路对照实验的定论（2026-10-11）

同一篇文章、同一图位、同一画幅，只变风格路线，四张实图对照。**详见 [配图路线.md](配图路线.md)。**

| 路线 | 载体 | 结论 |
|---|---|---|
| A `aws` 媒介池 | 打印稿实拍（含台面与景深） | 质感最好，**但纸只占约 60% 画幅** |
| B `planner` 模式 A | 纯净扁平矢量（`IG-004`+`FC-029`） | 信息最清楚，**但就是 AI 默认模板脸**，且模型自加了叙事人物 |
| C `aws` 媒介池 | 终端等宽 | 纯平面、密度高，**但和本篇主题只是间接相关** |
| **D 推荐** | **打印稿平面** | **两家的公约数：保留实物载体，去掉环境浪费** |

**在线路 D 的定义**（写 prompt 时第一句整句抄）：纸面填满画面、无台面/角度/景深；
核心数字放大成视觉重心；红笔圈划 + 手写批注是标志动作；红色是唯一饱和色。

**为什么两个技能不能直接照抄**：`aws` 的媒介池要求实物摆拍，而包里
`article-illustration-planner` 的**红线 1 明令禁止**物理摆拍与景深虚化（吃掉 30~40% 画幅）；
`style-fusion-prompter` 的核心指令又是「微缩摄影」，同样撞红线 1。**三者在媒介上互相矛盾，
[配图路线.md](配图路线.md) 是这三家的交集。**

**两个技能的分工**：用 `article-illustration-planner` 定**图数与点位间距**（≥400~500 字且跨标题）
和**排版图型 ID**；用 `handdraw-style-prompter` 定**风格编号与主题色**（它只产 prompt 不生图）；
实际生成仍走 `aws-wechat-article-images`（`finalize.py` 依赖它的 `img-*` 命名）。

### 配图的两个已知事实（2026-10-11 实测）

**① 封面实际是 1.75:1，不是 config 写的 2.35:1 —— 这是端点边界，不是缺陷。**

`image_create.py` 的映射表里 `"2.35:1": "1792x1024"`，而 1792×1024 就是 **1.75:1**。
该图像端点最宽只到 1792×1024，所以 2.35 永远出不来，脚本每次都会告警并保留原图。

三篇实测完全一致，且前两篇**已发布且显示正常**：

| 草稿 | 封面尺寸 | 比例 | 状态 |
|---|---|---|---|
| 20261006-riben-kangyi | 1659x948 | 1.750 | 已进草稿箱 |
| 20261006-shijie-diyi | 1659x948 | 1.750 | 已进草稿箱 |
| 20261011-pingfenbiao | 1659x948 | 1.750 | 已配图 |

**结论：不要为这个告警重跑或裁切。** 裁到 2.35 会砍掉 25% 高度（本篇会切掉封面下半的
评分表与红圈）。真要 2.35 得先换支持更宽比例的端点。

**② 生图日志是 UTF-16LE，按 UTF-8 读会静默漏掉所有告警。**

PowerShell 的 `>` 重定向默认写 UTF-16LE，而日志内容全是 ASCII 标记。字符间夹着 NUL，
任何 UTF-8 读取都会匹配不到 `[WARN]`——**技能自检第 5 条「看过有没有腰斩告警」就变成一句假话**。

```bash
python tools/check-image-log.py drafts/YYYYMMDD-slug [更多目录...]
python tools/check-image-layout.py drafts/YYYYMMDD-slug [更多目录...]
python tools/gen-topics.py [--date YYYY-MM-DD] [--dry] [--top 10]
```

它按真实编码解码，列出每篇的图片数、告警与失败。实测三篇各 6 条告警、0 条失败。

### 写作 DNA 蒸馏：咪蒙（2026-10-14 起）

用 `writing-dna-skill` 的六层框架蒸馏咪蒙（2015–2019 公众号）的写作风格。
语料 6 篇（23,624 字），在 **`writing-dna/mimeng/`**：

```
raw/      6 篇原文
refs/     标题库 / 结构模板 / 自我剖析（**注意不叫 references**——沙箱对那个目录名有保护，写不进也删不掉）
_meta/    6 个元数据（100% 覆盖）+ l1/l6/titles 三份统计 JSON
语言DNA.md          置信度**高**（全量统计，可复现）
文章结构模板.md      置信度**中**（人工标注，每类体裁仅 1 篇支持）
视觉风格指南.md      置信度**低**（PDF 导出丢了排版，6 篇实测加粗=0、小标题=0）
标题公式实测.md      基于 289 条标题样本（该文件自称 1013 条，实际每节只列 50 条）
```

**三条实测结论（都推翻了仓库自带的二手说法）**：

1. **人称是第一特征**。正文每千字「我」16.9 +「你」12.5 = 29.4，是「他」（7.2）的 4.1 倍；
   标题 53.3% 直接含「你/我」。**她的机制不是「毒舌」，是把第三人称叙述改成第一、第二人称对话。**
2. **句长随体裁分档，不是一个常数**。情感故事型均 18.2 字/句（短句 47.8%），
   清单干货型均 30.1 字/句（短句 19.2%）。学平均值得不到任何一种。
3. **问号 5.5/千字，感叹号仅 1.1/千字**。二手 SKILL.md 声称「疑问与感叹号双高，各占约 20%」，
   **误差约 20 倍**。她的情绪标点是问号与省略号，不是感叹号。

**一处需要注意的语料缺陷**：PDF 导出把省略号渲染成三种不同字形
（`…` 22 个 / `......` 11 个 / `。。。` 49 个），统计时容易漏或重。已分别核对。

### 违禁词扫描：是提示工具，不是闸门（2026-10-14）

红狐技能包里的 `wechat-prohibited-word` 已装（见「红狐技能包」一节），
包装成 `tools/check-prohibited.py`。**它不阻断定稿**，理由如下。

**实测我们已有的稿子，命中的是这些词**：

| 稿子 | 命中 |
|---|---|
| 20261009-gaosu-kadian | 免费、第一、最后、极、官方、全部、安全 |
| 20261009-cunshang-zuoxi | 第一、最、最高、极大、安全 |
| 20261013-lina-tuiyi | 最、拥有、公开信 |
| 其余 6 篇 | 0 |

**「最后」「安全」「全部」「免费」「官方」在新闻评论里无法避免**——「AI 安全」是我们的专题词，
「最后，其中大约 700 个…」是正常行文。**红狐这个库是广告法/电商取向的，对评论类文章误报率高。**
设成硬门就等于每篇都要人工豁免，闸门立刻失去意义。

所以报告分两块，**互不依赖**：

1. **广告法绝对化短语自查**——直接在原文里找「最好/国家级/100%/包治百病」这类**完整短语**。
   不走红狐的词表，因为按命中词分档会误报（「第一反应」「极限操作」都会被算成广告法用语）。
2. **红狐命中词**——分组列出（行业相关 / 含绝对化前缀 / 其它），附上下文，**供人工判断**。

**真正有用的场合**：正文带带货/推广/品牌宣传语时（那时绝对化用语是真红线）；
或引用了他人宣传文案，需要确认没照抄违禁词。

**⚠️ 一个技能侧的 bug 要知道**：脚本自己的客户端检查写「单次上限 3000 字符」，
但服务端实际只允许 **2000**：

```
code=1003 body.content 参数长度超过限制（2600字符），最大允许2000字符
```

所以包装脚本按 1800 分块扫描再合并。**我们的稿子 1500~5000+ 字，不分块长稿永远扫不了。**

### 命令速查

```bash
python tools/workbench-db.py init                 # 建表 + 迁移（幂等）
python tools/workbench-db.py list-jobs            # 待分析队列
python tools/workbench-db.py list-topics          # 选题库
python tools/workbench-db.py list-drafts          # 创作库
python tools/workbench-db.py list-publishes       # 发布管理
python tools/workbench-db.py export               # 导出界面快照
python tools/wb.py take-job 12                    # 按 id 精确取任务（不带 id 则 FIFO）
python tools/wb.py counts                         # 各表计数
```

**数据层与 node 半之间走 JSON**：`api --payload <base64>`，请求 `{"op": "..."}`，
响应 `{"ok": true, ...}`。node 半的 `callDb()` 就是这一层的封装。

---

## 四、API 路由（20 条，全部挂在 `/api` 下）

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/workbench/jobs` | GET / POST | 待分析队列：列表 / 入队（带 `preset`）/ `action:'take'` |
| `/api/workbench/topics` | GET / POST | 选题方案：列表 / 改状态 / 删除 |
| `/api/workbench/drafts` | GET / POST | 创作库：列表 / `action:'create'` 建草稿 / `action:'delete'` / 其余按回写 |
| `/api/workbench/styles` | GET / POST | **文字风格库**：GET 列表（`?kind=personal\|system\|sub\|all`）或单条（`?code=MS-001`）；POST 新建 / 更新 / `action:'delete'` 归档 / `action:'vote'` / `action:'use'` |
| `/api/workbench/publishes` | GET | 发布记录 |
| `/api/workbench/draft-content` | GET | **读全文**：优先 `article.html` → `article.md` → `draft.md`；markdown 会转 HTML |
| `/api/workbench/asset` | GET | **读配图**：按路径返回二进制（带路径穿越防护） |
| `/api/workbench/materials` | GET | **每日热榜归档**：实时返回 `materials.snapshot.json`（不再只靠构建时烘焙） |
| `/api/workbench/fetch` | POST | **手动采集热点**：跑 `gen-materials.py`，覆盖当天归档并返回新快照 |
| `/api/workbench/gzh` | GET / POST | **公众号爆文**：GET 读 `gzh-hot.snapshot.json`（没采过返回空骨架 + `empty:true`，不是 404）；POST 跑 `collect-gzh.py` 抓 22 个分类的 10w+ 榜（约 100 秒） |
| `/api/workbench/xhs` | GET / POST | **小红书爆文**：GET 读 `xhs-hot.snapshot.json`（同样空骨架兜底）；POST 跑 `collect-xhs.py` 抓 25 个分类的单日爆款（约 60 秒） |
| `/api/workbench/inbox` | POST | **手动投料**：文字 + 截图落盘到 `materials/inbox/`，返回记录供界面投递分析指令 |
| `/api/workbench/health` | GET | 数据层自检 |
| `/api/workbench/image-catalog` | GET | **风格库索引**：324 风格 / 161 图型 / 36 主题色 / 角色，由 `image-gen.py catalog` 归一化，进程内缓存 |
| `/api/workbench/image-asset` | GET | **读图片二进制**：`from=skill` 读技能安装目录，`from=workspace` 读生成物；**两个根都做越界检查** |
| `/api/workbench/image-jobs` | GET / POST | 生图任务：GET 列表（连资产与用量一起给）/ POST `action:'preview'` 组词、`action:'enqueue'` 入队 |
| `/api/workbench/image-run` | POST | **起一个后台生成进程**：单张 30–70 秒，不能挂在请求里等；界面轮询任务状态 |
| `/api/workbench/image-usage` | GET | 计费账本汇总（累计 / 今日 / 按模型） |
| `/api/workbench/image-assets` | GET / POST | **资产库**（角色/道具/场景）：GET 读全貌；POST `action:'init'` 挂载图库目录、`action:'save'` 把生成物归档 |
| `/api/workbench/image-series` | GET / POST | **漫画流**：GET 系列（含分镜与产出）；POST `action:'preview'` 试拆、`action:'create'` 建系列并写分镜、`action:'run'` 起跑批进程 |

**⚠️ 路径必须挂 `/api` 前缀下**（这条踩了很久）：`connection` 把共享 fetch 处理器挂在
`API_PATH = "/api"` 这个 prefix 路由上，并用**完整路径名精确匹配**。挂在 `/api` 之外
（如 `/dsh-workbench/...`）永远匹配不到，请求会落到前端托管的兜底处理器 →
**GET 404 / POST 405**。DSH 自己的范例是 `path: "/api/file"`（`dsh-api-session-controller`）。

**鉴权说明**：`ctx.connection.fetch` 走连接层，自带 403（Host/Origin 围栏）+ 401（浏览器鉴权）。
不用自己造令牌。（对比：`ctx.webServer.register` 是底层路由，**不做鉴权**。）

**拒绝时怎么写（19 条必须一致）**：

```js
const bad = rejected(request)
if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
```

`rejected()` 返回的 `verdict.rejection` **本身就是数字状态码**（实测 401），
可以直接当 `status` 传给 `Response`。

⚠️ **不要写成 `json({ ... }, bad)` 之外的花样**，也不要传对象：`Response` 的 status
必须在 200–599，传对象会抛 `init["status"] must be in the range of 200 to 599`，
结果变成 500 而不是干净的 401。早前 `/gzh` 和 `/xhs` 两条曾用「抠出 code 再夹区间」
的写法绕这个坑，2026-10-26 已统一成上面这一行 —— 19 条一致，便于 grep 核对。

> 自查：`grep -c "if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)" lib/index.js` 应为 **19**。

---

## 五、触发机制（点击即唤起 Agent）

### ⛔ 不全自动：创作配置是必经的一道人工闸门（2026-10-25）

**旧行为（已废弃）**：点【选为写作】→ 立刻建草稿 → 立刻投指令给 Agent 开写。
问题是人没有插手的机会：主题、素材、观点、用哪个写作技能，全是代码猜的。

**现在**：点【选为写作】**只打开「创作配置」抽屉并带入值**，不建草稿、不投指令。
配置里由人决定这些，然后点【开始创作】才真的动笔：

| 配置项 | 从选题带入 | 说明 |
|---|---|---|
| 主题 * | 选题标题 | 必填，决定 Agent 定角度的起点 |
| 写作技能 | 赛道（仅预选） | **手工选**，8 个候选，标 A/B 类 |
| 参考素材 | 选题蒸馏段（摘要/角度/钩子/收获/读者） | 最多 5000 字；输入网址识别不了，要粘贴正文 |
| 用户要求（观点） | 选题 `viewpoint` | 会一路传到写作与审稿 |
| 字数 | 中等 1200~1500 | 短文 300~500 / 中等 1200~1500 / 长文 2000~2500，滑杆 100–10000 可细调 |
| 创作风格 | 个人 | 个人（账号既有语气/平实）/ 系统（锐利/故事/拆解） |

**两条入口共用同一个抽屉**：

- 选题库点【选为写作】→ 带入主题/素材/观点

> **为什么参考素材不是「来源文章正文」**（2026-10-26 实测修正）：
> 前端原来读 `topic.source_summary`——**这个字段根本不存在**，所以素材恒为空；
> `source_title` 靠 `LEFT JOIN topic_jobs`，但归档只留 7 天，28 条全查不到；
> `viewpoint` 28/28 也全空。真正有值的是选题自己蒸馏出来的几段，
> 于是按「有哪段带哪段」拼：`【摘要】【切入角度】【钩子】【读者收获】【目标读者】`，
> 平均 346 字，缺就留空、不编造。
> **`angle` 不进「用户要求」**——那是选题建议，不是用户立场，混进去会让 Agent 以为用户在表态。
- 创作库点【＋ 新建创作】→ 全空，自己填

**只有「开始创作」会投递指令**。待写草稿（`queued`）还能点【改配置并重新开始创作】，
走 `set-draft` 回写，**不新建草稿**——否则同一个选题会攒出多条重复稿。

界面点【入选题库】/【开始创作】/阶段推进按钮 → 入队 → **投递一条指令到会话**：

```js
ctx.remote.session.prompt({
  requestId: 'wb-…',
  sessionId,                          // 从 session.list() 取最近的非空会话
  mode: 'queue',                      // 排队，不打断用户正在说的话
  content: [{ type: 'text', text: analysisPrompt(focus) }]
})
```

**三个设计点**：

1. **合并触发**：投递前查队列里有没有 `running` 任务，有就只入队不投递。连点 6 条 = 只跑 1 轮。
2. **冷却 90 秒**：`TRIGGER_COOLDOWN_MS`，防止连点造成多轮。
3. **focus**：投递的指令里点名「用户刚点的是 job #N」，让 Agent 精确处理那条，
   而不是 FIFO 取最旧的。

**写作阶段指令（`WRITING_PROMPT`）里也写了符号限制**——因为 B 类技能
（娱乐套件、卡兹克）**不读 `writing-spec.md`**，只有指令层能覆盖到所有技能。

### 热点采集：DSH 自动化任务 + 手动（2026-10-06）

**热点是动态更新的**——同一天不同时刻抓到的榜单不一样。所以归档按**日期**存，同一天重复抓会**覆盖**当天并刷新 `fetchedAt`。

| 方式 | 实现 | 特点 |
|---|---|---|
| **每日自动** | **DSH 的「自动化任务」**（`schedule_create`，22:00 Asia/Shanghai） | **存盘的**：重启后仍在，且能**补投递错过的发生**。到点让 Agent 采集 + 对比昨天、点出 1-2 个选题角度。**代价：每天一个 Agent 轮次** |
| **启动补采** | node 半 `ensureTodayArchive()` | 快照最后一天不是今天 → 启动 20 秒后静默补抓。**零成本**，补"采集时刻 DSH 没开"的缺口 |
| **手动采集** | 每日热榜「手动采集当天热点」→ `POST /api/workbench/fetch` | 随时抓一次，界面立刻刷新 |
| **手动投料** | 每日热榜「手动投料」→ `POST /api/workbench/inbox` | 用户贴文字 / 传截图，落盘后交给 Agent 提炼 |

### 采集源：7 个平台（含 AI 与 IT）

| 平台 | 来源 | 备注 |
|---|---|---|
| 今日头条 / 百度 / 抖音 | 各自官方榜单接口 | 直取 |
| 微博 / 知乎 | 60s 聚合兜底（`60s.viki.moe/v2/`） | 微博/知乎直取会 403/401 |
| **AI·热点** | **AIHOT** `/api/v1/hot-topics` | 多源交叉的热点事件，带来源数 |
| **AI·资讯** | **AIHOT** `/api/v1/items` | 24h 内资讯，**带摘要**（表格里显示在标题下） |

**为什么接 AIHOT**：60s 聚合**没有 AI/IT 频道**（实测 `36kr` / `hackernews` / `github` / `v2ex` /
`ithome` / `juejin` / `infoq` / `sspai` **全部 404**）。AIHOT 是多源聚合，覆盖
IT之家（RSS）、Hacker News、TechCrunch、X、技术博客等——**一条接入同时补上 AI 与 IT 两类渠道**。

用**JSON 接口**（`/api/v1/*`）而非 `/agent/*`（后者返回给人读的 Markdown）；
AIHOT 使用说明写明：做定时同步或本地副本请用 JSON 接口，UA 用 `aihot-api/2.0.0`。

> ⚠️ **授权**：AIHOT 匿名免费仅限个人非商业、公益非商业、组织内部使用。
> **面向外部的商业用途（含对外发布的公众号内容）须先取得书面授权**，
> 见 <https://aihot.news/terms>。这不是技术问题，用之前请自行判断。

### 手动投料（截图 / 一段话）

界面：每日热榜 →「手动投料」→ 贴文字 + 传图片（可多选，单张 ≤12MB）→「存下并让 Agent 分析」。

```
落盘：<workspace>/materials/inbox/<时间戳>-<n>.<ext>   与同名 .json 记录
投递：一条指令到会话（复用 session.prompt 的触发机制）
```

**Agent 拿到后做四件事**：① 提炼事实锚点（原话/数字/时间/人物/动作，信息不足就直说，**不许补写**）；
② 判断够不够出选题（够则给 2-3 个角度 + 候选标题，不够则说明缺什么）；
③ 指出疑点（截图不清 / 来源不明 / 数字矛盾）；④ 简短回报。

**刻意不自动入选题库**——先让 Agent 判断信息够不够，避免"一条微博就生成三个方案"。
用户看完判断再决定。

**为什么每日定时不放在插件里**：插件进程内的 `setTimeout` 是**纯内存**的，DSH 一关就没了，也补不了错过的发生；
DSH 的调度器是**持久化**的，官方契约写明「After downtime, a recurring reminder delivers only its latest missed occurrence」。
所以**持久可靠的触发交给 DSH，插件只做零成本的启动补采**——两者分工，不同时在 22:00 抢跑。

> 查看/修改：DSH 侧边栏 →「自动化任务」。改时间后，界面上的提示文案（`FETCH_HOUR`）与其无联动，
> 那只是展示用的约定值，**真值以 DSH 任务为准**。

**能力边界（说实话）**：热榜接口只返回实时榜单，**没有历史日期查询参数**，所以**无法回溯补抓**。
「最近 7 天」是**攒**出来的。

**数据流**：每日热榜**不依赖构建时烘焙的快照**——首屏用内置快照兜底，随后从
`/api/workbench/materials` 实时读取，所以手动采集后**不需要重新构建 + 重启 DSH**。
（`gen-catalog.py` 仍会把快照烘进 `client.js`，那只作为离线兜底。）

---

## 六、五条 API 规则（踩坑换来的，照做即可）

| # | 规则 | 写错的后果 |
|---|---|---|
| 1 | **`register(options, Component)` 的 `options` 必须带 `name` = 槽位名** | 注册落空，菜单不出现。外层 `inject(slot, cb)` 只是「等槽位声明」，**不是绑定** |
| 2 | **槽位分两代**：`0.1.6+` 是 list 型（要 `id` + `order`）；`0.1.5-` 是 chain 型（要 `key` + `priority`/`select`） | 字段给错则不渲染 |
| 3 | **cordis 插件的 `Config` 要么不导出，要么必须是 Standard Schema**（带 `~standard.validate`） | 导出 `{}` → 激活失败：`Cannot read properties of undefined (reading 'validate')` |
| 4 | **`dsh.client.inject` 填客户端模块 id，不是 cordis 服务名** | 填 `["slots"]` → client 半被静默丢弃 |
| 5 | **client bundle 不需要构建**（`artifactRevision` 只读 mtime/ctime，source-map trailer 会被剥掉重建） | 误以为必须上 tsdown 构建链 |

规则 1、2 的证据：`@nagi-ovo/dsh-visualize/lib/client.js` 第 1056-1064 行。
规则 3 的证据：`@deepseek-ai/cordis/lib/index.js` 第 956-958 行。
规则 4、5 的证据：`@deepseek-ai/dsh-client-modules/lib/index.js` 第 61-71、170-181、192-196 行。

**第 6 条（后来补的）**：**main 面板拿不到会话上下文**——`layout` 的
`renderSlot("main", {}, { entryKey })` 第二个参数是空对象。所以会话相关的 API
（如 `ctx.remote.skills.list({sessionId})`）在 `main` 里用不了，得自己从
`session.list()` 找会话。`/api/workbench/*` 那套自带鉴权、不依赖 sessionId，就是为了绕开这点。

---

## 七、文件结构

```
dsh-workbench/
├── package.json              dsh.bundle.patch + dsh.client.platform:web；peer 全 optional
├── cordis.patch.yml          insert 一条 {id, name}
├── lib/
│   ├── index.js              node 半：19 条带鉴权的 fetch 路由 + mdToHtml 转换器
│   ├── client.template.js    client 半源码（**改这个**）
│   ├── gzh-rank-summary.json 各赛道实力榜的汇总（gzh-compare.py 的输入）
│   ├── gzh-deep-stats.json   各分类账号分布统计（gzh-deep.py 的输出）
│   ├── img-catalog.json      技能图库目录留档快照（`image-gen.py catalog` 的输出，界面不读它）
│   ├── gzh-rank/             实力榜全量账号 JSON（gzh-fetch.py 输出，按「分类-日期」命名）
│   ├── vd744-analysis.json   VD744 语料全量盘点（_tmp/vd744-scan.py 输出：篇幅/主题/重复度）
│   ├── vd744-index.json      VD744 语料逐条索引（_tmp/vd744-group.py 输出，带 A/B/C/D 安全分级）
│   ├── vd744-topics.md       VD744 分组清单（人看；A 级可用选题按主题列）
│   ├── topics.generated.json 当日选题生成结果（gen-topics.py 输出：分数/角度/待查证）
│   └── client.js             生成物（**不要手改**，由 tools/build.py 生成）
├── tools/
│   ├── build.py              一条命令刷新：抓热榜 → 导出 DB → 生成 client.js → **文档对账**
│   ├── check-docs.py         README 漂移检测（把文档声明当断言，跟代码对账）⛔
│   ├── check-draft.py        按写作技能跑对应 L1 检查（A 类=aws 配额，B 类=卡兹克）⛔
│   ├── check-image-log.py    读生图日志（**UTF-16**，按 UTF-8 读会漏掉全部告警）
│   ├── check-image-layout.py 查配图位置（图位数/均匀性/结尾覆盖，build.py 硬闸门）
│   ├── gen-topics.py         从当天素材生成选题（打分筛选 + 定角度，build.py 每日跑）
│   ├── check-prohibited.py    违禁词扫描（红狐包装；**提示工具不是闸门**）
│   ├── dna-l1.py             L1 语言层：词频/句长/人称/标点统计
│   ├── dna-l6.py             L6 排版层：加粗/小标题/段落节奏（配图测不了）
│   ├── dna-meta.py           生成 _meta/ 元数据标注
│   ├── dna-titles.py         标题库量化（1013 条标题的字数/句式/人称）
├── 配图路线.md              配图媒介的四路对照实验与定论（**配图前先读**）
│   ├── check-khazix.py       khazix-writer 的 L1/L2 硬性规则（禁冒号破折号、禁小标题…）⛔
│   ├── check-drafts.py       草稿技能与赛道路由一致性（--fix 修正 queued）⛔
│   ├── check-symbols.py      符号规范检查（**含 article.html**；--fix 修直引号）⛔
│   ├── finalize.py           定稿流水线：引号→剥离→插图→排版→校验→发布（幂等）⛔
│   ├── gen-materials.py      抓 7 天热榜归档 → lib/materials.snapshot.json
│   ├── gen-sports.py         体育战报采集（头条搜索 → 全文 → 归档；搜索与详情都扣积分）
│   ├── gzh-rank.py           从实力榜 HTML 抽账号 JSON（HTML 里内嵌 `var RAW = [...]`）
│   ├── gzh-compare.py        对比各赛道对标账号生态（转/赞比、10w+ 占比），用于定赛道
│   ├── gzh-fetch.py          实力榜取数（**urllib 版，不依赖 requests**）→ lib/gzh-rank/
│   ├── collect-gzh.py        爆文库·公众号取数：22 个分类 10w+ 榜 → lib/gzh-hot.snapshot.json（约 100 秒）
│   ├── collect-xhs.py        爆文库·小红书取数：25 个分类单日爆款 → lib/xhs-hot.snapshot.json（约 60 秒）
│   ├── gzh-deep.py           实力榜账号分布（10w+ 占比 / 转赞中位 / 阅读中位 / 发布频次）
│   ├── gzh-seg.py            按内容方向切开一个分类的账号（民生细分用；--list 列账号）
│   ├── measure-tone.py       单篇/多篇的 AI 味标记频率（用 lieflat 的量尺脚本）
│   ├── gen-catalog.py        扫技能目录 + 注入快照 → lib/client.js
│   ├── workbench-db.py       SQLite 数据层（公众号 5 张表：建表/迁移/CLI/api）
│   ├── image-db.py           生图数据层（生图 4 张表，同一个库；CLI/api 与上面同构）
│   ├── image-gen.py          生图执行器（索引归一化 / 组词 / 调接口）；**功能设计的接缝在这**
│   ├── ws_path.py            工作区解析（DSH_HOME / 工作区根，其他脚本共用）
│   ├── fetch-skills.py       从上游补下载技能（按 skills-manifest.json）
│   └── wb.py                 调 api 的简写助手（Agent 用）
├── DEVELOPMENT.md
└── README.md
```

**改界面必须走 `client.template.js` + `build.py`**，直接改 `client.js` 会在下次生成时被覆盖。

---

## 八、安装（写 DSH 目录，在工作区之外，需要一次提权）

1. profile 的 `package.json`：`dependencies` 加 `"dsh-workbench": "link:C:/data/test/dsh-workbench"`，
   `dsh.profile.bundles` 数组加 `"dsh-workbench"`
2. profile 目录跑 `pnpm install` 建立 link
3. **完全退出 DSH 再启动**（client 半按模块 id 加载，必须重启进程）
4. 看左侧栏

---

## 九、加一个新工作台只要两步

`lib/client.template.js` 顶部的 `APPS` 数组追加一项（下例是假设的 `podcast`，
**当前实际只有 `skills` / `gzh` / `image` 三项**）：

```js
{ key: 'podcast', label: '播客工作台', glyph: '播', pack: 'podcast',
  modules: ['选题', '脚本', '录制', '成品', '技能包'] }
```

再在 `tools/gen-catalog.py` 的 `PACKS` 里加一个包，**只写「用哪些技能、挂在哪个阶段」**：

```python
"podcast": {"title": "播客创作技能包", "stages": [
    {"name": "1 选题", "mode": "Agent + 技能", "note": "…",
     "members": ["hot-topics", "humanizer-zh"]},      # ← 引用技能名即可
]},
```

`apply` 会自动为它注册 `main` 应用界面 + `sidebar.panellist` 菜单项（key 与 id 同源），
并挂上它自己的技能包。

**⛔ 共用技能写名字就行，不要复制元数据。** `humanizer-zh`、`hot-topics`、`collect-source-material`
这些在多个包里出现时，**引用的是同一份磁盘扫描结果**——技能信息（标题/描述/脚本/路径）只在
`scan()` 里读一次。改技能说明不需要动任何包定义。

---

## 十、技能组织：两种视图，一份数据

2026-10-06 重构。**同一批技能，两个角度看**：

| 视图 | 位置 | 回答的问题 | 数据 |
|---|---|---|---|
| **资产视图** | **顶层「技能库」**（侧边栏第 4 个入口） | 系统里装了什么、**谁在用它** | `SKILL_REGISTRY`：全部已安装技能 + `usedBy` 反向索引 |
| **流程视图** | 各工作台内的「技能包」tab | **这一步该用什么** | `SKILL_PACKS`：按流水线阶段编排 |

**为什么要两个**：合并成一个会丢掉一个。「按 11 个阶段查该用哪个」和「系统里有什么、哪些没人用」
是两个不同的问题。

**关键：引用而非拷贝。** `gen-catalog.py` 里 `scan()` **扫一次磁盘**得到技能元数据，
工作台的 `stages[].members` 只写技能名，构建时解析成同一份数据。
所以 `humanizer-zh` 同时被公众号包和（将来新增的）别的包引用时，**没有两份定义**。

| 工作台 | 技能包 | 状态 |
|---|---|---|
| **（顶层）** | **技能库 · 资产视图** | **155 个已安装技能**（其中红狐 108）；未挂流水线的见技能库 |
| 公众号工作台 `gzh` | 公众号创作技能包 | **48 个技能 / 12 个阶段**（含红狐 29 个） |
| 生图工作台 `image` | 生图技能包 | 3 个技能 / 5 个阶段 |

**19 个公众号包里，9 个是跨工作台可共用的**（hot-topics、aihot、collect-source-material、
hv-analysis、select-entertaining-materials、bigpeng-hot-gzh、develop-entertainment-article-angles、
khazix-writer、humanizer-zh）——它们被引用，不是被"锁"在公众号里。

**分组按流水线阶段**，每段带「调用方式」（脚本 / Agent + 技能 / Agent + 技能 + 脚本）
与「具体调什么」。**装了新技能后重跑 `tools/build.py` 即可**（跑完会打印未挂流水线的技能）。

### 红狐技能包：挂在工作台里，**不放 DSH 全局扫描目录**（2026-10-14）

红狐社区技能包（`github.com/redfox-data/redfox-community-dsh`，115 个技能）装在
**`.dsh/redfox-skills/`**，不是 `.dsh/skills/`。

**⛔ 为什么不放 `.dsh/skills/`**：那是 **DSH 的全局技能扫描目录**，
放进去等于**每个会话不管在做什么**都把 115 个技能读进系统提示——
实测技能目录从 40 条涨到 155 条，是纯浪费的 context。

**而我们的流程根本不需要 DSH 把它们当技能加载**：
工作台有自己的技能库（`gen-catalog.py` 构建，第三个扫描根就是这个目录），
流程要调它们时**直接调脚本**（`check-prohibited.py` 就是这么做的）。

**115 个里只有 29 个真正对得上流水线**，已挂进对应阶段：

| 阶段 | 新增 |
|---|---|
| 1 发现热点 | trending-hub、trending-hub-top10、weibo-hot-search、douyin-hot-trend、toutiao-search、global-ai-news-brief |
| 2 采集与补素材 | wechat-search、gzh-search-crawler、cn-last30days、deepseek/doubao/kimi-websearch |
| 3 选材与选题 | wechat-10w-hot、wechat-original-hot、wechat-fastest-growing、douyin-daily-hot、xiaohongshu-dailytop、xiaohongshu-lowtop |
| 4 定角度 | wechat-similar-account、wechat-top-account、wechat-account-analyzer |
| 5 写正文 | **wechat-write、wechat-rewrite、multi-copywrite-alchemy、visual-ops-writer、multi-rewrite** |
| 8 审稿定稿 | wechat-prohibited-word、multi-wordcheck |
| 9 配图 | wechat-cover |

**其余 86 个**（小红书/抖音/B站/快手的账号查询、评论分析、行业日报、部分下载器…）
留在技能库里可查、可手动调用，**但不占流水线阶段**。

**依赖**：技能脚本用**捆绑运行时**的 Python
（`.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe`），
已给它装了 `requests` / `beautifulsoup4` / `deep_translator`
（`requests` 被 69 个脚本引用，是唯一的硬阻塞）。

**凭据**：`REDFOX_API_KEY` 读**环境变量**（用户级已设），不是 `.credentials.yaml`。

### 打磨阶段：只用 lieflat-less-ai-tone（2026-10-09 起）

阶段 6「打磨」**只挂 `lieflat-less-ai-tone`**，不再挂 `humanizer-zh`。

| | `lieflat-less-ai-tone` | `humanizer-zh`（已移出流水线） |
|---|---|---|
| 依据 | **283 万字语料实测**，11 条规则各带**可定位触发标记** | 31 条模式清单，靠写作经验判断 |
| 改法 | **白名单**：没命中规则的句子**必须逐字保留** | 较激进：删空话、拆模板、去拔高 |
| 兜底 | **信息守恒**：每个实词都要能在原文指出出处 | 散文式原则 |

**⛔ 为什么不挂 humanizer-zh 了**：它有**两条规则已被实测推翻**，而且**结构规则与 lieflat 直接冲突**。

| 特征 | humanizer-zh | lieflat（实测） |
|---|---|---|
| 被动句 / 被字句堆叠 | 要改（§11 §28） | **不改**，人类同样这么写 |
| 四字词排比 / 句内同构 | 要改（§29） | **不改**，人类用得不比 AI 少 |
| 段落数量与顺序 | §4 会删整段铺垫 | **必须原样保留**（实测中观察到这条冲突） |

**代价要说清楚**：lieflat 是白名单式的，**humanizer-zh 能抓的这几类它抓不到**——
起跑式铺垫（「这件事最值得琢磨的地方在这里」）、格言式收尾、戏剧性碎片（「她没有卡点。她提前下了高速。」）。
**换来的是可预测性**：每次改动都能指到某条编号规则，不会凭感觉润色。

`humanizer-zh` **仍然装在系统里**（`~/.dsh/skills/humanizer-zh`），技能库里标记为「未挂流水线」，
需要时手动 `/humanizer-zh` 调用即可。

### 量化的浓度自检（lieflat 的三个脚本）

```bash
# 单篇或多篇：按每千汉字统计 20+ 个标记，并给基准对照
python tools/measure-tone.py drafts/YYYYMMDD-slug/draft.md before   # 打磨前
python tools/measure-tone.py drafts/YYYYMMDD-slug/draft.md after    # 打磨后
```

底层是 `lieflat-less-ai-tone/scripts/check-translationese.py`（`measure-tone.py` 是它的单篇包装）。

**实测记录（2026-10-09，《卡点的这几天》一篇）**：

| 标记 | 打磨前 | 打磨后 | AI 基线 |
|---|---|---|---|
| 破折号 | 3.29 ×4 | **0.84 ×1** | 2.38 |
| 不是…而是 | 0.82 ×1 | **0** | 0.70 |
| 正是/恰恰是 | 0.82 ×1 | 0.84 ×1 | — |
| **总命中** | **6 次** | **2 次** | |

剩下的 1 处破折号是**金句行的机器语法**（`> 金句。 —— 出处`），必须留；
「正是/恰恰是」在 lieflat 里只是**测量标记，不在 11 条可执行规则内**，按白名单原则不动。

> `check-structure.py` / `compare-human-ai.py` 的分母是**段数或语料总量**，
> 不是为单篇设计的（脚本注释里写明了原因：结构类指标用「每千字」会被体裁带偏）。
> 单篇浓度参考用 `measure-tone.py` 就够。

**安装位置**：`.dsh/skills/lieflat-less-ai-tone/`（**项目级**，与 collect-source-material /
select-entertaining-materials 等创作技能同处；`~/.dsh/skills/` 是全局级）。
上游：<https://github.com/larashero3-dotcom/lieflat-less-ai-tone>

---

## 十一、运行手册

```bash
# 一条命令刷新界面数据（抓热榜 + 导出 DB + 生成 client.js + 文档对账）
python tools/build.py
python tools/build.py --no-fetch        # 改完数据只重新导出与生成
python tools/build.py --skip-doc-check  # 明确跳过文档对账（不建议，要想清楚为什么）
python tools/check-docs.py              # 只跑文档对账
```

**改完必须重启 DSH**（client 半按模块 id 加载）。

### 文档对账是构建闸门 ⛔

`build.py` 最后一步会跑 `check-docs.py`，**不一致就中止构建**。它检查 6 类声明：

| 检查项 | 对账对象 |
|---|---|
| 表清单 + 「N 张业务表」 | `workbench.db` 里实际存在的表 |
| 路由清单 + 「N 条路由」 | `lib/index.js` 里 `path: '/api/workbench/…'` |
| 状态机 | `client.template.js` 的 `DRAFT_STAGES` |
| 命令速查 | `workbench-db.py` 的 `add_parser` 与 `cmd_api` 的 `op == "…"` |
| 文件结构 | README 列的每个文件是否真的存在 |

**为什么要有这个闸门**：2026-10-06 一天里出现两次文档与代码不符——README 停留在
「下一步（数据层还没接）」而实际已有完整数据层；写进 README 的「6 张表」是用
`grep CREATE TABLE` 数出来的，**把 docstring 里的中文也数进去了**（当时真值是 4 张业务表）。
靠"记得改文档"管不住，所以做成机器闸门。

**改了代码就要同步 README**；`check-docs.py` 自己也做过反向验证（故意注入 4 种漂移，
全部抓到）。**若它出现假阳性，要修检测器而不是放宽断言**——假阳性会让人开始忽略这个检查。

### 符号闸门：必须查排版产物 ⛔

```bash
python tools/check-symbols.py drafts/YYYYMMDD-slug          # 查（含 article.html），违规退出码 1
python tools/check-symbols.py drafts/YYYYMMDD-slug --fix    # 修直引号，然后**必须重新排版**
```

**2026-10-06 踩到的坑（已发布出去才发现）**：

稿件里写的是 **ASCII 直引号 `"`**，`draft.md` 里 `「」` 计数为 0 —— **看着完全合规**。
但排版工具 `format.py` 的「Markdown 预格式化」会**把直引号成对转成 `「」`**，
于是 `article.html` 里凭空多出 18 对 `「」`，并随发布进了微信草稿箱。

| 输入 | 排版后 |
|---|---|
| `"直引号"` | `「直引号」` ❌ |
| `“中文双引号”` | `“中文双引号”` ✅ |
| `「直角引号」` | `「直角引号」` ❌（不修正） |

**教训有两条，都写进了工具与指令**：

1. **只查 `draft.md` 等于没查**——违规符号可能由排版阶段产生，必须查 `article.html`。
2. **写稿时就用中文双引号 `“”`**，不要用直引号；`writing-spec.md` 与自动触发指令都已写明。

`check-symbols.py` 做过反向验证：注入「直引号 / 直角引号 / 非金句行破折号 / 排版产物里的直角引号」
四种违规，**全部抓到**。

### 定稿流水线：不许手工分步 ⛔

```bash
python tools/finalize.py drafts/YYYYMMDD-slug              # 定稿+排版+校验
python tools/finalize.py drafts/YYYYMMDD-slug --publish    # 再加发布到草稿箱
```

固定六步，任一步失败就停下（不会带着坏产物去发布）：

```
1. 直引号 → 中文双引号（draft.md）
2. strip-citations
3. **占位符 → imgs/ 里的实际图片路径** → article.md（封面行移除，不进正文）
4. format.py 排版 → article.html
5. check-symbols.py 校验（含 article.html）
6. 可选：发布 → 自动记 publishes + 回写 draftbox
```

**为什么必须固化**：2026-10-06 手工分步时出过一次事故——
修引号的那一步写了 `io.open("article.md","w").write(来自 draft.md 的内容)`，
**用带占位符的草稿覆盖了已经插好图的定稿**，于是排版产物变成 4 张裂图，
并发布进了微信草稿箱（用户看到"配图不见了"）。

**根因**：`article.md` 是**派生文件**（草稿 + 图片路径），却被当成草稿的副本处理。
派生文件不能被源头覆盖——把它做进脚本，就不存在"用错源文件"和"漏做某一步"。

### 跨层新增字段时的验证纪律

不要只验证「每层代码写对了」，要从**最外层打到最里层**验一遍。
我们曾在 `preset` 字段上连踩两次——前端和 Python 都写对了，中间 node 半漏转发，
参数静默丢失。**同一个错误重复出现，说明缺的是纪律不是细心。**
## 十三、生图工作台（`image`）

2026-10-06 建。把 handraw-style 的**静态画廊**（`gallery/index.html`：筛选、看大图、复制提示词）
搬进面板，并补上画廊没有的三件事：选中组合直接带到生成页、编号参考图自动垫入出图、生成物落库可回看。

### 数据来源：与画廊同一份，不复制

画廊是 `build_*_gallery.py` 从 `references/styles.json` / `layouts.json` / `colors.json` 生成的静态页。
工作台读**同一批 JSON**，所以画廊照旧可用，两边不会各养一份。

**gallery 里的 `image` 是相对 `gallery/` 的（`../../../images/…`），归一成相对技能根只在
`image-gen.py` 做一次**——前端不做二次解析，避免两处换算慢慢漂移。

### 四张表（同一个库，与公众号那 5 张并存）

| 表 | 作用 | 说明 |
|---|---|---|
| `image_jobs` | 生图任务 | `queued → running → done / failed`；`arms` 决定出几张 |
| `image_assets` | 生成物（一行 = 一张） | `rel_path` 相对工作区，界面走 `image-asset` 路由读 |
| `image_usage` | 计费账本 | 接口**没有配额端点**（`/v1/models` 与配额都是 404），只能本地记 |

**同样分两个轴**：`image_jobs.status` 管内容进度，`image_usage` 管花了多少钱——
和 `drafts` / `publishes` 的分法同源，不要合并。

### 生图接口形状（实测确定，踩过坑）

```
POST {host}/v1/api/generate   {"model","prompt","images":[裸base64],"aspectRatio","quality","replyType":"async"}
GET  {host}/v1/api/result?id=<task_id>    → running/… → succeeded → results[].url
```

| 形状 | 结果 |
|---|---|
| `multipart` 表单（`image` / `image[]` 字段） | ❌ 形状不对 |
| `{image: "data:image/png;base64,…"}` 发到 `/v1/images/edits` | ❌ 形状不对 |
| **`images: [裸 base64]` 发到 `/v1/api/generate`** | ✅ 实测 11/11 成功 |

`images` 数组最多 1–6 张，参考图先转 PNG 再 base64（网关对 webp 上传的兼容性未验证）。
多模态那套 `image_create.py` 只实现了纯文生图，所以生图工作台**没有复用它**，另写了 `image-gen.py`。

### 七个模块（都是顶层 tab，不合并）

**顺序 = 模块的优先级**：`漫图创作` 排第一，所以打开工作台直接落在创作页（它也确实是这个工作台的主线）。

| 模块 | 是什么 |
|---|---|
| **漫图创作** | **左表单 + 右渲染预览的工作室**（见第十五节）：创作模式 / 出图模式与留白 / 主题 / 画幅与情绪 / 视觉资产与风格搭配。**默认展示页** |
| 风格库 | 324 种手绘风格。分类筛选 + 搜索（**纯数字按编号精确搜**）；点卡片开抽屉看大图、复制提示词、选为生成 |
| 图型库 | 161 种**排版图型模板**。每种给一套构图与版式；选中的原文会逐字拼进提示词，出图就按这个排版来 |
| 主色调 | 36 种经典单色。选中后写进提示词的「主题色」段 |
| 角色资产库 | **角色 / 道具 / 场景三个子库**。可从生成物一键归档、可作垫图引用。图库目录的**挂载入口不在这里**（在漫图创作分组④，见第十四节） |
| 我的创作 | **创作产出**：漫画流 / 电商详情页 / 单张出图。卡片网格 + 下载 + 存入资产库 + 统计。**不含角色/道具/场景基准图**（见下） |
| 技能包 | `image` 包，5 个阶段 |

> **「资产库」改名为「我的创作」（2026-10-08）。** 它装的是"你创作出来的东西"，
> 而「角色 / 道具 / 场景」是另一回事 —— 那是**可复用的素材**。两个都叫"资产库"时，
> 用户分不清"我去哪儿找我的图"和"我去哪儿找能复用的素材"。

**角色 / 道具 / 场景的基准图不进「我的创作」。** 它们生成后会自动归档进「角色资产库」，
在那里已经有一条记录；再在「我的创作」里列一遍就是重复。

判定方式是任务的 `params.noStyle === true`（see build_bare_prompt）——
这条规则**在数据入口处过滤**，不是在渲染时滤：否则统计和筛选数量会与卡片对不上
（「全部 9」但只看得到 8 张，用户会开始怀疑整个面板）。

> 这个 tab 原名「生成」，2026-10-07 改为「**漫图创作**」并移到首位。
> 改名不只是好听：它和「资产库」都带「生成」二字时，界面里两个入口读起来容易混。

**三个浏览库**（风格库 / 图型库 / 主色调）共用同一套浏览/筛选/详情交互
（`galleryView(g)` 按 `GALLERIES` 配置渲染），但**各自是独立入口**。
切 tab 会清掉搜索与筛选——条件串味会让人以为点错了库。

> **踩过的两次，都是"名字与结构"的问题**：
> 1. 第一版把四个库合并成一个「画廊」页、用子切换切，结果被问「图形画廊没做吗」——
>    那行子切换长得像页头装饰。**合并入口 = 让人以为只做了第一个。**
> 2. 改叫「画廊」也不够：模块名要能一对一地说出它装的是什么，所以拆成平级 tab。
>
> **第三次是定位错了。** 161 个图型曾被命名成「画廊广场」，并按"生成案例参考"来写文案 ——
> 这是把**模板库**误解成了**作品展示**。实际情况是：图型就是**排版模板**，
> 选中后原文逐字进提示词，出图就照这个版式来；不选中它就不生效。
> 现在叫「**图型库**」，文案也改成了模板口径。
> 教训：**"参考"和"生效"是两回事** —— 只读参考可以随便看，模板选中就会改变输出。

## 十四、角色资产库（角色 / 道具 / 场景）

**它不是画廊，是资产库。** 区别在于：图型/风格/色卡是只读的预置库（324 风格/161 图型/36 色卡），
而资产库要能往里加东西、并且这些基准图要在**出图时当垫图**用 —— 保持主体形象一致、跨媒介不漂移。

### 数据层：复用技能自带的，不另造

技能包里已经有 `custom_library_manager.py`，它管着：

| 位置 | 作用 |
|---|---|
| `~/.handraw-style/config.json` | 全局配置（图库目录），**独立于代码仓库，更新技能不丢** |
| `<工作区>/.custom_library_config.json` | 工作区容灾层（已 gitignore） |
| `<你指定的图库目录>/` | `characters/` `props/` `scenes/` + 自包含 `library.json`，方便跨设备迁移 |
| `images/custom/<cat>/<id>.webp` | 离线预览镜像（gitignore） |

`image-gen.py` 只做三件事：**动态加载它**、把「官方预置 + 自建」合并成界面能吃的形状、
把 `init` / `save` 转发过去。**逻辑一行都不复制** —— 复制出来的第二份迟早漂移。

分类与编号前缀：`characters` → `CH`、`props` → `PR`、`scenes` → `SCN`。

### ⚠️ 图库挂载入口在哪（2026-10-07 移出 → 2026-10-08 落到两处）

「角色资产库」页**不放挂载图库目录的输入框** —— 那是第一版的做法，按用户要求移出。

> **移出时留了个坑，已修。** 当时在生成模块里没自造 UI（等设计落地），但「存入资产库」
> 的拦截提示写的是「挂载入口在生成模块统一设置」—— **那个入口根本不存在**。
> 结果用户被卡在「存不进去、也不知道去哪挂」中间，提示指向空气。
>
> 教训：**任何提示都不能指向不存在的入口。** 要么把入口建出来，要么别这么写。

现在挂载面板（`mountPanel()`）放在**两个真正用到自建资产的地方**：

| 位置 | 为什么在这 |
|---|---|
| 漫图创作 → 分组④「自建图库垫图」 | 它本来就属于「自建图库」，是这个功能的第一站 |
| 「存入资产库」抽屉（未挂载时） | **就卡在这里的时候，把怎么解决放在眼前**，不让人去别处找 |

面板带一个**真实可用的默认目录**：后端在 `library.defaultDir` 里给出
`<工作区>/image-library`，留空即用它（不存在会自动创建）。
不再用 `d:\path\to\tuku` 这种占位符 —— 占位符没法一键挂载，等于把皮球踢回给用户。

能力本身一直完好，三条路都能走：

| 方式 | 位置 |
|---|---|
| 界面 | 漫图创作分组④ / 存入资产库抽屉里的挂载面板 |
| HTTP | `POST /api/workbench/image-assets`，`{action:'init', path}` |
| CLI | `python tools/image-gen.py asset-init --path D:\tuku` |
| 自然语言 | 让 Agent 调 `custom_library_manager.init_or_attach_library(path)` |

### 两种垫图，语义正好相反（容易搞混）

| 垫图 | 图从哪来 | 提示词里要求模型做什么 |
|---|---|---|
| **画风垫图** | 风格编号对应的 `images/individual/*.webp` | 只要线条/笔触/媒介/材质/色彩倾向，**严禁带走主体** |
| **资产垫图** | 资产库的基准图（角色/道具/场景） | **就要主体**：沿用外形、比例、配色、关键特征 |

两者混成一句话会让模型同时被要求「抄」和「别抄」，所以 `image-gen.py` 里是两个独立常量
（`REF_ISOLATION` / `ASSET_REF`）。两张图同时给时，提示词会显式说明
「第 1 张为画风参考，第 2 张为资产主体参考」，并且传图的顺序与之严格一致。

### 闭环

```
资产库「生成新角色」 → 带入图型 IP-002（角色三视图） → 生成页出图
    → 资产库 tab 点「存入资产库」→ 起名 + 选库 → 写进外部图库
    → 回到角色资产库点「以此出图」→ 作为垫图参与下一次生成
```

角色有专属图型 `IP-002`（角色形象三视图基准图），所以「生成新角色」会自动带上它；
道具/场景没有专属图型，由用户在生成页自己挑风格与主题。

> **一个命名上的将就**：顶层 tab 叫「角色资产库」（按用户原话），里面又有子库「角色库」，
> 读起来有点绕。如果改叫「资产库」更顺，改一处 `APPS` 的 modules 即可。

### ⚠️ 两套风格编号，别混

| 编号 | 形态 | 谁在用 |
|---|---|---|
| **全局序号** | `001` – `324` | 技能契约、用户心智、`SKILL.md` 的「a 001–324 hand-drawn style number」 |
| **组内 ID** | `FA-001`、`FE-059` | 库里真实文件名、卡片上的 ID |

两套靠 `references/style_alias_map.json` 对应（例：**257 → FE-059**，324 → FG-018）。
`image-gen.py` 把 `legacy` 一并带进索引，搜索框识别**纯数字**（可带 `#`）时按编号**精确**匹配，
所以「257」直接命中 FE-059、「18」命中 018；其余输入走模糊匹配。
卡片上编号显示为 `#257　FE-059`。

**纯数字只认 legacy，不拿组内序号兜底。** 这条是踩出来的：`018` 是全局唯一的 #018（FA-018），
但 `-018` 在 8 个组里各有一个，兜底会让搜索结果变成一锅粥（实测一次返回 7 条）。
想按组内编号找就用完整 ID（`FB-018`），走模糊匹配。

### 异步是必须的，不是优化

单张出图 30–70 秒（实测 11 张：不带垫图均 41s，带垫图均 51s，串行 8.5 分钟）。
`/api/workbench/image-run` 起一个 **detached 进程**就返回，界面靠轮询 `image-jobs` 看进度；
生成器把日志写进 `image-studio/<job>/generation.log`，不经管道回传。

**卡死回收**：进程被杀或 DSH 重启后 `running` 会永远挂着，所以 `image-jobs` 的 GET
会顺手把超过 15 分钟的 `queued`/`running` 置为 `failed`（与公众号那条 10 分钟复位同源）。

### ⚠️ 路径不要写死

技能装在 `<DSH_HOME>/skills/handraw-style`，会随 `git pull` / 重装换位置。
解析顺序：`DSH_WORKBENCH_SKILL_ROOT` 环境变量 > `DSH_HOME` > `~/.dsh`。

**顺带一个容易踩的坑：目录名 ≠ 技能名。** 包根 `handraw-style/SKILL.md` 声明的名字是
`handdraw-style-prompter`（包内 `skills/handdraw-style-prompter/` 还有一份操作契约）。
技能库里看到的是**声明名**，所以按目录名去查技能会查不到。
`gen-catalog.py` 一律以 frontmatter 为准，目录名只作兜底。

### 命令速查（生图，与公众号那套并列）

```bash
python tools/image-db.py init                 # 建生图的 4 张表（与公众号共库）
python tools/image-db.py list-image-jobs      # 生图任务
python tools/image-db.py list-image-assets    # 生成物
python tools/image-db.py list-image-usage     # 计费账本

python tools/image-gen.py catalog             # 归一化索引（界面用）
python tools/image-gen.py preview --style FA-018 --theme "深夜的便利店" --color C-01
python tools/image-gen.py layout --id SC-021  # 一个图型的完整资料（中英原文 + 实际会追加的后缀）
python tools/image-gen.py run --job 3         # 执行一条任务（界面也是这么调的）

python tools/image-gen.py assets              # 资产库全貌（角色/道具/场景 + 图库目录状态）
python tools/image-gen.py asset-init --path D:\tuku           # 挂载/初始化自建图库目录
python tools/image-gen.py asset-save --category characters --name "黑猫侍者" --image <图片路径>
```

### 图型（图型库）：完整生成方法

**每个图型都有完整的双语提示词**，不是只有一张缩略图：`references/layouts/<ID>.md` 里是
`<!-- zh -->` / `<!-- en -->` 两段原文（161 个文件、165.7 KB、**双语标记 162/162 齐全**），
最长的是 SC-022（9.8 KB）和 SC-021（8.8 KB）——那两类是「高维动态解析型」，
文件本身就是一套完整的构图决策框架，不是一句话。

抽屉里给出的是**完整生成方法**，按实际拼接顺序：

| 段 | 来源 | 说明 |
|---|---|---|
| ① 风格 | 风格库选定 | 风格名称 + 参考作者 + 核心风格特征 |
| ② 主题 | 生成页输入 | 唯一由用户决定的变量 |
| ③ 图型原文 | `references/layouts/<ID>.md` | **逐字**进提示词 |
| ④ 固定图文后缀 | `image-gen.py` 的 `GRAPHIC_TEXT_SUFFIX` | **逐字**追加；`EC-*` 电商图型按规范跳过 |
| ⑤ 参考图使用约束 | `image-gen.py` 的 `REF_ISOLATION` | 勾选垫图时追加 |

**三段常量必须与实际发出去的内容一致**，否则抽屉里展示的「方法」就是假的。
所以原文与后缀都由 `image-gen.py` 提供，界面不自己拼；`GRAPHIC_TEXT_SUFFIX` 是从
SKILL.md 里原样提取的（118 字），改它等于改图型的实际行为——README 里这条是断言，不是描述。

**按需读取，不塞进首屏**：161 个图型原文共 165 KB，全量塞进索引会让首屏包体翻倍，
而用户一次只看一个。所以走 `GET /api/workbench/image-catalog?layout=<ID>`
（**没有新开路由**，避免 README 的路由断言跟着动）。

> **数据里的一个孤儿**：`references/layouts/IG-036.md` 存在（索引 `layouts.json` 161 条里没有它），
> 原画廊也没有收录。工作台与画廊一致，以索引为准；这是技能包自身的数据不一致，未擅自补进去。

### 已知边界 / 留给下一次设计

| 项 | 现状 |
|---|---|
| **垫图会迁移主体** | 预研证实：垫 FA-018 的参考图，会把参考图里的长发女孩搬进新场景。现有隔离块拦不住，**提示词策略待设计** |
| **效果分风格** | 名称强激活的风格（波特、OscarAI）纯文字就够；靠「画法经济性」的风格（极简、涂鸦）必须垫图 |
| 图型组合 | ✅ 已实现：原文逐字 + `graphic-text` 后缀 + `EC-*` 例外，与抽屉展示一致 |
| SC-021 的动态轮替 | SKILL.md 要求构图语法「严格轮替抽卡」（越界破框/微缩浮岛/记忆图谱…）由 AI 做设计总监前置决策；**目前只是把原文送出去**，轮替未实现 |
| `_grid` 接触印相表 | ✅ 已修正：改为导入技能的 `style_asset_paths`，grid 优先、单图兜底（见第十五节） |
| 尺寸 | 请求 `1024x1024` 实返 `1254x1254`，**不保证遵守**；出图后记录了真实尺寸，未做裁切 |
| 手臂策略 | 界面给了 `垫图 / 纯文字 / 两种都出`，默认单臂；**默认值该是什么待定** |
| 海报 / 文章插图 / 文章封面 / 摄影 | 参考产品里有这四个出图模式，技能只有纯图与图文两种。**映射规则待定**，未自造 |
| 风格融合 | 技能包里有独立的 `style-fusion-prompter`，工作台**尚未接入** |
| 分镜数 / 气泡对话 / 纯图无字 | 参考产品里的漫画向参数，技能无对应物；**未实现** |

---

## 十五、漫图创作（左表单 + 右预览）

2026-10-07 按参考产品的交互范式重做这个页：**左侧一列分组卡片、底部固定主行动按钮、右侧渲染预览**。
它现在是工作台的**默认展示页**（tab 排在首位）。

### 分组按「技能提示词真正需要什么」排，不照抄参考产品

| 分组 | 内容 | 与技能的关系 |
|---|---|---|
| 创作模式 | 一键生图 / 分步精修 | **映射到技能的工作流**：一键 = 直接出图；分步 = 先给完整提示词确认再出图 |
| ① 出图模式与留白 | 纯图 / 图文；留白 正常/适中/多 | 模式是技能的**真参数**；**留白技能没有**，走「附加约束」通道 |
| ② 画面主题与内容 | 主题文本（600 字） | 技能唯一必填的语义输入 |
| ③ 画幅比例与情绪 | 6 个比例预设；15 个情绪多选 | 比例对应技能的 `--ratio`；**情绪技能没有**，同走附加约束 |
| ④ 视觉资产与风格搭配 | 自建资产垫图（多选）、图型/风格/主题色三张选择卡、智能随机抽卡、一键清空 | 对应技能的 layout / style / color + 资产库垫图 |

**「留白」「情绪」不是技能参数**，界面里明确标注了它们走附加约束通道 —— 不假装技能原生支持。

**挑选器（图型 / 风格 / 主题色 / 自建资产）带分类 tab 与搜索**，和三个浏览库**共用同一套判定**
（`groupOptions()` / `filterItems()`）。这不是为了省代码，是**防漂移**：
「纯数字按编号精确搜」这条规则（`018` → FA-018、且不拿组内序号兜底）如果在两处各写一遍，
迟早有一处忘改。挑选器切换时会清空搜索与分类——换一个库还留着上次的条件，会让人以为库是空的。

自建资产按 角色 / 道具 / 场景 分组，所以拼装列表时会**把分类打在每个条目上**
（资产数据本身不带 `groupKey`）。

### 出图模式 → 画幅比例（模式与比例绑定）

出图模式六种，**每种带出一个默认画幅**；切换模式会把画幅与留白带进第 3 组，之后仍可手改。

| 出图模式 | 技能模式 | 默认画幅 | 留白 | 附带的构图要求 |
|---|---|---|---|---|
| 纯图 | `pure-image` | 不预设 | — | — |
| 图文 | `graphic-text` | 不预设 | — | — |
| 海报 | `graphic-text` | `2:3` | 多 | 大标题与主视觉并重，信息层级清晰 |
| 文章插图 | `pure-image` | `4:3` | — | — |
| 文章封面 | `graphic-text` | `2.35:1` | — | 标题与主视觉协调，缩略图下仍能辨识 |
| 摄影 | `pure-image` | `3:2` | — | 写实摄影质感：真实光影与材质，不要手绘笔触 |

**技能的「真模式」只有 `pure-image` / `graphic-text` 两种**（`prompt_style.py` 的 `--mode`），
所以上表只有前两行是技能原生；后四行是**工作台叠的场景层**：
一个画幅 + 一个留白 + 一条「构图要求」附加约束。技能收到的仍然只是纯图或图文。

> **这张表是设计意图，不是技能规范。** 海报的 `2:3`、摄影的 `3:2`、以及三条构图要求都是工作台定的；
> 要改直接改 `client.template.js` 的 `OUTPUT_MODES`（一处配置）。
> `摄影` 与手绘画风库天然有张力 —— 现在靠构图要求里那句「不要手绘笔触」拉方向；
> 如果不够，得换做法（例如摄影模式下干脆不拼画风）。

### 编号参考图：那个开关是什么，以及为什么不该藏起来

「编号参考图」指的是**每种风格对应的那张样图**（`images/individual/FA/FA-018.webp`）。
这个开关决定出图时要不要把它一起送给模型：

| 选择 | 行为 |
|---|---|
| 垫入参考图 | 样图进接口的 `images[]`，并追加「只提取画风、不要抄主体」的隔离块 |
| 只给文字 | 不发图，只给风格名称与特征词 |

**它不是一个可有可无的开关**，预研实测过三种情况：

- 强激活风格（波特、OscarAI）：纯文字就够，垫图多余
- 靠「画法经济性」的风格（极简、社论涂鸦）：纯文字会**退化成精细插画**，垫图能拉回来
- 但垫图有副作用：会把样图里的**主体一起带进画面**（FA-018 那次，参考图里的长发女孩直接进了新场景）

技能里有 `model_capabilities.json`，按**风格 × 模型**判定属于哪种情况。界面在**选中风格后自动查**
（`GET /api/workbench/image-catalog?decision=<风格>`），把那三种来源翻成人话直接显示，
**不用点按钮**：

| `activation_source` | 界面文案 |
|---|---|
| `name+style` | 强激活：只给风格名就够 —— 不给特征词，也不需要垫图 |
| `name+style+traits` | 名称不够强：会附带核心特征词 —— 不需要垫图 |
| 含 `reference-image` | 名称与特征词都不够强 —— 技能建议垫参考图 |

> 第一版把这件事做成了「查看能力判定」按钮，被问「这个是有什么用的」——
> **判定是决策依据，不该藏在一个需要点击才知道有没有东西的按钮后面。**

**智能随机抽卡是全库随机**，不做「主题 → 风格」的静态映射：SKILL.md 明令禁止那种死映射，
而技能自带的 `--auto` 打分器只是离线兜底，审美判断应由 Agent 做。

### ⚠️ 画幅比例必须换算成接口尺寸（否则静默错位）

接口只认**具体像素尺寸**（`864x1152`），不认 `3:4` 这种比例字符串。所以比例不能只写进提示词——
那样会出现「提示词写着画幅 3:4、实际按 1:1 出图」，**而且没有任何报错**。

`image-gen.py` 的 `RATIO_TO_SIZE` 负责换算，取值来自接口支持的比例档位：

| 比例 | 接口尺寸 | | 比例 | 接口尺寸 |
|---|---|---|---|---|
| `1:1` | 1024×1024 | | `3:2` | 1536×1024 |
| `4:3` | 1152×864 | | `2:3` | 1024×1536 |
| `3:4` | 864×1152 | | `16:9` | 1280×720 |
| `5:4` | 1120×896 | | `9:16` | 720×1280 |
| `4:5` | 896×1120 | | `21:9` | 1456×624 |

三条规则：

1. **直接填像素**（`1024x1536`）→ 原样使用。
2. **认不出的比例**（如 `7:3`）→ 退回配置默认尺寸，**界面会如实提示「将用配置默认尺寸」**。
3. `2.35:1` 与 `5:2` 映射到 `21:9` 那一档（`1456x624`），属于**最接近档而非精确比例**——
   `ratioApprox` 把它们标出来，界面会显示「（最接近档，非精确比例）」，不把近似说成精确。

界面上比例是**预设 chip + 一个可编辑输入框**：chip 填入输入框，也可以直接手打比例或像素尺寸；
输入框下方实时显示换算结果。换算表随索引下发（`catalog.ratioToSize`），**JS 里不抄第二份**。

### 情绪：15 个预设 + 自定义输入

融合技能对情绪有一条规定：

> 除非用户在需求中**明确指定了情绪词**，否则【情绪】字段**必须且只能**从内置 15 种标准预设中选择；
> **严禁自行生造非标复合长句词**（如"压抑、肃杀、孤注一掷的狂暴史诗感与生存觉醒"）。

注意这两半：**被禁的是 AI 自作主张生造长句**，不是用户自己指定。所以工作台：

- 15 个预设 chip 是**默认口径**，与技能的列表一字不差（顺带印证了这批预设本来就是这个来源）；
- 另有**自定义输入框**（回车即添加），加进去的情绪会作为 chip 显示、可点击移除；
- 融合模式下，输入框旁的提示会换成技能那条规矩的说明 —— 提醒你自定义词是"你明确指定"才成立。

换句话说：这条限制**约束的是 Agent 的自动行为，不该变成对用户输入的限制**。
把它读成"禁止自定义"，是把一条防腐条款当成了功能阉割。

### 拼装已经与技能的参考实现逐字节对齐

`prompt_style.py` 是技能自己的确定性组词器。这次把 `build_prompt()` 重写成与它同序，
并**直接 import 技能的 `resolve_reference.py` 做能力判定**，不重新实现：

| 之前的问题 | 现在的做法 |
|---|---|
| 无条件塞核心特征词 | 按 `model_capabilities.json`：`name_activation=strong` 时**一个特征词都不给**（FA-018 在 gpt-image-2 下就是这种） |
| 色卡放提示词末尾 | 移到**风格名称之后、主题之前**（与技能一致） |
| 特征词按 `、` 切 | 用技能 `resolve_reference.positive_traits()`：按 `；;。换行` 切，另过滤「无写实纹理」类，5 个风格保留原文 |
| 参考图只用单图 | 用技能 `style_asset_paths`：`{编号}_grid.webp` 优先，单图兜底 |
| 无模式概念 | 实现 pure-image / graphic-text；**选了图型自动切图文**（技能规范） |
| 无附加约束 | 实现 ratio / whitespace / mood / subject / text / redraw |

**验证方式**：拿同一组输入跑技能 CLI 与 `image-gen.py preview`，逐字节比对 —— 纯风格分支、图型分支均一致。

### 唯一一处刻意差异：实发 vs 可复制

技能 CLI 是**给人粘贴**的，所以纯图模式下会把
「参考图：请上传本地参考图 `<路径>`」写进提示词；而工作台是**真把图挂上去**，所以不写「请上传」那句。

更关键的是图文模式：按技能规范，可复制提示词里**不放**孤立块，
但「the actual image-generation prompt still receives it together with the attached asset」——
所以 `build_prompt()` 返回两版：

| 字段 | 用途 | 图文模式下 |
|---|---|---|
| `zh` / `en` | 给人复制 | **不含**参考图约束 |
| `sendZh` / `sendEn` | 真发给模型 | **含**参考图约束 + 资产一致性 + 图片顺序说明 |

抽屉里两版都给出来，免得看到「可复制版没有参考图约束」以为是漏了。

---

## 十六、漫画流（一段文案 → 一组分镜）

创作模式里的第三项：贴一段文章 / 一句话 / 一句金句，拆成 N 镜，每镜各出一张图。

### 数据模型：参数在系列上，分镜只带自己的文案

| 表 | 存什么 |
|---|---|
| `image_series` | 一次创作：原始文案、镜数、拆解元信息、**风格/画幅/模式/垫图等参数** |
| `image_jobs` | 每个分镜一行，带 `series_id` + `panel_index`，`theme` 就是该镜的文案 |

参数存系列而不是逐镜复制：否则 N 行各存一份完全相同的参数，改一次要同步 N 行。

### 一次创作 = 一个数据对象（资产库里也是）

**漫画流在资产库里是「一张卡」，不是 N 张。** 卡片带「漫画流 N 张」角标，点开在同一个界面里
看完全部分镜（含镜序角标、逐张下载与归档）。

`image_assets` 上**没有** `series_id` 列——归属关系由 `image_assets.job_id → image_jobs.series_id`
实时 JOIN 出来（`image-list-assets` 那条 SQL）。冗余存一份就要同步两份，而这里 JOIN 一次就够。

> 为什么必须归组：把一组的 N 张拆成 N 个独立资产，**时间线、系列标题、镜序全丢了**——
> 用户看到的是 4 张零散的图，认不出它们是同一次创作。而成组之后，
> 「这 4 张是一套」这件事在数据层就是事实，不是靠用户自己记。

### 放大预览

预览列的主图、分镜板的每一格、资产库的每一张、分镜查看器里的每一张，**点一下都能放大**
（`Esc` 或点任意处关闭）。分镜板的小图尤其需要——格子小，细节看不清。

### 文字排布（图上字下 / 气泡对话 …）：技能没有这个参数

**要如实标注**：技能里的文字排布是靠**图型**表达的（`SC-004 上下双格图文分区卡`、
`SC-005 气泡文字思考IP卡`…），`SKILL.md` 只有一个固定的图文后缀，**没有「文字排布」这个参数**。

所以界面里的「图上字下 / 字上图下 / 旁白标题 / 气泡对话 / 画面不出现文字」走的是
**附加约束**通道（`文字排布：…`），和 `留白`、`情绪`、`构图要求` 落在同一处。
选中任一项会自动把模式切到图文——纯图模式下画面本就不出现文字，两者矛盾。

### ⚠️ 拆解只做确定性切分，语义扩展是 Agent 的活

`split_panels()` 的规则：

1. 按**空行分段** → 每段一镜（「自动」= 段落数）
2. 段落不够 → 按**句子**（`。！？；`）拆开再合并
3. 仍然不够 → **如实返回实际镜数**，`meta.short = true`

**第 3 条是刻意的。** 「一句话拆成 5 个不同场景」需要把内容展开——那是语义创作，
字符串切分做不到。硬凑只能靠复制原句或加序号，产出 5 张几乎一样的图，**比拆不出来更糟**。
所以界面会明说「这段文字只能拆出 M 镜，要 N 镜需要 Agent 做语义扩展」，而不是假装拆成功了。

### 执行：一个进程跑完整组

`image-gen.py run-series` 按 `panel_index` 顺序跑完所有待跑分镜。
**不是每镜 spawn 一个进程**——N 个进程各自要重载索引、逐张读盘；串行还能让日志按镜序连成一条。

部分成功如实标记：全成 → `done`；部分成 → `done` + `error` 记「x/y 镜失败」；
全失败 → `failed`。**不能因为一镜失败就把整组标成失败**，那样已经出的图会被当成没出。

### 计费提醒

漫画流是**按张计费 × N**。界面在启动时会说「一组 N 张，按张计费」——
这句话不能省，否则用户切到漫画流后随手点一下就是 N 倍开销。

### 命令速查（漫画流）

```bash
python tools/image-gen.py split --text "第一段。\n\n第二段。"          # 试拆，不落库
python tools/image-gen.py split --text "一句话。" --count 5           # 指定镜数（会如实告诉你拆不出）
python tools/image-gen.py run-series --series 3                       # 跑完整组（界面也是这么调的）
```

---

## 十七、风格融合（角色视觉语言 × 场景视觉语言）

分组④ 右上角的「风格融合」勾选后，单一「风格」选择器**裂成「角色风格 + 场景风格」**——
分别给人物和场景指定画风，让两者在同一画面里独立共存。

这不是工作台自造的玩法：技能包里有独立的 **`style-fusion-prompter`**，有自己的拼装契约。

### 与普通路径的重大差别

| 维度 | 普通路径 | 风格融合 |
|---|---|---|
| 输入 | 一个风格编号 | **角色风格（必须编号）+ 场景风格（编号或名称）** |
| 场景风格写名称（如「写实」） | 不支持 | **原样输出，严禁扩写**（技能规范） |
| 核心特征词 | 按 `model_capabilities` 决定给不给、且**过滤否定句** | **从 `styles.json` 逐字完整复制，严禁压缩/提炼/删改**（技能红线） |
| 编号写法 | `FA-018` | 展开成 `#235 …（全局序号）` |
| 默认画幅 | 无 | **`3:4`**（技能规定） |
| 编号参考图 | 可垫 | **不垫** |

最后一条要解释：融合的契约是**靠文字把两套风格各自完整展开**；而两张风格图谁对应角色、
谁对应场景在接口层无法表达，垫上去只会互相污染（而且垫图本身有「主体迁移」的副作用，预研实测过）。
自建资产垫图（角色/道具/场景基准图）仍然可用——那是用户自己的主体，与风格正交。

### ⚠️「共存规范」必须逐字，所以运行时从 SKILL.md 提取

技能里有一段 18 行的「共存控制指令」（从「缩微摄影，角色尺寸异常小……」到「主题事件明确可读」），
技能原话是：

> 生图模型精准理解双视觉媒介解耦共存与微缩透视的**底层核心契约**……**必须一模一样、逐字逐句完整复制**，
> 严禁任何形式的删减、提炼、压缩、篡改或遗漏！

所以 `fusion_blocks()` **在运行时从 `SKILL.md` 原文里提取**，而不是抄进代码。
抄一份就多一份会漂移的副本，而「必须逐字」的文本手抄一定会静默出错。
提取失败（文件缺失 / 结构变了）**直接报错**，不静默降级。

**验证方式**：程序化提取后用 `==` 与原文比对，中文 885 字 / 英文 3405 字均逐字一致。

### 命令速查（融合）

```bash
python tools/image-gen.py preview --style FB-027 --scene-style 写实 --theme "山中的妖精"
python tools/image-gen.py preview --style FB-027 --scene-style FH-001 --theme "山中的妖精"
```

### 已知边界

- **融合路径不自动选风格。** 技能规定「只给主题时由 AI 推荐一组最具反差的配对」——
  那是审美判断，应由 Agent 做，工作台不替他决定。
- **智能随机抽卡**在融合模式下会**刻意抽一个不同的场景风格**：同一种风格做角色和场景没有融合可言。
- 融合目前**不接漫画流**（界面不禁止，但每镜都会用同一对风格，还没有逐镜换风格的设计）。

---

## 十八、电商图（第七种出图模式）+ 本次上传参考图

### 电商图**不是海报的子类**

查过技能包，两处证据：

1. **海报技能里完全没有「电商 / 商品 / 产品 / 主图」** —— `poster-prompt-generator` 的字段是
   「主题 / 业务场景 / 受众 / 内容密度 / 情感基调 / 主题色 / editorial风格 / 画风」，
   它说的是**广告投放海报**，跟商品主图不是一回事。
2. **电商在图型层是一个独立分类** —— 图型索引的五个分类是
   `social-card 21 / infographic 35 / comic-storyboard 68 / ip-character 13 / **ecommerce 24**`。

所以电商图既不是海报的子类，也不是一个独立子技能 —— **它是图型分类**（24 个 `EC-*`）。
工作台把它单立为出图模式，是**产品层的组织决定**，作用有三：

- 技能模式固定走 `pure-image`（`EC-*` 图型本来就不加图文后缀，这是既有实现）；
- 默认画幅 `1:1`（电商主图惯例）；
- **开放「商品图上传」** —— 这才是这个模式存在的关键理由。

### 本次上传参考图：与「存入资产库」是两件事

| | 本次上传 | 存入资产库 |
|---|---|---|
| 落盘位置 | `<工作区>/image-studio/_uploads/` | 外部图库目录（`characters/` `props/` `scenes/`） |
| 进索引 | ❌ | ✅ `library.json` |
| 出现在挑选器 | ❌ | ✅ |
| 寿命 | 本次生成 | 长期，可跨设备迁移 |
| 适用 | 一次性商品图、临时参考 | 会反复用的角色 / 道具 / 场景基准图 |

**为什么必须分开**：把只用一次的商品图塞进道具库会**污染库** —— 它从此出现在挑选器里，
以后每次挑垫图都得绕过它。反过来，把长期复用的角色基准图当成"本次上传"，
下次出图又得重新上传一遍。两者的生命周期不同，入口就该不同。

商品图会作为**主体参考**参与出图（让模型照着这个商品画，而不是凭空编一个）。

### ⚠️ 路径解析必须同时查越界 + 存在性

上传通道引入了一个新问题：现在垫图有**两个来源**（技能目录、工作区）。

```
技能资产：images/characters/CH-001.webp        → 技能根
本次上传：image-studio/_uploads/xxx.png        → 工作区
```

**只查越界是不够的。** 上面第二条（工作区相对路径）在技能根下**同样"越界合法"却并不存在**，
只查越界会把它解析到技能根，任务随后以一个莫名其妙的错误失败。所以先按存在性挑，
挑不到就不传 —— **宁可不传，不传错**。四种情况都实测过：库资产→技能根、上传图→工作区、
不存在的→不传、`../../Windows/System32/config/SAM`→拒绝。

新上传的图**不上传校验格式**（接受 png/jpg/webp/gif），但有 **12MB 上限**，
文件名只保留中文/字母/数字/点/横线并截断 —— 不信任浏览器给的名字。

### 电商详情页多图：一次出一整组

详情页本来就是多图的（主图 / 场景 / 卖点 / 细节 / 参数 / 包装…），一张张做效率太低。
所以电商图模式下可选「**单张主图 / 详情页多图**」，多图模式一次出一组。

**拆解配方不是我编的。** 技能里那 **24 个电商图型本身就是一套完整的详情页镜头表**：

| 图型 | 名称 |
|---|---|
| EC-001 / 002 / 003 / 004 | 单品主图 / 多角度展示 / 细节特写 / 包装·套装·内容物 |
| EC-005 / 006 / 007 / 008 | 卖点标注 / 功能演示 / 参数尺寸 / 材质·结构解析 |
| EC-009 / 010 / 011 / 012 | 生活方式场景 / 人物使用 / 多场景适用 / 使用步骤·教程 |
| EC-013 ~ EC-018 | 对比优势 / SKU差异 / 适配指南 / FAQ / 品质工艺 / 认证数据 |
| EC-019 ~ EC-024 | 评价口碑 / 品牌故事 / 新品上市 / 促销活动 / 内容种草 / 广告主视觉 |

工作台按**常规详情页图序**取前 N 个（默认 6 张：主图 → 生活场景 → 卖点 → 细节 → 参数 → 包装），
最多 12 张。点「预览拆解」能看到这一组具体是哪几张再决定。

### ⚠️ 每张分镜要有**自己的图型**

这是与漫画流最大的结构差异，也是本次唯一的数据层改动：

| | 漫画流 | 电商详情页多图 |
|---|---|---|
| 图型 | 整组共用一个（可以没有） | **每张各自不同**（主图和细节图不可能是同一版式） |
| 分镜内容 | 一段文案切出来的每段 | 商品信息 + 本张要做什么 |

所以 `image_jobs.layout_id` 是**逐行**的（`series-panels` 支持每个分镜用 `layoutId` 覆盖系列上的值），
而不是只挂在系列上。没有这一条，「详情页多图」会退化成「同一个版式出 6 遍」——
而那正是它要解决的问题。

分镜的两种来源在路由里分开处理：

- **显式面板**（电商多图）—— 客户端给出每张的文案与图型，**不走文本切分**。
  商品信息不是要「切开」的文本，而是要「换图型逐一呈现」的内容。
- **文本切分**（漫画流）—— 按空行段落 / 句子确定性拆分。

两者共用同一套 `image_series` / `image_jobs` / `run-series` / 分镜板机制，不另造一套 ——
**复用是对的：这正是漫画流那套机制存在的意义**，只是换了一份"怎么拆"的配方。

### 商品信息怎么写：指引做成常驻块，不是 placeholder

**placeholder 有个硬伤：一输入文字就消失。** 而"该写什么"恰恰是打字时最需要的信息。
所以「商品信息怎么写」做成了可展开的常驻块 + **一键填入示例**。

指引的核心不是"格式"，而是**哪几张图会读哪一部分**：

| 该写什么 | 例子 | 被哪些分镜读到 |
|---|---|---|
| 品名 / 品类 | 轻量保温杯 | 全部（必须先说清主体是什么） |
| 材质 / 成分 | 316 不锈钢内胆，杯身磨砂，杯盖食品级 PP | 细节特写 EC-003、材质解析 EC-008 |
| 规格 / 尺寸 / 重量 | 500ml，高 21cm，直径 6.8cm，净重 280g | 参数尺寸 EC-007、多角度 EC-002 |
| 核心卖点（3–5 条） | 24 小时保温 / 单手开盖 / 360° 防漏 | 卖点标注 EC-005、对比优势 EC-013 |
| 使用场景 | 通勤、办公室、健身房、户外徒步 | 生活场景 EC-009、多场景 EC-011 |
| 目标人群 | 25–35 岁上班族、健身人群 | 人物使用 EC-010、内容种草 EC-023 |
| 款式 / 颜色 | 雾蓝 / 燕麦白 / 墨绿 / 曜石黑 | SKU 差异 EC-014、主图 EC-001 |

最后那列是**为什么要写全**的原因：只写"保温杯好看"，参数图就没尺寸可画、卖点图就没卖点可标 ——
出来的是一组同质的漂亮图，而不是一组能卖的详情页。

### 资产库的统计口径与筛选维度

**统计有两个粒度，不能混：**

| 指标 | 口径 |
|---|---|
| 资产总数 / 电商图 / 漫画图 / 其他 | **按卡算** —— 一次创作 = 一个数据对象，一个漫画流 6 张是 **1 个资产** |
| 任务数 / 今日生成数量 | **按张算** —— 这才是这两个指标该有的粒度 |

如果资产也按张算，「资产总数」会变成 17 而卡片只有 9 张 —— 用户数一遍对不上，就开始不信这个面板了。

**筛选 tab 按出图模式分类**，不再混入「漫画流 / 单图」这类**形态**维度：

- 形态回答的是「一次出了几张」，模式回答的是「这是哪种图」；
- 两个维度混在一排会互相干扰 —— 用户能理解「电商图 2」，但很难理解
  「漫画流 2」和「电商图 2」为什么能并列（一个是形态、一个是模式）。

tab = 全部 + 出图模式控件那七个（顺序与命名完全一致，数量为 0 的照样显示但灰掉）。

**没有「早期任务 / 其他」这个 tab。** 曾经有过，后来去掉了 —— 那是**数据质量问题，不是一种图**。
把一个历史遗留问题做成产品分类展示，会让它看起来像一个正常的使用场景。
那些没有模式记录的老图现在只出现在「全部」里，不再单独给入口。

### 删除：库和磁盘必须一起删

资产库的每张单图和每组系列都带删除按钮（二次确认会说清删的是什么、几张）。

删除做两件事，**缺一都会留下垃圾**：

| 只做一件 | 后果 |
|---|---|
| 只删数据库行 | `image-studio/<jobId>/*.png` 变成孤儿文件 —— 界面上看不见、磁盘上一直留着 |
| 只删文件 | 列表里挂着一条打不开的记录 |

所以：`asset-delete` / `series-delete` 只动数据库并**返回待删文件路径**，
由 node 半负责 `unlink`（**只删工作区内的路径**，越界一律不碰）。

还有一层容易漏：**删图片不够，任务目录里还有 `generation.log`**。
所以任务被整条删掉时（某任务的最后一张被删，或整组被删），产物目录也一并 `rm -rf` ——
否则磁盘上会积一堆再也没有入口的残留目录。这一条是实测发现的：第一次只删了 PNG，
`image-studio/1/generation.log` 留了下来。

**计费账本不受删除影响**（`image_usage` 是独立的账本，删图 ≠ 退款）。
但「今日生成数量」是按现存生成物算的，所以删图后它会减少 —— 这是两个不同的口径，别混。




---

## 十九、技能来源与版权

本插件自带 **50 个第三方技能**，作为工作台的技能库随包分发。
它们不是本项目原创，**版权归各自作者所有**，按各自许可证使用。

本项目只是**集成引用**：未修改技能内部实现，未做二次开发，未将技能单独售卖。
技能是工作台正常运行所必需的组成部分。

**完整来源清单、许可证类型与署名要求，见 [SKILLS-CREDITS.md](./SKILLS-CREDITS.md)。**
逐项的机器可读清单（含上游地址与许可证）见 [skills-manifest.json](./skills-manifest.json)。

速览：

| 项目 | 数量 |
|---|---|
| 依赖技能总数 | 50 |
| 带 LICENSE 文件 | 6 |
| 未附带 LICENSE（按依赖收录） | 44 |
| 本项目自建 | 4 |
| 无公开上游 | 2 |

按上游来源：

| 上游仓库 | 许可证 | 技能数 |
|---|---|---|
| [aiworkskills/wechat-article-skills](https://github.com/aiworkskills/wechat-article-skills) | Apache-2.0 | 9 |
| [redfox-data/redfox-community](https://github.com/redfox-data/redfox-community) | **未声明** ⚠️ | 27 |
| [KKKKhazix/khazix-skills](https://github.com/KKKKhazix/khazix-skills) | MIT | 3 |
| [yang0/handraw-style](https://github.com/yang0/handraw-style) | MIT + 署名 | 1 |
| [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) | MIT | 1 |
| [larashero3-dotcom/writing-dna-skill](https://github.com/larashero3-dotcom/writing-dna-skill) | NOASSERTION | 2 |
| [BigPengSays/bigpeng-hot-gzh](https://github.com/BigPengSays/bigpeng-hot-gzh) | MIT | 1 |
| 本项目自建 | 本项目 MIT | 4 |
| 无公开上游 | — | 2 |

### 关于第三方技能的说明

1. 技能代码版权归原作者，本项目不主张任何权利。
2. 各技能的 LICENSE 文件随技能目录一并保留，未做改动。
3. 本项目免费开源，**不销售**技能，也不对技能做商业再授权。
4. `redfox-data/redfox-community` **未声明许可证**（仓库无 LICENSE 文件），
   其 27 个技能按依赖引用收录。若该仓库作者有异议，请联系我们，会配合调整或移除。
5. 补装或更新技能可从上游重新获取：`python tools/fetch-skills.py`

### 本项目自身的 MIT 许可证（[LICENSE](./LICENSE)）**只覆盖插件代码**，
不覆盖 `skills/` 下任何第三方技能。