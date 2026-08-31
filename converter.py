"""
converter.py
------------
Turn an ordinary photo into machine-executable embroidery stitches.

Pipeline
========
1. Load + orient the image, scale it to fit a physical hoop size (in mm).
2. Optionally smooth it (median filter) to kill JPEG/camera noise.
3. Reduce it to a small palette of thread colours (adaptive quantisation).
4. For every colour region, generate a scanline "fill" of stitches
   (boustrophedon / back-and-forth ordering to minimise travel), with
   jumps between disconnected runs and a colour-change/trim between threads.
5. Emit a pyembroidery ``EmbPattern`` that can be written to real machine
   formats (DST / PES / EXP / JEF / VP3 ...), plus a rendered preview and a
   set of human-readable stats.

Coordinate system
=================
pyembroidery's native unit is 1/10 mm.  Everything below works in millimetres
and multiplies by ``UNITS_PER_MM`` (=10) at the moment stitches are added.
Image pixel (col,row) maps to mm as (col / px_per_mm, row / px_per_mm); the
y axis points down, matching the source image, so the preview lines up with
what the user uploaded.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import List, Tuple

import numpy as np
from PIL import Image, ImageFilter, ImageOps, ImageDraw

from pyembroidery import (
    EmbPattern,
    EmbThread,
    STITCH,
    JUMP,
    TRIM,
    COLOR_CHANGE,
    END,
)

UNITS_PER_MM = 10.0  # pyembroidery native unit is 1/10 mm

# Working resolution used for the internal fill grid.  Higher = more faithful
# but slower and denser.  5 px/mm (a 100 mm design -> 500 px) is a good balance.
WORKING_PX_PER_MM = 5.0


# --------------------------------------------------------------------------- #
# Vectorise (raster -> clean SVG)
# --------------------------------------------------------------------------- #
# Lightness is weighted below chroma when judging "is this a different colour?"
# A logo's burgundy→pink glow is one thread even though its lightness swings a
# lot, whereas different hues (blue vs yellow) must stay apart — so we care more
# about hue/chroma (a*, b*) than lightness (L*).
_L_WEIGHT = 0.5

# Separation (in the L-weighted Lab metric) below which two colours aren't worth
# a separate thread. Sits in the gap between same-hue shades (~<28) and distinct
# hues (~>40): the palette auto-stops once seeds get this close together, and
# same-hue shades collapse onto one thread.
_MIN_LAB_SEP = 30.0

# Most contrasting colours we'll ever propose for one design (matches the UI's
# thread-count cap). The palette search runs up to here, then auto-stops.
_PALETTE_CEILING = 12


def _srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """Convert an Nx3 array of sRGB (0–255) to CIE-Lab (D65), vectorised."""
    rgb = rgb.astype(np.float64) / 255.0
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124, 0.3576, 0.1805],
                  [0.2126, 0.7152, 0.0722],
                  [0.0193, 0.1192, 0.9505]])
    xyz = lin @ m.T / np.array([0.95047, 1.0, 1.08883])
    e, kappa = 216 / 24389, 24389 / 27
    f = np.where(xyz > e, np.cbrt(xyz), (kappa * xyz + 16) / 116)
    return np.stack([116 * f[:, 1] - 16,
                     500 * (f[:, 0] - f[:, 1]),
                     200 * (f[:, 1] - f[:, 2])], axis=1)


def _flatten_palette(img: Image.Image, max_colors: int) -> Image.Image:
    """Reduce an RGBA image to its most *contrasting* solid colours, keeping alpha.

    A logo photo carries dozens of near-identical shades (anti-aliasing, JPEG
    noise, lighting), and left alone each traces to its own colour — one burgundy
    becomes four "threads". We want the opposite of averaging: keep the handful of
    colours that stand furthest apart (the burgundy, the blue, the yellow…) and
    snap everything else onto the nearest of them, so colours stay vivid.

    Algorithm — farthest-point (max-min) selection in perceptual Lab space:
      1. Build candidate colours from the opaque pixels (coarse-binned, counted).
      2. Seed with the dominant colour, then repeatedly add the candidate that is
         *most distant* from those already chosen — the most contrasting colour
         wins each round. Tiny speckle colours are ignored while seeding.
      3. Stop early once the farthest remaining colour is within _MIN_LAB_SEP of
         the palette (not worth a thread change), so the count self-limits.
      4. Map every opaque pixel to its nearest seed (nearest, never averaged).

    Fully transparent pixels are left untouched, so the cut-out and soft edges
    survive.
    """
    img = img.convert("RGBA")
    arr = np.asarray(img)
    alpha = arr[:, :, 3]
    rgb = arr[:, :, :3].astype(np.float32)
    opaque = alpha > 8
    if max_colors < 1 or not opaque.any():
        return img, {"suggested": 0, "used": 0, "colors": []}

    pix = rgb[opaque]                                   # Nx3 visible pixels

    # Candidate colours: coarse-bin to ~32 levels/channel, average + count each.
    q = (pix / 8).astype(np.int64)
    keys = (q[:, 0] << 20) | (q[:, 1] << 10) | q[:, 2]
    _, inv, counts = np.unique(keys, return_inverse=True, return_counts=True)
    cand = np.zeros((counts.size, 3), dtype=np.float64)
    np.add.at(cand, inv, pix)
    cand /= counts[:, None]
    cand_lab = _srgb_to_lab(cand)
    cand_lab[:, 0] *= _L_WEIGHT              # weight hue/chroma above lightness

    # Colours too rare to be intentional shouldn't be picked as a seed, but a
    # design with only a few flat colours must still seed — so relax the floor if
    # it leaves too few candidates.
    floor = max(1, int(0.002 * pix.shape[0]))
    eligible = counts >= floor
    if eligible.sum() < min(_PALETTE_CEILING, counts.size):
        eligible = np.ones_like(counts, dtype=bool)

    # Farthest-first: dominant colour first, then most-distant each round. Run all
    # the way up to the ceiling; because farthest-first is prefix-optimal, the
    # ordered seeds double as the answer for *any* smaller count. The auto-stop
    # gives the "natural" number of distinct colours in the image (the suggestion).
    order = np.argsort(counts)[::-1]
    first = int(order[eligible[order]][0])
    chosen = [first]
    dist = np.linalg.norm(cand_lab - cand_lab[first], axis=1)
    while len(chosen) < min(_PALETTE_CEILING, counts.size):
        masked = np.where(eligible, dist, -1.0)
        nxt = int(np.argmax(masked))
        if masked[nxt] < _MIN_LAB_SEP:      # nothing left worth a new thread
            break
        chosen.append(nxt)
        dist = np.minimum(dist, np.linalg.norm(cand_lab - cand_lab[nxt], axis=1))

    suggested = len(chosen)                  # natural distinct-colour count
    used = min(max_colors, suggested)
    seeds = chosen[:used]
    palette_rgb = cand[seeds]
    palette_lab = cand_lab[seeds]

    # Map each opaque pixel to its nearest seed (streamed over K to bound memory).
    pix_lab = _srgb_to_lab(pix)
    pix_lab[:, 0] *= _L_WEIGHT               # same metric as seed selection
    best = np.full(pix.shape[0], np.inf)
    nearest = np.zeros(pix.shape[0], dtype=np.int64)
    for i, pl in enumerate(palette_lab):
        d = np.linalg.norm(pix_lab - pl, axis=1)
        closer = d < best
        best[closer] = d[closer]
        nearest[closer] = i

    out = rgb.copy()
    out[opaque] = palette_rgb[nearest].astype(np.float32)
    result = np.dstack([out.astype(np.uint8), alpha[:, :, None]])
    hexes = ["#%02X%02X%02X" % tuple(int(v) for v in c) for c in palette_rgb]
    meta = {"suggested": suggested, "used": used, "colors": hexes}
    return Image.fromarray(result, "RGBA"), meta


def simplify_png(png_bytes: bytes, *, max_colors: int = 6) -> Tuple[bytes, dict]:
    """Reduce a raster to its most contrasting solid colours, staying a raster.

    Same palette engine as the vectorise step (:func:`_flatten_palette`) but
    without tracing — for the "extract logo" path, which sometimes reads better
    as pixels than as smooth vector shapes. Returns ``(png_bytes, meta)`` with the
    same ``suggested`` / ``used`` / ``colors`` palette summary as vectorise, so the
    UI can recommend a thread count here too.
    """
    img = Image.open(io.BytesIO(png_bytes))
    img.load()
    img = img.convert("RGBA")

    meta = {"suggested": 0, "used": 0, "colors": []}
    if max_colors and max_colors > 0:
        img, meta = _flatten_palette(img, int(min(64, max_colors)))

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue(), meta


def vectorise_png(
    png_bytes: bytes,
    *,
    filter_speckle: int = 4,
    color_precision: int = 6,
    max_colors: int = 6,
) -> Tuple[str, dict]:
    """Trace a raster image into a clean, scalable SVG.

    Sits between background removal and stitch generation: the extracted design
    (a PNG, alpha preserved) is retraced into smooth vector shapes, which tidies
    away jagged/anti-aliased edges and speckle before we fill it with stitches,
    and gives the user a reusable vector file for other applications.

    Transparent pixels stay transparent, so an extracted logo keeps its cut-out.

    Returns ``(svg, meta)`` where ``meta`` reports the palette: ``suggested`` (the
    natural number of distinct contrasting colours in the image), ``used`` (how
    many were kept, capped by ``max_colors``) and ``colors`` (their hexes).

    Parameters
    ----------
    filter_speckle : drop shapes smaller than this many pixels (higher = tidier).
    color_precision : bits of colour kept (higher = more shades preserved).
    max_colors : flatten to at most this many solid colours first, so each colour
        traces to a single thread (<= 0 keeps the full palette).
    """
    import vtracer  # local import: keeps the stitch path free of the trace dep

    # Normalise: re-encode to RGBA PNG so vtracer always gets a format it groks
    # and transparency is preserved regardless of what the caller uploaded.
    img = Image.open(io.BytesIO(png_bytes))
    img.load()
    img = img.convert("RGBA")

    # Reduce step: collapse to the most contrasting solid colours before tracing.
    meta = {"suggested": 0, "used": 0, "colors": []}
    if max_colors and max_colors > 0:
        img, meta = _flatten_palette(img, int(min(64, max_colors)))

    buf = io.BytesIO()
    img.save(buf, "PNG")

    svg = vtracer.convert_raw_image_to_svg(
        buf.getvalue(),
        img_format="png",
        colormode="color",
        hierarchical="stacked",   # stacked shapes preserve the transparent cut-out
        mode="spline",            # smooth Bezier curves rather than jagged polygons
        filter_speckle=int(max(0, min(64, filter_speckle))),
        color_precision=int(max(1, min(8, color_precision))),
    )
    return svg, meta


# --------------------------------------------------------------------------- #
# Options + result containers
# --------------------------------------------------------------------------- #
@dataclass
class ConvertOptions:
    hoop_mm: float = 100.0          # longest side of the finished design, in mm
    num_colors: int = 6             # number of thread colours to reduce to
    row_spacing_mm: float = 0.40    # gap between fill rows (density; smaller = denser)
    max_stitch_mm: float = 3.0      # longest single stitch along a run
    min_run_mm: float = 0.8         # ignore fill runs shorter than this (speckle)
    smooth: bool = True             # median-filter the photo before quantising
    remove_background: bool = True  # drop the dominant border colour as a thread

    def clamp(self) -> "ConvertOptions":
        self.hoop_mm = float(min(max(self.hoop_mm, 20.0), 300.0))
        self.num_colors = int(min(max(self.num_colors, 2), 15))
        self.row_spacing_mm = float(min(max(self.row_spacing_mm, 0.2), 2.0))
        self.max_stitch_mm = float(min(max(self.max_stitch_mm, 1.0), 7.0))
        self.min_run_mm = float(min(max(self.min_run_mm, 0.2), 5.0))
        return self


@dataclass
class ThreadInfo:
    index: int
    rgb: Tuple[int, int, int]
    hex: str
    stitches: int


@dataclass
class ConvertResult:
    pattern: EmbPattern
    width_mm: float
    height_mm: float
    stitch_count: int
    color_count: int
    threads: List[ThreadInfo] = field(default_factory=list)
    preview_png: bytes = b""
    # Ordered stitch path for the client "watch it stitch" animation.
    anim_w: int = 0
    anim_h: int = 0
    anim_segments: list = field(default_factory=list)  # [[hex, [run, run...]], ...]


# --------------------------------------------------------------------------- #
# Image preparation
# --------------------------------------------------------------------------- #
def _prepare_image(img: Image.Image, opts: ConvertOptions):
    """Orient, scale to the hoop, denoise and return (rgb_array, px_per_mm)."""
    img = ImageOps.exif_transpose(img).convert("RGB")

    # Scale so the longest side equals hoop_mm * WORKING_PX_PER_MM pixels.
    target_long_px = int(round(opts.hoop_mm * WORKING_PX_PER_MM))
    w, h = img.size
    scale = target_long_px / float(max(w, h))
    new_size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    img = img.resize(new_size, Image.LANCZOS)

    if opts.smooth:
        img = img.filter(ImageFilter.MedianFilter(size=3))

    return np.asarray(img, dtype=np.uint8), WORKING_PX_PER_MM


def _quantize(rgb: np.ndarray, opts: ConvertOptions):
    """Reduce to a palette. Returns (label_grid HxW, list_of_rgb_tuples)."""
    h, w, _ = rgb.shape
    pil = Image.fromarray(rgb, "RGB").quantize(
        colors=opts.num_colors, method=Image.FASTOCTREE, dither=Image.NONE
    )
    labels = np.asarray(pil, dtype=np.int32)              # HxW palette indices
    pal = pil.getpalette()[: opts.num_colors * 3]
    colors = [(pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2])
              for i in range(len(pal) // 3)]

    used = np.unique(labels)
    colors = [colors[i] if i < len(colors) else (0, 0, 0) for i in range(len(colors))]

    # Merge palette entries that are visually near-identical (octree sometimes
    # splits one shade across two slots) so we don't waste a thread change.
    labels, colors, used = _merge_similar(labels, colors, used, threshold=28.0)

    # Optionally treat the dominant border colour as background (skip stitching).
    background = None
    if opts.remove_background:
        border = np.concatenate([labels[0, :], labels[-1, :],
                                  labels[:, 0], labels[:, -1]])
        vals, counts = np.unique(border, return_counts=True)
        cand = int(vals[int(np.argmax(counts))])
        # Only drop it if it really dominates the border (>55%).
        if counts.max() / border.size > 0.55:
            background = cand

    order = [int(i) for i in used if i != background]
    return labels, colors, order, background


# --------------------------------------------------------------------------- #
# Stitch generation
# --------------------------------------------------------------------------- #
def _merge_similar(labels: np.ndarray, colors, used, threshold: float = 28.0):
    """Collapse palette indices whose colours are within `threshold` (RGB
    Euclidean). Remaps `labels` in place-ish and returns (labels, colors, used)."""
    used_list = [int(u) for u in used]
    remap = {}
    kept = []  # representative indices
    for u in used_list:
        cu = np.array(colors[u], dtype=float)
        match = None
        for k in kept:
            if np.linalg.norm(cu - np.array(colors[k], dtype=float)) <= threshold:
                match = k
                break
        if match is None:
            kept.append(u)
            remap[u] = u
        else:
            remap[u] = match
    if len(kept) != len(used_list):
        out = labels.copy()
        for src, dst in remap.items():
            if src != dst:
                out[labels == src] = dst
        labels = out
        used = np.array(sorted(kept), dtype=np.int32)
    return labels, colors, used


def _runs_in_row(row_mask: np.ndarray):
    """Yield (x_start_px, x_end_px_inclusive) runs of True in a 1-D bool row."""
    if not row_mask.any():
        return []
    padded = np.concatenate(([False], row_mask, [False]))
    diff = np.diff(padded.astype(np.int8))
    starts = np.where(diff == 1)[0]
    ends = np.where(diff == -1)[0] - 1
    return list(zip(starts.tolist(), ends.tolist()))


def _fill_color(mask: np.ndarray, px_per_mm: float, opts: ConvertOptions):
    """
    Scanline fill for one colour mask.
    Returns a flat list of ('STITCH'|'JUMP', x_mm, y_mm) tuples.
    """
    h, w = mask.shape
    row_step = max(1, int(round(opts.row_spacing_mm * px_per_mm)))
    max_stitch_px = max(1.0, opts.max_stitch_mm * px_per_mm)
    min_run_px = max(1.0, opts.min_run_mm * px_per_mm)

    out: List[Tuple[str, float, float]] = []
    flip = False  # boustrophedon toggle

    def px_to_mm(x, y):
        return (x / px_per_mm, y / px_per_mm)

    for y in range(0, h, row_step):
        runs = _runs_in_row(mask[y])
        runs = [(a, b) for (a, b) in runs if (b - a + 1) >= min_run_px]
        if not runs:
            continue
        if flip:
            runs = list(reversed(runs))
        flip = not flip

        for i, (a, b) in enumerate(runs):
            # Direction of travel across this run alternates with the row.
            x0, x1 = (a, b) if not flip else (b, a)
            # Sample points along the run no more than max_stitch_px apart.
            length = abs(x1 - x0)
            n = max(1, int(np.ceil(length / max_stitch_px)))
            xs = np.linspace(x0, x1, n + 1)

            first_mm = px_to_mm(xs[0], y)
            # Move to the run start: a jump if we're mid-fill, else first stitch.
            out.append(("JUMP", first_mm[0], first_mm[1]))
            for xp in xs:
                mx, my = px_to_mm(xp, y)
                out.append(("STITCH", mx, my))
    return out


def convert_image(img: Image.Image, opts: ConvertOptions) -> ConvertResult:
    opts = opts.clamp()
    rgb, px_per_mm = _prepare_image(img, opts)
    labels, colors, order, background = _quantize(rgb, opts)
    h, w = labels.shape

    pattern = EmbPattern()
    threads: List[ThreadInfo] = []
    total_stitches = 0

    # Order colours darkest-first so light detail stitches on top of dark fill.
    def luminance(i):
        r, g, b = colors[i]
        return 0.299 * r + 0.587 * g + 0.114 * b
    order = sorted(order, key=luminance)

    first_color = True
    for out_index, ci in enumerate(order):
        mask = labels == ci
        if not mask.any():
            continue
        stitch_ops = _fill_color(mask, px_per_mm, opts)
        if not any(op == "STITCH" for op, _, _ in stitch_ops):
            continue

        rgb_tuple = colors[ci]
        thread = EmbThread()
        thread.set_color(*rgb_tuple)
        thread.description = f"Thread {out_index + 1}"
        pattern.add_thread(thread)

        if not first_color:
            pattern.add_command(TRIM)
            pattern.add_command(COLOR_CHANGE)
        first_color = False

        color_stitches = 0
        for op, mx, my in stitch_ops:
            ux, uy = mx * UNITS_PER_MM, my * UNITS_PER_MM
            if op == "JUMP":
                pattern.add_stitch_absolute(JUMP, ux, uy)
            else:
                pattern.add_stitch_absolute(STITCH, ux, uy)
                color_stitches += 1

        total_stitches += color_stitches
        threads.append(ThreadInfo(
            index=out_index + 1,
            rgb=rgb_tuple,
            hex="#%02X%02X%02X" % rgb_tuple,
            stitches=color_stitches,
        ))

    pattern.add_command(END)

    width_mm = w / px_per_mm
    height_mm = h / px_per_mm
    preview = _render_preview(pattern, width_mm, height_mm, threads)
    aw, ah, asegs = _preview_paths(pattern, width_mm, height_mm, threads)

    return ConvertResult(
        pattern=pattern,
        width_mm=round(width_mm, 1),
        height_mm=round(height_mm, 1),
        stitch_count=total_stitches,
        color_count=len(threads),
        threads=threads,
        preview_png=preview,
        anim_w=aw,
        anim_h=ah,
        anim_segments=asegs,
    )


# --------------------------------------------------------------------------- #
# Ordered stitch path (for the client-side "watch it stitch" animation)
# --------------------------------------------------------------------------- #
def _preview_paths(pattern: EmbPattern, width_mm: float, height_mm: float,
                   threads: List[ThreadInfo], scale: float = 4.0):
    """Return (w, h, segments) where segments = [[hex, [run, run, ...]], ...] and
    each run is a flat [x0, y0, x1, y1, ...] polyline in the same pixel space as
    the preview PNG. Colour-ordered, so replaying it draws the design as stitched."""
    W = max(1, int(round(width_mm * scale))) + 8
    H = max(1, int(round(height_mm * scale))) + 8

    def hex_at(i):
        return threads[i].hex if 0 <= i < len(threads) else "#333333"

    segments = []
    ci = 0
    runs = []
    run = []
    prev = None

    def flush_run():
        nonlocal run
        if len(run) >= 4:            # at least two points
            runs.append(run)
        run = []

    def flush_color():
        nonlocal runs
        flush_run()
        segments.append([hex_at(ci), runs])
        runs = []

    for stitch in pattern.stitches:
        x, y, cmd = stitch[0], stitch[1], stitch[2]
        px = int(round(4 + (x / UNITS_PER_MM) * scale))
        py = int(round(4 + (y / UNITS_PER_MM) * scale))
        if cmd == COLOR_CHANGE:
            flush_color()
            ci += 1
            prev = None
        elif cmd in (JUMP, TRIM):
            flush_run()
            prev = None
        elif cmd == STITCH:
            if prev is None:
                run = [px, py]
            else:
                run.append(px)
                run.append(py)
            prev = (px, py)
        else:
            flush_run()
            prev = None
    flush_color()

    # Drop empty trailing colour buckets but keep alignment with threads.
    segments = [s for s in segments if s[1]]
    return W, H, segments


# --------------------------------------------------------------------------- #
# Preview rendering
# --------------------------------------------------------------------------- #
def _render_preview(pattern: EmbPattern, width_mm: float, height_mm: float,
                    threads: List[ThreadInfo], scale: float = 4.0) -> bytes:
    """Draw the actual stitch paths to a PNG so the user sees the plan."""
    W = max(1, int(round(width_mm * scale)))
    H = max(1, int(round(height_mm * scale)))
    # Transparent background so the stitches sit directly on the hoop fabric in
    # the UI (whatever colour that is, in light or dark theme).
    canvas = Image.new("RGBA", (W + 8, H + 8), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    color_idx = 0
    cur_rgb = threads[0].rgb if threads else (30, 30, 30)
    prev = None
    for stitch in pattern.stitches:
        x, y, cmd = stitch[0], stitch[1], stitch[2]
        px = 4 + (x / UNITS_PER_MM) * scale
        py = 4 + (y / UNITS_PER_MM) * scale
        if cmd == COLOR_CHANGE:
            color_idx = min(color_idx + 1, len(threads) - 1) if threads else 0
            cur_rgb = threads[color_idx].rgb if threads else cur_rgb
            prev = None
            continue
        if cmd in (JUMP, TRIM):
            prev = None
            continue
        if cmd == STITCH:
            if prev is not None:
                draw.line([prev, (px, py)], fill=cur_rgb, width=1)
            prev = (px, py)
        else:
            prev = None

    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# Writing machine files
# --------------------------------------------------------------------------- #
SUPPORTED_FORMATS = {
    "dst": "Tajima DST",
    "pes": "Brother / Babylock / Bernina PES",
    "exp": "Melco / Bernina EXP",
    "jef": "Janome JEF",
    "vp3": "Husqvarna Viking / Pfaff VP3",
    "xxx": "Singer XXX",
}


def write_pattern(pattern: EmbPattern, fmt: str) -> bytes:
    """Serialise the pattern to the given machine format and return raw bytes."""
    import os
    import tempfile
    from pyembroidery import write

    fmt = fmt.lower()
    if fmt not in SUPPORTED_FORMATS:
        raise ValueError(f"Unsupported format: {fmt}")

    tmp = tempfile.NamedTemporaryFile(suffix="." + fmt, delete=False)
    tmp.close()
    try:
        write(pattern, tmp.name)
        with open(tmp.name, "rb") as fh:
            return fh.read()
    finally:
        os.unlink(tmp.name)
