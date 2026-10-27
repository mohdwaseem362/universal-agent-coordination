#!/usr/bin/env python3
"""
Persistent SQLite3 ACID Transaction Worker for Universal Agent Coordination.
Provides zero-build, cross-IDE SQLite3 access with WAL mode, busy_timeout,
and atomic BEGIN IMMEDIATE transactions over JSON-lines stdio.
"""

import json
import os
import sqlite3
import sys
import traceback


def connect_db(db_path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    # isolation_level=None enables manual transaction management (autocommit mode by default,
    # allowing explicit BEGIN IMMEDIATE / COMMIT / ROLLBACK).
    conn = sqlite3.connect(db_path, timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


def row_to_dict(row):
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}


def handle_request(conn: sqlite3.Connection, req: dict) -> dict:
    op = req.get("op")
    if op == "exec_script":
        sql = req["sql"]
        conn.executescript(sql)
        return {"ok": True}

    elif op == "query":
        sql = req["sql"]
        params = req.get("params", [])
        cur = conn.execute(sql, params)
        rows = [row_to_dict(r) for r in cur.fetchall()]
        return {"ok": True, "rows": rows, "rowcount": cur.rowcount, "lastrowid": cur.lastrowid}

    elif op == "run":
        sql = req["sql"]
        params = req.get("params", [])
        cur = conn.execute(sql, params)
        return {"ok": True, "changes": cur.rowcount, "lastrowid": cur.lastrowid}

    elif op == "transaction":
        statements = req.get("statements", [])
        results = []
        conn.execute("BEGIN IMMEDIATE;")
        try:
            for stmt in statements:
                sql = stmt["sql"]
                params = stmt.get("params", [])
                mode = stmt.get("mode", "run")
                expect_changes = stmt.get("expect_changes")
                cur = conn.execute(sql, params)
                if mode == "query":
                    rows = [row_to_dict(r) for r in cur.fetchall()]
                    results.append({"rows": rows, "changes": cur.rowcount, "lastrowid": cur.lastrowid})
                else:
                    if expect_changes is not None and cur.rowcount != expect_changes:
                        raise RuntimeError(
                            f"CONFLICT_OR_STALE_WRITE: Expected {expect_changes} affected rows, got {cur.rowcount}"
                        )
                    results.append({"changes": cur.rowcount, "lastrowid": cur.lastrowid})
            conn.execute("COMMIT;")
            return {"ok": True, "results": results}
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK;")
            raise

    elif op == "begin_immediate":
        conn.execute("BEGIN IMMEDIATE;")
        return {"ok": True}

    elif op == "commit":
        if conn.in_transaction:
            conn.execute("COMMIT;")
        return {"ok": True}

    elif op == "rollback":
        if conn.in_transaction:
            conn.execute("ROLLBACK;")
        return {"ok": True}

    elif op == "ping":
        return {"ok": True, "sqlite_version": sqlite3.sqlite_version}

    elif op == "close":
        conn.close()
        return {"ok": True, "closed": True}

    else:
        raise ValueError(f"Unknown database operation: {op}")


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: sqlite_worker.py <db_path>\n")
        sys.exit(1)

    db_path = sys.argv[1]
    conn = connect_db(db_path)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            res = handle_request(conn, req)
            res["id"] = req_id
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()
            if res.get("closed"):
                break
        except sqlite3.IntegrityError as e:
            if conn.in_transaction and not req.get("keep_tx"):
                try:
                    conn.execute("ROLLBACK;")
                except Exception:
                    pass
            err_resp = {
                "id": req_id,
                "ok": False,
                "error_code": "SQLITE_INTEGRITY_ERROR",
                "error": str(e),
            }
            sys.stdout.write(json.dumps(err_resp) + "\n")
            sys.stdout.flush()
        except sqlite3.OperationalError as e:
            if conn.in_transaction and not req.get("keep_tx"):
                try:
                    conn.execute("ROLLBACK;")
                except Exception:
                    pass
            err_resp = {
                "id": req_id,
                "ok": False,
                "error_code": "SQLITE_OPERATIONAL_ERROR",
                "error": str(e),
            }
            sys.stdout.write(json.dumps(err_resp) + "\n")
            sys.stdout.flush()
        except Exception as e:
            if conn.in_transaction and not req.get("keep_tx"):
                try:
                    conn.execute("ROLLBACK;")
                except Exception:
                    pass
            err_resp = {
                "id": req_id,
                "ok": False,
                "error_code": "DB_WORKER_ERROR",
                "error": str(e),
                "trace": traceback.format_exc(),
            }
            sys.stdout.write(json.dumps(err_resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
