#!/usr/bin/env python3
"""make-social-preview.py —— 合成 GitHub 社交预览卡片（1280×640）

依据 `.github/SOCIAL-PREVIEW.txt` 的设计草图实现：
左侧放文案、右侧露出主视觉、底部放安装命令与仓库地址。
用 PIL 渲染文字（而非 AI 生图）以保证文字**逐字正确**。

用法：
    python3 screenshots/scripts/make-social-preview.py
产物：
    plugin/dsh-voice-mode/assets/social-preview-card-1280x640.png

依赖：Pillow（本机 12.2.0 已验证）
字体：Lato（拉丁）+ 文泉驿正黑（中文），均为本机已有系统字体。
"""
from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BG = os.path.join(ROOT, "plugin/dsh-voice-mode/assets/social-preview.png")
OUT = os.path.join(ROOT, "plugin/dsh-voice-mode/assets/social-preview-card-1280x640.png")

FONT_LATIN_BLACK = "/usr/share/fonts/truetype/lato/Lato-Black.ttf"
FONT_LATIN_REG = "/usr/share/fonts/truetype/lato/Lato-Regular.ttf"
FONT_CJK = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"

W, H = 1280, 640

# 配色（与 .github/SOCIAL-PREVIEW.txt 一致）
BG_DARK = (13, 17, 23)      # #0d1117
FG = (230, 237, 243)        # #e6edf3
ACCENT_GREEN = (46, 160, 67)   # #2ea043
ACCENT_BLUE = (88, 166, 255)   # #58a6ff
MUTED = (139, 148, 158)     # #8b949e


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    if not os.path.exists(path):
        sys.exit(f"缺字体：{path}")
    return ImageFont.truetype(path, size)


def build() -> str:
    if not os.path.exists(BG):
        sys.exit(f"缺主视觉底图：{BG}")

    # 1) 底图 cover 到 1280×640
    bg = Image.open(BG).convert("RGB")
    ratio = max(W / bg.width, H / bg.height)
    bg = bg.resize((round(bg.width * ratio), round(bg.height * ratio)), Image.LANCZOS)
    ox, oy = (bg.width - W) // 2, (bg.height - H) // 2
    bg = bg.crop((ox, oy, ox + W, oy + H))

    # 2) 左侧暗色 scrim（x 越左越暗，保证文案可读；右侧露出主视觉）
    grad = Image.new("L", (W, 1))
    for x in range(W):
        v = int(min(255.0, (x / W) ** 1.35 * 255.0))
        grad.putpixel((x, 0), v)
    grad = grad.resize((W, H))
    scrim = Image.new("RGB", (W, H), (9, 12, 20))
    card = Image.composite(bg, scrim, grad)  # mask=0 → 暗，255 → 底图

    draw = ImageDraw.Draw(card)
    pad = 72

    # 3) 标题（两色：dsh / -voice-mode）
    f_title = font(FONT_LATIN_BLACK, 62)
    x, y = pad, 118
    draw.text((x, y), "dsh", font=f_title, fill=ACCENT_BLUE)
    w_dsh = draw.textlength("dsh", font=f_title)
    draw.text((x + w_dsh, y), "-voice-mode", font=f_title, fill=FG)

    # 4) 副标 + 标语
    f_sub = font(FONT_CJK, 32)
    draw.text((pad, y + 88), "DSH 全双工语音插件", font=f_sub, fill=ACCENT_BLUE)

    f_tag = font(FONT_CJK, 25)
    draw.text((pad, y + 140), "边说边出字 · 按句朗读 · 开口即打断", font=f_tag, fill=MUTED)

    # 5) 三条卖点
    f_li = font(FONT_CJK, 22)
    lines = [
        "本地识别，零 API Key（zipformer2 + SenseVoice）",
        "按句流式朗读 + 实时字幕（Edge / VITS / Kokoro）",
        "开口即打断 · 三档灵敏度 · 让位语义",
    ]
    ly = y + 200
    for i, text in enumerate(lines):
        cy = ly + i * 40
        draw.ellipse((pad, cy + 9, pad + 7, cy + 16), fill=ACCENT_GREEN)
        draw.text((pad + 20, cy), text, font=f_li, fill=FG)

    # 6) 底部：安装命令 + 仓库地址
    f_code = font(FONT_LATIN_REG, 21)
    draw.line((pad, H - 110, W - pad, H - 110), fill=(48, 54, 61), width=2)
    draw.text((pad, H - 92), "$ dsh plugin --profile web add dsh-voice-mode",
              font=f_code, fill=FG)
    draw.text((pad, H - 58), "github.com/qishuilalala/dsh-voice-mode",
              font=f_code, fill=ACCENT_BLUE)

    # 7) 右上角胶囊徽章
    f_badge = font(FONT_LATIN_REG, 18)
    badge = "MIT · v0.7.11"
    tw = draw.textlength(badge, font=f_badge)
    bx, by = W - pad - tw - 34, 30
    draw.rounded_rectangle((bx, by, W - pad, by + 34), radius=17, fill=(24, 30, 41),
                           outline=(48, 54, 61), width=1)
    draw.text((bx + 17, by + 7), badge, font=f_badge, fill=MUTED)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    card.save(OUT, "PNG", optimize=True)
    return OUT


if __name__ == "__main__":
    path = build()
    size = os.path.getsize(path)
    print(f"OK: {os.path.relpath(path, ROOT)}  {W}x{H}  {size / 1024:.0f} KB")
