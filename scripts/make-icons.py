"""Generate the extension icons without any external assets."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
SIZES = (16, 32, 48, 128)
SCALE = 8
SIZE = 128


def build_master() -> Image.Image:
    canvas = SIZE * SCALE
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = int(canvas * 0.22)
    inset = int(canvas * 0.035)
    draw.rounded_rectangle(
        (inset, inset, canvas - inset, canvas - inset),
        radius=radius,
        fill=(23, 26, 32, 255),
        outline=(58, 63, 74, 255),
        width=max(1, int(canvas * 0.012)),
    )

    # Timeline track.
    track_left = int(canvas * 0.16)
    track_right = int(canvas * 0.84)
    track_y = int(canvas * 0.66)
    track_width = max(2, int(canvas * 0.045))
    draw.rounded_rectangle(
        (track_left, track_y - track_width // 2, track_right, track_y + track_width // 2),
        radius=track_width // 2,
        fill=(63, 68, 79, 255),
    )

    # Played portion.
    played_right = int(track_left + (track_right - track_left) * 0.56)
    draw.rounded_rectangle(
        (track_left, track_y - track_width // 2, played_right, track_y + track_width // 2),
        radius=track_width // 2,
        fill=(255, 204, 77, 255),
    )

    # Timestamped comment markers.
    dot_radius = int(canvas * 0.052)
    for x_ratio in (0.31, 0.56, 0.79):
        x = int(track_left + (track_right - track_left) * x_ratio)
        draw.ellipse(
            (x - dot_radius, track_y - dot_radius, x + dot_radius, track_y + dot_radius),
            fill=(255, 216, 110, 255),
            outline=(23, 26, 32, 255),
            width=max(1, int(canvas * 0.014)),
        )

    # A small waveform accent above the track, kept simple enough for 16 px.
    bar_color = (255, 204, 77, 210)
    bar_width = int(canvas * 0.035)
    for index, height in enumerate((0.09, 0.15, 0.22, 0.13, 0.08)):
        x = int(canvas * (0.3 + index * 0.1))
        half = int(canvas * height / 2)
        draw.rounded_rectangle(
            (x - bar_width // 2, int(canvas * 0.33) - half, x + bar_width // 2, int(canvas * 0.33) + half),
            radius=bar_width // 2,
            fill=bar_color,
        )

    return image


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    master = build_master()
    for size in SIZES:
        resized = master.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(ICONS / f"icon{size}.png", "PNG")


if __name__ == "__main__":
    main()
