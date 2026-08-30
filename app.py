"""
app.py
------
Flask web server for the photo -> embroidery converter.

Routes
======
GET  /                       upload UI
POST /convert                multipart photo + options -> JSON (preview + stats + job id)
GET  /download/<job>/<fmt>   download a generated machine file
GET  /preview/<job>          the rendered stitch-plan PNG

Generated jobs live in a small in-memory LRU cache plus a temp dir; they are
evicted after JOB_TTL or when MAX_JOBS is exceeded.  This is a single-process
demo server — put it behind gunicorn + a shared store for real deployment.
"""

from __future__ import annotations

import io
import time
import uuid
import threading
from collections import OrderedDict

from flask import (
    Flask, request, jsonify, send_file, render_template, abort,
)
from PIL import Image

from converter import (
    ConvertOptions, convert_image, write_pattern, SUPPORTED_FORMATS,
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25 MB upload cap

MAX_JOBS = 30
JOB_TTL = 3600  # seconds

_jobs: "OrderedDict[str, dict]" = OrderedDict()
_lock = threading.Lock()


def _evict():
    now = time.time()
    with _lock:
        for jid in list(_jobs.keys()):
            if now - _jobs[jid]["created"] > JOB_TTL:
                _jobs.pop(jid, None)
        while len(_jobs) > MAX_JOBS:
            _jobs.popitem(last=False)


def _store(job: dict) -> str:
    jid = uuid.uuid4().hex[:12]
    with _lock:
        _jobs[jid] = job
        _jobs.move_to_end(jid)
    _evict()
    return jid


def _get(jid: str):
    with _lock:
        job = _jobs.get(jid)
        if job:
            _jobs.move_to_end(jid)
    return job


@app.route("/")
def index():
    return render_template(
        "index.html",
        formats=[{"ext": k, "label": v} for k, v in SUPPORTED_FORMATS.items()],
    )


@app.route("/convert", methods=["POST"])
def convert():
    if "photo" not in request.files or request.files["photo"].filename == "":
        return jsonify({"error": "No photo uploaded."}), 400

    file = request.files["photo"]
    try:
        img = Image.open(io.BytesIO(file.read()))
        img.load()
    except Exception:
        return jsonify({"error": "Could not read that image file."}), 400

    def num(name, default, cast):
        try:
            return cast(request.form.get(name, default))
        except (TypeError, ValueError):
            return default

    opts = ConvertOptions(
        hoop_mm=num("hoop_mm", 100.0, float),
        num_colors=num("num_colors", 6, int),
        row_spacing_mm=num("row_spacing_mm", 0.40, float),
        max_stitch_mm=num("max_stitch_mm", 3.0, float),
        smooth=request.form.get("smooth", "true") != "false",
        remove_background=request.form.get("remove_background", "true") != "false",
    )

    try:
        result = convert_image(img, opts)
    except Exception as exc:  # pragma: no cover - defensive
        return jsonify({"error": f"Conversion failed: {exc}"}), 500

    # Pre-render all machine files up front so downloads are instant.
    files = {}
    for fmt in SUPPORTED_FORMATS:
        try:
            files[fmt] = write_pattern(result.pattern, fmt)
        except Exception:
            pass

    jid = _store({
        "created": time.time(),
        "preview": result.preview_png,
        "files": files,
        "name": file.filename.rsplit(".", 1)[0] or "design",
    })

    return jsonify({
        "job": jid,
        "width_mm": result.width_mm,
        "height_mm": result.height_mm,
        "stitch_count": result.stitch_count,
        "color_count": result.color_count,
        "threads": [
            {"index": t.index, "hex": t.hex, "stitches": t.stitches}
            for t in result.threads
        ],
        "formats": [
            {"ext": k, "label": v} for k, v in SUPPORTED_FORMATS.items()
            if k in files
        ],
        "preview_url": f"/preview/{jid}",
    })


@app.route("/preview/<job>")
def preview(job):
    j = _get(job)
    if not j:
        abort(404)
    return send_file(io.BytesIO(j["preview"]), mimetype="image/png")


@app.route("/download/<job>/<fmt>")
def download(job, fmt):
    j = _get(job)
    fmt = fmt.lower()
    if not j or fmt not in j["files"]:
        abort(404)
    return send_file(
        io.BytesIO(j["files"][fmt]),
        mimetype="application/octet-stream",
        as_attachment=True,
        download_name=f"{j['name']}.{fmt}",
    )


@app.route("/health")
def health():
    return jsonify({"status": "ok", "jobs": len(_jobs)})


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=bool(os.environ.get("DEBUG")))
