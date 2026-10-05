"""Add local audio and readable captions to the assembled video host."""
import json
import re
from pathlib import Path

project = Path(__file__).resolve().parents[1] / 'videos' / 'pastepanda-story'
host = project / 'index.html'
html = host.read_text(encoding='utf-8')
html = re.sub(r'<script src="https://cdn[^>]+></script>', '<script src="assets/gsap.min.js"></script>', html)
html = html.replace('lang="en"', 'lang="zh-CN"').replace('class="scene"', 'class="scene clip"')
meta = json.loads((project / 'audio' / 'audio_meta.json').read_text(encoding='utf-8'))
captions = []
for index, voice in enumerate(meta['voices']):
    text = voice['text'].replace('Paste Panda', 'PastePanda')
    captions.append(f'<div id="caption-{index}" class="clip narration-caption" data-start="{voice["start"]}" data-duration="{voice["duration_s"] + .5}" data-track-index="50"><span>{text}</span></div>')
audio = '<audio id="film-mix" class="clip" src="audio/mix.wav" data-start="0" data-duration="60" data-track-index="51" data-volume="1"></audio>'
html = html.replace('    </div>\n\n    <script>', '\n' + '\n'.join(captions) + '\n' + audio + '\n    </div>\n\n    <script>')
css = '''@font-face{font-family:'Panda Sans';src:url('assets/panda-sans.ttc')}
.narration-caption{position:absolute;left:80px;right:80px;top:954px;height:70px;display:flex;justify-content:center;align-items:center;font:32px 'Panda Sans';color:#F5F7FF;z-index:80}
.narration-caption span{padding:12px 25px;background:rgba(4,8,18,.88);border-radius:8px;white-space:nowrap}
'''
html = html.replace('    </style>', css + '    </style>')
host.write_text(html, encoding='utf-8')
for frame in (project / 'compositions' / 'frames').glob('*.html'):
    source = frame.read_text(encoding='utf-8')
    source = source.replace('width:1920px;height:1080px', 'width:100%;height:100%').replace('width: 1920px; height: 1080px', 'width: 100%; height: 100%')
    frame.write_text(source, encoding='utf-8')
print('60s host assembled with local GSAP, mixed audio and 10 caption cues')
