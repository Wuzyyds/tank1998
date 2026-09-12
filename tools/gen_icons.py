# -*- coding: utf-8 -*-
"""生成 PWA 图标（192 / 512 / 512 maskable），零额外依赖（仅 Pillow）。

用法：python tools/gen_icons.py
输出：assets/icons/icon-192.png, icon-512.png, icon-512-maskable.png
"""
import os
from PIL import Image, ImageDraw

BG = (13, 17, 23, 255)          # #0d1117
BODY = (240, 192, 64, 255)      # #f0c040
LIGHT = (255, 233, 135, 255)    # #ffe987
TRACK = (74, 79, 87, 255)       # #4a4f57
TRACK_T = (139, 148, 158, 255)  # #8b949e
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'icons')


def draw_icon(size, maskable=False):
    img = Image.new('RGBA', (size, size), BG)
    d = ImageDraw.Draw(img)
    s = float(size)
    # maskable 需要把内容收在中心安全区内
    k = 0.68 if maskable else 1.0
    cx = cy = s / 2.0

    bw, bh = s * 0.46 * k, s * 0.42 * k          # 车体
    tw = s * 0.075 * k                            # 履带宽

    # 履带
    for sx in (-1, 1):
        x0 = cx + sx * (bw / 2) - (tw if sx < 0 else 0)
        d.rectangle([x0, cy - bh / 2, x0 + tw, cy + bh / 2], fill=TRACK)
        # 履带齿
        n = 5
        for i in range(n):
            ty = cy - bh / 2 + (i + 0.35) * (bh / n)
            d.rectangle([x0, ty, x0 + tw, ty + bh / n * 0.3], fill=TRACK_T)

    # 车体
    d.rectangle([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], fill=BODY)
    # 高光
    d.rectangle([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy - bh / 2 + s * 0.025 * k], fill=LIGHT)

    # 炮塔
    tx, ty = s * 0.115 * k, s * 0.105 * k
    d.rectangle([cx - tx, cy - ty, cx + tx, cy + ty], fill=LIGHT)
    # 炮管
    px_, pw = s * 0.042 * k, s * 0.185 * k
    d.rectangle([cx - px_, cy - bh / 2 - pw, cx + px_, cy - bh / 2 + s * 0.02 * k], fill=LIGHT)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [(192, False, 'icon-192.png'), (512, False, 'icon-512.png'), (512, True, 'icon-512-maskable.png')]
    for size, maskable, name in jobs:
        path = os.path.join(OUT, name)
        draw_icon(size, maskable).save(path, 'PNG')
        print('written', path, size, 'maskable' if maskable else '')


if __name__ == '__main__':
    main()
