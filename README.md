# StitchForge — Photo → Machine Embroidery

Upload a photo in your browser and get back a file a computerised embroidery
machine can stitch. StitchForge reduces the photo to a handful of thread
colours, generates a scanline fill for each colour region, and writes real
machine formats via [`pyembroidery`](https://github.com/EmbroidePy/pyembroidery).

## What it produces

- **`.PES`** — Brother / Babylock / Bernina
- **`.DST`** — Tajima (near-universal)
- **`.EXP`** — Melco / Bernina
- **`.JEF`** — Janome
- **`.VP3`** — Husqvarna Viking / Pfaff
- **`.XXX`** — Singer

Every design is measured in real millimetres, so it stitches at the size you
pick with the hoop slider.

## How it works

```
photo ──► fit to hoop ──► denoise ──► quantise to N thread colours
      ──► per colour: scanline (boustrophedon) fill + jumps/trims
      ──► colour-ordered EmbPattern ──► write DST/PES/EXP/…
      └─► render a stitch-plan PNG preview
```

Core logic lives in `converter.py`; the Flask server and UI are `app.py`,
`templates/`, and `static/`.

## Run it locally

```bash
pip install -r requirements.txt
python app.py            # serves on http://localhost:5000  (set PORT=… to change)
```

Open the page, drop in a photo, tune the settings, and download.

## Try it offline (no install)

`demo/index.html` is a single self-contained page — **double-click it to open in
any browser, no server or internet required.** It runs the same
quantise → background-drop → scanline-fill → stitch-preview pipeline client-side
and animates the design stitching into an embroidery hoop, with live stitch-plan
stats. It shows the plan only; generating the actual `.PES`/`.DST`/… machine files
needs the Python app above.

### Settings

| Control | Effect |
|---|---|
| **Your machine** | One-click preset (Brother/Babylock, Janome, Viking/Pfaff, Bernina/Melco, Singer, Tajima) that picks the right file format. Brother → `.PES` is the default. |
| **Hoop size** | Longest side of the finished design (20–300 mm). |
| **Thread colours** | How many threads to reduce the photo to (2–12). |
| **Fill density** | Gap between stitch rows — denser = more solid, more stitches. |
| **Machine format** | Which file to download (all formats are generated). |
| **Smooth photo** | Median-filter to reduce camera/JPEG noise before quantising. |
| **Drop background colour** | Skip stitching a dominant border colour. |

## Notes & limitations

This is a **raster fill** converter: it fills colour regions with rows of
stitches. It is great for logos, silhouettes, and bold graphic photos. It does
**not** do satin-column lettering, automatic underlay, or push/pull
compensation like commercial digitising software (Wilcom, Hatch, Ink/Stitch).

Photo fills can get **dense** — always stitch a test on scrap fabric first, use
a stabiliser, and lower the density or colour count if the design feels heavy.

## Deploying

### One-click on Render

This repo ships a [`render.yaml`](render.yaml) Blueprint. In the Render
dashboard: **New + → Blueprint**, point it at this repository, and Render reads
the Blueprint to build and start the app (`gunicorn app:app`) with a health
check on `/health`. The free plan works.

### Any WSGI host

```bash
pip install -r requirements.txt
gunicorn app:app --bind 0.0.0.0:8000 --workers 1 --threads 4 --timeout 120
```

Jobs are held **in memory per process**, so run a single worker (use threads for
concurrency, as above). To scale out to multiple workers or instances, move the
job cache to a shared store (Redis, a database, or object storage).
