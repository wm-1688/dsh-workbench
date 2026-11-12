#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""公众号违禁词扫描（红狐 wechat-prohibited-word 的包装）。

⛔ 这个**不是闸门**，是审稿阶段的提示工具。为什么不做硬闸门：
   实测我们已有的稿子，「最后」「安全」「全部」「免费」「官方」全部命中——
   而这些词在新闻评论里无法避免（「AI 安全」是我们的专题词）。
   红狐这个库是**广告法/电商取向**的，对评论类文章误报率高。
   设成硬门就等于每篇都必须人工豁免，闸门立刻失去意义。

它真正有用的场合：
  · 文章里带**带货/推广/品牌宣传语**（那时绝对化用语是真红线）
  · 引用**他人宣传文案**时需要确认有没有照抄违禁词
  · 想知道平台侧可能标红的词有哪些，作为**参考**而不是判决

报告分两块，**互不依赖**：
  ① 绝对化短语自查——直接在原文里找「最好/国家级/100%/包治百病」这类**完整短语**。
     按**命中词**分档会误报（「第一反应」「极限操作」都会被算成广告法用语），
     所以这一块不用红狐的词表，直接扫原文。
  ② 红狐命中词——按风险大类列出，附上下文，供人工判断。

用法：
    python tools/check-prohibited.py <草稿目录>
    python tools/check-prohibited.py <目录> --file x.md
    python tools/check-prohibited.py --content "一段话"

退出码：恒为 0（提示工具）。脚本自身出错才返回 2。
"""

import argparse
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
# 红狐技能装在 .dsh/redfox-skills/（**不在** .dsh/skills/——那是 DSH 全局扫描目录，
# 放进去会污染每个会话的技能目录）。两处都找一遍，兼容搬动前后的状态。
SKILL = next((p for p in (
    os.path.join(ROOT, ".dsh", "redfox-skills", "wechat-prohibited-word",
                 "scripts", "check_sensitive_words.py"),
    os.path.join(ROOT, ".dsh", "skills", "wechat-prohibited-word",
                 "scripts", "check_sensitive_words.py"),
) if os.path.exists(p)), os.path.join(ROOT, ".dsh", "redfox-skills",
                                      "wechat-prohibited-word",
                                      "scripts", "check_sensitive_words.py"))

# 红狐违禁词接口（**直接 urllib 调用，不经技能脚本**）。
# 技能脚本 check_sensitive_words.py 依赖 requests，本机两个 Python 都没有这个包，
# 走脚本会在「找不到装了 requests 的 Python」处**静默跳过整项检查**，等于没查。
# 接口单次上限 2000 字符，按 1800 切块（见 main 里的注释）。
SENSITIVE_API = "https://redfox.hk/story/api/cozeSkill/sensitiveWordSearch"
SENSITIVE_SOURCE = "公众号违禁词查询-GitHub"

# ① 广告法绝对化用语：**完整短语**，直接扫原文。歧义词（第一、极）不入此表。
HARD_PHRASES = [
    "最好", "最佳", "最优", "最强", "最大", "最便宜", "最先进", "最科学", "最高端", "最赚钱",
    "最高级", "国家级", "世界级", "国际级", "顶级", "顶尖", "极致", "绝对", "100%", "百分百",
    "唯一", "独家", "首选", "首个", "史无前例", "万能", "永久", "彻底", "根治", "包治百病",
    "无效退款", "药到病除", "王牌", "销量第一", "行业第一", "全国第一", "全球第一", "第一名",
]
# ② 红狐命中词分档（只做归类，不当判决）
INDUSTRY = ["治疗", "药", "病", "疗效", "根治", "血脂", "血糖", "血压", "减肥", "丰胸", "壮阳",
            "投资", "收益", "保本", "稳赚", "翻倍", "涨停", "荐股"]
ADVERT = ["最", "极", "超级", "独家", "唯一", "顶级", "第一", "100%", "免费", "官方", "权威"]


def _redfox_key():
    k = os.environ.get("REDFOX_API_KEY", "").strip()
    if k:
        return k
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as h:
            return winreg.QueryValueEx(h, "REDFOX_API_KEY")[0].strip()
    except Exception:
        return ""


def redfox_sensitive(content):
    """调一次红狐违禁词接口，返回 data 字典（含 content 富文本 + prohibitedWordsType）。"""
    key = _redfox_key()
    if not key:
        raise RuntimeError("未配置 REDFOX_API_KEY（环境变量或用户环境变量）")
    body = json.dumps({"content": content, "platform": "公众号",
                       "source": SENSITIVE_SOURCE},
                      ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(SENSITIVE_API, data=body, method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    req.add_header("X-API-KEY", key)
    req.add_header("User-Agent", "QoderWork/1.0")
    with urllib.request.urlopen(req, timeout=40) as r:
        j = json.loads(r.read().decode("utf-8"))
    if j.get("code") != 2000:
        raise RuntimeError(f"接口错误 code={j.get('code')} msg={j.get('msg')}")
    return j.get("data") or {}


def ctx(text, word, span=20, limit=2):
    out, i = [], text.find(word)
    while i >= 0 and len(out) < limit:
        out.append(text[max(0, i - span):i + len(word) + span].replace("\n", " "))
        i = text.find(word, i + 1)
    return out


def split_chunks(text, limit):
    """按段落边界切块，单块不超过 limit 字符（红狐接口单次上限 3000）。"""
    if len(text) <= limit:
        return [text]
    chunks, cur = [], ""
    for para in text.split("\n\n"):
        if len(cur) + len(para) + 2 > limit and cur:
            chunks.append(cur)
            cur = para
        else:
            cur = (cur + "\n\n" + para) if cur else para
    if cur:
        chunks.append(cur)
    # 极端情况：单段就超长，再按字符硬切
    out = []
    for c in chunks:
        while len(c) > limit:
            out.append(c[:limit])
            c = c[limit:]
        if c:
            out.append(c)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("draft_dir", nargs="?")
    ap.add_argument("--file", default=None)
    ap.add_argument("--content", default=None)
    a = ap.parse_args()

    if a.content:
        text, src, cmd_tail = a.content, "（命令行文本）", ["--content", a.content]
    else:
        if a.file:
            path = a.file if os.path.isabs(a.file) else os.path.join(
                os.path.abspath(a.draft_dir or "."), a.file)
        else:
            if not a.draft_dir:
                print("  用法：check-prohibited.py <草稿目录> | --file <路径> | --content <文本>")
                return 2
            path = os.path.join(os.path.abspath(a.draft_dir), "draft.md")
        if not os.path.exists(path):
            print(f"  ❌ 找不到 {path}")
            return 2
        text = open(path, encoding="utf-8").read()
        src, cmd_tail = os.path.relpath(path, ROOT), ["--file", path]

    print(f"  扫描 {src}   {len(text)} 字符")

    # ── ① 绝对化短语自查（不依赖接口，精确）──
    hits = [p for p in HARD_PHRASES if p in text]
    print(f"\n  ① 广告法绝对化短语（完整短语匹配）")
    if hits:
        for p in hits:
            print(f"     🔴 「{p}」")
            for c in ctx(text, p):
                print(f"        …{c}…")
        print("        → 若正文含带货/推广/品牌宣传语，这些必须改；纯评论文章通常只需确认没照抄他人宣传语。")
    else:
        print("     ✅ 无")

    # ── ② 红狐命中词（参考）──
    # ⚠️ 红狐接口**单次上限 2000 字符**。
    # 注意技能脚本自己的客户端检查写的是 3000，服务端实际只允许 2000：
    #   code=1003 body.content 参数长度超过限制（2600字符），最大允许2000字符
    # 实测 2000 通过、2600 失败。所以按 1800 切，留出余量。
    chunks = split_chunks(text, 1800)
    words, types, failed, first_err = [], set(), 0, None
    for ch in chunks:
        try:
            d = redfox_sensitive(ch)
        except Exception as e:
            failed += 1
            first_err = first_err or str(e)
            continue
        words += re.findall(
            r'<span class="(?:banned-word|sensitive-word|industry-banned-word)">(.*?)</span>',
            d.get("content") or "")
        types |= set(d.get("prohibitedWordsType") or [])
    words = list(dict.fromkeys(words))
    if failed == len(chunks):
        print(f"\n  ② ❌ 全部 {len(chunks)} 块都失败了：{first_err}")
        print("     （这项没查成，不等于通过）")
        return 1

    if filename_only := failed:
        print(f"     （{filename_only}/{len(chunks)} 块失败，结果可能不全）")
    if len(chunks) > 1:
        print(f"     （正文 {len(text)} 字符 → 分 {len(chunks)} 块扫描"
              + (f"，{failed} 块失败" if failed else "") + "；接口单次上限 2000 字符）")
    print(f"\n  ② 红狐命中词 {len(words)} 个（**参考，不是判决**）")
    if not words:
        print("     ✅ 无")
    else:
        groups = {"行业相关": [], "含绝对化前缀（**看上下文**）": [], "其它（多为误报）": []}
        for w in words:
            if any(k in w for k in INDUSTRY):
                groups["行业相关"].append(w)
            elif w in ADVERT or (len(w) <= 4 and w[:1] in "最极超"):
                groups["含绝对化前缀（**看上下文**）"].append(w)
            else:
                groups["其它（多为误报）"].append(w)
        for g, ws in groups.items():
            if not ws:
                continue
            print(f"     [{g}] " + "  ".join(f"「{w}」" for w in ws))
        for w in words[:6]:
            c = ctx(text, w, limit=1)
            if c:
                print(f"        「{w}」…{c[0]}…")
    print(f"     红狐库的类型标记：{sorted(types) if types else '（接口未返回）'}")

    print("\n  ⛔ 本工具不阻断定稿（理由见文件头：该库对评论类文章误报率高）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
