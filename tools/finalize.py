#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""定稿流水线（幂等，一条命令做完，不允许中间手工步骤）。

    python tools/finalize.py <draft_dir> [--publish] [--delete-draft <media_id>]

做的六件事，顺序固定：
    1. 直引号 → 中文双引号（draft.md）
    2. strip-citations → draft-stripped.md
    3. **把占位符换成 imgs/ 里的实际图片路径** → article.md（封面行移除，不进正文）
    4. format.py 排版 → article.html
    5. check-symbols.py 校验（含 article.html）—— 不通过就停下
    6. 可选：发布到微信草稿箱

为什么要有这个脚本：2026-10-06 手工分步时出过一次事故——
修引号时把 `article.md` 用 `draft.md` 的内容覆盖了，于是占位符回到了定稿里，
排版产物变成 4 张裂图，并发布进了草稿箱。
**根因是 `article.md` 是派生文件（草稿 + 图片路径），却被当成草稿的副本处理。**
把链路固化成脚本，就不存在"漏做某一步"或"用错源文件"。
"""

import io
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
ROOT = os.path.dirname(PLUGIN)


def skill_root():
    """技能安装目录。不要写死绝对路径：换机器 / 换用户名都会变。

    解析顺序：环境变量覆盖 > DSH_HOME/skills > ~/.dsh/skills
    """
    env = os.environ.get("DSH_WORKBENCH_SKILL_ROOT")
    if env and os.path.isdir(env):
        return env
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "skills")


SK = skill_root()
PY = sys.executable
FMT = os.path.join(SK, "aws-wechat-article-formatting", "scripts", "format.py")
STRIP = os.path.join(SK, "aws-wechat-article-writing", "scripts", "write.py")
PUB = os.path.join(SK, "aws-wechat-article-publish", "scripts", "publish.py")
SYMCHK = os.path.join(HERE, "check-symbols.py")
DB = os.path.join(HERE, "workbench-db.py")

QUOTE_L, QUOTE_R = "\u201c", "\u201d"


def rd(p):
    return io.open(p, encoding="utf-8").read()


def wr(p, t):
    io.open(p, "w", encoding="utf-8", newline="\n").write(t)


def fix_quotes(text):
    out, n = [], 0
    for ch in text:
        if ch == '"':
            out.append(QUOTE_L if n % 2 == 0 else QUOTE_R)
            n += 1
        else:
            out.append(ch)
    return "".join(out), n


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    d = os.path.abspath(args[0])
    do_publish = "--publish" in sys.argv
    allow_ph = "--allow-placeholder" in sys.argv   # 配图之前先排版预览时用
    draft_md = os.path.join(d, "draft.md")
    if not os.path.exists(draft_md):
        print(f"  ❌ 找不到 {draft_md}")
        return 2

    # 0. 按写作技能跑 L1 硬性检查（**不同技能的硬性规则互斥，必须按 skill 选尺子**）
    #    A 类（aws）：导语 80-128 字、加粗密度、金句行
    #    B 类（khazix）：禁冒号/破折号、禁小标题、禁大量加粗、口语词密度
    #    拿 A 类的配额去卡 B 类的稿子必然失败，那不是稿子的问题。
    if "--skip-skill-check" not in sys.argv:
        r = subprocess.run([PY, "-X", "utf8", os.path.join(HERE, "check-draft.py"), d],
                           capture_output=True, text=True, encoding="utf-8")
        tail = [l for l in ((r.stdout or "") + (r.stderr or "")).splitlines() if l.strip()]
        for line in tail[-2:]:
            print("  " + line.strip())
        if r.returncode != 0:
            print("\n  ❌ 写作技能的 L1 硬性规则未通过，停下（定稿前必须过）。")
            print("     · 确认要跳过：加 --skip-skill-check")
            return 1
        print("  0) 写作技能 L1 检查通过")

    # 1. 引号
    t = rd(draft_md)
    nq = t.count('"')
    if nq:
        t, _ = fix_quotes(t)
        wr(draft_md, t)
    print(f"  1) 直引号 {nq} 个 → 中文双引号")

    # 2. strip-citations
    r = subprocess.run([PY, "-X", "utf8", STRIP, "strip-citations", draft_md,
                        "-o", os.path.join(d, "draft-stripped.md")],
                       capture_output=True, text=True, encoding="utf-8")
    stripped = rd(os.path.join(d, "draft-stripped.md"))

    # 3. 占位符 → 实际图片路径（**这一步以前是手动的，也是最容易漏的**）
    marks = list(re.finditer(r"!\[([^\]]+)\]\(placeholder\)", stripped))
    img_dir = os.path.join(d, "imgs")
    photos = (sorted(f for f in os.listdir(img_dir)
                     if f.endswith(".png") and f.startswith("img-"))
              if os.path.isdir(img_dir) else [])
    body = [m for m in marks if not m.group(1).startswith("封面")]
    n_inserted = 0

    if len(photos) != len(body) and not allow_ph:
        print(f"  ❌ 图片数({len(photos)}) 与正文图位数({len(body)}) 不一致，停下。")
        print("     配图还没生成、只想先排版预览：加 --allow-placeholder")
        return 1

    if len(photos) != len(body):
        # 预览模式：保留占位符，不插图
        wr(os.path.join(d, "article.md"), stripped)
        print(f"  2) 剥离引用标注 → 3) 跳过插图（--allow-placeholder："
              f"图位 {len(body)} / 已有图 {len(photos)}，产物里仍是裂图预览）")
    else:
        out, last, i = [], 0, 0
        for m in marks:
            out.append(stripped[last:m.start()])
            if m.group(1).startswith("封面"):
                out.append("")                  # 封面不进正文
            else:
                out.append(f"![{m.group(1)}](imgs/{photos[i]})")
                i += 1
            last = m.end()
        out.append(stripped[last:])
        article = re.sub(r"\n{3,}", "\n\n", "".join(out))
        wr(os.path.join(d, "article.md"), article)
        n_inserted = i
        print(f"  2) 剥离引用标注 → 3) 插入 {i} 张正文图（封面不进正文）")

    # 4. 排版
    r = subprocess.run([PY, "-X", "utf8", FMT, os.path.join(d, "article.md"),
                        "--theme", "资讯", "--scheme", "藏青",
                        "-o", os.path.join(d, "article.html")],
                       capture_output=True, text=True, encoding="utf-8")
    html = rd(os.path.join(d, "article.html")) if r.returncode == 0 else ""
    imgs = re.findall(r'<img[^>]*src="([^"]+)"', html)
    bad = [s for s in imgs if "placeholder" in s]
    print(f"  4) 排版 → <img> {len(imgs)} 个"
          + (f"，其中 placeholder {len(bad)} 个（预览，未配图）" if bad else " ✅"))
    if allow_ph and not photos:
        pass                                    # 预览模式允许裂图
    elif bad or len(imgs) != len(photos):
        print("  ❌ 排版产物里的图片不对，停下（不发布）")
        return 1
    if bad and do_publish:
        print("  ❌ 产物里还有 placeholder，禁止发布")
        return 1

    # 5. 符号校验
    r = subprocess.run([PY, "-X", "utf8", SYMCHK, d], capture_output=True,
                       text=True, encoding="utf-8")
    print(f"  5) 符号校验 → {'通过 ✅' if r.returncode == 0 else '不通过 ❌'}")
    if r.returncode != 0:
        for line in (r.stdout or "").splitlines():
            if "❌" in line:
                print("       " + line.strip())
        return 1

    # 6. 发布
    if do_publish:
        # 发布前的最后一道闸门：产物里不许还有 placeholder。
        # 为什么必须有：`--allow-placeholder`（排版预览用）会故意留下 <img src="placeholder">，
        # 而 publish.py 本身**不检查**这一点，直接上传——这条链路就是 2026-10-06
        # 那次「4 张裂图进草稿箱」事故的复现路径。
        html = os.path.join(d, "article.html")
        if os.path.exists(html):
            n_ph = rd(html).count("placeholder")
            if n_ph:
                print(f"  ❌ article.html 里还有 {n_ph} 处 placeholder，拒绝发布。")
                print("     原因：--allow-placeholder 只用于排版预览，产物是裂图。")
                print("     修法：先配图（生成 imgs/），再不带 --allow-placeholder 重跑 finalize.py，")
                print("           确认 <img> 全部指向实际图片后再发布。")
                return 1
        r = subprocess.run([PY, "-X", "utf8", PUB, "full",
                            os.path.relpath(d, ROOT)],
                           capture_output=True, text=True, encoding="utf-8", cwd=ROOT)
        wr(os.path.join(d, "publish.log"), (r.stdout or "") + (r.stderr or ""))
        m = re.search(r"草稿创建成功: media_id=(\S+)", r.stdout or "")
        print(f"  6) 发布 → {'media_id ' + m.group(1)[:26] + '…' if m else '失败 ❌'}")
        if not m:
            return 1
        # 记一条 publishes（method=draft 表示只进草稿箱）并回写状态
        import base64
        import json
        did = os.path.basename(d).split("-")[0]
        try:
            drafts = json.loads(subprocess.run(
                [PY, "-X", "utf8", DB, "api", "--payload",
                 base64.b64encode(json.dumps({"op": "list-drafts"}).encode()).decode()],
                capture_output=True, text=True, encoding="utf-8").stdout)["drafts"]
            target = [x for x in drafts if x.get("path", "").rstrip("/").endswith(
                os.path.basename(d))] or []
            if target:
                tid = target[0]["id"]
                subprocess.run([PY, "-X", "utf8", DB, "add-publish", "--draft-id", str(tid),
                                "--account", "测试号", "--method", "draft", "--status", "uploaded",
                                f"--media-id={m.group(1)}",
                                "--note", "finalize.py 自动记录：封面+正文图已上传，进草稿箱未群发"],
                               capture_output=True, text=True, encoding="utf-8")
                subprocess.run([PY, "-X", "utf8", DB, "api", "--payload",
                                base64.b64encode(json.dumps(
                                    {"op": "set-draft", "id": tid, "status": "draftbox",
                                     "imagesCount": len(photos)}).encode()).decode()],
                               capture_output=True, text=True, encoding="utf-8")
                print(f"     已记录 publishes 并回写 draft #{tid} → draftbox")
        except Exception as e:
            print(f"     ⚠️ 回写失败（不影响已发布的草稿）: {e}")

    print("\n  完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
