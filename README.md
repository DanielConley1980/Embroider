# StitchForge — Photo & Text → Machine Embroidery

A little browser design studio that turns a photo, a built-in shape, or **typed
text** into a file a computerised embroidery machine can stitch. Compose your
design (optionally removing the background to extract a logo, and adding text in
any Google Font), and StitchForge reduces it to a handful of thread colours,
generates a scanline fill for each colour region, and writes real machine
formats via [`pyembroidery`](https://github.com/EmbroidePy/pyembroidery).

## Design studio

- **Sources** — drop a photo, pick a starting shape (flower, mountain, fox), or
  start blank for text-only.
- **Text** — type one or more lines, choose any Google Font (search a bundled
  list or type a family name), set size / colour / weight, and drag it to
  position in the hoop. Use it alone or layered over a photo/shape.
- **Background removal** — a fast, in-browser flood-fill cutout with a tolerance
  control and a live preview, for extracting a simple logo/design from a plain
  background.

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

Open the page, build your design, tune the settings, and download.

The live app is deployed on Render; `docs/index.html` is a small redirect to it
so the GitHub Pages link points at the running app.

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
