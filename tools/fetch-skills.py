#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按 skills-manifest.json 从上游仓库下载依赖技能。

设计要点（都是为了不破坏用户已有环境）：

1. **不打包、按需下载**。仓库里不含第三方技能代码，安装时才从各上游仓库拉取，
   版权与许可证仍归原作者，本插件只做「引用」。
2. **绝不覆盖**。目标目录已存在就跳过——用户可能改过、或版本更新过。
3. **离线可用**。下载失败只降级提示，不让安装中断。缺技能时插件仍能启动，
   只是对应功能报错。
4. **按仓库聚合下载**。同一仓库的多个技能只下一次 zip，避免重复拉取
   （redfox-community 有 133 个技能，单次 5MB）。
5. **分支名逐个写清**。各仓库默认分支不统一，handraw-style 是 master，
   其余是 main，统一写 main 会 404。

用法：
    python tools/fetch-skills.py --list        # 看清单
    python tools/fetch-skills.py --dry-run     # 只算会下什么，不落盘
    python tools/fetch-skills.py               # 下载缺的技能
    python tools/fetch-skills.py --only aihot  # 只装指定技能
"""
import argparse
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
MANIFEST = os.path.join(PLUGIN, "skills-manifest.json")

# codeload 直连，不经过 github.com（部分网络环境 github.com 443 不通，
# codeload 通）。也不需要 git，纯 urllib。
CODELOAD = "https://codeload.github.com/{repo}/zip/refs/heads/{branch}"
UA = "dsh-workbench-installer"


def say(msg=""):
    print("  " + msg if msg else "")


def skills_home():
    """技能安装目录。与 lib/index.js 的 imageSkillRoot() 保持一致。"""
    env = os.environ.get("DSH_WORKBENCH_SKILL_ROOT", "").strip()
    if env:
        return env
    home = os.environ.get("DSH_HOME", "").strip() or os.path.join(
        os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "skills")


def load_manifest():
    with io.open(MANIFEST, "r", encoding="utf-8") as f:
        return json.load(f)


def download_zip(repo, branch, timeout=300):
    """下整个仓库的 zip 到内存，返回 (bytes, 顶层目录名)。失败抛异常。"""
    import urllib.request
    import urllib.error

    url = CODELOAD.format(repo=repo, branch=branch)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    if not names:
        raise ValueError("zip 是空的")
    root = names[0].split("/")[0]
    return z, root


def extract_skill(z, root, path, dest):
    """把 zip 里 root/path/** 解到 dest。path 为空表示整仓就是技能。

    跳过 .git 相关与 __pycache__，其余原样保留（含 LICENSE）。
    """
    prefix = (root + "/" + path).rstrip("/") + "/" if path else root + "/"
    members = [n for n in z.namelist() if n.startswith(prefix) and not n.endswith("/")]
    if not members:
        raise ValueError("zip 里找不到目录 %s" % (path or "(根)"))

    os.makedirs(dest, exist_ok=True)
    got = 0
    for n in members:
        rel = n[len(prefix):]
        if not rel:
            continue
        # 这些是构建产物/版本库残留，不该进技能目录
        parts = rel.split("/")
        if "__pycache__" in parts or ".git" in parts:
            continue
        out = os.path.join(dest, *parts)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with z.open(n) as src, open(out, "wb") as dst:
            shutil.copyfileobj(src, dst)
        got += 1
    return got


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--list", action="store_true", help="只列清单")
    ap.add_argument("--dry-run", action="store_true", help="不下载，只报告")
    ap.add_argument("--only", action="append", default=None,
                    help="只处理指定技能（可多次）")
    ap.add_argument("--dest", default=None, help="覆盖安装目录")
    ap.add_argument("--offline", action="store_true", help="跳过所有网络请求")
    args = ap.parse_args()

    man = load_manifest()
    repos = man.get("repos", {})
    skills = man.get("skills", [])
    dest_root = args.dest or skills_home()

    if args.only:
        want = set(args.only)
        skills = [s for s in skills if s["name"] in want]

    if args.list:
        say("清单：%s" % MANIFEST)
        say("可下载技能 %d 个，上游仓库 %d 个" % (len(skills), len(repos)))
        say()
        for s in skills:
            lic = repos.get(s["repo"], {}).get("license") or "未声明"
            flag = "必需" if s.get("required") else "可选"
            say("  %-36s %-38s %-8s %s" % (
                s["name"], s["repo"] + "/" + (s["path"] or "."), flag, lic))
        no_up = man.get("no_upstream", [])
        if no_up:
            say()
            say("无公开上游（需随包分发或跳过）%d 个：" % len(no_up))
            for s in no_up:
                say("  %-36s %s" % (s["name"], s["note"]))
        return 0

    os.makedirs(dest_root, exist_ok=True)

    # 先分拣：已装的跳过，剩下的按仓库分组
    todo, skipped = [], []
    for s in skills:
        target = os.path.join(dest_root, s["name"])
        if os.path.isdir(target):
            skipped.append(s["name"])
        else:
            todo.append(s)

    say("安装目录: %s" % dest_root)
    say("已存在 %d 个（跳过不覆盖），待下载 %d 个" % (len(skipped), len(todo)))

    if not todo:
        say("✅ 依赖技能齐全，无需下载")
        return 0

    if args.dry_run:
        by_repo = {}
        for s in todo:
            by_repo.setdefault(s["repo"], []).append(s["name"])
        say()
        say("将要下载：")
        for repo, names in sorted(by_repo.items()):
            br = repos.get(repo, {}).get("branch", "main")
            lic = repos.get(repo, {}).get("license") or "未声明许可"
            say("  %s@%s  [%s]  %d 个技能" % (repo, br, lic, len(names)))
            for n in names:
                say("      - %s" % n)
        return 0

    if args.offline:
        say("⚠️ --offline：跳过 %d 个技能的下载" % len(todo))
        return 0

    by_repo = {}
    for s in todo:
        by_repo.setdefault(s["repo"], []).append(s)

    ok, failed = [], []
    for repo, items in sorted(by_repo.items()):
        br = repos.get(repo, {}).get("branch", "main")
        lic = repos.get(repo, {}).get("license")
        say()
        say("↓ %s@%s%s" % (repo, br, ("  许可: " + lic) if lic else "  ⚠️ 上游未声明许可证"))
        try:
            z, root = download_zip(repo, br)
        except Exception as e:
            # 断网 / 仓库改名 / 分支变更都在这里兜住，不让安装中断
            say("  ⚠️ 下载失败: %s: %s" % (type(e).__name__, str(e)[:80]))
            for s in items:
                failed.append((s["name"], "下载失败"))
            continue

        for s in items:
            target = os.path.join(dest_root, s["name"])
            try:
                n = extract_skill(z, root, s.get("path", ""), target)
                say("  ✅ %-34s %d 个文件" % (s["name"], n))
                ok.append(s["name"])
            except Exception as e:
                say("  ⚠️ %-34s %s" % (s["name"], str(e)[:60]))
                # 解压失败留下半个目录会污染下次安装，清掉
                if os.path.isdir(target):
                    shutil.rmtree(target, ignore_errors=True)
                failed.append((s["name"], type(e).__name__))

    say()
    say("完成：成功 %d 个，失败 %d 个，跳过 %d 个" % (len(ok), len(failed), len(skipped)))

    if failed:
        say()
        say("⚠️ 以下技能没装上，相关功能会报错：")
        for n, why in failed:
            say("  - %-34s %s" % (n, why))
        say("  可以稍后重试：python tools/fetch-skills.py")
        no_up = [s["name"] for s in man.get("no_upstream", [])]
        lack_req = [s["name"] for s in man.get("skills", [])
                    if s.get("required") and not os.path.isdir(
                        os.path.join(dest_root, s["name"]))]
        if lack_req:
            say()
            say("⚠️ 必需技能仍缺 %d 个: %s" % (len(lack_req), ", ".join(lack_req)))
            say("   插件能启动，但写稿/检查/配图会失败。")
        if no_up:
            say()
            say("说明：%s 无公开上游，需随包分发或手动安装。" % ", ".join(no_up))
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
