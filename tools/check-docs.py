#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""README 漂移检测：把文档里的声明当断言，跟代码实际状态对账。

    python tools/check-docs.py          # 对账，漂移时退出码 1

为什么需要它：2026-10-06 出现了两次文档与代码不符——
  1. README 停留在「数据层还没接」，而实际已有 4 张表、7 条路由
  2. 写进 README 的「6 张表」是用 grep 数出来的，把 docstring 里的中文也数进去了
靠"记得改文档"管不住，所以做成可检测的。

检查项：表清单 / 路由清单 / 状态机 / 命令速查 / 文件结构 / 关键数字。
"""

import io
import os
import re
import sqlite3
import sys

# 「跑一次才生成」的产物：允许缺失，存在时必须与 README 一致。
# 开源包不含这些（20MB 本地数据），但 README 文件树里应当写明它们的存在，
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
README = os.path.join(PLUGIN, "README.md")
DB_PY = os.path.join(HERE, "workbench-db.py")
INDEX_JS = os.path.join(PLUGIN, "lib", "index.js")
TPL_JS = os.path.join(PLUGIN, "lib", "client.template.js")
DB_FILE = os.path.join(os.path.dirname(PLUGIN), "workbench", "workbench.db")

problems = []
checked = []


def note(ok, label, detail=""):
    checked.append((ok, label, detail))
    if not ok:
        problems.append(f"{label}：{detail}")


def read(p):
    return io.open(p, encoding="utf-8").read()


doc = read(README)
db_py = read(DB_PY)
index_js = read(INDEX_JS)
tpl = read(TPL_JS)

# ── 1. 表清单 ──
# 文档：第三节表格里的 `表名`
doc_tables = set(re.findall(r"(?m)^\| `(\w+)` \| [^|]+ \| [^|]+ \|$", doc))
if not doc_tables:
    # 宽松兜底：抓第三节到第四节之间的反引号表名
    seg = doc.split("## 三、")[1].split("## 四、")[0]
    doc_tables = set(re.findall(r"^\| `(\w+)` \|", seg, re.M))
real_tables = set()
if os.path.exists(DB_FILE):
    con = sqlite3.connect(DB_FILE)
    real_tables = {n for (n,) in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'") if n != "sqlite_sequence"}
    con.close()
else:
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
doc_states = []
# 允许行首缩进（状态机写在代码块里）
m = re.search(r"^\s*(\w+) → ([\w →]+)$", doc, re.M)
if m:
    doc_states = [m.group(1)] + m.group(2).split(" → ")
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
tree = doc.split("## 七、文件结构")[1].split("## 八、")[0] if "## 七、文件结构" in doc else ""
for f in re.findall(r"^[│├└─\s]*([\w.\-]+\.(?:json|yml|js|py|md))", tree, re.M):
    p = os.path.join(PLUGIN, f)
    found = os.path.exists(p) or any(
        os.path.exists(os.path.join(PLUGIN, d, f)) for d in ("lib", "tools", ""))
    # 可选产物（跑一次才生成）缺失不算错——开源包不含本地数据，
    # 但 README 该写它们的存在，否则使用者不知道会多出什么。
    if not found and f in OPTIONAL_GENERATED:
        continue
    note(found, f"文件结构·{f}", "README 列了但文件不存在")

# ── 7. 反向：实际存在的文件有没有写进 README ──
# （2026-10-06 补：新增了两个工具却忘了写进 README，此前只查一个方向，查不出来）
listed = set(re.findall(r"([\w.\-]+\.(?:json|yml|js|py|md))", tree))
SKIP = {"client.js", "本地数据说明.md"}          # 生成物，README 在同段说明了，不单列
for sub in ("lib", "tools"):
    dp = os.path.join(PLUGIN, sub)
    if not os.path.isdir(dp):
        continue
    for f in sorted(os.listdir(dp)):
        if (not os.path.isfile(os.path.join(dp, f)) or f.startswith("_")
                or f.endswith(".snapshot.json") or f in SKIP):
            continue
        note(f in listed, f"反向·{sub}/{f}",
             "文件存在，但 README 的文件结构里没有它（新增文件要补进 README）")

# ── 输出 ──
print("README 漂移检测")
print("=" * 60)
for ok, label, detail in checked:
    print(f"  {'✅' if ok else '❌'} {label}" + (f"  —— {detail}" if not ok else ""))
print("=" * 60)
if problems:
    print(f"发现 {len(problems)} 处漂移，README 与代码不一致：")
    for p in problems:
        print("  · " + p)
    print("\n→ 改代码后请同步 README；改 README 后请复核断言格式。")
    sys.exit(1)
print(f"全部 {len(checked)} 项一致。")
sys.exit(0)
