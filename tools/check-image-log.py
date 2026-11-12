#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按真实编码读生图日志，统计告警/失败。

为什么单独做：PowerShell 的 `>` 重定向写的是 **UTF-16LE**，而日志里全是 ASCII 标记
（[WARN] / [ERROR]）。任何按 UTF-8 读的检查都会因为字符间夹着 NUL 而匹配不到，
于是「生成日志已看过、无告警」变成一句假话。技能自检第 5 条正是要求看这个。
"""
import os
import sys


def read_log(p):
    b = open(p, "rb").read()
    for enc in ("utf-8-sig", "utf-16", "utf-8", "gbk"):
        try:
            return b.decode(enc), enc
        except Exception:
            continue
    return b.decode("utf-8", errors="replace"), "utf-8/replace"


def main():
    dirs = sys.argv[1:] or [r"C:\data\test\drafts\20261011-pingfenbiao"]
    bad = 0
    for d in dirs:
        p = os.path.join(d, "image-generation.log")
        if not os.path.exists(p):
            print(f"  ·  {os.path.basename(d):<26} 无日志")
            continue
        t, enc = read_log(p)
        warns = t.count("[WARN]")
        errs = t.count("[ERROR]")
        oks = t.count("[OK]")
        print(f"  {os.path.basename(d):<26} 编码={enc:<10} 图 {oks} 张  告警 {warns}  失败 {errs}")
        for line in t.splitlines():
            if "[WARN]" in line or "[ERROR]" in line:
                print(f"       {line.strip()[:110]}")
        if errs:
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
