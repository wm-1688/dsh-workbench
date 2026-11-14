#!/usr/bin/env python3
"""路由重复检查：同一 path 只能 register 一次。

为什么需要这道检查
------------------
DSH 的 slots 对同一 path **只认第一次注册**，第二次会被静默丢弃。
2026-11-13 踩过一次：给 draft-content 加了独立的 POST register，
结果 GET 正常、POST 报 404，排查了半天才发现是重复注册。

`node --check` 只查语法，查不出这种问题 —— 它语法完全合法。

判据
----
扫 lib/index.js 里所有 `path: '/api/...'`，同一字符串出现两次即报错。

退出码
------
0 通过 / 1 有重复
"""
import io
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))


def find_index():
    """优先当前工作目录下的 lib/index.js（测试时用），否则用插件目录。"""
    cand = os.path.join(os.getcwd(), "lib", "index.js")
    if os.path.isfile(cand):
        return cand
    return os.path.join(os.path.dirname(HERE), "lib", "index.js")


def scan(path):
    s = io.open(path, encoding="utf-8").read()
    # 只认 register 里的 path 字段
    hits = []
    for m in re.finditer(r"path:\s*['\"](/api/[^'\"]+)['\"]", s):
        hits.append((m.group(1), m.start()))
    return s, hits


def main():
    INDEX = find_index()
    if not os.path.isfile(INDEX):
        print(f"  ⚠️  找不到 {INDEX}，跳过")
        return 0

    s, hits = scan(INDEX)
    print(f"  文件：lib/index.js（{len(s)} 字符）")
    print(f"  路由：{len(hits)} 条")

    counter = Counter(p for p, _ in hits)
    dups = {p: n for p, n in counter.items() if n > 1}

    if not dups:
        print(f"  ✅ 无重复路由（{len(counter)} 个唯一路径）")
        return 0

    print(f"\n  ❌ 发现 {len(dups)} 个重复注册的路径：")
    for p, n in sorted(dups.items()):
        offsets = [o for pp, o in hits if pp == p]
        line_nos = [s.count("\n", 0, o) + 1 for o in offsets]
        print(f"     {p}  出现 {n} 次（第 {', '.join(map(str, line_nos))} 行）")
    print("\n  为什么是错：DSH 的 slots 对同一 path 只认第一次注册，")
    print("  后面那条会被静默丢弃 → 那个方法（GET/POST）永远 404。")
    print("\n  修法：合并成一条 register，用 methods: ['GET','POST']，")
    print("        handler 里按 request.method 分流。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
