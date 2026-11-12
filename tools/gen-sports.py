#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""体育战报数据采集：ESPN 结构化比分/球员数据 + 红狐中文资讯。

⚠️ 为什么不用一个源：
   · 素材库（gen-materials.py）只收 7 平台**热榜标题**——7 天里体育相关只有 7 条标题，
     **没有正文、没有比分、没有球员数据**。体育内容不走热榜，走赛程/比分接口。
   · 红狐头条搜索能拿中文**过程描述和赛后采访**，但拿不到结构化比分；
   · NBA 官方 cdn.nba.com 返回 **403**（被挡）；ESPN 公开接口可用、无需 key。
   所以：**ESPN 出事实（比分/数据），红狐出表达（中文场景/原话）**。

用法：
    python tools/gen-sports.py                          # 今天，只取比分+领先者
    python tools/gen-sports.py --box --max-players 8    # 连球员数据一起取
    python tools/gen-sports.py --redfox NBA 杨瀚森       # 再叠一层中文资讯
"""
import argparse
import io
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
OUT = os.path.join(PLUGIN, "lib", "sports.snapshot.json")

ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
REDFOX_SEARCH = "https://redfox.hk/story/api/toutiao/searchWork"
REDFOX_DETAIL = "https://redfox.hk/story/api/toutiao/workDetail"


def get_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post_json(url, payload, key, timeout=30):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-API-KEY", key)
    req.add_header("User-Agent", "QoderWork/1.0")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def redfox_key():
    k = os.environ.get("REDFOX_API_KEY", "").strip()
    if k:
        return k
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as h:
            return winreg.QueryValueEx(h, "REDFOX_API_KEY")[0].strip()
    except Exception:
        return ""


def parse_team(c):
    """ESPN competitor → 精简结构。"""
    t = c.get("team", {})
    return {
        "name": t.get("displayName", ""), "abbr": t.get("abbreviation", ""),
        "score": c.get("score"), "home": c.get("homeAway") == "home",
        "winner": bool(c.get("winner")),
        "record": next((r.get("summary") for r in c.get("record", [])
                        if r.get("type") == "total"), ""),
    }


def box(ev_id, max_players):
    """取单场 box score + 分节比分 + 关键回合。

    字段名已实测：
      keys = ['minutes','points','fieldGoalsMade-fieldGoalsAttempted',
              'rebounds','assists','turnovers','steals','blocks','plusMinus']
      header.competitions[0].competitors[].linescores[] → 分节比分
      plays[] → 逐回合事件（516 条/场）
    """
    d = get_json(f"{ESPN}/summary?event={ev_id}")

    # 分节比分
    lines = {}
    for c in d.get("header", {}).get("competitions", [{}])[0].get("competitors", []):
        lines[c.get("team", {}).get("abbreviation", "")] = [
            x.get("displayValue") for x in (c.get("linescores") or [])]

    # 关键回合：只留进球、末节、以及分差变化大的
    plays = []
    for p in d.get("plays") or []:
        txt = p.get("text", "")
        per = p.get("period", {}).get("number")
        if any(k in txt for k in ("makes", "dunk", "three point", "free throw")) or per >= 4:
            plays.append({"q": per, "clock": p.get("clock", {}).get("displayValue", ""),
                          "text": txt})

    gi = d.get("gameInfo") or {}
    venue = (gi.get("venue") or {}).get("fullName", "")
    att = gi.get("attendance")

    rows = {}
    for tm in d.get("boxscore", {}).get("players", []):
        name = tm.get("team", {}).get("displayName", "")
        out = []
        for st in tm.get("statistics", []):
            keys = st.get("keys", [])
            ix = {k: i for i, k in enumerate(keys)}
            for a in st.get("athletes", [])[:max_players]:
                s = a.get("stats", [])

                def g(k):
                    i = ix.get(k)
                    return s[i] if i is not None and i < len(s) else "-"
                out.append({
                    "name": a.get("athlete", {}).get("displayName", ""),
                    "min": g("minutes"), "pts": g("points"),
                    "fg": g("fieldGoalsMade-fieldGoalsAttempted"),
                    "reb": g("rebounds"), "ast": g("assists"),
                    "plusMinus": g("plusMinus"),
                })
        rows[name] = out
    lead = []
    for t in d.get("leaders", []):
        for cat in t.get("leaders", []):
            top = (cat.get("leaders") or [{}])[0]
            lead.append({
                "team": t.get("team", {}).get("abbreviation", ""),
                "cat": cat.get("displayName", ""),
                "player": top.get("athlete", {}).get("displayName", ""),
                "value": top.get("displayValue", ""),
            })
    return rows, lead, lines, plays, venue, att


def fetch_games(with_box, max_players):
    sb = get_json(f"{ESPN}/scoreboard")
    games = []
    for e in sb.get("events", []):
        c = e["competitions"][0]
        cs = [parse_team(x) for x in c.get("competitors", [])]
        away = next((x for x in cs if not x["home"]), {})
        home = next((x for x in cs if x["home"]), {})
        g = {
            "id": e["id"], "name": e.get("name", ""),
            "date": e.get("date", ""),
            "status": e["status"]["type"]["description"],
            "completed": e["status"]["type"].get("completed", False),
            "detail": c.get("status", {}).get("type", {}).get("detail", ""),
            "away": away, "home": home, "box": None, "leaders": None,
        }
        if with_box:
            try:
                (g["box"], g["leaders"], g["lines"], g["plays"],
                 g["venue"], g["attendance"]) = box(e["id"], max_players)
            except Exception as ex:
                g["boxError"] = f"{type(ex).__name__}: {ex}"
        games.append(g)
    return sb.get("day", {}).get("date", ""), games


def redfox_news(keywords, hours, max_items):
    key = redfox_key()
    if not key:
        print("    ⚠️ 无 REDFOX_API_KEY，跳过中文资讯")
        return []
    out, seen = [], set()
    for kw in keywords:
        try:
            r = post_json(REDFOX_SEARCH, {"keyword": kw, "offset": "0", "source": 2}, key)
        except Exception as e:
            print(f"    ❌ [{kw}] {type(e).__name__}")
            continue
        d = r.get("data")
        items = d if isinstance(d, list) else (d or {}).get("list", []) if isinstance(d, dict) else []
        n = 0
        for it in items:
            oid = it.get("opusId") or it.get("workId")
            if not oid or oid in seen:
                continue
            try:
                t = int(it.get("publishTime", 0))
            except Exception:
                t = 0
            if t and t < time.time() - hours * 3600:
                continue
            seen.add(oid)
            out.append({"opusId": oid, "title": it.get("title", ""),
                        "author": it.get("nickname", ""), "keyword": kw,
                        "publish_at": time.strftime("%Y-%m-%d %H:%M", time.localtime(t)) if t else "",
                        "url": it.get("opusUrl", "")})
            n += 1
        print(f"    [{kw}] {n} 条")
        if len(out) >= max_items:
            break
    return out[:max_items]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--box", action="store_true", help="取球员数据（逐场多一次请求）")
    ap.add_argument("--max-players", type=int, default=8)
    ap.add_argument("--redfox", nargs="*", default=[], help="叠加中文资讯的关键词")
    ap.add_argument("--redfox-hours", type=int, default=48)
    ap.add_argument("--max-news", type=int, default=20)
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    print("  [1] ESPN 赛程与比分")
    day, games = fetch_games(a.box, a.max_players)
    print(f"      比赛日 {day}，共 {len(games)} 场")
    for g in games:
        print(f"      {g['away']['abbr']:>4} {g['away']['score']:>4} @ "
              f"{g['home']['abbr']:>4} {g['home']['score']:>4}   [{g['status']}]")

    news = []
    if a.redfox:
        print("\n  [2] 红狐中文资讯")
        news = redfox_news(a.redfox, a.redfox_hours, a.max_news)
        print(f"      合计 {len(news)} 条")

    snap = {
        "fetchedAt": time.strftime("%Y-%m-%d %H:%M", time.localtime()),
        "day": day, "games": games, "news": news,
        "withBox": sum(1 for g in games if g.get("box")),
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(snap, io.open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\n  写入 {os.path.relpath(a.out, PLUGIN)}：{len(games)} 场"
          f"（{snap['withBox']} 场含球员数据）/ {len(news)} 条资讯")
    return 0


if __name__ == "__main__":
    sys.exit(main())
