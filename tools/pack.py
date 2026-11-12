#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包 dsh-workbench 插件 → dist/dsh-workbench-<版本>.zip

    python tools/pack.py              # 只打包
    python tools/pack.py --dry-run    # 只列清单，不写文件

为什么要有这个脚本（2026-11-12）：
    之前 dist/ 里那份是手工复制的快照，写完后代码又改了很多轮，
    README 停在 100.6KB、docs/ 根本没进去，等于发出的是旧版本。
    手工复制管不住，所以做成一条命令。

包含什么 / 排除什么：
    包含：lib/ tools/ docs/ writing-dna/ skills/ + 根目录的 md/yml/py/json
    排除：__pycache__、_t.json/_d.json 这类调试残留、drafts/ image-studio/
          workbench/（都是本地数据，几十 MB，不该进包）

版本号从 package.json 读，包内目录名与之一致。
"""

import json
import os
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
DIST = os.path.join(os.path.dirname(PLUGIN), "dist")

# 进包的目录
# 注意：不含 skills/ —— 技能不随包发布，由 fetch-skills.py 在安装后
# 从 GitHub 下载到 $DSH_HOME/skills（仓库里没有技能源码，这是设计如此）。
INCLUDE_DIRS = ["lib", "tools", "docs", "writing-dna"]
# 根目录下进包的文件类型
INCLUDE_EXTS = {".md", ".json", ".yml", ".yaml", ".py", ".txt"}
# 无论在哪都排除
EXCLUDE_NAMES = {"__pycache__", ".git", ".DS_Store", "node_modules"}
EXCLUDE_SUFFIX = (".pyc", ".pyo")
# 根目录里明确不打包的（本地数据 / 调试残留）
EXCLUDE_ROOT = {"_t.json", "_d.json", ".env", ".jzl.env"}
# lib/ 里的本地数据快照：装完跑 build.py 会重新生成，
# 打进去只会让包变大（materials 737KB / xhs-hot 8MB / gzh-hot 435KB）
EXCLUDE_SNAPSHOTS = {
    "db.snapshot.json", "materials.snapshot.json", "xhs-hot.snapshot.json",
    "gzh-hot.snapshot.json", "sports.snapshot.json", "topics.generated.json",
    "vd744-analysis.json", "vd744-index.json", "img-catalog.json",
}


def version():
    p = os.path.join(PLUGIN, "package.json")
    try:
        return json.load(open(p, encoding="utf-8")).get("version") or "0.0.0"
    except Exception:
        return "0.0.0"


def walk_rel(root):
    """产出 (绝对路径, 相对 root 的路径)，跳过排除项。"""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_NAMES]
        for f in filenames:
            if f in EXCLUDE_NAMES or f.endswith(EXCLUDE_SUFFIX):
                continue
            ap = os.path.join(dirpath, f)
            yield ap, os.path.relpath(ap, root)


def build_manifest():
    items = []
    # ① 包含目录
    for d in INCLUDE_DIRS:
        p = os.path.join(PLUGIN, d)
        if not os.path.isdir(p):
            print(f"  ⚠️ 目录不存在，跳过：{d}")
            continue
        for ap, rel in walk_rel(p):
            if d == "lib" and os.path.basename(rel) in EXCLUDE_SNAPSHOTS:
                continue
            items.append((ap, os.path.join(d, rel)))
    # ② 根目录散文件
    for f in sorted(os.listdir(PLUGIN)):
        ap = os.path.join(PLUGIN, f)
        if not os.path.isfile(ap):
            continue
        if f in EXCLUDE_ROOT or f.startswith("."):
            continue
        if os.path.splitext(f)[1].lower() not in INCLUDE_EXTS:
            continue
        items.append((ap, f))
    return items


def main():
    dry = "--dry-run" in sys.argv
    ver = version()
    name = f"dsh-workbench-{ver}"
    out_zip = os.path.join(DIST, name + ".zip")
    stage = os.path.join(DIST, name)

    items = build_manifest()
    total = sum(os.path.getsize(a) for a, _ in items)
    print(f"  版本 {ver}，共 {len(items)} 个文件，{total/1024/1024:.2f} MB")

    # 按顶层分组报一下，方便核对
    from collections import Counter
    grp = Counter(r.split(os.sep)[0] if os.sep in r else "(根目录)" for _, r in items)
    for k, v in sorted(grp.items()):
        print(f"    {k:<16} {v:>4} 个")

    if dry:
        print("\n  === dry-run：文件清单（前 20）===")
        for _, r in items[:20]:
            print(f"    {r}")
        return 0

    # ① 清旧
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    if os.path.isfile(out_zip):
        os.remove(out_zip)

    # ② 复制到 staging
    os.makedirs(stage, exist_ok=True)
    for ap, rel in items:
        dst = os.path.join(stage, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(ap, dst)
    print(f"\n  ✅ staging 就绪：{stage}")

    # ③ 打 zip
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for ap, rel in items:
            z.write(ap, os.path.join(name, rel))
    size = os.path.getsize(out_zip)
    print(f"  ✅ 打包完成：{out_zip}  ({size/1024/1024:.2f} MB)")

    # ④ 校验：zip 里的条目数对不对
    with zipfile.ZipFile(out_zip) as z:
        n = len(z.namelist())
        has_docs = any("docs/screenshots/" in x for x in z.namelist())
    print(f"     条目 {n} 个，docs/screenshots 在包内：{'是' if has_docs else '否'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
