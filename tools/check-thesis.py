#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""论点一致性检查：这篇文章有没有在讲同一件事。

    python tools/check-thesis.py drafts/20261109-slug [更多目录...]
    python tools/check-thesis.py drafts/*/

为什么需要（2026-11-10，复盘立冬那篇）：
    那篇稿子脚本全过（符号/事实/质感/结构/内容质检/选题对齐/违禁词/技能全绿），
    但内容上是散的：10 个话题、3 个互相竞争的论点、1316 字没有方向。

    现有检查器查不出这件事：
      · check-quality   只查第一人称、开头抓手这类形式项
      · check-structure 只查开头废话、结尾总结这类套话
      · check-topic-align 查读者三问，且当时因 topic_id=None 直接跳过

    而「发散」是可以机器判定的：如果每节讲的词和主论点不重叠、结尾讲的和开头不是一件事，
    那它就是发散的。

查四条：
    ① 主论点落地率 —— 主论点的核心词在文中出现了多少
    ② 结尾回扣开头 —— 结尾和开头是不是同一件事
    ③ 单节占比 —— 有没有一节吃掉太多篇幅（像在写另一篇文章）
    ④ 小标题主题离散度 —— 各节之间讲的还是不是一回事

主论点从哪来：
    优先 drafts.viewpoint，其次按 topic_id 去 topics.viewpoint 取。
    取不到就只跑 ②③④（纯文本可判定的部分），并明确说明「无主论点可比对」。
"""
import glob
import io
import os
import re
import sqlite3
import sys

DB = r"C:\data\test\workbench\workbench.db"

# 功能字：含这些字的 bigram 不算内容词
FUNC = set("的了着是在也就都还又和与把被从对为以之其而且但却因所如若虽然则个么什一"
           "我你他她它们这那哪谁甚怎多少几")

# 结尾回扣开头的判据：共享内容 bigram 数
ECHO_MIN = 3
# 主论点落地率的及格线
THESIS_COVER_MIN = 0.50
# 单节占比上限（超过就像在写另一篇文章）
SECTION_MAX_SHARE = 0.35

def bigrams(text):
    """中文 bigram，去掉标点与纯功能字组合。"""
    t = re.sub(r"[^\u4e00-\u9fff]", "", text or "")
    out = set()
    for i in range(len(t) - 1):
        bg = t[i:i + 2]
        if bg[0] in FUNC or bg[1] in FUNC:
            continue
        out.add(bg)
    return out


def cjk_len(t):
    return len(re.findall(r"[\u4e00-\u9fff]", t or ""))


def load_thesis(draft_dir):
    """按目录名反查草稿的 viewpoint。找不到返回空串。"""
    name = os.path.basename(os.path.normpath(draft_dir))
    try:
        conn = sqlite3.connect(DB)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT id, topic_id, viewpoint FROM drafts WHERE path LIKE ?",
            (f"%{name}%",)).fetchone()
        if row is None:
            conn.close()
            return "", None
        vp = (row["viewpoint"] or "").strip()
        if not vp and row["topic_id"]:
            t = conn.execute("SELECT viewpoint FROM topics WHERE id=?",
                             (row["topic_id"],)).fetchone()
            if t:
                vp = (t["viewpoint"] or "").strip()
        conn.close()
        return vp, row["id"]
    except Exception:
        return "", None


def split_sections(text):
    """按 H2 切节。返回 (head, [(title, body), ...])。"""
    parts = re.split(r"^## (.+)$", text, flags=re.M)
    head = parts[0]
    secs = []
    for i in range(1, len(parts), 2):
        secs.append((parts[i].strip(), parts[i + 1] if i + 1 < len(parts) else ""))
    return head, secs


def check(path):
    text = io.open(path, encoding="utf-8").read()
    # 去掉图位与摘要行，它们不参与正文判断
    body = re.sub(r"^!\[[^\]]*\]\([^)]*\)\s*$", "", text, flags=re.M)
    body_noq = "\n".join(l for l in body.split("\n") if not l.strip().startswith(">"))

    draft_dir = os.path.dirname(path)
    name = os.path.basename(os.path.normpath(draft_dir))
    total = cjk_len(body_noq)
    if total < 800:
        print(f"  -- {name:<32} {total:>5}字  (短于800字，跳过)")
        return []

    thesis, draft_id = load_thesis(draft_dir)
    head, secs = split_sections(body_noq)
    head_text = re.sub(r"^#\s.*$", "", head, flags=re.M)
    problems = []

    # ① 主论点落地率
    if thesis:
        tb = bigrams(thesis)
        db_ = bigrams(body_noq)
        if tb:
            hit = tb & db_
            rate = len(hit) / len(tb)
            if rate < THESIS_COVER_MIN:
                missing = "、".join(sorted(tb - hit)[:6])
                problems.append(
                    f"主论点只落地了 {rate*100:.0f}%（{len(hit)}/{len(tb)} 个核心词）。"
                    f"没写到的：{missing} —— 文章讲了别的事，主论点没兑现")
    # 没有主论点不算本检查器的错：缺观点是选题层的问题，由选题提示词负责。
    # 这里只在输出里标注，不阻断——否则所有历史稿都会卡住。
    # ①④ 两项依赖主论点，无观点时自动跳过。

    # ② 结尾回扣开头
    if secs:
        tail = secs[-1][1]
    else:
        tail = body_noq
    lead = head_text
    if cjk_len(lead) > 80 and cjk_len(tail) > 80:
        shared = bigrams(lead) & bigrams(tail)
        if len(shared) < ECHO_MIN:
            problems.append(
                f"结尾和开头不是同一件事（共享核心词只有 {len(shared)} 个）。"
                f"开头讲的是：{re.sub(chr(10), '', lead)[:30]}…，"
                f"结尾讲的是：{re.sub(chr(10), '', tail)[:30]}… —— 结尾另起炉灶了")

    # ③ 单节占比
    if secs:
        sizes = [(t, cjk_len(b)) for t, b in secs]
        body_total = sum(n for _, n in sizes) or 1
        for t, n in sizes:
            share = n / body_total
            if share > SECTION_MAX_SHARE:
                problems.append(
                    f"「{t}」一节占正文 {share*100:.0f}%（{n} 字），"
                    f"超过 {SECTION_MAX_SHARE*100:.0f}% —— 一节吃掉近半篇幅，像在写另一篇文章")

    # ④ 每节与主论点的关联度
    # 判据不是「各节之间像不像」——讲不同侧面时本来就该用不同的词，那样必然误报。
    # 而是「每节跟主论点有没有关系」：零重叠的节，就是在讲另一件事。
    # 实测依据：v16 的「三、这些建议适合谁」= 0/19 个核心词，正是那节跑题的确证。
    if thesis and secs:
        tb2 = bigrams(thesis)
        body_total2 = sum(cjk_len(b) for _, b in secs) or 1
        for t, b in secs:
            hit2 = tb2 & bigrams(b)
            share2 = cjk_len(b) / body_total2
            if len(hit2) == 0 and cjk_len(b) >= 100:
                problems.append(
                    f"「{t}」一节跟主论点之间一个核心词都没有（0/{len(tb2)}），"
                    f"而它占正文 {share2*100:.0f}% —— 这一节在讲另一件事，是跑题节，删掉或压成一句")
            elif len(hit2) <= 1 and share2 > 0.30:
                problems.append(
                    f"「{t}」一节占正文 {share2*100:.0f}%，但只碰到主论点的 {len(hit2)} 个核心词 —— "
                    f"篇幅大而关联弱，容易被读成另一篇文章")

    mark = "OK" if not problems else "XX"
    tag = "" if thesis else "（无主论点）"
    print(f"  {mark} {name:<32} {total:>5}字  主论点{len(bigrams(thesis)) if thesis else 0}词{tag}")
    for p in problems:
        print(f"       · {p}")
    return problems


# 创作中的状态：这些才需要被本检查器拦
# queued 不算：它代表「已入队但还没开始写」，此时没有成稿可查。
# 把 queued 算进来会让一堆从未开工的历史草稿永久卡住构建。
ACTIVE = {"draft", "polished", "reviewed", "formatted"}


def active_paths():
    """返回处于创作中的草稿目录名集合。读不到 DB 就返回 None（不过滤）。"""
    try:
        conn = sqlite3.connect(DB)
        rows = conn.execute("SELECT path, status FROM drafts").fetchall()
        conn.close()
        out = set()
        for p, st in rows:
            if not p:
                continue
            if (st or "") in ACTIVE:
                out.add(os.path.basename(str(p).rstrip("/\\")))
        return out
    except Exception:
        return None


def main():
    args = [a for a in sys.argv[1:] if a != "--all"]
    check_all = "--all" in sys.argv[1:]
    if not args:
        print(__doc__)
        return 1

    dirs = []
    for a in args:
        if os.path.isdir(a):
            dirs.append(a)
        else:
            dirs.extend(sorted(d for d in glob.glob(a) if os.path.isdir(d)))

    print("  论点一致性检查（这篇文章有没有在讲同一件事）")
    print("  " + "=" * 68)
    act = None if check_all else active_paths()
    if act is not None:
        print(f"  只查创作中的稿子（{len(act)} 篇）；已完成的想看加 --all")
        print()

    bad = 0
    checked = 0
    for d in dirs:
        p = os.path.join(d, "draft.md")
        if not os.path.isfile(p):
            print(f"  -- {os.path.basename(d):<32} 无 draft.md，跳过")
            continue
        if act is not None and os.path.basename(os.path.normpath(d)) not in act:
            continue
        checked += 1
        if len(check(p)) > 0:
            bad += 1
    print()
    print(f"  {bad} / {checked} 篇有论点一致性问题")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
