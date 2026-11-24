#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""README 漂移检测：把文档里的声明当断言，跟代码实际状态对账。

    python tools/check-docs.py          # 对账，漂移时退出码 1

为什么需要它：2026-10-06 出现了两次文档与代码不符——
  1. README 停留在「数据层还没接」，而实际已有 4 张表、7 条路由
  2. 写进 README 的「6 张表」是用 grep 数出来的，把 docstring 里的中文也数进去了
靠"记得改文档"管不住，所以做成可检测的。

文档分两份（2026-11-12 起）：
  README.md       面向用户：功能、安装、依赖、免责
  DEVELOPMENT.md  面向开发：表结构、路由、文件结构、命令速查、踩坑记录
断言可以写在其中任意一份，本脚本把两份合起来对账。

检查项：表清单 / 路由清单 / 状态机 / 命令速查 / 文件结构 / 关键数字。
"""

import io
import os
import re
import sqlite3
import sys

# 「跑一次才生成」的产物：允许缺失，存在时必须与 README 一致。
# 开源包不含这些（20MB 本地数据），但文档文件树里应当写明它们的存在，
# 否则使用者不知道跑完 build 会多出什么。缺失时 check-docs 不报错。
OPTIONAL_GENERATED = {
    "lib/client.js",
    "lib/db.snapshot.json",
    "lib/materials.snapshot.json",
    "lib/topics.generated.json",
    "lib/img-catalog.json",
    "lib/vd744-analysis.json",
    "lib/vd744-index.json",
    "lib/vd744-topics.md",
    "lib/gzh-rank-summary.json",
    "lib/gzh-deep-stats.json",
    "lib/gzh-hot.snapshot.json",
    "lib/xhs-hot.snapshot.json",
    "lib/sports.snapshot.json",
}

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
DOC_NAMES = ["README.md", "DEVELOPMENT.md"]
DB_PYS = [os.path.join(HERE, "workbench-db.py"),
          os.path.join(HERE, "image-db.py")]
INDEX_JS = os.path.join(PLUGIN, "lib", "index.js")
TPL_JS = os.path.join(PLUGIN, "lib", "client.template.js")
# 库位置交给 ws_path 解析：装到 profile 里或另设 DSH_WORKBENCH_HOME 时，
# 硬写 PLUGIN/.. 会指到不存在的目录，读不到库就退化成「文档说 10 张、实际 0 张」。
sys.path.insert(0, HERE)
import ws_path
DB_CANDIDATES = [os.path.join(ws_path.resolve_workspace(PLUGIN), "workbench", "workbench.db"),
                 os.path.join(PLUGIN, "workbench", "workbench.db"),
                 os.path.join(os.path.dirname(PLUGIN), "workbench", "workbench.db")]

problems = []
checked = []


def note(ok, label, detail=""):
    checked.append((ok, label, detail))
    if not ok:
        problems.append(f"{label}：{detail}")


def read(p):
    return io.open(p, encoding="utf-8").read()


# 两份文档合并对账：断言写在哪一份都认
docs = {}
for name in DOC_NAMES:
    p = os.path.join(PLUGIN, name)
    docs[name] = read(p) if os.path.isfile(p) else ""
doc = "\n".join(docs.values())
db_py = "\n".join(read(p) for p in DB_PYS if os.path.isfile(p))
index_js = read(INDEX_JS)
tpl = read(TPL_JS)

# ── 1. 表清单 ──
# 文档：表清单表格里的 `表名`（三列或两列都认）
doc_tables = set(re.findall(r"(?m)^\| `(\w+)` \| [^|]+ \| [^|]+ \|$", doc))
if not doc_tables:
    # 宽松兜底：抓所有表格行首的反引号标识符
    doc_tables = set(re.findall(r"(?m)^\| `(\w+)` \|", doc))
real_tables = set()
for p in DB_CANDIDATES:
    if os.path.exists(p):
        con = sqlite3.connect(p)
        real_tables = {n for (n,) in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")
            if n != "sqlite_sequence"}
        con.close()
        break
else:
    # 建表语句分布在两个数据层脚本里，都要数
    real_tables = set(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)\s*\(", db_py))
note(doc_tables == real_tables, "表清单",
     f"文档 {sorted(doc_tables)} ≠ 实际 {sorted(real_tables)}")

# ── 2. 关键数字：N 张表 ──
m = re.search(r"SQLite（(\d+) 张业务表）", doc)
if m:
    note(int(m.group(1)) == len(real_tables), "「N 张业务表」",
         f"文档写 {m.group(1)}，实际 {len(real_tables)}")
else:
    note(False, "「N 张业务表」", "README 里找不到该声明（格式应为 `SQLite（4 张业务表）`）")

# ── 3. 路由清单 ──
doc_routes = set(re.findall(r"(?m)^\| `(/api/workbench/[a-z-]+)` \|", doc))
if not doc_routes:
    doc_routes = set(re.findall(r"/api/workbench/[a-z-]+", doc)) - {"/api/workbench/"}
real_routes = set(re.findall(r"path: '(/api/workbench/[a-z-]+)'", index_js))
note(doc_routes == real_routes, "路由清单",
     f"文档缺 {sorted(real_routes - doc_routes)}；文档多 {sorted(doc_routes - real_routes)}")

m = re.search(r"API 路由（(\d+) 条", doc)
if m:
    note(int(m.group(1)) == len(real_routes), "「N 条路由」",
         f"文档写 {m.group(1)}，实际 {len(real_routes)}")
else:
    note(False, "「N 条路由」", "README 里找不到该声明（格式应为 `API 路由（7 条，`）")

# ── 4. 状态机 ──
# 两种写法都认：表格行 `| `drafts` | … | `queued → draft → …` |`，
# 或独立一行 `drafts : queued → draft → …`
doc_states = []
m = re.search(r"`(\w+ → [\w →]+)`", doc)
if m:
    doc_states = m.group(1).split(" → ")
else:
    m = re.search(r"^\s*drafts\s*:?\s*(\w+(?: → \w+)+)\s*$", doc, re.M)
    if m:
        doc_states = m.group(1).split(" → ")
m2 = re.search(r"const DRAFT_STAGES = \[([^\]]+)\]", tpl)
real_states = re.findall(r"'(\w+)'", m2.group(1)) if m2 else []
note(doc_states == real_states, "状态机",
     f"文档 {doc_states} ≠ 实际 {real_states}")

# ── 5. 命令速查 ──
seg = doc.split("### 命令速查")[1].split("##")[0] if "### 命令速查" in doc else ""
doc_cli = set(re.findall(r"workbench-db\.py (\w[\w-]*)", seg))
real_cli = set(re.findall(r'sub\.add_parser\("([\w-]+)"', db_py))
doc_api = set(re.findall(r"wb\.py (\w[\w-]*)", seg))
real_api = set(re.findall(r'op == "([\w-]+)"', db_py))
for label, d, r in [("命令速查·CLI", doc_cli, real_cli), ("命令速查·wb.py", doc_api, real_api)]:
    missing = sorted(d - r)
    note(not missing, label, f"文档里的 {missing} 在代码里不存在")

# ── 6. 文件结构 ──
# 文件树写在 DEVELOPMENT.md（面向开发）；README 只讲用户可见的目录。
tree = ""
for name in ("DEVELOPMENT.md", "README.md"):
    d = docs.get(name, "")
    for head in ("## 七、文件结构", "## 目录结构", "## 文件结构"):
        if head in d:
            tail = d.split(head, 1)[1]
            tree = tail.split("\n## ", 1)[0]
            break
    if tree:
        break
# 只从**树线行**里取文件名：必须以 │ ├ └ 开头（允许前导空格）。
# 不能用「行首任意字符」去匹配 —— 正文里的 `_sync_env_file()`（`workbench-db.py`
# 这种句子会被当成文件名，误报到文档漂移里。
# 文件名可能含中文与空格（如「大小姐方法论·全9讲整理.md」），
# 所以树线之后的字符类放宽到「非树线、非路径分隔符」。
#
# 取**每行第一个**带目标扩展名的词（树里文件名在最前面，后面是说明文字）。
# 不能要求行尾锚定 —— 绝大多数行后面都跟着一句用途说明。
#
# 实现：逐行处理 —— 剥掉树线前缀，取第一个空白分隔的 token 当文件名。
# 正则跨行回溯会把说明文字里的 `gzh-fetch.py` / `package.json` 也抓进来，
# 那是错的；按行切 token 不会。
# 图标等资源也要能被反向检查认到（media/ 下是 png/svg）
TREE_EXTS = (".json", ".yml", ".yaml", ".js", ".py", ".md", ".png", ".svg", ".jpg")
_tree_names = []
for _ln in tree.splitlines():
    _s = _ln.strip()
    if not _s or _s[0] not in "│├└":
        continue
    # 去掉开头的树线字符与空格
    _s = re.sub(r"^[│├└─\s]+", "", _s)
    if not _s:
        continue
    _tok = _s.split()[0]
    if _tok.lower().endswith(TREE_EXTS):
        _tree_names.append(_tok)
for f in _tree_names:
    p = os.path.join(PLUGIN, f)
    found = os.path.exists(p) or any(
        os.path.exists(os.path.join(PLUGIN, d, f))
        for d in ("lib", "tools", "locale", "docs", "media", "assets", ""))
    # 可选产物（跑一次才生成）缺失不算错——开源包不含本地数据，
    # 但文档该写它们的存在，否则使用者不知道会多出什么。
    # 集合里存的是 `lib/xxx.json` 全路径，这里比裸文件名，两种都认。
    if not found and (f in OPTIONAL_GENERATED
                      or os.path.basename(f) in {os.path.basename(x)
                                                 for x in OPTIONAL_GENERATED}):
        continue
    note(found, f"文件结构·{f}", "文档列了但文件不存在")

# ── 7. 反向：实际存在的文件有没有写进文档 ──
# （2026-10-06 补：新增了两个工具却忘了写进文档，此前只查一个方向，查不出来）
listed = set(_tree_names)
SKIP = {"client.js", "本地数据说明.md"}          # 生成物，文档在同段说明了，不单列
for sub in ("lib", "tools", "locale", "docs", "media", "assets"):
    dp = os.path.join(PLUGIN, sub)
    if not os.path.isdir(dp):
        continue
    for f in sorted(os.listdir(dp)):
        if (not os.path.isfile(os.path.join(dp, f)) or f.startswith("_")
                or f.endswith(".snapshot.json") or f in SKIP):
            continue
        note(f in listed, f"反向·{sub}/{f}",
             "文件存在，但文档的文件结构里没有它（新增文件要补进 DEVELOPMENT.md）")

# ── 输出 ──
print("文档漂移检测（README + DEVELOPMENT）")
print("=" * 60)
for ok, label, detail in checked:
    print(f"  {'✅' if ok else '❌'} {label}" + (f"  —— {detail}" if not ok else ""))
print("=" * 60)
if problems:
    print(f"发现 {len(problems)} 处漂移，文档与代码不一致：")
    for p in problems:
        print("  · " + p)
    print("\n→ 改代码后请同步文档；改文档后请复核断言格式。")
    sys.exit(1)
print(f"全部 {len(checked)} 项一致。")
sys.exit(0)
