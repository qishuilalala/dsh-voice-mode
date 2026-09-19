#!/usr/bin/env python3
"""make-demo-gif.py —— 把 capture-demo.mjs 采到的帧合成为演示 GIF

关键点：
- **裁掉左侧会话列表**（`CROP` 的 x 起点），避免把私人会话标题录进公开素材。
- 只挑讲得清链路的关键帧，并给不同阶段不同停留时长（转写要快、思考可略过、朗读要停住）。

用法：
    python3 screenshots/scripts/make-demo-gif.py

输入：/tmp/demo-frames/fNN.png（由 capture-demo.mjs 产出）
输出：plugin/dsh-voice-mode/assets/demo-voice-flow.gif
"""
from __future__ import annotations

import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = "/tmp/demo-frames"
OUT = os.path.join(ROOT, "plugin/dsh-voice-mode/assets/demo-voice-flow.gif")

# 去掉左侧会话列表；保留会话正文 + 状态条 + 字幕浮层 + 输入区
CROP = (272, 240, 1440, 900)
WIDTH = 760
COLORS = 128

# (帧号, 停留毫秒)：转写阶段快、思考阶段跳过冗余、朗读阶段停住
PLAN = [
    (1, 450), (2, 450), (3, 550), (4, 550), (5, 800),
    (6, 700), (24, 700), (27, 1000),
    (28, 900), (30, 900), (32, 900), (34, 900), (36, 1300),
]


def main() -> None:
    imgs, durs = [], []
    for n, d in PLAN:
        p = os.path.join(SRC, f"f{n:02d}.png")
        if not os.path.exists(p):
            print(f"跳过缺帧 {p}", file=sys.stderr)
            continue
        im = Image.open(p).convert("RGB").crop(CROP)
        im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
        imgs.append(im.convert("P", palette=Image.ADAPTIVE, colors=COLORS))
        durs.append(d)

    if not imgs:
        sys.exit(f"没有可用帧（{SRC}）——请先跑 capture-demo.mjs")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    imgs[0].save(OUT, save_all=True, append_images=imgs[1:], duration=durs,
                 loop=0, optimize=True, disposal=2)
    print(f"GIF: {os.path.relpath(OUT, ROOT)}  {len(imgs)} 帧  "
          f"{os.path.getsize(OUT) / 1048576:.2f} MB  {imgs[0].size}")


if __name__ == "__main__":
    main()
