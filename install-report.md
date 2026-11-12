# 安装报告

- 时间：2026-11-12 10:28:30
- 目录：`C:\data\dsh\gh-push\dsh-workbench`
- Python：3.12.10
- 系统：Windows 11

## 已完成

- 数据库：10 张表 → C:\data\dsh\gh-push\dsh-workbench\workbench\workbench.db
- 界面代码：379KB
- 数据快照：0KB
- 技能：包内新装 50 个，跳过已存在 0 个
- 技能：上游下载 成功

## 依赖技能

- 安装位置：`C:\data\dsh\_fakedsh\skills`
- 本插件**不打包**第三方技能代码，安装时按 `skills-manifest.json`
  从各上游仓库（GitHub）按需下载，版权与许可证归原作者
- 若你的 DSH 已有同名技能，安装器会跳过不覆盖
- 上游来源与许可证见 `SKILLS-CREDITS.md`

补装/重试缺的技能：

```bash
python tools/fetch-skills.py --list     # 看清单
python tools/fetch-skills.py            # 下载缺的
python tools/fetch-skills.py --only aihot
```

## 下一步

1. **让 DSH 加载插件**（见上面第 4 步的说明）
2. 重启 DSH，侧边栏会出现「创作工作台」
3. 首次使用前，可选：抓一次热榜素材

```bash
python tools/gen-materials.py   # 抓 7 平台热榜（需要网络）
python tools/gen-topics.py      # 从素材生成选题
```

## 可选配置

需要图片生成？在环境变量或 `aws.env` 里配：

```
IMAGE_MODEL_API_KEY=你的key
```

数据默认放在插件目录内。想换位置就设环境变量：

```
DSH_WORKBENCH_HOME=D:\my-workbench
```
