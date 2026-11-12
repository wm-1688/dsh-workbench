#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""封面专项检查：不能是「左图右纯色」的两半拼贴。

    python tools/check-cover.py drafts/20261109-slug
    python tools/check-cover.py drafts/*/

为什么需要（2026-11-09，用户发现）：
    v11–v15 七张封面全是「左四成画面 + 右六成纯色块」的拼贴。
    根因是配图规范的旧版要求「文字区必须是纯色」，提示词照着写，
    模型就真的画了一块纯色。

    而这些纯色区完全没用——微信信息流里标题显示在封面下方，不压在图里。

查什么：
    ① 像素层面：封面图里有没有一片占比 ≥25% 的「几乎无变化」区域
    ② 提示词层面：plan JSON 的 theme 里有没有「纯色」「留白」「空白」这类词
"""
import glob
import io
import os
import sys

try:
    from PIL import Image
except ImportError:
    print("  需要 Pillow")
    sys.exit(2)

# 提示词里不该出现的词
BAN_WORDS = ["纯色平面", "纯色区域", "纯色背景", "纯净的", "留白区", "空白区域",
             "平坦的背景", "单一色彩平面"]

# 一块区域「是纯色块」的判据：标准差 < 2 且动态范围 ≤ 6。
# 实测对比：
#   纯色块（v13 旧封面右侧深灰）：std≈1.2, range≈3   ← 命中
#   干净墙面（v13 新封面背景）：  std≈4~6, range≈20  ← 不命中
# 阈值定在 2/6，卡在两者之间。
FLAT_STD = 2.0
FLAT_RANGE = 6
# 这块区域至少占画面多大比例才判定为「拼贴」
FLAT_AREA_RATIO = 0.25


def _grid_stats(im, cols, rows):
    """把图缩到固定网格，返回每格的 (std, range)。

    用「动态范围 max-min」而不是只看标准差：纯色块里偶尔一两个噪点会把
    std 抬高，但 range 仍然是 0。两个一起看更稳。
    """
    w, h = im.size
    small = im.resize((cols * 8, max(1, rows * 8)), Image.BILINEAR)
    sw, sh = small.size
    px = list(small.getdata())
    cw, ch = sw // cols, sh // rows
    out = []
    for r in range(rows):
        row = []
        for c in range(cols):
            vals = []
            for y in range(r * ch, min((r + 1) * ch, sh)):
                base = y * sw
                vals.extend(px[base + c * cw: base + min((c + 1) * cw, sw)])
            if not vals:
                row.append((999.0, 999))
                continue
            mean = sum(vals) / len(vals)
            std = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
            rng = max(vals) - min(vals)
            row.append((std, rng))
        out.append(row)
    return out


def analyze_flat_regions(path):
    """找出最大的「纯色连通块」占画面比例。

    判据同时看 std 和 range：两者都小才算纯色。
    网格 16×12，每格 8×8 像素——够细能定位区块，够粗不受单像素噪点影响。
    """
    im = Image.open(path).convert("L")
    COLS, ROWS = 16, 12
    stats = _grid_stats(im, COLS, ROWS)
    flat = [[(std < FLAT_STD and rng <= FLAT_RANGE) for (std, rng) in row]
            for row in stats]

    # 找最大的连通平坦块（4 邻接）
    seen = [[False] * COLS for _ in range(ROWS)]
    best = 0
    for r in range(ROWS):
        for c in range(COLS):
            if flat[r][c] and not seen[r][c]:
                stack = [(r, c)]
                seen[r][c] = True
                size = 0
                while stack:
                    y, x = stack.pop()
                    size += 1
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < ROWS and 0 <= nx < COLS and flat[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            stack.append((ny, nx))
                best = max(best, size)
    return best / (COLS * ROWS)


def edge_flat_band(path):
    """检查左右两侧有没有贯穿整条边的纯色带。

    做法：把图缩到 100 宽，逐列算 std/range。
    从左边数，连续多少列是零方差；从右边数同理。
    某一侧连续 ≥20% 宽度都是零方差，就判定为纯色带。

    返回 (side, width_ratio) 或 None。
    """
    im = Image.open(path).convert("L")
    w, h = im.size
    small = im.resize((100, max(8, int(h * 100 / w))), Image.BILINEAR)
    sw, sh = small.size
    px = list(small.getdata())

    col_flat = []
    for c in range(sw):
        vals = [px[y * sw + c] for y in range(sh)]
        mean = sum(vals) / len(vals)
        std = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
        rng = max(vals) - min(vals)
        col_flat.append(std < FLAT_STD and rng <= FLAT_RANGE)

    # 左侧连续
    left = 0
    while left < sw and col_flat[left]:
        left += 1
    # 右侧连续
    right = 0
    while right < sw and col_flat[sw - 1 - right]:
        right += 1

    if left / sw >= 0.20:
        return ("左", left / sw)
    if right / sw >= 0.20:
        return ("右", right / sw)
    return None



def check_cover_image(png_path):
    if not os.path.isfile(png_path):
        return []
    ratio = analyze_flat_regions(png_path)
    if ratio >= FLAT_AREA_RATIO:
        return [f"封面有 {ratio*100:.0f}% 的面积是纯色块——这是「左图右色」的两半拼贴，"
                f"应该是整幅画面。重做时去掉提示词里的「纯色/留白」要求。"]

    # 第二道：检查左右两侧有没有「贯穿整条边的纯色带」。
    # 这是「左图右色」最典型的形态，比面积占比更准。
    band = edge_flat_band(png_path)
    if band:
        side, w_ratio = band
        return [f"封面{side}侧有占画面宽 {w_ratio*100:.0f}% 的纯色带（贯穿整条边）——"
                f"典型的「左图右色」拼贴。重做时去掉提示词里的纯色/留白要求。"]
    return []


def check_cover_prompt(plan_glob):
    """查 plan JSON 里的封面提示词有没有留着旧的纯色要求。"""
    bad = []
    for f in glob.glob(plan_glob):
        try:
            import json
            j = json.load(io.open(f, encoding="utf-8"))
        except Exception:
            continue
        items = j if isinstance(j, list) else [j]
        for it in items:
            if not isinstance(it, dict) or it.get("id") != "cover":
                continue
            theme = str(it.get("theme") or "")
            for w in BAN_WORDS:
                if w in theme:
                    bad.append(f"{os.path.basename(f)} 的封面提示词含「{w}」——"
                               f"会让模型画出纯色块，删掉")
                    break
    return bad


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1

    dirs = []
    for a in args:
        if os.path.isdir(a):
            dirs.append(a)
        else:
            dirs.extend(sorted(d for d in glob.glob(a) if os.path.isdir(d)))

    print("  封面专项检查（不能是左图右纯色的拼贴）")
    print("  " + "=" * 66)
    bad = 0
    for d in dirs:
        name = os.path.basename(os.path.normpath(d))
        cover = os.path.join(d, "imgs", "cover.png")
        if not os.path.isfile(cover):
            print(f"  -- {name:<32} 无封面，跳过")
            continue
        problems = check_cover_image(cover)
        if problems:
            bad += 1
            print(f"  XX {name:<32}")
            for p in problems:
                print(f"       · {p}")
        else:
            print(f"  OK {name:<32} 整幅画面，无大块纯色")

    # 提示词层（只查 _tmp 下现存的 plan 文件）
    prompt_bad = check_cover_prompt(os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))), "_tmp", "plan-*.json"))
    if prompt_bad:
        print()
        print("  提示词层提醒：")
        for p in prompt_bad:
            print(f"    · {p}")

    print()
    print(f"  {bad} / {len(dirs)} 篇封面有问题")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
