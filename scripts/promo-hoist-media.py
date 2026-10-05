"""Keep timed video directly under its composition stage for reliable seeking."""
import re
from pathlib import Path

project = Path(__file__).resolve().parents[1] / 'videos' / 'pastepanda-story'
for frame_name, windows in {
    '01-find': [('history', '01-find-history-window', '01-find-window', 5, 6), ('history-search', '01-find-search-window', '01-find-window', 11, 6)],
    '02-save': [('knowledge-search', '02-save-search-window', '02-save-window', 13, 9)],
}.items():
    path = project / 'compositions' / 'frames' / f'{frame_name}.html'
    source = path.read_text(encoding='utf-8')
    media = []
    for name, window_id, window_class, start, duration in windows:
        pattern = rf'<div\b[^>]*id="{window_id}"[^>]*><video\b[^>]*>\s*</video></div>'
        source, count = re.subn(pattern, '', source)
        assert count == 1, window_id
        media.append(f'<video id="{window_id}" class="clip {window_class} native-window" src="assets/live-{name}.mp4" data-start="{start}" data-duration="{duration}" data-track-index="20" muted playsinline></video>')
    source = source.replace('  </style>', '    .native-window{object-fit:contain;border-radius:12px}\n  </style>')
    source = source.replace('\n  </div>\n  <script', '\n' + '\n'.join(media) + '\n  </div>\n  <script', 1)
    path.write_text(source, encoding='utf-8')
print('Timed media is now directly under each scene stage')
