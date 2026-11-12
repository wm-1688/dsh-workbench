#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""小红书每日爆款采集器 → lib/xhs-hot.snapshot.json

为什么单独一个脚本、单独一个快照：
    每天 25 个分类 × 50 条 ≈ 1200 行，直接烘进 client.js 会把前端产物再撑大
    1~2 MB（gen-catalog.py 是 pretty-print 的）。所以按「日期 → 分类」分桶存成
    运行时 JSON，由 /api/workbench/xhs 路由读给界面，和 collect-gzh.py 同构。

数据源（红狐，付费接口，按次扣积分）：
    GET https://redfox.hk/story/api/cozeSkill/getXhsCozeSkillDataOne
        ?rankDate=YYYY-MM-DD&source=小红书单日数据爆款文章-GitHub&category=<分类>
    只支持 GET；POST 会返回 500。code==2000 才算成功。

用法：
    python collect-xhs.py '{"days":1,"categories":["综合全部"]}'
    参数是一个 JSON 字符串，全部可选：
        days       往回采几天，默认 1（昨天）
        categories 只采这些分类，默认全部 25 个
        out        输出路径，默认 lib/xhs-hot.snapshot.json
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import winreg

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
OUT = os.path.join(PLUGIN, "lib", "xhs-hot.snapshot.json")

API = "https://redfox.hk/story/api/cozeSkill/getXhsCozeSkillDataOne"
SOURCE = "小红书单日数据爆款文章-GitHub"
UA = "QoderWork/1.0"

# 25 个有效分类（接口对无效分类返回 code=3203「无效的分类参数」）
CATEGORIES = [
    "综合全部", "出行代步", "休闲爱好", "影视娱乐", "数码科技",
    "医疗保健", "综合杂项", "星座情感", "时尚穿搭", "婚庆婚礼",
    "拍摄记录", "学习教育", "化妆美容", "居家装修", "旅行度假",
    "亲子育儿", "个人护理", "美味佳肴", "职业发展", "宠物天地",
    "潮流鞋包", "日常生活", "科学探索", "新闻资讯", "体育锻炼",
]

KEEP_DAYS = 7


def api_key():
    """三级回退取 Key：环境变量 → HKCU 环境 → HKLM 环境。"""
    key = os.environ.get("REDFOX_API_KEY")
    if key:
        return key
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, r"Environment") as h:
                val, _ = winreg.QueryValueEx(h, "REDFOX_API_KEY")
                if val:
                    return val
        except OSError:
            pass
    raise SystemExit("缺少 REDFOX_API_KEY：请设环境变量或写到用户环境变量里")


def clean(text, limit=0):
    """压掉多余空白；limit>0 时截断并补省略号。"""
    if text is None:
        return ""
    s = " ".join(str(text).split())
    if limit and len(s) > limit:
        s = s[:limit] + "…"
    return s


def num(v):
    """把 '4w+' / '2417' / '1.2亿' / '9w+' 这类中文计数统一成整数。

    注意顺序：接口里大量是「9w+」这种「万 + 加号」组合，必须先把 '+' 去掉
    再判单位，否则 '9w+' 会落到 float('9w') 上抛 ValueError 变成 0。
    """
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().replace(",", "").replace("+", "").replace(" ", "")
    if not s:
        return 0
    mult = 1
    if s.endswith("亿"):
        mult, s = 100000000, s[:-1]
    elif s and s[-1] in ("w", "W", "万"):
        mult, s = 10000, s[:-1]
    try:
        return int(float(s) * mult)
    except ValueError:
        return 0


def pull(category, date):
    """拉一个「日期 + 分类」的爆款榜；返回 (rows, note)。"""
    q = urllib.parse.urlencode({
        "rankDate": date,
        "source": SOURCE,
        "category": category,
    })
    req = urllib.request.Request(
        API + "?" + q,
        headers={"X-API-KEY": api_key(), "User-Agent": UA},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return [], "HTTP %s" % exc.code
    except Exception as exc:  # 网络/超时都不该让整批挂掉
        return [], str(exc)[:80]

    code = body.get("code")
    if code != 2000:
        return [], "code=%s %s" % (code, clean(body.get("msg"), 60))
    data = body.get("data")
    return (data if isinstance(data, list) else []), ""


def normalize(category, items, date):
    """把接口原始行整理成界面直接能用的结构。

    指标分两套，别混用：
        useLikeCount / useCommentCount / useShareCount / collectedCount /
        interactiveCount  → 累计值，爆文库排序与展示用这套
        addLikeCount / addCommentCount / addShareCount / addCollectedCunt /
        addInteractiveount → 当日新增，用来判断「正在起量」
    字段名里的 Interactiveount / CollectedCunt 是接口自己的拼写，不能改。
    """
    rows = []
    for idx, it in enumerate(items, 1):
        if not isinstance(it, dict):
            continue
        title = clean(it.get("title"))
        url = clean(it.get("photoJumpUrl"))
        # 标题为空的行（小红书常见：只发图无标题）用 desc 首句兜底，两者都空就丢
        if not title:
            title = clean(it.get("desc"), 40)
        if not title or not url:
            continue
        add = it.get("anaAdd") or {}
        if not isinstance(add, dict):
            add = {}
        like = num(add.get("useLikeCount"))
        cmt = num(add.get("useCommentCount"))
        col = num(add.get("collectedCount"))
        shr = num(add.get("useShareCount"))
        inter = num(add.get("interactiveCount"))
        add_inter = num(add.get("addInteractiveount"))
        hot = inter or (like + cmt + col + shr)
        rows.append({
            "pid": url.rsplit("/", 1)[-1] if "/" in url else url,
            "category": category,
            "rank": idx,
            "title": title,
            "account": clean(it.get("userName")),
            "accountUrl": clean(it.get("userJumpUrl")),
            "avatar": clean(it.get("userHeadUrl")),
            "cover": clean(it.get("coverUrl")),
            "url": url,
            "fans": num(it.get("fans")),
            "like": like,
            "comment": cmt,
            "collect": col,
            "share": shr,
            "inter": inter,
            "addLike": num(add.get("addLikeCount")),
            "addInter": add_inter,
            "hot": hot,
            "publicTime": clean(it.get("publicTime")),
            "summary": clean(it.get("desc"), 180),
            "date": date,
        })
    return rows


def merge_day(bucket, fresh):
    """同一天重复采集时按 pid 去重：分类合并成 cats，rank 取最好，数值取最大。"""
    by_pid = {}
    for row in bucket:
        by_pid[row["pid"]] = row
    for row in fresh:
        pid = row["pid"]
        old = by_pid.get(pid)
        if not old:
            row["cats"] = [row["category"]]
            by_pid[pid] = row
            continue
        cats = old.get("cats") or [old.get("category")]
        if row["category"] not in cats:
            cats = cats + [row["category"]]
        old["cats"] = cats
        old["rank"] = min(old.get("rank") or 999, row["rank"])
        for key in ("like", "comment", "collect", "share", "inter", "hot",
                    "fans", "addLike", "addInter"):
            old[key] = max(old.get(key) or 0, row.get(key) or 0)
        for key in ("summary", "avatar", "cover", "account", "accountUrl", "publicTime"):
            if not old.get(key) and row.get(key):
                old[key] = row[key]
    return list(by_pid.values())


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else "{}"
    try:
        opts = json.loads(raw)
    except Exception:
        print(json.dumps({"ok": False, "error": "参数不是合法 JSON：" + raw[:80]},
                         ensure_ascii=False))
        return 1

    out_path = opts.get("out") or OUT
    days = int(opts.get("days") or 1)
    cats = opts.get("categories") or CATEGORIES
    cats = [c for c in cats if c in CATEGORIES] or CATEGORIES

    # 接口只出「昨天」的榜，所以从昨天往前数
    today = time.localtime()
    base = time.mktime((today.tm_year, today.tm_mon, today.tm_mday,
                        0, 0, 0, 0, 0, -1))
    want = [time.strftime("%Y-%m-%d", time.localtime(base - 86400 * (i + 1)))
            for i in range(days)]

    if os.path.exists(out_path):
        try:
            archive = json.load(open(out_path, encoding="utf-8"))
        except Exception:
            archive = {}
    else:
        archive = {}
    by_date = archive.get("byDate") or {}

    notes = []
    total = 0
    for date in want:
        bucket = by_date.get(date) or []
        fresh = []
        for cat in cats:
            rows, note = pull(cat, date)
            if note:
                notes.append("%s/%s: %s" % (date, cat, note))
                continue
            fresh.extend(normalize(cat, rows, date))
        if fresh:
            by_date[date] = merge_day(bucket, fresh)
            total += len(fresh)
        elif bucket:
            by_date[date] = bucket

    # 只保留最近 KEEP_DAYS 天
    keep = sorted(by_date.keys())[-KEEP_DAYS:]
    by_date = {d: by_date[d] for d in keep}
    for date in by_date:
        by_date[date].sort(key=lambda r: (-(r.get("hot") or 0), r.get("rank") or 999))
        for i, row in enumerate(by_date[date], 1):
            row["key"] = "小红书@%s#%s" % (date, row["pid"])
            row["n"] = i

    payload = {
        "platform": "小红书",
        "categories": CATEGORIES,
        "dates": keep,
        "latest": keep[-1] if keep else "",
        "fetchedAt": time.strftime("%Y-%m-%d %H:%M"),
        "byDate": by_date,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(out_path)
    print(json.dumps({
        "ok": True,
        "rows": sum(len(v) for v in by_date.values()),
        "fresh": total,
        "dates": keep,
        "categories": len(cats),
        "bytes": size,
        "notes": notes[:6],
        "out": out_path,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
