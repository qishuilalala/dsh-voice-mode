"""Generate docs/demo.gif: an animated mock of the dsh-voice loop (v0.5).

Simulates the DSH web UI: a Chinese voice prompt (SenseVoice ASR), a streamed
assistant reply spoken sentence-by-sentence (Edge TTS), then a barge-in (the
user speaks, playback stops and the turn is cancelled). Seamless loop: fade in
from empty, fade out to empty. Runs on plain Python + Pillow, no other deps.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 800, 540
TOTAL = 96
DUR = 50  # ms per frame -> 20 fps, ~4.8s loop

BG = (16, 18, 22)
PANEL = (22, 25, 30)
BUBBLE_USER = (31, 111, 235)
BUBBLE_AI = (33, 38, 45)
CODE_BG = (13, 17, 23)
TEXT = (230, 237, 243)
SUB = (139, 148, 158)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
PURPLE = (163, 113, 247)
BLUE = (88, 166, 255)
KW = (255, 123, 114)
FN = (210, 168, 255)

SANS = "/System/Library/Fonts/STHeiti Medium.ttc"
MONO = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

f_title = ImageFont.truetype(SANS, 15)
f_text = ImageFont.truetype(SANS, 16)
f_code = ImageFont.truetype(MONO, 14)
f_cap = ImageFont.truetype(SANS, 12)
f_badge = ImageFont.truetype(SANS, 11)
f_big = ImageFont.truetype(SANS, 44)
f_mic = ImageFont.truetype(SANS, 10)

USER_TEXT = "帮我写一个 TypeScript 快速排序"
SEG1 = "没问题，这是原地快速排序的实现："
CAPTION = "没问题，这是原地快速排序的实现"
CODE = [
    "function quickSort(a, lo, hi) {",
    "  if (lo >= hi) return",
    "  const p = partition(a, lo, hi)",
    "  quickSort(a, lo, p - 1)",
    "  quickSort(a, p + 1, hi)",
    "}",
]
BARGE = 60  # frame where the user's voice interrupts


def lerp(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def alpha(c, t):
    return lerp(BG, c, t)


def rrect(d, box, radius, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_chrome(d):
    d.rectangle([0, 0, W, H], fill=BG)
    d.rectangle([0, 0, W, 38], fill=PANEL)
    d.text((18, 10), "dsh", font=f_title, fill=TEXT)
    d.text((58, 11), "session — voice mode", font=f_badge, fill=SUB)
    for i, c in enumerate((RED, (240, 190, 60), GREEN)):
        d.ellipse([W - 62 + i * 18, 14, W - 48 + i * 18, 28], fill=c)


def draw_code(d, x, y, lines_visible):
    for i, item in enumerate(lines_visible):
        if item is None:
            continue
        text, k = item
        s = text[:k]
        yy = y + i * 21
        xpos = x
        j = 0
        while j < len(s):
            matched = False
            for kw in ("function", "return", "if", "const"):
                if s.startswith(kw, j) and (
                    j + len(kw) == len(s) or not s[j + len(kw)].isalnum()
                ):
                    d.text((xpos, yy), kw, font=f_code, fill=KW)
                    xpos += d.textlength(kw, font=f_code)
                    j += len(kw)
                    matched = True
                    break
            if matched:
                continue
            for fn in ("quickSort", "partition"):
                if s.startswith(fn, j):
                    d.text((xpos, yy), fn, font=f_code, fill=FN)
                    xpos += d.textlength(fn, font=f_code)
                    j += len(fn)
                    matched = True
                    break
            if matched:
                continue
            d.text((xpos, yy), s[j], font=f_code, fill=TEXT)
            xpos += d.textlength(s[j], font=f_code)
            j += 1


def eq_bars(d, x, y, w, h, t, color, phase=0.0):
    """Three bouncing bars; the classic 'now speaking' equalizer."""
    for i in range(3):
        k = 0.35 + 0.65 * (0.5 + 0.5 * math.sin(t / 2.2 + i * 1.9 + phase))
        bh = max(2, int(h * k))
        d.rectangle([x + i * (w + 2), y + h - bh, x + i * (w + 2) + w, y + h],
                    fill=color)


def frame(t):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    draw_chrome(d)

    # seamless loop: global fade in/out at the edges
    fin = min(1.0, t / 8.0)
    fout = min(1.0, (TOTAL - 1 - t) / 8.0)
    edge = fin * fout
    if edge <= 0:
        return img

    # --- user bubble (fade in over 12 frames) ---
    ua = min(1.0, t / 12.0) * edge
    if ua > 0:
        tw = d.textlength(USER_TEXT, font=f_text)
        rrect(d, [W - 60 - tw - 24, 58, W - 40, 92], 12, alpha(BUBBLE_USER, ua))
        d.text((W - 48 - tw - 12, 66), USER_TEXT, font=f_text, fill=alpha(TEXT, ua))

    # --- streamed assistant reply ---
    seg1_start, seg1_speed = 12, 1.0
    seg1_k = max(0, min(len(SEG1), int((t - seg1_start) * seg1_speed))) if t >= seg1_start else 0
    code_start, code_per = 40, 6
    code_lines_vis = []
    for i, line in enumerate(CODE):
        s0 = code_start + i * code_per
        if t < s0:
            code_lines_vis.append(None)
        else:
            k = min(len(line), int((t - s0) / code_per * len(line)) + 1)
            code_lines_vis.append((line, k))

    # barge-in: freeze the reply mid-stream
    if t >= BARGE:
        for i in range(len(code_lines_vis)):
            item = code_lines_vis[i]
            if item is None:
                continue
            text, _ = item
            s0 = code_start + i * code_per
            if s0 >= BARGE:
                code_lines_vis[i] = None
            else:
                kk = min(len(text), int((BARGE - 1 - s0) / code_per * len(text)) + 1)
                code_lines_vis[i] = (text, kk)

    aia = (1.0 if t >= 10 else 0.0) * edge
    if aia > 0:
        rrect(d, [20, 108, 560, 330], 12, alpha(BUBBLE_AI, aia))
        if seg1_k > 0:
            d.text((40, 122), SEG1[:seg1_k], font=f_text, fill=alpha(TEXT, aia))
        vis = [c for c in code_lines_vis if c is not None]
        if vis:
            rrect(d, [40, 152, 540, 318], 8, alpha(CODE_BG, aia))
            draw_code(d, 52, 160, code_lines_vis)

    # --- composer ---
    comp_a = edge
    if comp_a > 0:
        rrect(d, [60, 480, 740, 518], 18, alpha(PANEL, comp_a))
        d.text((78, 492), "想问点什么…", font=f_text, fill=alpha(SUB, comp_a))

    # --- mic button (new UI: label + per-state indicator) ---
    mic_speaking = t >= BARGE
    if comp_a > 0:
        rrect(d, [748, 480, 780, 514], 8, alpha(PANEL, comp_a))
        if mic_speaking:
            eq_bars(d, 752, 492, 4, 12, t, alpha(GREEN, comp_a), phase=1.0)
            d.text((766, 493), "说", font=f_badge, fill=alpha(GREEN, comp_a))
        else:
            d.ellipse([753, 491, 763, 501], fill=alpha(SUB, comp_a))
            d.text((766, 491), "mic", font=f_badge, fill=alpha(SUB, comp_a))

    # --- voice capsule (new UI: frosted pill with equalizer when playing) ---
    cap_a = (1.0 if t >= 18 else 0.0) * edge
    if cap_a > 0:
        playing = t < BARGE
        cap_box = [560, 434, 780, 466]
        rrect(d, cap_box, 16, alpha((28, 30, 34), cap_a * 0.92))
        # 1px frosted border
        rrect(d, cap_box, 16, fill=None, outline=alpha((90, 96, 105), cap_a), width=1)
        if playing:
            # equalizer bars + live caption
            eq_bars(d, 574, 444, 4, 14, t, alpha(GREEN, cap_a))
            k = min(seg1_k, len(CAPTION))
            d.text((598, 441), (CAPTION[:k] or "voice ready")[:30],
                   font=f_cap, fill=alpha(TEXT, cap_a))
        else:
            # pulsing red dot while listening (ring expands with sin)
            pulse = int(2.5 + 2.5 * math.sin(t / 1.4))
            d.ellipse([572 - pulse, 443 - pulse, 586 + pulse, 457 + pulse],
                      outline=alpha(RED, cap_a * (0.35 * (1 - pulse / 5.0))), width=1)
            d.ellipse([574, 445, 584, 455], fill=alpha(RED, cap_a))
            d.text((596, 441), "voice: listening…", font=f_cap, fill=alpha(TEXT, cap_a))
            # skip button is gone after barge-in (playback already stopped)

    # --- barge-in callout ---
    big_a = (min(1.0, (t - 64) / 8.0) if t >= 64 else 0.0) * edge
    if big_a > 0:
        label = "true barge-in"
        tw2 = d.textlength(label, font=f_big)
        d.text(((W - tw2) / 2, 352), label, font=f_big, fill=alpha(PURPLE, big_a * 0.9))
        sub = "你的声音打断正在运行的回答"
        tw3 = d.textlength(sub, font=f_text)
        d.text(((W - tw3) / 2, 408), sub, font=f_text, fill=alpha(SUB, big_a))

    return img


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    frames = [frame(t) for t in range(TOTAL)]
    first = frames[0].convert("P", palette=Image.ADAPTIVE, colors=256)
    pf = [f.quantize(palette=first) for f in frames]
    pf[0].save(
        os.path.join(out_dir, "docs", "demo.gif"),
        save_all=True,
        append_images=pf[1:],
        duration=DUR,
        loop=0,
        optimize=False,
    )
    size = os.path.getsize(os.path.join(out_dir, "docs", "demo.gif"))
    print(f"demo.gif written: {size // 1024} KB, {len(pf)} frames @ {1000 // DUR} fps")


if __name__ == "__main__":
    main()
