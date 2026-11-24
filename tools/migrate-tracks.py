# -*- coding: utf-8 -*-
"""把库里旧赛道名迁移到新的 15 垂类体系。

策略：**按标题重新判断**，而不是简单映射。
  「体育与健康」里的养生文应该去「健康」不是「体育」，
  「教育与职场」里的职场文应该去「职场」不是「教育」。
  简单映射会把一半内容分错，那还不如不迁。

判断用 gen-topics 的 TRACKS 词表（和赛道订阅筛选同一套），
命中多的胜出；一个都不命中才退回映射表。

用法：
  python tools/migrate-tracks.py --check   # 只看会怎么改，不写
  python tools/migrate-tracks.py           # 真改
"""
import io
import os
import sqlite3
import sys
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
WORKSPACE = os.path.dirname(PLUGIN)
DB = os.path.join(WORKSPACE, "workbench", "workbench.db")

NEW_TRACKS = ["社会民生", "国际与时事", "AI 与科技", "财经与商业", "文化与生活",
              "娱乐", "体育", "健康", "教育", "亲子家庭", "职场",
              "情绪心理", "两性关系", "女性成长", "人生感悟"]

# 旧合并名 → 兜底归属（只在标题一个词都命中不了时用）
OLD_FALLBACK = {
    "体育与健康": "健康",
    "教育与职场": "职场",
    "娱乐与情感": "娱乐",
    "健康养生": "健康",
    "职场成长": "职场",
    "婚姻经营": "两性关系",
}


def load_tracks():
    spec = importlib.util.spec_from_file_location("_gt", os.path.join(HERE, "gen-topics.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.TRACKS


def best_track(title, tracks, old_track=""):
    """按词表打分选赛道。

    **旧合并名是一条强提示，不是干扰**：
    原来只按词表命中数打分，结果「到校时间改了，但接孩子的人没变」里
    「孩子」命中了社会民生、「到校」没命中教育 → 被判成社会民生，
    而这个内容显然该在「教育」。旧名本身就是"这条属于这两类之一"的信息。

    做法：旧合并名拆出的候选项各自 +2 分（相当于命中两个词），
    只有当别的赛道命中数明显更多时才被压过。
    """
    t = title or ""
    # 旧合并名 → 它可能的归宿
    HINT = {
        "体育与健康": ("体育", "健康"),
        "教育与职场": ("教育", "职场"),
        "娱乐与情感": ("娱乐", "两性关系", "情绪心理"),
        "健康养生": ("健康",),
        "职场成长": ("职场",),
        "婚姻经营": ("两性关系",),
    }
    hinted = HINT.get(old_track, ())

    scores = {}
    for name, cfg in tracks.items():
        n = sum(1 for k in (cfg.get("kw") or []) if k in t)
        if name in hinted and n > 0:
            # 旧名只在**该赛道自己也命中了词**时才加分。
            # 不加这个条件会出现「立冬之后身体该睡了」被判成体育 ——
            # 它一个体育词都没命中，全靠旧名「体育与健康」的加分抬上去。
            n += 1
        if n > 0:
            scores[name] = n
    if not scores:
        return None
    # 分数最高的胜出；同分取词表里靠前的（词表已按具体度排过）
    best_n = max(scores.values())
    for name in tracks:
        if scores.get(name) == best_n:
            return name
    return None


def main():
    check_only = "--check" in sys.argv
    tracks = load_tracks()
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    plan = []
    for tbl, title_col in (("drafts", "title"), ("topics", "title")):
        rows = conn.execute(
            "SELECT id, track, %s AS ttl FROM %s "
            "WHERE track IS NOT NULL AND track <> ''" % (title_col, tbl)).fetchall()
        for r in rows:
            old = r["track"]
            if old in NEW_TRACKS:
                continue
            new = best_track(r["ttl"], tracks, old) or OLD_FALLBACK.get(old)
            if not new:
                print("  ⚠️ %s#%s 判不出来，保留原样：%r" % (tbl, r["id"], old))
                continue
            plan.append((tbl, r["id"], old, new, r["ttl"] or ""))

    print("需要迁移 %d 条：" % len(plan))
    from collections import Counter
    # 按「旧→新」汇总
    summary = Counter((p[2], p[3]) for p in plan)
    for (old, new), n in sorted(summary.items(), key=lambda x: -x[1]):
        print("  %-10s → %-8s %d 条" % (old, new, n))

    print("\n逐条（前 20）：")
    for tbl, rid, old, new, ttl in plan[:20]:
        print("  %-7s#%-4s %-10s → %-8s  %s" % (tbl, rid, old, new, ttl[:34]))

    if check_only:
        print("\n--check：未写入。")
        conn.close()
        return 0

    for tbl, rid, old, new, _ in plan:
        conn.execute("UPDATE %s SET track=? WHERE id=?" % tbl, (new, rid))
    conn.commit()
    print("\n✅ 已更新 %d 条" % len(plan))

    # 复核
    for tbl in ("drafts", "topics"):
        left = conn.execute(
            "SELECT track, COUNT(*) n FROM %s WHERE track IS NOT NULL AND track <> '' "
            "AND track NOT IN (%s) GROUP BY track" %
            (tbl, ",".join("?" * len(NEW_TRACKS))), NEW_TRACKS).fetchall()
        bad = [(r["track"], r["n"]) for r in left]
        print("  %s 里剩余的旧赛道名：%s" % (tbl, bad if bad else "无"))
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
