#!/usr/bin/env python3
"""探针语料导出（S0-P1 步骤 0）：真实 clipboard.db → probe/embed/data/*.json

- 只读拷贝 %APPDATA%/com.pastepanda.app/clipboard.db（含 -wal/-shm）到临时快照，
  不碰活库（app 可能在跑，WAL 模式下直接读会拿不到最新页）。
- 产物含用户真实内容 ⇒ data/ 已在 probe/.gitignore 忽略，禁止提交。
- notes：全量 13 条（id/title/summary/content/pinyin_initials——pinyin 取库里
  已算好的真实值，FTS5 对照组忠实复刻 notes_fts 写入路径）。
- history：1000 条最近的文本类卡片（text/code/doc/markdown/json/shell/rich），
  仅用于吞吐与 1k 索引外推的**规模基准**（真实中文语料），不进召回对比。
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile

APP_DB = os.path.expandvars(r"%APPDATA%\com.pastepanda.app\clipboard.db")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
HISTORY_N = 1000
TEXT_TYPES = ("text", "code", "doc", "markdown", "json", "shell", "rich")


def snapshot_db() -> str:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    for suf in ("", "-wal", "-shm"):
        src = APP_DB + suf
        if os.path.exists(src):
            shutil.copy(src, path + suf)
    return path


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    snap = snapshot_db()
    try:
        con = sqlite3.connect(snap)
        cur = con.cursor()

        notes = [
            {
                "id": r[0],
                "title": r[1],
                "summary": r[2] or "",
                "content": r[3] or "",
            }
            for r in cur.execute(
                "SELECT id, title, summary, content FROM notes "
                "WHERE deleted_at IS NULL ORDER BY updated_ms DESC"
            )
        ]
        # pinyin_initials 只是首字母串；notes_fts 的 pinyin 列由 compute_pinyin_initials
        # (title+content) 生成，单取一列不等于索引值。为忠实复刻，从库里的
        # notes_fts.pinyin 直接读（应用真实写入的派生值）。
        fts_pinyin = {
            r[0]: r[1]
            for r in cur.execute(
                "SELECT n.id, f.pinyin FROM notes n JOIN notes_fts f ON n.rowid = f.rowid"
            )
        }
        for n in notes:
            n["fts_pinyin"] = fts_pinyin.get(n["id"], "")

        qmarks = ",".join("?" for _ in TEXT_TYPES)
        # 正文口径：text/code/markdown 的载荷在 `text` 列，doc 类两列都有
        # （text=纯文本 / content=HTML）⇒ text 优先、content 兜底。
        history = [
            {"id": r[0], "content": (r[1] or "")[:4000], "type": r[2]}
            for r in cur.execute(
                f"SELECT id, CASE WHEN length(text) > 0 THEN text ELSE content END, "
                f"content_type FROM history "
                f"WHERE content_type IN ({qmarks}) "
                f"AND length(CASE WHEN length(text) > 0 THEN text ELSE content END) > 0 "
                f"ORDER BY time DESC LIMIT ?",
                (*TEXT_TYPES, HISTORY_N),
            )
        ]
    finally:
        con.close()
        for suf in ("", "-wal", "-shm"):
            if os.path.exists(snap + suf):
                os.remove(snap + suf)

    with open(os.path.join(OUT_DIR, "notes.json"), "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False)
    with open(os.path.join(OUT_DIR, "history_1000.json"), "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False)

    lens = [len(n["content"]) for n in notes]
    print(f"notes: {len(notes)} (content chars: min={min(lens)} max={max(lens)} "
          f"total={sum(lens)}); with fts_pinyin: {sum(1 for n in notes if n['fts_pinyin'])}")
    hlens = [len(h["content"]) for h in history]
    print(f"history: {len(history)} (chars: min={min(hlens)} max={max(hlens)} "
          f"total={sum(hlens)})")
    if len(notes) < 5:
        print("WARN: notes < 5，召回对比统计力不足", file=sys.stderr)


if __name__ == "__main__":
    main()
