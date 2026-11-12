#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从实力榜 HTML 抽账号 JSON（HTML 里内嵌 `var RAW = [...]`）。

榜单脚本只打印汇总，实际数据全在这段 JSON 里。抽出来后可以：
  · 按综合分/阅读量/转发量排序，挑对标候选
  · 用 accountId 喂给 querySimilarAccounts 做对标匹配
  · 用 accountId 喂给账号诊断做拆解
"""
import io
import json
import os
import re
import sys


def extract(path):
    t = io.open(path, encoding="utf-8", errors="replace").read()
    m = re.search(r"var RAW = (\[.*?\])\s*;", t, re.S)
    if not m:
        m = re.search(r"RAW\s*=\s*(\[[\s\S]*?\])\s*;\s*\(function", t)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception as e:
        print(f"  ❌ JSON 解析失败: {e}")
        return None


def main():
    paths = sys.argv[1:] or [r"C:\data\test\_tmp_gzh.html"]
    for p in paths:
        if not os.path.exists(p):
            print(f"  ❌ 不存在 {p}")
            continue
        rows = extract(p)
        if not rows:
            print(f"  ❌ {p} 未抽到 RAW")
            continue
        cat = rows[0].get("category", "?")
        print(f"\n  === {os.path.basename(p)}  分类 {cat}  共 {len(rows)} 个账号 ===\n")
        print(f"  {'#':>3} {'账号':<18}{'综合分':>7}{'总阅读':>9}{'头条阅读':>9}{'最高阅读':>9}{'点赞':>7}{'转发':>7}{'在看':>6}  发布")
        for r in rows[:25]:
            def n(k):
                v = r.get(k)
                try:
                    return f"{int(v):,}"
                except Exception:
                    return str(v)
            print(f"  {r.get('rankPosition',0):>3} {str(r.get('accountName'))[:16]:<18}"
                  f"{r.get('compositeScore',0):>7}{n('totalReadCount'):>9}{n('headlineReadCount'):>9}"
                  f"{n('maxReadCount'):>9}{n('totalLikeCount'):>7}{n('totalForwardCount'):>7}"
                  f"{n('totalInSeeCount'):>6}  {r.get('publishCount','')}")
        # 落盘
        out = os.path.join(os.path.dirname(p) or ".", "gzh-rank-" + cat + ".json")
        json.dump(rows, io.open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"\n  写入 {out}")


if __name__ == "__main__":
    main()
