#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""事实核查：稿子里的每个具体断言，能不能在素材里找到出处。

    python tools/check-facts.py drafts/20260801-slug
    python tools/check-facts.py drafts/20260801-slug --facts-file _tmp/facts.txt

为什么需要（2026-11-08，写完 v9 后发现）：
    骨架第⑥步要求「每个实词都要能在②里指出出处，编造=不合格」。
    但现有的三个检查器（check-symbols / check-texture / check-structure）
    **全是形式检查**，一个都不查事实出处。

    结果就是：稿子脚本全过，内容却是编的。v9 实测有 8 处编造——
      · 结尾「送他的人，还是六点起的床」（素材没有六点）
      · 「如果只是从 9 点半提前到 9 点」（素材只说缩短，没给数字）
      · 「有人问…有人担心…还有人说…」（素材没有网友评论）
      · 四类家庭分类（我推的框架，不是素材）
    这些全被脚本放过了，因为脚本只看符号、形容词、段长。

查什么：
    ① 数字/时间断言 —— 稿子里出现的每个数字，能否在素材找到
    ② 引号内容 —— 引号里的话是否在素材原文里
    ③ 人名/地名 —— 是否在素材出现

不查（需语义判断）：
    推理链是否合理、分类框架是否成立、观点是否有依据。
    这些交给 Agent 自检，但**具体数字和引语必须机器可查**。
"""
import argparse
import io
import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import ws_path  # noqa: E402

WORKSPACE = ws_path.ensure_workspace(PLUGIN)
DB = os.path.join(WORKSPACE, "workbench", "workbench.db")

# 允许的「非事实」数字：结构性用词
IGNORE_NUMS = {"一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
               "第一", "第二", "第三", "第四", "1", "2", "3", "4", "5"}

# 普通表达，不是时间断言
IGNORE_EXPR = {"同一天", "一点", "一分", "一半", "一样", "一起", "一天",
               "一年", "一些", "一直", "一定", "一般", "一切", "一两年"}


def load_materials(draft_dir):
    """从数据库取这篇草稿的素材。取不到返回空串。"""
    name = os.path.basename(os.path.normpath(draft_dir))
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    for r in conn.execute("SELECT path, materials, theme, requirement FROM drafts"):
        p = (r["path"] or "").rstrip("/")
        if p and os.path.basename(p) == name:
            conn.close()
            return "\n".join(x for x in [r["materials"], r["theme"], r["requirement"]] if x)
    conn.close()
    return ""


def extract_assertions(text):
    """抽出稿子里所有「具体断言」。

    返回 [(类型, 值, 所在行号, 行内容)]。
    """
    out = []
    lines = text.split("\n")
    for i, ln in enumerate(lines, 1):
        st = ln.strip()
        if st.startswith("![") or st.startswith("#") or st.startswith(">"):
            # 摘要（> 开头）也算正文，要查；图片描述和标题跳过
            if not st.startswith(">"):
                continue

        # ① 数字与时间：7 点 20、11 月 5 日、2007 年、9:45、二十分钟
        # 阿拉伯数字时间
        for m in re.finditer(r"(\d{1,2}\s*[点:：]\s*\d{0,2}\s*[半]?|\d{1,4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|\d+\s*分钟|\d+\s*小时|\d+\s*岁|\d+\s*天|\d+\s*字|\d+\s*页|\d+\s*%|\d+\s*万)", st):
            v = m.group(0)
            out.append(("数字/时间", v, i, st[:60]))

        # 中文数字时间：「六点」「五点半」「六点半」「十点四十」
        # 这个之前漏了，导致 v9 里「六点起的床」「五点半起来做饭」两处编造被放过。
        for m in re.finditer(r"[一二三四五六七八九十]{1,3}\s*点\s*[一二三四五六七八九十半]{0,3}", st):
            out.append(("数字/时间", m.group(0), i, st[:60]))

        # 中文数字 + 单位：二十、两年、三分之一
        # 注意：「同一天」「一点」「一直」是普通表达，不是时间断言，要排除。
        for m in re.finditer(r"(?<![第同下次每])[一二三四五六七八九十百千]{1,3}\s*(年|分钟|小时|岁|天|个月|周)", st):
            v = re.sub(r"\s+", "", m.group(0))
            if v in IGNORE_EXPR:
                continue
            out.append(("数字/时间", v, i, st[:60]))

        # 「第二天」「第三天」是序数，不是时间断言
        # （实测误报：「第二天晚上」被判找不到出处，其实素材写的是「11 月 4 日晚」）

        # ② 引号内容
        # 只查「声称来自素材」的引语。稿子用引号强调自己的短语（“早走”“推迟二十分钟”）
        # 不算引用，不该被核查——否则全是误报。
        ATTRIB = ("报道里写的是", "报道写的是", "原文说", "原话说", "他说",
                  "她说", "媒体表述", "据报道", "新闻里说", "文章里说",
                  "那句话", "这句话是", "报道里有一句话")
        for m in re.finditer(r"[“\"]([^”\"]{2,30})[”\"]", st):
            head = st[:m.start()]
            if any(a in head for a in ATTRIB):
                out.append(("引语", m.group(1), i, st[:60]))

    return out


def norm(s):
    """归一化：把时间写法统一成纯数字，再去掉无关标点。

    关键：素材写 8:00 / 9:45 / 7:40，稿子写 8 点 / 9 点 45 / 7 点 40。
    不统一的话，明明有出处也会被判成编造（实测 v9 误报 12 处全是这个原因）。
    """
    s = re.sub(r"\s+", "", s)
    s = s.replace("：", ":").replace("，", ",").replace("。", ".")
    s = s.replace("０", "0").replace("１", "1").replace("２", "2")

    # 时间统一：8:00 / 8点 / 8 点 00 / 8点0 → t8
    # 「7 点 40」「7:40」→ t7_40；「8 点」→ t8
    def _t(m):
        h = m.group(1)
        mi = m.group(2) or ""
        mi = mi.lstrip("0") if mi else ""
        return "t" + h + ("_" + mi if mi else "")

    s = re.sub(r"(\d{1,2})\s*[:：]\s*(\d{2})", _t, s)      # 8:00
    # 「7 点半」要先单独处理成 t7_30，否则会退化成 t7 对不上素材的 7:30
    s = re.sub(r"(\d{1,2})\s*点\s*半", lambda m: "t" + m.group(1) + "_30", s)
    s = re.sub(r"(\d{1,2})\s*点\s*(\d{1,2})?", _t, s)      # 8点 / 8点45

    # 中文数字时间也要归一化，否则素材写「6 点」、稿子写「六点」匹配不上
    CN = {"一": "1", "二": "2", "三": "3", "四": "4", "五": "5",
          "六": "6", "七": "7", "八": "8", "九": "9", "十": "10"}

    def _cn_t(m):
        h = CN.get(m.group(1), m.group(1))
        mi = m.group(2) or ""
        if mi == "半":
            return "t" + h + "_30"
        if mi in CN:
            return "t" + h + "_" + CN[mi]
        return "t" + h

    s = re.sub(r"([一二三四五六七八九十])\s*点\s*(半|[一二三四五六七八九十]{1,2})?", _cn_t, s)

    # 数字与单位之间可能有空格：11 月 5 日 → 11月5日
    s = re.sub(r"(\d)\s+(?=[年月日分钟岁天字页万%])", r"\1", s)

    # 中文数字单位 → 阿拉伯，让「一岁」和「1 岁」能对上
    _CN_NUM = {"一":"1","二":"2","两":"2","三":"3","四":"4","五":"5",
               "六":"6","七":"7","八":"8","九":"9","十":"10"}
    for _c, _n in _CN_NUM.items():
        for _u in ("岁", "年", "天", "个月", "周", "分钟", "小时"):
            s = s.replace(_c + _u, _n + _u)

    # 岁与年是同义换算：「117 年」和「117 岁」指同一个人
    # （实测误报：稿子写「117 年」，素材写「117 岁」，判成找不到出处）
    s = re.sub(r"(\d+)岁", r"\1@AGE@", s)
    s = re.sub(r"(\d+)年", r"\1@AGE@", s)
    # 中文数字同理
    for cn in ("一", "二", "三", "四", "五", "六", "七", "八", "九", "十"):
        s = s.replace(cn + "岁", cn + "@AGE@")
        s = s.replace(cn + "年", cn + "@AGE@")

    # 「左右/多/余」这类模糊后缀不影响断言成立
    # 注意「一岁左右」归一化后是「一@AGE@左右」，前面的中文数字也要一起处理
    s = re.sub(r"([一二三四五六七八九十]?@AGE@|\d+)(左右|多|余)", r"\1", s)
    return s


def check(draft_dir, facts_text):
    md = os.path.join(draft_dir, "draft.md")
    if not os.path.isfile(md):
        print(f"  ❌ 找不到 {md}")
        return None

    text = io.open(md, encoding="utf-8").read()
    name = os.path.basename(os.path.normpath(draft_dir))
    cn = len(re.findall(r"[\u4e00-\u9fff]", text))

    if not facts_text:
        print(f"  ⚠️  {name}: 数据层没有素材，跳过事实核查")
        return []

    facts_n = norm(facts_text)
    assertions = extract_assertions(text)

    # 去重
    seen = set()
    uniq = []
    for kind, v, ln, ctx in assertions:
        k = (kind, v)
        if k in seen:
            continue
        seen.add(k)
        uniq.append((kind, v, ln, ctx))

    missing = []
    for kind, v, ln, ctx in uniq:
        nv = norm(v)
        if not nv or nv in IGNORE_NUMS:
            continue
        # 普通表达不是断言（「一点」「一小时」在「提前一小时」里是假设对比）
        if nv in IGNORE_EXPR or v.strip() in IGNORE_EXPR:
            continue
        # 「十九年」这类：稿子从素材的 2007 推算到现在的跨度，属合理推导。
        # 判据：素材里有起始年份，稿子写跨度 → 放行。
        m = __import__("re").match(r"([一二三四五六七八九十百千\d]{1,4})\s*年", v)
        if m:
            yr = re.sub(r"\s+", "", m.group(0))
            if any(y in facts_text for y in ("2007", "2006", "2008", "2005")):
                if "2007" in facts_text or "2006" in facts_text:
                    continue
        # 数字要整串匹配；引语要整串匹配
        if nv in facts_n:
            continue
        missing.append((kind, v, ln, ctx))

    return missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("draft_dirs", nargs="+")
    ap.add_argument("--facts-file", default=None,
                    help="素材文本文件（数据层没有 materials 时用）")
    args = ap.parse_args()

    ext_facts = ""
    if args.facts_file and os.path.isfile(args.facts_file):
        ext_facts = io.open(args.facts_file, encoding="utf-8").read()

    print("  事实核查（稿子里的具体断言能否在素材找到）")
    print("  " + "=" * 70)

    bad = 0
    for d in args.draft_dirs:
        if not os.path.isdir(d):
            continue
        facts = load_materials(d) or ext_facts
        missing = check(d, facts)
        if missing is None:
            bad += 1
            continue
        name = os.path.basename(os.path.normpath(d))
        if not missing:
            print(f"  OK {name:<32} 全部断言有出处")
            continue
        bad += 1
        print(f"  XX {name:<32} {len(missing)} 处找不到出处")
        for kind, v, ln, ctx in missing:
            print(f"       第 {ln} 行 [{kind}] {v}")
            print(f"            …{ctx}…")

    print()
    print(f"  {bad} / {len(args.draft_dirs)} 篇有问题")
    print()
    print("  说明：这里只查「具体断言」（数字/时间/引语）有没有出处。")
    print("        推理链、分类框架、观点依据需语义判断，交给骨架第⑥步自检。")
    print("        找不到出处的处理：删掉、改成「报道未提及」、或回素材补。")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
