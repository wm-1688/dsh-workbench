# dsh-workbench · 创作工作台

> 一个跑在 [DSH](https://github.com/deepseek-ai) 里的公众号创作工作台。从选题、写稿、审稿、排版到配图，把一条完整的创作流水线装进一个界面。

[![版本](https://img.shields.io/badge/version-0.1.0-blue)]()
[![Python](https://img.shields.io/badge/python-3.9%2B-brightgreen)]()
[![平台](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)]()

---

## 这个工具解决什么问题

写公众号的痛点不在「写不出来」，在于**流程散落在十几个地方**：

- 热榜在 A 网站看，选题记在 B 文档
- 稿子写在 C 编辑器，配图去 D 工具生成
- 排版复制到 E 后台，检查靠肉眼
- 写完一篇，下一篇从零开始

这个工作台把全流程收进一个界面，并且**每一步都有机器校验**——符号规范、AI 味、违禁词、配图位置，不靠记性。

---

## 核心特性

### 📋 选题库

- 从 7 个平台的热榜自动抓取素材（今日头条 / 百度 / 抖音 / 微博 / 知乎 / AIHOT 两频道）
- 按 8 个赛道自动打分排序，每赛道限 3 个，避免单一题材刷屏
- 同标题、同主题簇、同事件三层去重
- 每个选题自动生成：切入角度、候选标题、摘要、大纲、目标读者、工作量
- 支持「待分析队列」：粘贴一条热点链接，走技能链生成多个方案

### ✍️ 创作库

- 8 阶段状态机：`待写 → 初稿 → 已打磨 → 已审稿 → 已排版 → 已配图 → 已入草稿箱 → 已群发`
- **创作骨架**：七阶段固定流程（准备 → 吃透素材 → 定角度 → 出骨架 → 写正文 → 自检 → 交付），优先级高于任何技能自带步骤
- 3 个写作技能可选：公众号写稿（A 类）/ 娱乐成稿（B 类）/ 卡兹克长文（B 类）
- 风格库：从 skills 提取的风格提示词，个人 / 系统两个 tab

### 🎨 配图工作台

- 373 个风格 / 170 种图型 / 36 个主题色，按内容选而非按习惯选
- 封面与正文图分开设计（封面 2.35:1，正文 16:9）
- 配图位置自动校验：图位数、均匀性、结尾覆盖

### ✅ 质量检查

| 检查器 | 查什么 |
|---|---|
| `check-symbols.py` | 符号规范（`「」` 禁用、`——` 只在金句行、ASCII 直引号） |
| `check-draft.py` | 按技能分流：A 类走 aws 配额，B 类走卡兹克规则 |
| `check-image-layout.py` | 配图位置是否均匀 |
| `check-prohibited.py` | 违禁词（红狐库，提示工具不是闸门） |
| `measure-tone.py` | AI 味标记频率 |

---

## 快速开始

### 环境要求

- Python 3.9 或更高
- DSH（本插件是 DSH 的扩展，不能独立运行）

### 安装

```bash
# 1. 解压
unzip dsh-workbench-0.1.0.zip
cd dsh-workbench-0.1.0

# 2. 一键安装（会自动装插件依赖的技能）
python install.py
```

安装器会完成：

1. 检查 Python 与目录完整性
2. 初始化数据库（9 张业务表）
3. 生成界面代码 `client.js`
4. **安装 21 个依赖技能到 `$DSH_HOME/skills/`**
5. 检查 DSH 挂载配置
6. 生成 `install-report.md`

想先看会做什么、不改任何东西：

```bash
python install.py --check
```

### 让 DSH 加载插件

安装器跑完后会打印精确指令。两种方式：

**方式 A：让 AI 帮你装（推荐）**

把这句话发给 AI：

```
安装 dsh-workbench 插件，目录是 <安装目录>，它靠 cordis.patch.yml 注册，装完重启 DSH
```

**方式 B：手动**

把插件目录放进 DSH profile 的 `node_modules`，或在 profile 目录执行 `pnpm link <插件路径>`，然后重启 DSH。

重启后侧边栏出现「创作工作台」。

---

## 目录结构

```
dsh-workbench-0.1.0/
├── install.py                一键安装器
├── package.json              DSH 插件声明
├── cordis.patch.yml          插件注册补丁
├── lib/
│   ├── index.js              node 半：HTTP 路由 + 磁盘读写
│   └── client.template.js    client 半源码（改这个，然后跑 build.py）
├── tools/                    命令行工具（见下表）
├── skills/                   21 个依赖技能（安装时复制到 $DSH_HOME/skills/）
├── writing-dna/              写作 DNA 蒸馏产物
└── 配图路线.md               配图规范
```

### 工具清单

| 工具 | 用途 |
|---|---|
| `install.py` | 一键安装 |
| `build.py` | 刷新界面数据 + 全套文档/技能/配图位置校验 |
| `gen-materials.py` | 抓 7 平台热榜 |
| `gen-topics.py` | 从素材自动生成选题 |
| `workbench-db.py` | 数据库操作（选题 / 草稿 / 发布 / 风格） |
| `image-db.py` | 图片任务与资产 |
| `image-gen.py` | 调图像 API 生图 |
| `finalize.py` | 定稿排版一条龙（引号修正 → 插图 → 排版 → 符号校验） |
| `check-symbols.py` | 符号规范 |
| `check-draft.py` | 按技能分流的 L1 检查 |
| `check-image-layout.py` | 配图位置 |
| `check-prohibited.py` | 违禁词 |
| `measure-tone.py` | AI 味测量 |

---

## 数据存放位置

默认在插件目录内。想换位置，设环境变量：

```bash
export DSH_WORKBENCH_HOME=/path/to/your/data
```

解析顺序：

1. `DSH_WORKBENCH_HOME` 环境变量
2. 上级目录有 `drafts/` 或 `workbench/` → 视为开发环境，数据放上级
3. 都不满足 → 数据放插件目录内

---

## 可选配置

### 图像生成

配图功能需要图像 API：

```bash
# 环境变量或 .env
IMAGE_MODEL_API_KEY=你的key
```

支持 OpenAI 兼容端点，默认走 `gpt-image-2.5`。

### 红狐 API

违禁词检查、爆文库等功能需要[红狐](https://redfox.hk) key（**付费服务，需自行购买**）：

```bash
REDFOX_API_KEY=ak_xxxxx
```

没有 key 时，这些功能会降级或跳过，不影响写稿主流程。

---

## 首次使用

装完是空的，需要先抓一次素材：

```bash
# 抓 7 平台热榜（需要网络）
python tools/gen-materials.py

# 从素材生成选题
python tools/gen-topics.py
```

之后在界面里「选题库」就能看到自动生成的选题了。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 需要 DSH | 这是 DSH 插件，不能独立运行 |
| 图片无法自动核验 | 本仓库的模型无法读取图片，配图需人工过目 |
| 部分技能需付费 API | 红狐相关功能需自行购买 key |
| 只测过 Windows | macOS / Linux 理论可用，但未实测 |

---

## 开发

改界面的流程：

```bash
# 1. 改 lib/client.template.js（不是 client.js，那是生成物）
# 2. 重新生成
python tools/build.py --no-fetch
# 3. 重启 DSH
```

`build.py` 会跑全套校验：文档一致性、技能真实性、配图位置。任一不通过会中止。

### 项目约定

- **文档即断言**：`check-docs.py` 把 README 里的表清单、路由数量、文件树当断言核对代码
- **技能必须真实存在**：`build.py` 校验写作技能清单里每个名字在磁盘上有对应 `SKILL.md`
- **配图位置有硬指标**：图位数 = `clamp(ceil(字数/500), 1, 5)`，间隔须在平均值的 0.7~1.5 倍之间

---

## 许可证

MIT

## 致谢

- 依赖技能来自 [aws-wechat-article-*](https://github.com/aiworkskills/wechat-article-skills) 套件、[卡兹克写作 skill](https://github.com/KKKKhazix/human-writing)、[handraw-style](https://github.com/) 配图风格库等
- 插件框架基于 [DSH](https://github.com/deepseek-ai)
