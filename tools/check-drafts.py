#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""草稿路由一致性闸门。

为什么需要它：drafts.skill / skill_class 是**建草稿那一刻**按 route_writing(赛道)
算出来并写进行里的。路由表一改，已建草稿不会跟着变——于是「赛道是 AI 与科技、
技能却是 aws-wechat-article-writing」这种不一致会悄悄留着，写作阶段照着旧技能写，
产出跟赛道对不上。没有任何东西会报警。

判定：
  · status='queued'（还没写）→ **错误**，必须改：改它零成本，且不改就会写错
  · 已开写的（word_count>0）→ **提醒**，不报错：稿件是在旧规则下写的，改了反而与事实不符

用法：
  python tools/check-drafts.py            # 检查，有问题退出码 1
  python tools/check-drafts.py --fix      # 顺手把 queued 的改过来
"""
import argparse
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import importlib.util

spec = importlib.util.spec_from_file_location("wdb", os.path.join(HERE, "workbench-db.py"))
wdb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wdb)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="修正 queued 草稿的 skill / skill_class")
    args = ap.parse_args()

    conn = wdb.connect()
    rows = list(conn.execute(
        "SELECT id, title, track, skill, skill_class, status, word_count, config_json"
        " FROM drafts ORDER BY id"))

    errors, warns, fixed = [], [], 0
    manual = 0
    for r in rows:
        # 用户手选的技能不该被赛道路由覆盖（2026-10-25 起改为手选）。
        # 判据：config_json 非空 = 用户走过「创作配置」弹窗，技能是他选的。
        # 实测 config_json 里不存 skill（skill 是独立列），所以不能查字段。
        is_manual = False
        try:
            import json as _json
            cfg = _json.loads(r["config_json"] or "{}")
            is_manual = bool(cfg)
        except Exception:
            is_manual = False
        if is_manual:
            manual += 1
            continue

        want_skill, want_class = wdb.route_writing(r["track"] or "")
        if (r["skill"] or "", r["skill_class"] or "") == (want_skill, want_class):
            continue
        written = (r["word_count"] or 0) > 0
        item = (r["id"], r["track"], r["skill"], r["skill_class"], want_skill, want_class)
        if r["status"] == "queued" and not written:
            errors.append(item)
            if args.fix:
                conn.execute("UPDATE drafts SET skill=?, skill_class=? WHERE id=?",
                             (want_skill, want_class, r["id"]))
                fixed += 1
        else:
            warns.append(item)

    if args.fix and fixed:
        conn.commit()

    if not rows:
        print("  （创作库还没有草稿）")
    elif not errors and not warns:
        tail = f"（另有 {manual} 篇用户手选，不参与路由校验）" if manual else ""
        print(f"  ✅ {len(rows)} 篇草稿的技能与赛道路由一致{tail}")
    else:
        if errors:
            print(f"  ❌ {len(errors)} 篇 queued 草稿的技能与当前路由不一致"
                  f"（还没写，改它零成本）：")
            for i, tr, sk, kl, ws, wk in errors:
                print(f"      #{i} 赛道={tr or '—'}")
                print(f"          现状 {sk} ({kl})  →  应为 {ws} ({wk})")
            if args.fix:
                print(f"  ✅ 已修正 {fixed} 篇（重新运行确认）")
            else:
                print("      修法：python tools/check-drafts.py --fix")
        if warns:
            print(f"  ⚠️  {len(warns)} 篇已开写的草稿与当前路由不一致"
                  f"（稿件是在旧规则下写的，保持原样，仅提示）：")
            for i, tr, sk, kl, ws, wk in warns:
                print(f"      #{i} 赛道={tr or '—'}  现状 {sk} ({kl})，现规则为 {ws} ({wk})")

    conn.close()
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
