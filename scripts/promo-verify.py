"""Verify the delivered video has the promised dimensions, timing and sound."""
import json
import subprocess
from fractions import Fraction
from pathlib import Path

root = Path(__file__).resolve().parents[1]
project = root / 'videos' / 'pastepanda-story'
movie = project / 'renders' / 'PastePanda-A-60s-white.mp4'
probe = root / '.cache' / 'promo-tools' / 'node_modules' / 'ffprobe-static' / 'bin' / 'win32' / 'x64' / 'ffprobe.exe'
metadata = json.loads(subprocess.check_output([str(probe), '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(movie)], encoding='utf-8'))
video = next(stream for stream in metadata['streams'] if stream['codec_type'] == 'video')
audio = next(stream for stream in metadata['streams'] if stream['codec_type'] == 'audio')
assert (video['width'], video['height']) == (1920, 1080)
assert Fraction(video['r_frame_rate']) == 30
assert int(video['nb_frames']) == 1800
assert abs(float(metadata['format']['duration']) - 60) < .1
assert audio['codec_name'] == 'aac'
assert audio['channels'] == 2
assert int(audio['sample_rate']) == 48000
result = {'passed': True, 'video': str(movie), 'size_bytes': movie.stat().st_size, 'width': video['width'], 'height': video['height'], 'fps': str(Fraction(video['r_frame_rate'])), 'frame_count': video['nb_frames'], 'duration_s': metadata['format']['duration'], 'audio_codec': audio['codec_name'], 'audio_sample_rate': audio['sample_rate'], 'audio_channels': audio['channels']}
(project / '.hyperframes' / 'delivery-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
