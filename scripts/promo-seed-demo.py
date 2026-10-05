"""Seed only the isolated promo identifier, never the user's application DB."""
import datetime
import hashlib
import json
import os
import sqlite3
import uuid
from pathlib import Path

target = Path(os.environ['APPDATA']) / 'com.pastepanda.promo20261003' / 'clipboard.db'
assert target.parent.name == 'com.pastepanda.promo20261003'
assert target.exists(), 'Start the isolated Tauri instance first'
conn = sqlite3.connect(target)
now = datetime.datetime.now(datetime.timezone.utc)
items = [
    ('今天的待办：整理项目资料，下午检查演示环境。', '待办'),
    ('# Docker 启动排查\n\n## 问题\n启动容器时提示：port is already allocated。\n\n## 原因\n宿主机的 8080 端口被其他进程占用。\n\n## 解决办法\n1. 使用 netstat -ano | findstr :8080 检查占用。\n2. 确认进程是否可以停止。\n3. 如果需要保留进程，将映射改为 8081:80。\n4. 重新启动容器并访问 localhost:8081。\n\n## 结论\n保留原进程，修改端口映射后，服务正常启动。', 'VS Code'),
    ('设计灵感：让信息先被保留，再决定如何整理。', '浏览器'),
    ('SELECT project_name, updated_at\nFROM demo_projects\nORDER BY updated_at DESC;', 'VS Code'),
    ('周会笔记：本周完成资料整理，下周继续优化工作流程。', '笔记'),
    ('https://docs.docker.com/get-started/', '浏览器'),
]
for idx, (content, source) in enumerate(items):
    identity = str(uuid.uuid5(uuid.NAMESPACE_URL, 'pastepanda-promo-' + str(idx)))
    stamp = (now - datetime.timedelta(minutes=idx*8)).isoformat().replace('+00:00', 'Z')
    conn.execute('INSERT OR IGNORE INTO history (id,text,time,type,content,pinned,source,workspace,md5,pinyin_initials) VALUES (?,?,?,?,?,?,?,?,?,?)', (identity,content,stamp,'text',content,0,source,'默认',hashlib.md5(content.encode()).hexdigest(),''))
for key, value in {'theme':'ocean','ai_enabled':False,'hide_on_focus_out':False,'auto_startup':False,'lan_sync_enabled':False,'kb_sync_enabled':False,'rc_enabled':False}.items():
    conn.execute('INSERT OR REPLACE INTO config (key,value) VALUES (?,?)', (key,json.dumps(value,ensure_ascii=False)))
conn.commit()
print('Isolated promo fixture ready:', conn.execute('SELECT count(*) FROM history').fetchone()[0], 'history items')
conn.close()
