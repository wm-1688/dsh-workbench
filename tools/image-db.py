#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生图工作台 · SQLite 数据层

与 workbench-db.py 共用同一个库文件（<workspace>/workbench/workbench.db），
但只管生图工作台自己的三张表：

    image_jobs    一次生成任务（排队 → 执行 → 完成）
    image_assets  生成出来的图片文件（一行 = 一张）
    image_usage   计费账本（按张计费，接口没有配额查询，只能自己记）

为什么要跟 topic_jobs / drafts 分家：两个轴。
    image_jobs.status 管「这次生成跑到哪一步」，
    image_usage       管「花了几张的钱」——和 drafts/publishes 的分法同源。

用法：
    python tools/image-db.py init
    python tools/image-db.py list-image-jobs [--status queued] [--limit 20]
    python tools/image-db.py list-image-assets [--job-id 1]
    python tools/image-db.py list-image-usage
"""

import argparse
import base64
import datetime
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
import ws_path as _ws
# 工作区解析：开发环境用 PLUGIN/..，安装环境用 PLUGIN 自己。
# 详见 ws_path.py 顶部说明（2026-11-08 打包验证时修）。
WORKSPACE = _ws.ensure_workspace(PLUGIN)
DATA_DIR = os.path.join(WORKSPACE, "workbench")
DB_PATH = os.path.join(DATA_DIR, "workbench.db")

SCHEMA = """
-- 生图任务：界面点【生成】产生的一条任务
--   状态机：queued → running → done / failed
--   arms 决定这一条要出几次图（text=只给文字 / ref=垫编号参考图 / both=各出一张）
--   n_images 是本次「实际调用生图 API 的次数」——按张计费，必须落在库里
CREATE TABLE IF NOT EXISTS image_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT,
  status      TEXT    NOT NULL DEFAULT 'queued',
  style_id    TEXT,                      -- 风格编号，如 FA-018
  layout_id   TEXT,                      -- 图型编号，如 SC-001（可空）
  color_id    TEXT,                      -- 主题色编号，如 C-01（可空）
  theme       TEXT    NOT NULL,          -- 画面主题（用户输入）
  prompt_zh   TEXT,
  prompt_en   TEXT,
  model       TEXT,
  size        TEXT,
  quality     TEXT,
  with_ref    INTEGER NOT NULL DEFAULT 1,-- 是否垫入编号参考图
  ref_path    TEXT,                      -- 编号参考图的绝对路径
  asset_ref_path TEXT,                   -- 资产库垫图（角色/道具/场景基准图），JSON 数组可多选
  params_json TEXT,                      -- 其余拼装参数：mode/ratio/whitespace/mood/subject/textReq/redraw
  series_id   INTEGER,                   -- 漫画流：属于哪个系列（NULL = 单图创作）
  panel_index INTEGER,                   -- 漫画流：第几镜（从 1 开始）
  arms        TEXT    NOT NULL DEFAULT 'ref',
  n_images    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  note        TEXT
);

-- 漫画流：一次创作 = 一组分镜。
-- 参数（风格/画幅/模式/垫图）存在这里，**分镜只各带自己的文案** ——
-- 否则 N 个任务各存一份完全相同的参数，改参数时还要同步 N 行。
-- 每个分镜是 image_jobs 里的一行（series_id + panel_index）。
CREATE TABLE IF NOT EXISTS image_series (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT,
  status         TEXT    NOT NULL DEFAULT 'draft',
                         -- draft | queued | running | done | failed
  title          TEXT,
  source_text    TEXT,                   -- 原始文案（文章 / 一句话 / 金句）
  panel_total    INTEGER NOT NULL DEFAULT 0,
  split_meta     TEXT,                   -- 拆解来源与是否凑不够（JSON）
  style_id       TEXT,
  color_id       TEXT,
  layout_id      TEXT,
  params_json    TEXT,
  with_ref       INTEGER NOT NULL DEFAULT 1,
  asset_ref_path TEXT,
  model          TEXT,
  size           TEXT,
  quality        TEXT,
  error          TEXT,
  note           TEXT
);

-- 生成物：一行 = 一张图。path 是绝对路径，rel_path 供界面走资源路由读取。
CREATE TABLE IF NOT EXISTS image_assets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER REFERENCES image_jobs(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL,
  arm         TEXT,                      -- text | ref
  path        TEXT    NOT NULL,
  rel_path    TEXT,
  bytes       INTEGER NOT NULL DEFAULT 0,
  width       INTEGER,
  height      INTEGER,
  model       TEXT,
  elapsed_ms  INTEGER,
  style_id    TEXT,
  theme       TEXT,
  note        TEXT
);

-- 计费账本：接口没有配额端点（/v1/models 与配额接口都是 404），只能本地记账
CREATE TABLE IF NOT EXISTS image_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,
  job_id      INTEGER REFERENCES image_jobs(id) ON DELETE SET NULL,
  model       TEXT,
  calls       INTEGER NOT NULL DEFAULT 0,-- 计费次数（= 成功出图的张数）
  endpoint    TEXT,
  note        TEXT
);
"""


def now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _add_column_if_missing(conn, table, column, decl):
    """与 workbench-db.py 同一条坑：已存在的表不会因 CREATE TABLE IF NOT EXISTS 长出新列。"""
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        return True
    return False


def ensure_schema(conn):
    """建表 + 列级迁移。

    ⚠️ 与 workbench-db.py 同一个坑：CREATE TABLE IF NOT EXISTS 不会给已有表补新列，
    加字段必须走 ALTER TABLE。
    """
    conn.executescript(SCHEMA)
    _add_column_if_missing(conn, "image_jobs", "asset_ref_path", "TEXT")
    _add_column_if_missing(conn, "image_jobs", "params_json", "TEXT")
    _add_column_if_missing(conn, "image_jobs", "series_id", "INTEGER")
    _add_column_if_missing(conn, "image_jobs", "panel_index", "INTEGER")
    conn.commit()


def _rows(conn, sql, params=()):
    return [dict(r) for r in conn.execute(sql, params)]


# ── CLI ──────────────────────────────────────────────────────────────

def cmd_init(args):
    conn = connect()
    ensure_schema(conn)
    tables = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    print(f"生图表就绪：{DB_PATH}")
    print(f"  库内全部表：{', '.join(tables)}")
    conn.close()
    return 0


def cmd_list_image_jobs(args):
    conn = connect()
    ensure_schema(conn)
    sql, params = "SELECT * FROM image_jobs", []
    if args.status:
        sql += " WHERE status=?"
        params.append(args.status)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(args.limit)
    rows = _rows(conn, sql, params)
    conn.close()
    if not rows:
        print("（无生图任务）")
        return 0
    print(f"{'id':>4}  {'状态':<8} {'风格':<8} {'臂':<5} {'张':>2}  主题")
    for r in rows:
        print(f"{r['id']:>4}  {r['status']:<8} {r['style_id'] or '—':<8} "
              f"{r['arms']:<5} {r['n_images']:>2}  {(r['theme'] or '')[:34]}")
    return 0


def cmd_list_image_assets(args):
    conn = connect()
    ensure_schema(conn)
    sql, params = "SELECT * FROM image_assets", []
    if args.job_id:
        sql += " WHERE job_id=?"
        params.append(args.job_id)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(args.limit)
    rows = _rows(conn, sql, params)
    conn.close()
    if not rows:
        print("（无生成物）")
        return 0
    for r in rows:
        print(f"#{r['id']:<4} job={r['job_id']} arm={r['arm'] or '—':<5} "
              f"{r['width']}x{r['height']} {r['bytes']}B  {r['rel_path']}")
    return 0


def cmd_list_image_usage(args):
    conn = connect()
    ensure_schema(conn)
    rows = _rows(conn, "SELECT * FROM image_usage ORDER BY id DESC LIMIT ?", (args.limit,))
    total = conn.execute("SELECT COALESCE(SUM(calls),0) c FROM image_usage").fetchone()["c"]
    conn.close()
    print(f"累计计费调用：{total} 次（按张）")
    for r in rows:
        print(f"  {r['created_at']}  job={r['job_id']}  {r['model']}  {r['calls']} 次")
    return 0


# ── node 半的 JSON 入口 ──────────────────────────────────────────────

def cmd_api(args):
    """请求 {"op": "..."} → 响应 {"ok": true, ...}。形状与 workbench-db.py 一致。"""
    raw = ""
    if getattr(args, "payload", None):
        try:
            raw = base64.b64decode(args.payload).decode("utf-8")
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"bad payload: {e}"}))
            return 1
    else:
        raw = sys.stdin.read() or "{}"
    try:
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad json: {e}"}))
        return 1

    op = req.get("op")
    conn = connect()
    try:
        ensure_schema(conn)
        out = _dispatch(conn, op, req)
    except Exception as e:
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        conn.close()
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


def _dispatch(conn, op, req):
    if op == "image-enqueue":
        theme = (req.get("theme") or "").strip()
        if not theme:
            return {"ok": False, "error": "theme required"}
        # 资产垫图可多选（角色+道具+场景同框），存 JSON 数组
        refs = req.get("assetRefPaths")
        if refs is None:
            single = req.get("assetRefPath")
            refs = [single] if single else []
        params = req.get("params") or {}
        cur = conn.execute(
            "INSERT INTO image_jobs (created_at,status,style_id,layout_id,color_id,theme,"
            "prompt_zh,prompt_en,model,size,quality,with_ref,ref_path,asset_ref_path,"
            "params_json,arms,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (now(), "queued", req.get("styleId"), req.get("layoutId"), req.get("colorId"),
             theme, req.get("promptZh"), req.get("promptEn"), req.get("model"),
             req.get("size"), req.get("quality"), 1 if req.get("withRef", True) else 0,
             req.get("refPath"),
             json.dumps(refs, ensure_ascii=False) if refs else None,
             json.dumps(params, ensure_ascii=False) if params else None,
             req.get("arms") or "ref", req.get("note")))
        conn.commit()
        job = dict(conn.execute("SELECT * FROM image_jobs WHERE id=?", (cur.lastrowid,)).fetchone())
        return {"ok": True, "job": job}

    if op == "image-list-jobs":
        sql, params = "SELECT * FROM image_jobs", []
        if req.get("status"):
            sql += " WHERE status=?"
            params.append(req["status"])
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(int(req.get("limit") or 50))
        return {"ok": True, "jobs": _rows(conn, sql, params)}

    if op == "image-list-assets":
        # 带上 series_id / panel_index：漫画流是**一次创作 = 一个数据对象**，
        # 界面要按系列归组展示，不能把一组的 N 张拆成 N 个独立资产。
        # 用 LEFT JOIN 取，不往 image_assets 冗余存一份（存一份就要同步两份）。
        sql = ("SELECT a.*, j.series_id AS series_id, j.panel_index AS panel_index, "
               "j.params_json AS job_params "
               "FROM image_assets a LEFT JOIN image_jobs j ON a.job_id = j.id")
        params = []
        if req.get("jobId"):
            sql += " WHERE a.job_id=?"
            params.append(int(req["jobId"]))
        sql += " ORDER BY a.id DESC LIMIT ?"
        params.append(int(req.get("limit") or 120))
        return {"ok": True, "assets": _rows(conn, sql, params)}

    if op == "image-take":
        jid = int(req.get("jobId") or 0)
        row = conn.execute("SELECT * FROM image_jobs WHERE id=?", (jid,)).fetchone()
        if row is None:
            return {"ok": False, "error": f"job {jid} not found"}
        conn.execute("UPDATE image_jobs SET status='running', updated_at=? WHERE id=?",
                     (now(), jid))
        conn.commit()
        return {"ok": True, "job": dict(conn.execute(
            "SELECT * FROM image_jobs WHERE id=?", (jid,)).fetchone())}

    if op == "image-finish":
        jid = req.get("jobId")
        assets = req.get("assets") or []
        if not jid:
            return {"ok": False, "error": "jobId required"}
        stamp = now()
        for a in assets:
            conn.execute(
                "INSERT INTO image_assets (job_id,created_at,arm,path,rel_path,bytes,width,"
                "height,model,elapsed_ms,style_id,theme,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (jid, stamp, a.get("arm"), a.get("path"), a.get("relPath"),
                 int(a.get("bytes") or 0), a.get("width"), a.get("height"), a.get("model"),
                 a.get("elapsedMs"), a.get("styleId"), a.get("theme"), a.get("note")))
        calls = int(req.get("calls") or len(assets))
        if calls:
            conn.execute(
                "INSERT INTO image_usage (created_at,job_id,model,calls,endpoint,note) "
                "VALUES (?,?,?,?,?,?)",
                (stamp, jid, req.get("model"), calls, req.get("endpoint"),
                 req.get("usageNote")))
        conn.execute(
            "UPDATE image_jobs SET status='done', updated_at=?, n_images=?, error=NULL, "
            "prompt_zh=COALESCE(?,prompt_zh), prompt_en=COALESCE(?,prompt_en) WHERE id=?",
            (stamp, len(assets), req.get("promptZh"), req.get("promptEn"), jid))
        conn.commit()
        return {"ok": True, "saved": len(assets)}

    if op == "image-fail":
        jid = req.get("jobId")
        if not jid:
            return {"ok": False, "error": "jobId required"}
        conn.execute("UPDATE image_jobs SET status='failed', updated_at=?, error=? WHERE id=?",
                     (now(), str(req.get("error") or "unknown"), jid))
        conn.commit()
        return {"ok": True}

    if op == "image-usage":
        total = conn.execute(
            "SELECT COALESCE(SUM(calls),0) c FROM image_usage").fetchone()["c"]
        by_model = _rows(conn, "SELECT model, SUM(calls) calls, COUNT(*) runs "
                               "FROM image_usage GROUP BY model ORDER BY calls DESC")
        recent = _rows(conn, "SELECT * FROM image_usage ORDER BY id DESC LIMIT 20")
        day = conn.execute(
            "SELECT COALESCE(SUM(calls),0) c FROM image_usage WHERE created_at LIKE ?",
            (datetime.datetime.now().strftime("%Y-%m-%d") + "%",)).fetchone()["c"]
        return {"ok": True, "totalCalls": total, "todayCalls": day,
                "byModel": by_model, "recent": recent}

    # ── 漫画流（一次创作 = 一组分镜）──
    if op == "series-create":
        cur = conn.execute(
            "INSERT INTO image_series (created_at,status,title,source_text,panel_total,split_meta,"
            "style_id,color_id,layout_id,params_json,with_ref,asset_ref_path,model,size,quality,note) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (now(), "draft", req.get("title"), req.get("sourceText"),
             int(req.get("panelTotal") or 0),
             json.dumps(req.get("splitMeta") or {}, ensure_ascii=False),
             req.get("styleId"), req.get("colorId"), req.get("layoutId"),
             json.dumps(req.get("params") or {}, ensure_ascii=False),
             1 if req.get("withRef", True) else 0,
             json.dumps(req.get("assetRefPaths") or [], ensure_ascii=False),
             req.get("model"), req.get("size"), req.get("quality"), req.get("note")))
        conn.commit()
        row = conn.execute("SELECT * FROM image_series WHERE id=?", (cur.lastrowid,)).fetchone()
        return {"ok": True, "series": dict(row)}

    if op == "series-panels":
        sid = int(req.get("seriesId") or 0)
        s = conn.execute("SELECT * FROM image_series WHERE id=?", (sid,)).fetchone()
        if s is None:
            return {"ok": False, "error": f"series {sid} not found"}
        panels = req.get("panels") or []
        if not panels:
            return {"ok": False, "error": "panels required"}
        # 重跑时先清掉上一轮的分镜任务，避免越堆越多
        conn.execute("DELETE FROM image_jobs WHERE series_id=?", (sid,))
        created = []
        for i, p in enumerate(panels, 1):
            idx = int(p.get("index") or i)
            # 分镜可以有**各自的图型**：电商详情页每张版式都不同（主图/细节/卖点/场景…），
            # 不能整组共用一个 layout。没给才回落到系列上的那个。
            lay = p.get("layoutId") or s["layout_id"]
            cur = conn.execute(
                "INSERT INTO image_jobs (created_at,status,style_id,layout_id,color_id,theme,"
                "model,size,quality,with_ref,ref_path,asset_ref_path,params_json,arms,"
                "series_id,panel_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (now(), "queued", s["style_id"], lay, s["color_id"],
                 p.get("text") or "", s["model"], s["size"], s["quality"], s["with_ref"],
                 None, s["asset_ref_path"], s["params_json"], "ref", sid, idx))
            created.append(cur.lastrowid)
        conn.execute("UPDATE image_series SET status='queued', panel_total=?, updated_at=? WHERE id=?",
                     (len(panels), now(), sid))
        conn.commit()
        return {"ok": True, "jobIds": created}

    if op == "series-update":
        sid = int(req.get("seriesId") or 0)
        fields, params = [], []
        for col in ("status", "error", "note"):
            if req.get(col) is not None:
                fields.append(f"{col}=?")
                params.append(req[col])
        if not fields:
            return {"ok": False, "error": "nothing to update"}
        fields.append("updated_at=?")
        params.append(now())
        params.append(sid)
        conn.execute(f"UPDATE image_series SET {', '.join(fields)} WHERE id=?", params)
        conn.commit()
        return {"ok": True}

    if op in ("series-get", "series-list"):
        def _pack(r):
            d = dict(r)
            panels = _rows(conn, "SELECT * FROM image_jobs WHERE series_id=? ORDER BY panel_index",
                           (r["id"],))
            assets = _rows(conn,
                           "SELECT a.* FROM image_assets a JOIN image_jobs j ON a.job_id=j.id "
                           "WHERE j.series_id=? ORDER BY j.panel_index", (r["id"],))
            d["panels"] = panels
            d["assets"] = assets
            d["doneCount"] = sum(1 for p in panels if p["status"] == "done")
            return d

        if op == "series-get":
            sid = int(req.get("seriesId") or 0)
            s = conn.execute("SELECT * FROM image_series WHERE id=?", (sid,)).fetchone()
            if s is None:
                return {"ok": False, "error": f"series {sid} not found"}
            return {"ok": True, "series": _pack(s)}
        rows = _rows(conn, "SELECT * FROM image_series ORDER BY id DESC LIMIT ?",
                     (int(req.get("limit") or 20),))
        return {"ok": True, "seriesList": [_pack(r) for r in rows]}

    # ── 删除 ──
    # 返回要删的**文件路径**，由 node 半负责真正 unlink（Python 这边只动数据库）。
    # 顺序很重要：先把待删的资产行查出来，再删任务/系列 —— 反过来就查不到了。
    if op == "asset-delete":
        aid = int(req.get("assetId") or 0)
        row = conn.execute("SELECT * FROM image_assets WHERE id=?", (aid,)).fetchone()
        if row is None:
            return {"ok": False, "error": f"asset {aid} not found"}
        jid = row["job_id"]
        conn.execute("DELETE FROM image_assets WHERE id=?", (aid,))
        # 这个任务的最后一张被删掉时，任务行也一起清掉 —— 否则任务列表里会留下
        # 一条「已完成 0 张」的空任务：没有意义，还占着任务数。
        left = conn.execute("SELECT COUNT(*) FROM image_assets WHERE job_id=?", (jid,)).fetchone()[0]
        orphan = None
        if left == 0:
            j = conn.execute("SELECT * FROM image_jobs WHERE id=?", (jid,)).fetchone()
            conn.execute("DELETE FROM image_jobs WHERE id=?", (jid,))
            orphan = dict(j) if j is not None else None
        conn.commit()
        return {"ok": True, "files": [row["path"]], "jobRemoved": orphan is not None, "jobId": jid}

    if op == "series-delete":
        sid = int(req.get("seriesId") or 0)
        s = conn.execute("SELECT * FROM image_series WHERE id=?", (sid,)).fetchone()
        if s is None:
            return {"ok": False, "error": f"series {sid} not found"}
        files = _rows(conn, "SELECT a.path FROM image_assets a JOIN image_jobs j ON a.job_id=j.id "
                            "WHERE j.series_id=?", (sid,))
        job_ids = [r["id"] for r in _rows(conn, "SELECT id FROM image_jobs WHERE series_id=?", (sid,))]
        n_jobs = conn.execute("DELETE FROM image_jobs WHERE series_id=?", (sid,)).rowcount
        conn.execute("DELETE FROM image_series WHERE id=?", (sid,))
        conn.commit()
        return {"ok": True, "files": [r["path"] for r in files], "jobCount": n_jobs,
                "jobIds": job_ids, "title": s["title"]}

    if op == "image-reap":
        # 进程被杀 / DSH 重启后，running 会永远挂着；超过阈值的置为 failed
        cutoff = str(req.get("cutoff") or "")
        if not cutoff:
            return {"ok": False, "error": "cutoff required"}
        cur = conn.execute(
            "UPDATE image_jobs SET status='failed', updated_at=?, "
            "error=COALESCE(error, '超时未完成（进程可能已中断）') "
            "WHERE status IN ('queued','running') AND COALESCE(updated_at, created_at) < ?",
            (now(), cutoff))
        conn.commit()
        return {"ok": True, "reaped": cur.rowcount}

    if op == "image-counts":
        j = conn.execute("SELECT COUNT(*) c FROM image_jobs").fetchone()["c"]
        a = conn.execute("SELECT COUNT(*) c FROM image_assets").fetchone()["c"]
        u = conn.execute("SELECT COALESCE(SUM(calls),0) c FROM image_usage").fetchone()["c"]
        q = conn.execute("SELECT COUNT(*) c FROM image_jobs WHERE status IN "
                         "('queued','running')").fetchone()["c"]
        return {"ok": True, "counts": {"jobs": j, "assets": a, "calls": u, "pending": q}}

    return {"ok": False, "error": f"unknown op: {op}"}


def main():
    ap = argparse.ArgumentParser(description="生图工作台 SQLite 数据层")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init").set_defaults(func=cmd_init)

    p = sub.add_parser("list-image-jobs", help="生图任务队列")
    p.add_argument("--status")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(func=cmd_list_image_jobs)

    p = sub.add_parser("list-image-assets", help="生成物列表")
    p.add_argument("--job-id", type=int)
    p.add_argument("--limit", type=int, default=40)
    p.set_defaults(func=cmd_list_image_assets)

    p = sub.add_parser("list-image-usage", help="计费账本")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(func=cmd_list_image_usage)

    p = sub.add_parser("api", help="node 半用的 JSON 入口（stdin 或 --payload，base64）")
    p.add_argument("--payload", help="base64 编码的 JSON 请求")
    p.set_defaults(func=cmd_api)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


if __name__ == "__main__":
    main()
