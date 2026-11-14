#!/usr/bin/env python3
"""标识符定义检查：用到的顶层常量必须有定义。

为什么需要这道检查
------------------
2026-11-13 踩过两次：

  ① index.js 里写 `join(TOOLS_DIR, 'finalize.py')`，
     但项目里只有 PLUGIN_ROOT，没有 TOOLS_DIR。
     → 运行时 ReferenceError，整个 node 半边挂掉，界面全白。

  ② client.template.js 里写 `const res = await ...` 放在 if 块内，
     块外又用 `res.id` → 块作用域外访问，运行时崩。

`node --check` 两个都查不出来 —— 语法完全合法。

判据（只查能机械判定的部分）
--------------------------
扫 index.js / client.js 里形如 `join(XXX, ...)`、`path.join(XXX, ...)` 的第一参数，
如果它是全大写常量（如 TOOLS_DIR）或首字母大写的常量，
而文件里找不到它的 `const XXX =` / `let XXX =` 定义，就报错。

不查局部变量、不查函数参数 —— 那些误报率太高。

退出码
------
0 通过 / 1 有未定义引用
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def target_files():
    """优先当前工作目录下的 lib/（测试时用），否则用插件目录。"""
    base = os.getcwd() if os.path.isdir(os.path.join(os.getcwd(), "lib")) else ROOT
    return [os.path.join(base, "lib", "index.js"), os.path.join(base, "lib", "client.js")]

# 这些是 JS / Node 内置或全局，不该报错
WHITELIST = {
    "Math", "Object", "Array", "String", "Number", "Boolean", "JSON", "Date",
    "Promise", "Map", "Set", "Error", "RegExp", "Symbol", "BigInt",
    "process", "Buffer", "console", "window", "document", "globalThis",
    "Intl", "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
}


def check_file(path):
    if not os.path.isfile(path):
        return []
    s = io.open(path, encoding="utf-8", errors="ignore").read()

    # 收集本文件里所有顶层声明
    declared = set()
    for m in re.finditer(r"^\s*(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)", s, re.M):
        declared.add(m.group(1))
    # import 进来的
    for m in re.finditer(r"import\s*\{([^}]+)\}\s*from", s):
        for part in m.group(1).split(","):
            name = part.strip().split(" as ")[-1].strip()
            if name:
                declared.add(name)
    # 函数参数 / 解构也会产生名字，宽松放行：凡在 `(` 后出现过的也算
    for m in re.finditer(r"\(([^()]{0,300})\)\s*=>", s):
        for part in re.split(r"[,\s{}:=]+", m.group(1)):
            if part:
                declared.add(part.strip())

    problems = []
    # 只看路径拼接的第一参数：最典型的「常量名写错」场景
    for m in re.finditer(r"\b(?:join|resolve)\(\s*([A-Z_][A-Z0-9_]{2,})\s*,", s):
        name = m.group(1)
        if name in declared or name in WHITELIST:
            continue
        # 同一文件里没定义 → 报错
        line = s.count("\n", 0, m.start()) + 1
        problems.append((line, name, s[m.start():m.start() + 60].split("\n")[0]))
    return problems


def main():
    total = 0
    for f in target_files():
        if not os.path.isfile(f):
            continue
        probs = check_file(f)
        name = os.path.basename(f)
        if not probs:
            print(f"  ✅ {name}：路径拼接用到的常量都有定义")
            continue
        total += len(probs)
        print(f"  ❌ {name}：{len(probs)} 处未定义常量")
        for line, sym, ctx in probs[:20]:
            print(f"     第 {line} 行  {sym}")
            print(f"       {ctx.strip()[:80]}")

    if total:
        print("\n  为什么是错：这些名字在运行时求值，写错就是 ReferenceError，")
        print("  整个半边的 JS 会挂掉（node 半边挂 → 界面白屏；client 挂 → 面板消失）。")
        print("  `node --check` 查不出这类问题，它只看语法。")
        print("\n  修法：改成文件里真实存在的常量名（如 PLUGIN_ROOT / WORKSPACE）。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
