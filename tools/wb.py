#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据层快速调用助手（给 Agent 和自动任务用）。

    python tools/wb.py take-job
    python tools/wb.py list-jobs
    Get-Content req.json | python tools/wb.py          # 复杂请求走 stdin

等价于 workbench-db.py api --payload <base64>，只是省掉手工编码。
注意：PowerShell 会吃掉内联 JSON 的引号，所以复杂请求用 stdin 或文件。
"""

import base64
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "workbench-db.py")


def build_request(argv):
    if len(argv) >= 2 and argv[1].strip().startswith("{"):
        return json.loads(argv[1])
    if len(argv) >= 2:
        # 简写：wb.py list-jobs pending  →  {"op":"list-jobs","status":"pending"}
        #       wb.py take-job 12       →  {"op":"take-job","id":12}  精确取某条
        op = argv[1]
        req = {"op": op}
        if len(argv) >= 3 and argv[2]:
            if op == "take-job" and argv[2].isdigit():
                req["id"] = int(argv[2])
            else:
                req["status"] = argv[2]
        return req
    raw = sys.stdin.read().strip()
    if not raw:
        raise ValueError("没有请求：给一个 op 参数或从 stdin 传 JSON")
    return json.loads(raw)


def main():
    try:
        req = build_request(sys.argv)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad request: {e}"}, ensure_ascii=False))
        return 2
    payload = base64.b64encode(json.dumps(req, ensure_ascii=False).encode("utf-8")).decode()
    out = subprocess.run([sys.executable, "-X", "utf8", DB, "api", "--payload", payload],
                         capture_output=True, text=True, encoding="utf-8")
    text = (out.stdout or "").strip()
    print(text if text else (out.stderr or "").strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
