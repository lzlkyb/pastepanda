"""Wire the native-window capture sequences into the existing scene layout."""
from pathlib import Path
import re

project = Path(__file__).resolve().parents[1] / 'videos' / 'pastepanda-story'
for frame_name, clips in {
    '01-find': [('history', 5, 6), ('history-search', 11, 6)],
    '02-save': [('knowledge-search', 13, 9)],
}.items():
    path = project / 'compositions' / 'frames' / f'{frame_name}.html'
    source = path.read_text(encoding='utf-8')
    for name, start, duration in clips:
        video = f'<video id="native-{name}" class="clip native-footage" src="assets/live-{name}.mp4" data-start="{start}" data-duration="{duration}" data-track-index="20" muted playsinline></video>'
        source = re.sub(rf'<img src="assets/{name}\.png"[^>]*>', video, source)
    source = source.replace('  </style>', '    .native-footage{position:relative!important;inset:auto!important;display:block;width:100%;height:100%;object-fit:contain;border-radius:10px}\n  </style>')
    source = source.replace('<span>端口占用</span>', '<span>端口</span>')
    path.write_text(source, encoding='utf-8')

path = project / 'compositions' / 'frames' / '03-close.html'
source = path.read_text(encoding='utf-8')
source = source.replace('真实默认关闭设置', '真实经典白主题设置').replace('AI 默认关闭设置', '经典白主题设置')
path.write_text(source, encoding='utf-8')
story = project / 'STORYBOARD.md'
source = story.read_text(encoding='utf-8')
source = source.replace('visible default AI setting is false', 'screenshot shows the real classic-white appearance settings; AI default behavior is narrated separately')
story.write_text(source, encoding='utf-8')
print('Three genuine default-size white-window footage clips staged')
