#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一个分类的 100 个账号按内容方向切开，看哪个方向真能跑。

用法：
    python tools/gzh-seg.py 民生资讯          # 按民生细分方向切
    python tools/gzh-seg.py 知识百科 --list    # 直接列账号名
"""
import io
import json
import os
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
RANKDIR = os.path.join(PLUGIN, "lib", "gzh-rank")

# 民生细分方向：**顺序即优先级**，先命中先归类，避免「网」「生活」这类宽词乱抓
MINSHENG = OrderedDict([
    ("本地办事/同城", ["本地宝", "本地通", "同城", "便民", "微生活", "都市圈", "办事"]),
    ("地方媒体/都市报", ["晚报", "日报", "时报", "商报", "广播", "电视台", "融媒",
                    "新闻", "观察", "周刊", "融媒", "传媒"]),
    ("资讯聚合/早读", ["冯站长", "早读", "早餐", "夜读", "简报", "参考", "观天下",
                   "洞见", "文摘", "每日", "快看", "头条"]),
    ("健康医疗/疾控", ["医院", "医生", "健康", "疾控", "卫生", "医学", "药师", "护理"]),
    ("时政/政务", ["政务", "政知", "时政", "纪委", "检察", "法院", "公安", "发布",
                "长安", "决策", "党建", "宣传"]),
    ("海外华人", ["华人", "海外", "侨", "留学生", "北美", "欧洲"]),
    ("情感/家庭", ["情感", "故事", "家庭", "亲子", "夜听", "婚姻", "育儿"]),
])


def num(v):
    try:
        return int(v)
    except Exception:
        return 0


def med(xs):
    xs = sorted(x for x in xs if x)
    if not xs:
        return 0
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) // 2


def load(cat):
    p = os.path.join(RANKDIR, f"{cat}-2026-10-20.json")
    if not os.path.exists(p):
        print(f"  找不到 {p}，先跑 gzh-fetch.py")
        sys.exit(1)
    return json.load(io.open(p, encoding="utf-8"))


def stats(rows):
    n = len(rows)
    if not n:
        return None
    big = sum(1 for x in rows if num(x.get("maxReadCount")) >= 100000)
    fwd = [num(x.get("totalForwardCount")) for x in rows]
    like = [num(x.get("totalLikeCount")) for x in rows]
    ratios = [f / l for f, l in zip(fwd, like) if l >= 100]
    return {
        "n": n, "big": big, "pct": round(100 * big / n),
        "score": round(sum(x.get("comprehensiveScore") or 0 for x in rows) / n, 1),
        "read": med([num(x.get("totalReadCount")) for x in rows]),
        "avgread": med([num(x.get("averageReadCount")) for x in rows]),
        "ratio": round(med(ratios), 2),
        "pub": round(sum(int(str(x.get("publishCount") or "0/0").split("/")[0] or 0)
                         for x in rows) / n, 1),
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cat = sys.argv[1]
    rows = load(cat)

    if "--list" in sys.argv:
        print(f"  [{cat}] 共 {len(rows)} 个账号\n")
        for x in rows:
            print(f"  {x.get('rankPosition'):>3} {str(x.get('accountName'))[:20]:<22}"
                  f"分{x.get('comprehensiveScore'):>6} 阅{num(x.get('totalReadCount')):>9,}"
                  f" 发{x.get('publishCount')}")
        return 0

    if cat != "民生资讯":
        print(f"  没有为「{cat}」配置细分规则，用 --list 看账号名")
        return 1

    buckets = OrderedDict((k, []) for k in MINSHENG)
    buckets["其他/未归类"] = []
    for x in rows:
        name = str(x.get("accountName"))
        for seg, kws in MINSHENG.items():
            if any(k in name for k in kws):
                buckets[seg].append(x)
                break
        else:
            buckets["其他/未归类"].append(x)

    print(f"\n  【民生资讯】{len(rows)} 个账号按方向切分\n")
    print(f"  {'方向':<18}{'账号数':>6}{'10w+数':>7}{'10w+%':>7}{'阅读中位':>11}"
          f"{'篇均阅读':>10}{'转/赞':>7}{'篇数':>6}")
    print("  " + "-" * 76)
    res = []
    for seg, rs in buckets.items():
        s = stats(rs)
        if not s:
            continue
        res.append((seg, s, rs))
    for seg, s, rs in sorted(res, key=lambda t: -t[1]["n"]):
        print(f"  {seg:<18}{s['n']:>6}{s['big']:>7}{s['pct']:>6}%{s['read']:>11,}"
              f"{s['avgread']:>10,}{s['ratio']:>7}{s['pub']:>6}")
    print()
    for seg, s, rs in sorted(res, key=lambda t: -t[1]["n"]):
        if seg == "其他/未归类":
            continue
        names = " ".join(str(x.get("accountName")) for x in rs[:10])
        print(f"  [{seg}] {names}")

    print(f"\n  [其他/未归类] " +
          " ".join(str(x.get("accountName")) for x in buckets["其他/未归类"][:24]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
