from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path


STATE_TABLES_BY_THREAD = [
    ("threads", "id"),
    ("thread_dynamic_tools", "thread_id"),
    ("stage1_outputs", "thread_id"),
]

STATE_EDGE_TABLES = [
    ("thread_spawn_edges", ("parent_thread_id", "child_thread_id")),
]


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def connect(path: Path, readonly: bool = False) -> sqlite3.Connection | None:
    if not path.exists():
        return None
    if readonly:
        uri = f"file:{path.as_posix()}?mode=ro"
        con = sqlite3.connect(uri, uri=True)
    else:
        con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=5000")
    return con


def placeholders(count: int) -> str:
    return ",".join("?" for _ in range(count))


def has_table(con: sqlite3.Connection, table: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return row is not None


def count_where(con: sqlite3.Connection, table: str, column: str, ids: list[str]) -> int:
    if not ids or not has_table(con, table):
        return 0
    sql = f"SELECT COUNT(*) FROM {table} WHERE {column} IN ({placeholders(len(ids))})"
    return int(con.execute(sql, ids).fetchone()[0])


def preview(codex_home: Path, ids: list[str]) -> dict:
    result: dict[str, object] = {
        "state": {},
        "logs": {},
        "python": sys.executable,
    }
    state = connect(codex_home / "state_5.sqlite", readonly=True)
    if state:
        try:
            state_counts: dict[str, int] = {}
            for table, column in STATE_TABLES_BY_THREAD:
                state_counts[table] = count_where(state, table, column, ids)
            for table, columns in STATE_EDGE_TABLES:
                if has_table(state, table):
                    sql = (
                        f"SELECT COUNT(*) FROM {table} "
                        f"WHERE {columns[0]} IN ({placeholders(len(ids))}) "
                        f"OR {columns[1]} IN ({placeholders(len(ids))})"
                    )
                    state_counts[table] = int(state.execute(sql, ids + ids).fetchone()[0])
                else:
                    state_counts[table] = 0
            result["state"] = state_counts
        finally:
            state.close()

    logs = connect(codex_home / "logs_2.sqlite", readonly=True)
    if logs:
        try:
            result["logs"] = {"logs": count_where(logs, "logs", "thread_id", ids)}
        finally:
            logs.close()
    return result


def delete_from_table(con: sqlite3.Connection, table: str, column: str, ids: list[str]) -> int:
    if not ids or not has_table(con, table):
        return 0
    before = con.total_changes
    con.execute(f"DELETE FROM {table} WHERE {column} IN ({placeholders(len(ids))})", ids)
    return con.total_changes - before


def cleanup(codex_home: Path, ids: list[str], vacuum: bool) -> dict:
    result: dict[str, object] = {
        "stateDeleted": {},
        "logsDeleted": {},
        "vacuum": False,
        "python": sys.executable,
    }
    state = connect(codex_home / "state_5.sqlite")
    if state:
        try:
            state.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            state_deleted: dict[str, int] = {}
            for table, column in STATE_TABLES_BY_THREAD:
                state_deleted[table] = delete_from_table(state, table, column, ids)
            for table, columns in STATE_EDGE_TABLES:
                if has_table(state, table):
                    before = state.total_changes
                    sql = (
                        f"DELETE FROM {table} "
                        f"WHERE {columns[0]} IN ({placeholders(len(ids))}) "
                        f"OR {columns[1]} IN ({placeholders(len(ids))})"
                    )
                    state.execute(sql, ids + ids)
                    state_deleted[table] = state.total_changes - before
                else:
                    state_deleted[table] = 0
            state.commit()
            if vacuum:
                state.execute("VACUUM")
                state.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                result["vacuum"] = True
            result["stateDeleted"] = state_deleted
        finally:
            state.close()

    logs = connect(codex_home / "logs_2.sqlite")
    if logs:
        try:
            logs.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            logs_deleted = {"logs": delete_from_table(logs, "logs", "thread_id", ids)}
            logs.commit()
            if vacuum:
                logs.execute("VACUUM")
                logs.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                result["vacuum"] = True
            result["logsDeleted"] = logs_deleted
        finally:
            logs.close()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["preview", "cleanup"])
    parser.add_argument("--codex-home", required=True)
    parser.add_argument("--ids", required=True)
    parser.add_argument("--vacuum", action="store_true")
    args = parser.parse_args()

    codex_home = Path(args.codex_home).resolve()
    ids = [item for item in args.ids.split(",") if item]
    if not ids:
        emit({"error": "no ids supplied"})
        return 2
    if args.command == "preview":
        emit(preview(codex_home, ids))
    else:
        emit(cleanup(codex_home, ids, args.vacuum))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
