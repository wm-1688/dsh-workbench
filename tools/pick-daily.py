#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按账号订阅赛道，挑出每天最值得写的选题。

    python tools/pick-daily.py                  # 看今天该写哪几篇
    python tools/pick-daily.py --json           # 机器可读
    python tools/pick-daily.py --slot 1         # 只看账号 1
    python tools/pick-daily.py --dry            # 不标记为 writing

为什么单独一个脚本，不塞进 topic-pipeline：
    topic-pipeline 负责「把素材变成选题」，是**生产**；
    这个脚本负责「从已有选题里挑哪几篇来写」，是**消费决策**。
    两件事的输入输出完全不同，混在一起会让 pipeline 越来越难改。

选优规则（先过滤，再排序）：
    ① 过滤：status 必须是 candidate（已写/已放弃的不要）
    ② 过滤：score_window >= 1（过期的热点不写）
    ③ 过滤：该账号还没写过这个素材（避免两个号撞题）
    ④ 排序：加权总分，权重见 WEIGHTS
    ⑤ 每个「账号 × 赛道」取最高分那一条

为什么窗口权重最低但必须过门槛：
    时效窗口是「能不能写」的问题（过期就没意义），
    不是「值不值得写」的问题（不该因为它高就优先）。
    所以它做门槛，不做排序主力。
"""
import argparse
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
WORKSPACE = os.path.dirname(PLUGIN)
DB = os.path.join(WORKSPACE, "workbench", "workbench.db")

# 加权总分。权重不是拍的，按「对打开率的影响程度」排：
#   情绪势能 > 受众基数 > 差异化 > 时效窗口
# 情绪决定「想不想点」，受众决定「有多少人想点」，这两个是量级差异；
# 差异化决定「在同类里能不能被选中」，是竞争因素；
# 时效窗口只做门槛（见上），给个低权重兜底同分情况。
WEIGHTS = {
    "emotion": 1.5,
    "audience": 1.2,
    "difference": 1.0,
    "window": 0.8,
}

WINDOW_MIN = 1          # 时效窗口硬门槛

# ── 赛道 → 写作技能 / 风格 ────────────────────────────────────────
#
# 用户定的规则（2026-11-18）：
#   AI 与科技   → khazix-writer
#   娱乐        → write-entertainment-wechat-articles
#   其余所有    → aws-wechat-article-writing
#   风格统一     → MS-008（人格叙事体）
#
# 为什么风格都统一成 MS-008：用户明确要求三个技能都用「人格叙事体」。
# 技能定的是「怎么写这类题材」（结构/素材处理），风格定的是「用什么语气」，
# 两者不冲突，所以可以交叉组合。
STYLE_CODE = "MS-008"
STYLE_NAME = "人格叙事体"

SKILL_BY_TRACK = {
    "AI 与科技": ("khazix-writer", "卡兹克长文"),
    "娱乐": ("write-entertainment-wechat-articles", "娱乐成稿"),
}
SKILL_DEFAULT = ("aws-wechat-article-writing", "公众号写稿")


def skill_for(track):
    """按赛道给写作技能。返回 (skill_name, 中文名)。"""
    return SKILL_BY_TRACK.get(track, SKILL_DEFAULT)
#
# 只挑「今天生成的」选题，不用滚动 24 小时。
#
# 为什么：实测发现滚动 24 小时会把昨天下午的选题也算进来，
# 于是早上 7:15 跑的时候，选出来的可能是**昨天**的热点 ——
# 而昨天那批大概率已经写过了（有 already_written 兜底），
# 但没写过的会被当成今天的，导致「今天的新素材反而排不上」。
#
# 按自然日切，语义更清楚：今天 7:15 生成选题，就写今天生成的。
FRESH_SQL = "date(created_at) = date('now','localtime')"


def load_settings(conn):
    """读设置表，返回 dict。"""
    out = {}
    for r in conn.execute("SELECT key, value FROM settings"):
        out[r[0]] = r[1]
    return out


def split_tracks(s):
    """赛道串 → 列表。分隔符和设置页一致：顿号 / 逗号 / 中文逗号。

    **不能按空格切** —— 赛道名本身带空格（「AI 与科技」）。
    """
    if not s:
        return []
    out = []
    for part in str(s).replace("，", "、").replace(",", "、").split("、"):
        p = part.strip()
        if p:
            out.append(p)
    return out


def score_of(row):
    """加权总分。缺字段按 0 算，不让一条脏数据把整个排序搞崩。"""
    return (
        (row.get("score_emotion") or 0) * WEIGHTS["emotion"]
        + (row.get("score_audience") or 0) * WEIGHTS["audience"]
        + (row.get("score_difference") or 0) * WEIGHTS["difference"]
        + (row.get("score_window") or 0) * WEIGHTS["window"]
    )


def already_written(conn, source_key):
    """这个素材是不是已经有草稿了（任何账号）。

    判据用 source_key 而不是 topic id：同一个素材可能生成过多个选题，
    只要写过其中任何一个，就不该再写第二篇。
    """
    if not source_key:
        return False
    n = conn.execute(
        "SELECT COUNT(*) FROM topics t JOIN drafts d ON d.topic_id = t.id "
        "WHERE t.source_key = ?", (source_key,)).fetchone()[0]
    return n > 0


def account_ready(st, i):
    """这个账号槽位能不能参与自动创作。

    三道判断，缺一不可：
      ① AppId 和 AppSecret 都填了 —— **没填凭据的号根本发不出去**，
         写出来的稿子只能躺在库里，纯属浪费生图额度和时间。
         用户明确要求过这条（2026-11-18）。
      ② AutoWrite 开关打开 —— 填了凭据不代表要自动写，可能只是手动发布用。
      ③ Tracks 不为空 —— 不订赛道就不知道该写什么。

    返回 (能不能用, 原因)。原因用于界面/日志说明「为什么这个号没参与」，
    不然用户会觉得「我明明开了怎么没反应」。
    """
    app_id = (st.get("wechat%dAppId" % i) or "").strip()
    app_secret = (st.get("wechat%dAppSecret" % i) or "").strip()
    if not app_id or not app_secret:
        missing = []
        if not app_id:
            missing.append("AppId")
        if not app_secret:
            missing.append("AppSecret")
        return False, "没填 " + " 和 ".join(missing) + "，不参与自动创作"

    if st.get("wechat%dAutoWrite" % i) not in ("1", "true", "True", "on"):
        return False, "未开启「参与每日自动创作」"

    if not split_tracks(st.get("wechat%dTracks" % i)):
        return False, "没订阅赛道"

    return True, ""


def pick(conn, slot=None, mark=False):
    """核心逻辑。返回 [{slot, track, topic, reason}]。"""
    st = load_settings(conn)
    results = []

    slots = [slot] if slot else [1, 2, 3, 4, 5]
    skipped = {}          # 槽位 → 没参与的原因（凭据/开关/赛道），单独报给调用方
    for i in slots:
        ready, why = account_ready(st, i)
        if not ready:
            skipped[i] = why
            continue
        tracks = split_tracks(st.get("wechat%dTracks" % i))
        if not tracks:
            continue
        for track in tracks:
            # 取这个赛道**最近生成的**候选，按加权分降序。
            #
            # 为什么必须限时间：实测踩过 —— 库里躺着几十个历史选题，
            # 不加时间条件时，选出来的永远是「历史最高分」那篇，
            # 于是每天写的都是同一篇老稿，今天新生成的一个都用不上。
            # 「每日自动创作」的语义是**写今天的热点**，不是写历史库存。
            rows = conn.execute(
                "SELECT * FROM topics WHERE status='candidate' AND track=? "
                "AND " + FRESH_SQL,
                (track,)).fetchall()
            cands = []
            for r in rows:
                d = dict(r)
                if (d.get("score_window") or 0) < WINDOW_MIN:
                    continue                      # 门槛：过期的不写
                if already_written(conn, d.get("source_key")):
                    continue                      # 门槛：这个素材写过了
                d["_score"] = round(score_of(d), 2)
                cands.append(d)
            if not cands:
                results.append({
                    "slot": i, "track": track, "topic": None,
                    "reason": "该赛道没有可写的候选（都写过了 / 都过期了 / 还没生成）",
                })
                continue
            cands.sort(key=lambda x: (-x["_score"], -(x.get("id") or 0)))
            best = cands[0]
            sk, sk_zh = skill_for(track)
            results.append({
                "slot": i, "track": track, "topic": best,
                # 技能和风格由**赛道**决定，不由选题自己带。
                # 选题表里的 skill 字段是「生成选题用的技能」，不是写作技能，
                # 直接拿来用会变成 topic-pipeline（实测踩过）。
                "skill": sk, "skillName": sk_zh,
                "styleCode": STYLE_CODE, "styleName": STYLE_NAME,
                "reason": "加权分 %.2f（情绪%d 差异%d 受众%d 时效%d），该赛道 %d 个候选里最高"
                          % (best["_score"], best.get("score_emotion") or 0,
                             best.get("score_difference") or 0,
                             best.get("score_audience") or 0,
                             best.get("score_window") or 0, len(cands)),
            })
            if mark:
                conn.execute(
                    "UPDATE topics SET status='writing', updated_at=datetime('now','localtime') "
                    "WHERE id=?", (best["id"],))
    if mark:
        conn.commit()
    return results, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slot", type=int, default=None, help="只看某个账号槽位")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--dry", action="store_true", help="不把选中的标记成 writing")
    args = ap.parse_args()

    if not os.path.isfile(DB):
        print("❌ 数据库不存在：" + DB, file=sys.stderr)
        return 1

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    results, skipped = pick(conn, args.slot, mark=not args.dry)
    conn.close()

    if args.json:
        print(json.dumps({"picked": results,
                          "skipped": [{"slot": k, "reason": v}
                                      for k, v in sorted(skipped.items())]},
                         ensure_ascii=False, indent=2))
        return 0

    if not results:
        if skipped:
            print("今天没有要写的：没有账号满足「填了凭据 + 开启自动创作 + 订阅赛道」。")
            for k, v in sorted(skipped.items()):
                print("  账号%d —— %s" % (k, v))
        else:
            print("今天没有要写的（没有账号开启自动创作，或订阅赛道为空）")
        return 0

    print("=== 今天该写这几篇 ===")
    n_ok = 0
    for r in results:
        if r["topic"]:
            n_ok += 1
            t = r["topic"]
            print("\n  账号%d · %s" % (r["slot"], r["track"]))
            print("    #%s  %s" % (t["id"], t.get("title") or ""))
            print("    技能=%s（%s）  风格=%s（%s）" % (
                r["skill"], r["skillName"], r["styleCode"], r["styleName"]))
            print("    分=%s  " % t["_score"] + r["reason"])
        else:
            print("\n  账号%d · %s" % (r["slot"], r["track"]))
            print("    ⚠️ " + r["reason"])
    print("\n共 %d 篇待写" % n_ok)
    if skipped:
        print("\n🚫 未参与自动创作的账号：")
        for k, v in sorted(skipped.items()):
            print("  账号%d —— %s" % (k, v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
