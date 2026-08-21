"""Generate Shelf app icons + splash from the 📚 mark, matching app palette."""
from PIL import Image, ImageDraw, ImageFont
import os

BASE = r"D:\Sandbox\Shelf"
BG = (246, 245, 241)      # --bg light
DARK = (27, 26, 23)       # --dark
FONT = r"C:\Windows\Fonts\seguiemj.ttf"
EMOJI = "\U0001F4DA"  # 📚

def draw_mark(size, glyph_scale=0.62, bg=BG):
    """Square icon: bg fill + centered book emoji."""
    img = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * glyph_scale))
    d.text((size / 2, size / 2 + size * 0.02), EMOJI, font=font, anchor="mm",
           fill=DARK, embedded_color=True)
    return img

def save(img, *parts):
    p = os.path.join(BASE, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)
    print("wrote", p, img.size)

# --- Web icons ---
save(draw_mark(192, 0.66), "icons", "icon-192.png")
save(draw_mark(512, 0.66), "icons", "icon-512.png")
save(draw_mark(180, 0.66), "icons", "apple-touch-icon.png")
# Maskable: whole-bleed bg (it is), glyph pulled into the 80% safe zone
save(draw_mark(512, 0.52), "icons", "icon-maskable-512.png")

# --- Capacitor assets ---
save(draw_mark(1024, 0.62), "assets", "icon.png")

# Splash: 2732x2732, app bg, emoji centered (safe for status bar areas)
save(draw_mark(2732, 0.30), "assets", "splash.png")
print("done")
