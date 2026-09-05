# -*- coding: utf-8 -*-
"""AM-5 用例集的【词面泄漏】校验器。

为什么需要它：AM-5 的 semantic 型要求【刻意避开目标节里用过的词】。
人出题靠自律，AI 出题靠不住——照着笔记写题，用词必然往原文靠，
那就把 semantic 题写成了变相的 keyword，BM25 拿到白送的分。
本脚本把这个作弊路径机械地堵上。

口径对齐：notes_fts 是裸 fts5，中文靠 to_ngram 的 bigram 预处理才搜得到，
所以这里也拆 bigram 比对——判【能不能靠词面命中】就得用检索真正用的那一套。

它【只输出词与统计，不输出笔记正文】。
"""
import json
import re
import sqlite3
import sys

DB = sys.argv[1]
CASES = sys.argv[2]

# 近似 crate::markdown::outline：所有 ATX 标题行各起一节，扁平不嵌套，
# 开头到第一个标题之前是引言节（index 0）。
# 口径对不对，看总节数能不能对上 outline.md 的 352。
HEAD = re.compile(r"^(#{1,6})\s+(.*?)\s*$")


def split_sections(content):
    """返回 [(index, heading, body)]。index 0 的 heading 为空串。"""
    lines = content.split("\n")
    secs = []
    cur_head = ""
    cur_body = []
    idx = 0
    started = False
    in_fence = False
    for ln in lines:
        # 围栏代码块里的 `# xxx` 是注释不是标题。漏掉这一条会多切出节来，
        # 总节数就对不上 outline.md 的 352，heading 也会假性撞多条。
        if ln.lstrip().startswith("```"):
            in_fence = not in_fence
            cur_body.append(ln)
            continue
        m = None if in_fence else HEAD.match(ln)
        if m:
            # 开头就是标题时，不造空的引言节
            if started or "".join(cur_body).strip():
                secs.append((idx, cur_head, "\n".join(cur_body)))
                idx += 1
            elif not started:
                idx = 0
            started = True
            cur_head = m.group(2)
            cur_body = []
        else:
            cur_body.append(ln)
    if started or "".join(cur_body).strip():
        secs.append((idx, cur_head, "\n".join(cur_body)))
    # 重新编号：有引言节则从 0 起，否则从 1 起
    has_intro = bool(secs) and secs[0][1] == ""
    base = 0 if has_intro else 1
    return [(base + i, h, b) for i, (_, h, b) in enumerate(secs)]


def tokens(q):
    """拆成【中文 bigram】+【ASCII 单词】，与检索侧口径一致。"""
    out = []
    for run in re.findall(r"[一-鿿]+", q):
        for i in range(len(run) - 1):
            out.append(run[i:i + 2])
        if len(run) == 1:
            out.append(run)
    for w in re.findall(r"[A-Za-z][A-Za-z0-9_.-]*", q):
        out.append(w.lower())
    # 去重但保序
    seen = set()
    uniq = []
    for t in out:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    return uniq


conn = sqlite3.connect(DB)
rows = conn.execute(
    "SELECT id, title, content FROM notes WHERE deleted_at IS NULL OR deleted_at = ''"
).fetchall()

notes = []
total_sections = 0
for nid, title, content in rows:
    secs = split_sections(content or "")
    total_sections += len(secs)
    notes.append({"id": nid, "title": title or "", "secs": secs})

print("库规模：{} 篇 / {} 节（outline.md 当时导出的是 27 篇 / 352 节）".format(
    len(notes), total_sections))
print()

with open(CASES, encoding="utf-8") as f:
    data = json.load(f)

bad = 0
for c in data["cases"]:
    cid = c["id"]
    q = c.get("query", "")
    if not q:
        print("[{}] ⚠ query 为空".format(cid))
        bad += 1
        continue
    toks = tokens(q)
    for lab in c["expect"]:
        want_n = lab["note"].lower()
        want_h = lab["heading"].lower()
        hits = [n for n in notes if want_n in n["title"].lower()]
        if len(hits) != 1:
            print("[{}] ❌ note「{}」匹配到 {} 篇".format(cid, lab["note"], len(hits)))
            bad += 1
            continue
        note = hits[0]
        if not want_h:
            secs = [s for s in note["secs"] if s[0] == 0]
        else:
            secs = [s for s in note["secs"] if want_h in s[1].lower()]
        if len(secs) != 1:
            print("[{}] ❌ 「{}」里 heading「{}」匹配到 {} 节".format(
                cid, note["title"][:20], lab["heading"], len(secs)))
            bad += 1
            continue
        idx, head, body = secs[0]
        hay = (head + "\n" + body).lower()
        leaked = [t for t in toks if t in hay]
        rate = len(leaked) / len(toks) if toks else 0.0
        flag = "✅" if rate == 0 else ("⚠" if rate <= 0.25 else "🔴")
        print("{} [{}] {} §[{}] {}  泄漏 {}/{} = {:.0%}  {}".format(
            flag, cid, note["title"][:18], idx, head[:24],
            len(leaked), len(toks), rate, " ".join(leaked[:10])))

print()
print("解析失败 {} 处".format(bad))
