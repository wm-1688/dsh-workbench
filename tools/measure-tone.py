#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测一篇稿子的 AI 味标记频率（用 lieflat 的量尺脚本），便于前后对比。"""
import io
import os
import re
import shutil
import subprocess
import sys

SCRIPT = r"C:\data\test\.dsh\skills\lieflat-less-ai-tone\scripts\check-translationese.py"
TMP = r"C:\data\test\_measure"


def measure(md_path, label):
    if os.path.isdir(TMP):
        shutil.rmtree(TMP)
    os.makedirs(TMP)
    shutil.copy(md_path, os.path.join(TMP, label + ".md"))
    r = subprocess.run([sys.executable, "-X", "utf8", SCRIPT, TMP],
                       capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout or "") + (r.stderr or "")
    rows = []
    for line in out.splitlines():
        m = re.match(r"^(\S.*?)\s{2,}([\d.]+)\s+(\d+)\s+(\d+/\d+)", line)
        if m:
            rows.append((m.group(1).strip(), float(m.group(2)), int(m.group(3))))
    return rows, out


if __name__ == "__main__":
    md, label = sys.argv[1], sys.argv[2]
    rows, out = measure(md, label)
    print(f"  —— 标记频率（每千汉字）· {label} ——")
    for name, per, total in rows:
        if total:
            print(f"    {per:>6.2f}  ×{total:<3} {name}")
    nonZero = [r for r in rows if r[2]]
    print(f"\n  命中项: {len(nonZero)} / {len(rows)}")
    print(f"  总命中次数: {sum(r[2] for r in rows)}")
    if os.path.isdir(TMP):
        shutil.rmtree(TMP)
