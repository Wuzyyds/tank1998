"""把 assets/audio/*.wav 内嵌为 base64 dataURI，生成 assets/sounds.js。

用途：部分静态服务器（含 WorkBuddy 内置预览）不提供 .wav，会返回 404；
      此时 game.js 用这里内嵌的数据解码播放，保证任何环境都有真实音效。

用法（任意工作目录均可）：
    python tools/gen_sounds.py

替换 assets/audio/ 下的 wav 后，重新执行本脚本即可更新兜底数据。
"""
import base64, glob, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
AUDIO_DIR = os.path.join(ROOT, 'assets', 'audio')
OUT_FILE = os.path.join(ROOT, 'assets', 'sounds.js')

KEY_MAP = {'player_boom': 'playerBoom', 'item_pickup': 'itemPickup'}

files = sorted(glob.glob(os.path.join(AUDIO_DIR, '*.wav')))
if not files:
    raise SystemExit('未找到 wav：' + AUDIO_DIR)

parts = []
total_raw = 0
for p in files:
    stem = os.path.splitext(os.path.basename(p))[0]
    key = KEY_MAP.get(stem, stem)
    raw = open(p, 'rb').read()
    total_raw += len(raw)
    b64 = base64.b64encode(raw).decode('ascii')
    parts.append(f'  {key}: "data:audio/wav;base64,{b64}",')
    print(f'  {os.path.basename(p):20s} -> {key:12s} {len(raw)/1024:.1f}KB')

out = ('/* 自动生成（python tools/gen_sounds.py）：assets/audio/*.wav 的 base64 dataURI 内嵌兜底。\n'
       ' * 当静态服务器不提供 .wav（返回 404）时，音效用这里的数据解码播放。\n'
       ' */\n'
       'window.TANK_SND = {\n' + '\n'.join(parts) + '\n};\n')
open(OUT_FILE, 'w', encoding='utf-8').write(out)
print(f'\n原始音频合计 {total_raw/1024:.1f}KB -> assets/sounds.js {len(out)/1024:.1f}KB')
