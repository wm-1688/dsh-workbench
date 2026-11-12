#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""khazix-writer 的 L1 硬性规则扫描（它 SKILL.md 里自己定义的那一层）。

为什么做成脚本：它的 L1 全是可机械判定的禁令（禁用词/标点/结构套话），
靠肉眼数一定会漏。而且 B 类不过 aws 配额门禁，没有别的机器检查兜底。
"""
import io
import re
import sys

P = sys.argv[1] if len(sys.argv) > 1 else r"C:\data\test\drafts\20261011-pingfenbiao\draft.md"
t = io.open(P, encoding="utf-8").read()
lines = t.splitlines()

# 正文净字数（去掉配图标记与标题行）
body = "\n".join(l for l in lines if not l.startswith("![") and not l.startswith("# "))
n = len(re.sub(r"\s|\*", "", body))

print(f"  正文净字数 {n}   （khazix 规范 4000-8000）")
print(f"  段落数 {len([p for p in body.split(chr(10)+chr(10)) if p.strip()])}")

fails = []

print("\n=== L1-1 禁用词 ===")
BANNED = {
    "说白了": "坦率的讲 / 其实就是",
    "意味着什么": "那结果会怎样呢",
    "这意味着": "所以呢",
    "本质上": "说到底 / 其实",
    "换句话说": "你想想看 / 也就是说",
    "不可否认": "直接删掉",
    "综上所述": "具体回扣句",
    "总的来说": "具体回扣句",
    "值得注意的是": "直接说",
    "不难发现": "直接说",
    "让我们来看看": "删掉",
    "接下来让我们": "删掉",
}
for w, fix in BANNED.items():
    c = t.count(w)
    if c:
        fails.append(f"禁用词 {w} × {c}")
        print(f"  ❌ {w} × {c}（→ {fix}）")
if not any(t.count(w) for w in BANNED):
    print("  ✅ 零命中")

print("\n=== L1-2 禁用标点 ===")
prose = "\n".join(l for l in lines if not l.startswith("!["))
colon = [i for i, l in enumerate(lines, 1) if "：" in l and not l.startswith("![")]
dash = [i for i, l in enumerate(lines, 1) if "——" in l]
dq = t.count("\u201c") + t.count("\u201d")
bracket = t.count("\u300c") + t.count("\u300d")
ascii_q = t.count('"')
for name, val, hint in [
    ("冒号 ：（正文）", colon, "用逗号替代"),
    ("破折号 ——", dash, "用逗号或句号替代"),
    ("中文双引号 “”", dq, "khazix 用「」，但本项目全局规范要求用 “”，保留"),
    ("直角引号 「」", bracket, "**本项目禁用**，改 “”"),
    ("ASCII 直引号", ascii_q, "**禁用**"),
]:
    if name.startswith(("冒号", "破折号", "直角", "ASCII")):
        if val:
            fails.append(f"{name} × {len(val) if isinstance(val, list) else val}")
            print(f"  ❌ {name} × {len(val) if isinstance(val, list) else val}  行 {val if isinstance(val, list) else ''}  （{hint}）")
        else:
            print(f"  ✅ {name} 0")
    else:
        print(f"  ·  {name} {val}（{hint}）")

print("\n=== L1-3 结构套话 ===")
h = len([l for l in lines if l.startswith("# ")])
h2 = len([l for l in lines if l.startswith("## ")])
bold = t.count("**") // 2
bullets = len([l for l in lines if re.match(r"^\s*[-*+]\s", l)])
print(f"  {'❌' if h2 else '✅'} markdown 小标题 ## × {h2}   （khazix：绝大多数文章不加小标题）")
if h2:
    fails.append(f"小标题 × {h2}")
print(f"  ·  一级标题 # × {h}（文章标题）")
print(f"  {'❌' if bold > 3 else '✅'} 加粗 × {bold}   （khazix：不大量加粗，超 3 处即过度结构化）")
if bold > 3:
    fails.append(f"加粗 × {bold}")
print(f"  {'❌' if bullets > 3 else '✅'} bullet 列表项 × {bullets}   （超 3 需改散文）")
if bullets > 3:
    fails.append(f"bullet × {bullets}")

print("\n=== L1-4 空泛工具名 ===")
VAGUE = ["AI工具", "某个模型", "相关技术", "某工具"]
hit = [v for v in VAGUE if v in t]
print("  ✅ 零命中" if not hit else f"  ❌ {hit}")
if hit:
    fails.append(f"空泛工具名 {hit}")

print("\n=== L2 补充（风格层可机械判定的部分）===")
paras = [p.strip() for p in body.split("\n\n") if p.strip()]
short = [p for p in paras if len(p) <= 20 and not p.startswith("![")]
print(f"  {'✅' if len(short) >= 3 else '❌'} 一句话独立成段 × {len(short)}（khazix 要求 ≥3）")
if len(short) < 3:
    fails.append(f"短段 × {len(short)}")
emo = [x for x in ["。。。", "？？？", "= =", "..."] if x in t]
print(f"  {'✅' if emo else '❌'} 情绪标点 {emo or '无'}（khazix 要求至少一种）")
if not emo:
    fails.append("无情绪标点")
oral = ["坦率的讲", "说真的", "我是真的", "反正我觉得", "怎么说呢", "其实吧", "你想想看",
        "我跟你说", "回到", "顺着上面的", "我有时候觉得", "我一直觉得", "我自己的感受是",
        "说实话", "我自己也", "愚钝如我", "太牛逼", "离谱", "懵", "愣住了", "背脊发凉"]
used = [w for w in oral if w in t]
print(f"  {'✅' if len(used) >= 8 else '❌'} 口语化词组 × {len(used)}（khazix 要求 ≥8）：{used[:12]}")
if len(used) < 8:
    fails.append(f"口语词 × {len(used)}")

print("\n" + "=" * 56)
if fails:
    print(f"  ❌ L1/L2 未通过 {len(fails)} 项：")
    for f in fails:
        print(f"     · {f}")
    sys.exit(1)
print("  ✅ L1/L2 全部通过")
