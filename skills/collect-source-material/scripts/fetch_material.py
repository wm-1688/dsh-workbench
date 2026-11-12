#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""collect-source-material · 把链接变成可用的素材卡

用法
    python fetch_material.py fetch <url> [<url> ...] [--out DIR]
    python fetch_material.py list toutiao [--out DIR]

设计要点（都是实测踩出来的）
  1. 编码：中文媒体大量使用 GB2312 / GB18030，不能默认 UTF-8。
     顺序 = 响应头 charset → meta charset → utf-8 → gb18030 → gbk → big5
  2. 正文：两手策略取更长的那份
     A 标签剥离（服务端渲染的新闻站、百家号走这条）
     B 页面内嵌 JSON（部分站点把正文塞在 script 里）
  3. 清洗：标题去重、导航词行剔除、版式残留转成元数据、中文之间的多余空格
  4. 核验状态：聚合站转载的页面不是原始信源，必须标注，不能让下游当成一手事实
只依赖标准库。
"""

import argparse
import html as htmlmod
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# 聚合站：页面 ≠ 原始信源，引用前要回到一手来源
AGGREGATORS = {
    "baijiahao.baidu.com": "百家号",
    "toutiao.com": "今日头条",
    "sohu.com": "搜狐",
    "163.com": "网易",
    "sina.com.cn": "新浪",
    "qq.com": "腾讯",
    "ifeng.com": "凤凰",
    "360doc.com": "个人图书馆",
    "zhihu.com": "知乎",
    "weixin.qq.com": "微信公众号",
}
# 一手媒体：可直接判断
ONESHOT_MEDIA = {
    "cnr.cn": "央广网",
    "chinanews.com.cn": "中新网",
    "people.com.cn": "人民网",
    "xinhuanet.com": "新华网",
    "thepaper.cn": "澎湃新闻",
    "bjnews.com.cn": "新京报",
    "yicai.com": "第一财经",
    "caixin.com": "财新",
    "gov.cn": "政府站点",
}

NAV_WORDS = ("首页 新闻 财经 军事 汽车 科技 体育 教育 旅游 娱乐 健康 公益 图片 "
             "三农 中国广播 视频 直播 观点 地方 法治 军事 文化 读书 房产 家居 "
             "登录 注册 客户端 无障碍 简体 繁体 English 设为首页 加入收藏").split()

# 版式残留：这些行里其实藏着元数据，转成字段后从正文删掉
RE_SOURCE_LINE = re.compile(r"来\s*源\s*[:：]\s*(.{1,60})")
RE_EDITOR_LINE = re.compile(r"(责\s*任\s*编\s*辑|编\s*辑|校\s*对|记\s*者)\s*[:：]\s*([^\s，,。]{1,20})")
RE_BOILERPLATE = re.compile(
    r"(违法和不良信息举报|举报电话|举报邮箱|互联网新闻信息服务许可证|信息网络传播视听节目许可证|"
    r"网上传播视听节目许可证|ICP\s*备|京公网安备|版权所有|免责声明|免责申明|"
    r"本站(法律)?顾问|Copyright|All Rights Reserved|增值电信业务经营许可证|"
    r"广播电视节目制作经营许可证|网络文化经营许可证|扫码关注|微信扫一扫)"
    , re.I)
RE_PUBTIME = re.compile(
    r"(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:\s*(\d{1,2})[:：](\d{2}))?")
# 中文之间因标签剥离留下的空格
RE_CJK_SPACE = re.compile(r"(?<=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])[ \t]+"
                          r"(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])")
RE_MULTI_BLANK = re.compile(r"\n{3,}")


def fetch(url, timeout=25):
    """抓取并解码。返回 (html文本, 元信息dict)。"""
    info = {"url": url, "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M")}
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            info["http"] = r.status
            info["bytes"] = len(raw)
            ctype = r.headers.get("Content-Type", "")
            info["ctype"] = ctype
    except urllib.error.HTTPError as e:
        info["http"] = e.code
        info["error"] = f"HTTP {e.code}"
        info["hint"] = ("该站需要登录态或 cookie（微博 403 / 知乎 401 属此类）。"
                        "改用聚合 API 取榜单，或让用户手动粘贴正文。")
        return None, info
    except Exception as e:
        info["error"] = f"{type(e).__name__}: {e}"
        info["hint"] = "网络不可达。本机 pwsh 的 HTTPS 有代理问题，请用 Python 通道。"
        return None, info

    # 编码探测
    enc = None
    m = re.search(r"charset=([\w-]+)", info["ctype"], re.I)
    if m:
        enc = m.group(1)
    if not enc:
        m2 = re.search(rb'charset=["\']?([\w-]+)', raw[:4000], re.I)
        if m2:
            enc = m2.group(1).decode("ascii", "ignore")
    text = None
    for cand in ([enc] if enc else []) + ["utf-8", "gb18030", "gbk", "big5"]:
        if not cand:
            continue
        try:
            text = raw.decode(cand)
            info["enc"] = cand
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if text is None:
        info["error"] = "decode_failed"
        return None, info
    return text, info


def _strip_tags(fragment):
    s = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", fragment)
    s = re.sub(r"(?is)<!--.*?-->", " ", s)
    s = re.sub(r"(?is)<br\s*/?>|</p>|</div>|</h\d>|</li>|</tr>", "\n", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    return htmlmod.unescape(s)


def _lines(text, min_len):
    out = []
    for ln in text.split("\n"):
        ln = re.sub(r"[ \t\u3000]+", " ", ln).strip()
        if len(ln) >= min_len:
            out.append(ln)
    return out


def extract_body(html_text, min_len=25):
    """策略 A：标签剥离。"""
    lines = _lines(_strip_tags(html_text), min_len)
    return lines, "A(标签剥离)"


def extract_json_body(html_text, min_len=25):
    """策略 B：页面内嵌 JSON 的正文字段。"""
    best, best_lines = "", []
    patterns = [
        r'"content"\s*:\s*"((?:[^"\\]|\\.){200,})"',
        r'"article_content"\s*:\s*"((?:[^"\\]|\\.){200,})"',
        r'"htmlContent"\s*:\s*"((?:[^"\\]|\\.){200,})"',
        r'"body"\s*:\s*"((?:[^"\\]|\\.){200,})"',
    ]
    for pat in patterns:
        for mm in re.finditer(pat, html_text):
            try:
                s = json.loads('"' + mm.group(1) + '"')
            except Exception:
                continue
            lines = _lines(_strip_tags(s), min_len)
            cand = "\n\n".join(lines)
            if len(cand) > len(best):
                best, best_lines = cand, lines
    return best_lines, "B(JSON内嵌)"


def clean(lines, title):
    """清洗：去标题重复、导航词行、版式残留；残留里的元数据另行返回。"""
    meta = {}
    kept = []
    norm_title = re.sub(r"\s", "", title or "")
    for ln in lines:
        flat = re.sub(r"\s", "", ln)
        # 标题重复
        if norm_title and (flat == norm_title or flat.startswith(norm_title[:14]) and len(flat) < len(norm_title) + 12):
            continue
        # 纯版式残留
        if RE_BOILERPLATE.search(ln):
            continue
        # 来源行：抽成元数据，不进正文。先把编辑/校对摘出去，别混进「原始信源」
        ms = RE_SOURCE_LINE.search(ln)
        if ms and len(flat) < 90:
            tail = ms.group(1).strip()
            for me2 in RE_EDITOR_LINE.finditer(tail):
                meta.setdefault("credits", []).append(
                    f"{me2.group(1).replace(' ', '')}：{me2.group(2)}")
            tail = RE_EDITOR_LINE.sub("", tail).strip(" ，,、")
            meta.setdefault("source_line", tail)
            remainder = RE_SOURCE_LINE.sub("", ln)
            if len(re.sub(r"\s", "", remainder)) < 20:
                continue
            ln = remainder
            flat = re.sub(r"\s", "", ln)
        # 编辑/校对：抽成元数据
        me = RE_EDITOR_LINE.search(ln)
        if me:
            meta.setdefault("credits", []).append(f"{me.group(1).replace(' ', '')}：{me.group(2)}")
            remainder = RE_EDITOR_LINE.sub("", ln)
            if len(re.sub(r"\s", "", remainder)) < 20:
                continue
            ln = remainder
        # 导航词行：去掉导航词后所剩无几，判为导航
        stripped = ln
        for w in NAV_WORDS:
            stripped = stripped.replace(w, "")
        if len(re.sub(r"[\s|·/、,，]", "", stripped)) < 8:
            continue
        ln = _dedupe_sentences(ln)
        if kept and re.sub(r"\s", "", kept[-1]) == re.sub(r"\s", "", ln):
            continue
        kept.append(ln)
    body = "\n\n".join(kept)
    body = RE_CJK_SPACE.sub("", body)
    body = RE_MULTI_BLANK.sub("\n\n", body).strip()
    return body, meta


def _plausible_title(t):
    """过滤 h1/title 里的非文章内容：HTTP 状态页、纯英文导航、过短串。"""
    if not t:
        return False
    t = t.strip()
    if len(t) < 6:
        return False
    if re.fullmatch(r"\d{3}\s*[A-Za-z ]*", t):     # 302 Found / 404 Not Found
        return False
    if not re.search(r"[\u4e00-\u9fff]", t):       # 中文正文站的标题应含中文
        return False
    return True


def first_title(html_text, meta_tags):
    cands = []
    for key in ("og:title", "twitter:title"):
        if meta_tags.get(key):
            cands.append(meta_tags[key])
    m = re.search(r"(?is)<h1[^>]*>(.*?)</h1>", html_text)
    if m:
        t = re.sub(r"(?s)<[^>]+>", " ", m.group(1))
        cands.append(htmlmod.unescape(re.sub(r"\s+", " ", t)).strip())
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", html_text)
    if m:
        t = htmlmod.unescape(re.sub(r"\s+", " ", m.group(1))).strip()
        cands.append(re.sub(r"\s*[-_|]\s*[^-_|]{1,20}$", "", t).strip() or t)
    for t in cands:
        if _plausible_title(t):
            return t
    return cands[0].strip() if cands else ""


def meta_tags(html_text):
    tags = {}
    for m in re.finditer(r'(?is)<meta[^>]+>', html_text):
        tag = m.group(0)
        name = re.search(r'(?:name|property)\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        content = re.search(r'content\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        if name and content:
            tags.setdefault(name.group(1).lower(), content.group(1))
    return tags


def verify_status(domain, source_line):
    for d, label in ONESHOT_MEDIA.items():
        if domain.endswith(d):
            return f"可直接判断（一手媒体：{label}）"
    for d, label in AGGREGATORS.items():
        if domain.endswith(d):
            if source_line:
                return f"需要核验（{label}转载，原始信源：{source_line}）"
            return f"需要核验（{label}属聚合站，页面非原始信源）"
    if source_line:
        return f"需要核验（页面标注来源：{source_line}）"
    return "需要核验（来源不明）"


def _plausible_publisher(p):
    """过滤 CMS 垃圾值：author 字段常是 midi / admin / webmaster。"""
    if not p:
        return False
    p = p.strip()
    if len(p) < 2:
        return False
    if p.lower() in {"midi", "admin", "webmaster", "editor", "guest", "user",
                     "test", "root", "null", "none", "anonymous", "来源"}:
        return False
    if re.fullmatch(r"[A-Za-z0-9_.\-]{1,20}", p):
        return False
    return True


def _dedupe_sentences(line):
    """同一行里重复的句子只留一次（图片说明常被复读三遍）。"""
    parts = re.split(r"(?<=[。！？])", line)
    seen, out = set(), []
    for part in parts:
        key = re.sub(r"\s", "", part)
        if not key:
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append(part)
    return "".join(out)


def build_card(url, html_text, info):
    tags = meta_tags(html_text)
    title = first_title(html_text, tags)
    lines_a, strat_a = extract_body(html_text)
    lines_b, strat_b = extract_json_body(html_text)
    if len("\n".join(lines_b)) > len("\n".join(lines_a)):
        lines, strat = lines_b, strat_b
    else:
        lines, strat = lines_a, strat_a
    body, meta = clean(lines, title)

    domain = re.sub(r"^https?://", "", url).split("/")[0].lower()
    publish = tags.get("article:published_time") or tags.get("og:release_date") or ""
    if not publish:
        # 时间戳常在被清洗掉的版式行里（如「2015-10-04 13:26:00 来源：羊城晚报」），
        # 所以从原始文本里找，而不是从清洗后的正文里找
        m = RE_PUBTIME.search(_strip_tags(html_text))
        if m:
            publish = m.group(0)
    publisher = ""
    for cand in (tags.get("og:site_name"), tags.get("article:author"), tags.get("author")):
        if _plausible_publisher(cand):
            publisher = cand.strip()
            break
    if not publisher:
        m = re.search(r"([\u4e00-\u9fff\w]{2,30}官方账号)", body or _strip_tags(html_text))
        if m:
            publisher = m.group(1)
    if not publisher:
        # 页面没给站点名时，用域名兜底（一手媒体名单已内置）
        for d, label in {**ONESHOT_MEDIA, **AGGREGATORS}.items():
            if domain.endswith(d):
                publisher = label
                break

    return {
        "source_url": url,
        "domain": domain,
        "title": title,
        "publisher": publisher,
        "original_source": meta.get("source_line", ""),
        "credits": meta.get("credits", []),
        "published_at": publish,
        "fetched_at": info.get("fetched_at", ""),
        "http": info.get("http"),
        "encoding": info.get("enc", ""),
        "strategy": strat,
        "body_chars": len(re.sub(r"\s", "", body)),
        "verify_status": verify_status(domain, meta.get("source_line", "")),
        "body": body,
    }


def write_card(card, outdir):
    os.makedirs(outdir, exist_ok=True)
    slug = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", card["title"] or card["domain"])[:40].strip("-") or "material"
    md = [
        f"# 素材卡 · {card['title']}",
        "",
        f"- 来源 URL：{card['source_url']}",
        f"- 域名：{card['domain']}",
        f"- 发布方：{card['publisher'] or '（未识别）'}",
        f"- 原始信源：{card['original_source'] or '（未标注）'}",
        f"- 发布时间：{card['published_at'] or '（未识别）'}",
        f"- 抓取时间：{card['fetched_at']}",
        f"- 编码 / 抽取：{card['encoding']} / {card['strategy']}",
        f"- 正文字数：{card['body_chars']}",
        f"- 核验状态：{card['verify_status']}",
    ]
    if card["credits"]:
        md.append(f"- 版式残留：{'；'.join(card['credits'])}")
    md += ["", "## 正文", "", card["body"], ""]
    mdp = os.path.join(outdir, slug + ".md")
    io.open(mdp, "w", encoding="utf-8").write("\n".join(md))
    jsp = os.path.join(outdir, slug + ".json")
    io.open(jsp, "w", encoding="utf-8").write(json.dumps(card, ensure_ascii=False, indent=1))
    return mdp, jsp


def cmd_fetch(args):
    rows = []
    for url in args.urls:
        text, info = fetch(url)
        if text is None:
            rows.append({"source_url": url, "ok": False, **info})
            continue
        card = build_card(url, text, info)
        mdp, jsp = write_card(card, args.out)
        card["ok"] = True
        card["card_md"] = mdp
        card["card_json"] = jsp
        rows.append(card)

    print(f"{'结果':<6} {'HTTP':<6} {'编码':<9} {'字数':<7} 标题 / 说明")
    for r in rows:
        if r.get("ok"):
            print(f"{'✓':<6} {str(r.get('http')):<6} {r.get('encoding',''):<9} "
                  f"{str(r.get('body_chars')):<7} {(r.get('title') or '')[:38]}")
        else:
            print(f"{'✗':<6} {str(r.get('http','-')):<6} {'-':<9} {'-':<7} "
                  f"{r.get('error','')} · {r.get('hint','')}")
    ok = [r for r in rows if r.get("ok")]
    print(f"\n成功 {len(ok)} / {len(rows)}；素材卡目录：{os.path.abspath(args.out)}")
    for r in ok:
        print(f"  核验状态：{r['verify_status']}")
    return 0 if ok else 1


HOT_LISTS = {
    "toutiao": "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
    "douyin": "https://www.douyin.com/aweme/v1/web/hot/search/list/",
    "baidu": "https://top.baidu.com/api/board?platform=wise&tab=realtime",
}


def _find_items(obj, depth=0):
    """在未知结构里找条目数组（按小写键名匹配标题字段）。"""
    if depth > 5:
        return None
    if isinstance(obj, list) and obj and isinstance(obj[0], dict):
        keys = {k.lower(): k for k in obj[0].keys()}
        for want in ("title", "word", "query", "name", "note", "content"):
            if want in keys:
                return obj, keys[want], keys
        return None
    if isinstance(obj, dict):
        for v in obj.values():
            r = _find_items(v, depth + 1)
            if r:
                return r
    return None


def cmd_list(args):
    url = HOT_LISTS[args.platform]
    text, info = fetch(url)
    if text is None:
        print(f"✗ {args.platform} 取不到：{info.get('error')} · {info.get('hint','')}")
        return 1
    try:
        data = json.loads(text)
    except Exception:
        print(f"✗ {args.platform} 返回的不是 JSON（{info.get('bytes')} 字节，编码 {info.get('enc')}）")
        return 1
    found = _find_items(data)
    if not found:
        print(f"✗ {args.platform} 结构未适配：自动探测找不到条目数组。"
              f"原始响应已保存，需人工确认字段后补适配器。")
        os.makedirs(args.out, exist_ok=True)
        io.open(os.path.join(args.out, f"raw-{args.platform}.json"), "w", encoding="utf-8").write(text)
        return 1
    items, title_key, keys = found
    rows = []
    for i, it in enumerate(items, 1):
        title = str(it.get(title_key, "")).strip()
        hot = next((it[keys[k]] for k in keys if k in ("hotvalue", "hot_score", "hot", "score")
                    and str(it[keys[k]]).isdigit()), "")
        link = next((it[keys[k]] for k in keys if k in ("url", "link", "mobileurl")), "")
        rows.append({"rank": i, "title": title, "hot": str(hot), "url": str(link)})
    os.makedirs(args.out, exist_ok=True)
    io.open(os.path.join(args.out, f"hotlist-{args.platform}.json"), "w", encoding="utf-8").write(
        json.dumps({"platform": args.platform, "url": url, "fetched_at": info["fetched_at"],
                    "title_key": title_key, "count": len(rows), "items": rows},
                   ensure_ascii=False, indent=1))
    print(f"✓ {args.platform}：{len(rows)} 条（标题字段 {title_key}），已存 {args.out}\\hotlist-{args.platform}.json")
    for r in rows[:5]:
        print(f"  {r['rank']}. {r['title'][:40]}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="把链接变成可用的素材卡")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pf = sub.add_parser("fetch", help="采集链接正文 → 素材卡")
    pf.add_argument("urls", nargs="+")
    pf.add_argument("--out", default="materials")
    pf.set_defaults(func=cmd_fetch)

    pl = sub.add_parser("list", help="直取热点榜单（实测可用的平台）")
    pl.add_argument("platform", choices=sorted(HOT_LISTS))
    pl.add_argument("--out", default="materials")
    pl.set_defaults(func=cmd_list)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
