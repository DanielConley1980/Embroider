(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

  const FMT_LABEL = {};
  (window.FORMATS || []).forEach((f) => { FMT_LABEL[f.ext] = f.label; });

  // ---------------- state ----------------
  let baseImage = null;      // source canvas (photo or sample); null = text-only
  let baseProcessed = null;  // base after background removal (or null)
  let format = "pes";
  let lastJob = null, availableFormats = [];
  const text = { value: "", family: "Fraunces", size: 28, color: "#1b2724", weight: 400, x: 0.5, y: 0.5 };

  // ---------------- sample shapes ----------------
  function sample(draw) {
    const c = document.createElement("canvas");
    c.width = 260; c.height = 260;
    draw(c.getContext("2d"), 260, 260);
    return c;
  }
  const SAMPLES = {
    Flower(c, w, h) {
      c.fillStyle = "#e8ead9"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#3f7a45"; c.lineWidth = 11; c.beginPath(); c.moveTo(w / 2, h); c.lineTo(w / 2, h * 0.5); c.stroke();
      c.fillStyle = "#4f9a52"; c.beginPath(); c.ellipse(w * 0.38, h * 0.66, 28, 13, -0.6, 0, 7); c.fill();
      c.beginPath(); c.ellipse(w * 0.62, h * 0.72, 28, 13, 0.6, 0, 7); c.fill();
      c.fillStyle = "#d1477a"; c.beginPath(); c.moveTo(w / 2, h * 0.5); c.bezierCurveTo(w * 0.3, h * 0.5, w * 0.3, h * 0.22, w / 2, h * 0.24); c.bezierCurveTo(w * 0.7, h * 0.22, w * 0.7, h * 0.5, w / 2, h * 0.5); c.fill();
      c.fillStyle = "#b83568"; c.beginPath(); c.moveTo(w / 2, h * 0.5); c.lineTo(w * 0.42, h * 0.28); c.lineTo(w * 0.58, h * 0.28); c.fill();
    },
    Mountain(c, w, h) {
      c.fillStyle = "#f4c76b"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#f0a24a"; c.fillRect(0, h * 0.42, w, h);
      c.fillStyle = "#e8734f"; c.beginPath(); c.arc(w / 2, h * 0.44, 44, 0, 7); c.fill();
      c.fillStyle = "#5a7d6b"; c.beginPath(); c.moveTo(0, h); c.lineTo(w * 0.34, h * 0.5); c.lineTo(w * 0.66, h); c.fill();
      c.fillStyle = "#3f5c50"; c.beginPath(); c.moveTo(w * 0.4, h); c.lineTo(w * 0.72, h * 0.42); c.lineTo(w, h); c.fill();
      c.fillStyle = "#2e4239"; c.fillRect(0, h * 0.9, w, h);
    },
    Fox(c, w, h) {
      c.fillStyle = "#dce6ea"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#e07a3c";
      c.beginPath(); c.moveTo(w * 0.5, h * 0.82); c.lineTo(w * 0.24, h * 0.36); c.lineTo(w * 0.34, h * 0.36); c.lineTo(w * 0.5, h * 0.5); c.lineTo(w * 0.66, h * 0.36); c.lineTo(w * 0.76, h * 0.36); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(w * 0.24, h * 0.36); c.lineTo(w * 0.2, h * 0.2); c.lineTo(w * 0.37, h * 0.32); c.fill();
      c.beginPath(); c.moveTo(w * 0.76, h * 0.36); c.lineTo(w * 0.8, h * 0.2); c.lineTo(w * 0.63, h * 0.32); c.fill();
      c.fillStyle = "#f4ede2"; c.beginPath(); c.moveTo(w * 0.5, h * 0.82); c.lineTo(w * 0.4, h * 0.56); c.lineTo(w * 0.6, h * 0.56); c.fill();
      c.fillStyle = "#2b2622"; c.beginPath(); c.arc(w * 0.42, h * 0.5, 7, 0, 7); c.arc(w * 0.58, h * 0.5, 7, 0, 7); c.fill();
      c.beginPath(); c.arc(w * 0.5, h * 0.66, 7, 0, 7); c.fill();
    }
  };

  const samplesBox = $("samples");
  function addSampleButton(label, canvasOrNull) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.title = label; btn.setAttribute("aria-label", label);
    if (canvasOrNull) {
      const disp = document.createElement("canvas"); disp.width = 260; disp.height = 260;
      disp.getContext("2d").drawImage(canvasOrNull, 0, 0);
      btn.appendChild(disp);
    } else {
      const span = document.createElement("span"); span.className = "blank"; span.textContent = "TEXT";
      btn.appendChild(span);
    }
    btn.addEventListener("click", () => {
      [...samplesBox.children].forEach((x) => x.classList.remove("active"));
      btn.classList.add("active");
      clearThumb();
      baseImage = canvasOrNull;
      updateBase();
    });
    samplesBox.appendChild(btn);
    return btn;
  }
  Object.keys(SAMPLES).forEach((name) => addSampleButton(name, sample(SAMPLES[name])));
  addSampleButton("Text only", null);

  // ---------------- upload ----------------
  const drop = $("drop"), fileInput = $("photo");
  function clearThumb() { $("thumb").hidden = true; $("dropMsg").hidden = false; drop.classList.remove("has-img"); }
  fileInput.addEventListener("change", (e) => loadFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

  function loadFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      baseImage = c;
      $("thumb").src = url; $("thumb").hidden = false; $("dropMsg").hidden = true; drop.classList.add("has-img");
      [...samplesBox.children].forEach((x) => x.classList.remove("active"));
      updateBase();
    };
    img.src = url;
  }

  // ---------------- background removal ----------------
  function scaledCopy(src, maxSide) {
    const s = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(src.width * s));
    c.height = Math.max(1, Math.round(src.height * s));
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function removeBackground(src, tol) {
    const w = src.width, h = src.height;
    const ctx = src.getContext("2d");
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    // reference = average of border pixels
    let ar = 0, ag = 0, ab = 0, n = 0;
    const acc = (x, y) => { const p = (y * w + x) * 4; ar += d[p]; ag += d[p + 1]; ab += d[p + 2]; n++; };
    for (let x = 0; x < w; x++) { acc(x, 0); acc(x, h - 1); }
    for (let y = 0; y < h; y++) { acc(0, y); acc(w - 1, y); }
    const rr = ar / n, rg = ag / n, rb = ab / n;
    const tol2 = tol * tol;
    const vis = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
    while (stack.length) {
      const idx = stack.pop();
      if (vis[idx]) continue;
      vis[idx] = 1;
      const p = idx * 4;
      const dr = d[p] - rr, dg = d[p + 1] - rg, db = d[p + 2] - rb;
      if (dr * dr + dg * dg + db * db > tol2) continue;   // boundary — keep opaque
      d[p + 3] = 0;                                        // background — clear
      const x = idx % w, y = (idx / w) | 0;
      if (x > 0) stack.push(idx - 1);
      if (x < w - 1) stack.push(idx + 1);
      if (y > 0) stack.push(idx - w);
      if (y < h - 1) stack.push(idx + w);
    }
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    out.getContext("2d").putImageData(img, 0, 0);
    return out;
  }

  $("removeBg").addEventListener("change", () => { $("tolWrap").hidden = !$("removeBg").checked; updateBase(); });
  $("tol").addEventListener("input", () => { $("tolVal").textContent = $("tol").value; updateBase(); });

  function updateBase() {
    if (baseImage && $("removeBg").checked) {
      baseProcessed = removeBackground(scaledCopy(baseImage, 520), +$("tol").value);
    } else {
      baseProcessed = null;
    }
    render();
  }

  // ---------------- fonts ----------------
  fetch("/static/googlefonts.json").then((r) => r.json()).then((list) => {
    const dl = $("fontlist");
    list.forEach((f) => {
      const o = document.createElement("option");
      o.value = f.n; o.label = f.c;
      dl.appendChild(o);
    });
  }).catch(() => {});

  const loadedFonts = new Set();
  async function ensureFont(family, weight) {
    if (!family) return;
    const key = family + ":" + weight;
    if (!loadedFonts.has(key)) {
      loadedFonts.add(key);
      try {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://fonts.googleapis.com/css2?family=" +
          encodeURIComponent(family).replace(/%20/g, "+") + ":wght@" + weight + "&display=swap";
        document.head.appendChild(link);
      } catch (e) { /* ignore */ }
    }
    try {
      await Promise.race([
        document.fonts.load(weight + ' 40px "' + family + '"'),
        new Promise((res) => setTimeout(res, 2500)),
      ]);
    } catch (e) { /* fall back silently */ }
  }

  async function applyFont() {
    text.family = $("fontInput").value.trim() || "Fraunces";
    await ensureFont(text.family, text.weight);
    $("fontPreview").style.fontFamily = '"' + text.family + '", serif';
    $("fontPreview").style.fontWeight = text.weight;
    $("fontPreview").textContent = (text.value.split("\n")[0] || "Sample").slice(0, 24) || "Sample";
    render();
  }
  $("fontInput").addEventListener("change", applyFont);
  $("fontInput").addEventListener("input", () => { /* wait for change/enter to load */ });

  $("weightSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    [...$("weightSeg").children].forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    text.weight = +b.dataset.w;
    applyFont();
  });

  $("text").addEventListener("input", () => {
    text.value = $("text").value;
    $("fontPreview").textContent = (text.value.split("\n")[0] || "Sample").slice(0, 24) || "Sample";
    render();
  });
  $("fontSize").addEventListener("input", () => { text.size = +$("fontSize").value; $("sizeVal").textContent = text.size; render(); });
  $("textColor").addEventListener("input", () => { text.color = $("textColor").value; render(); });

  // ---------------- design canvas ----------------
  const design = $("design");
  function designDims() {
    if (baseImage) {
      const long = 720;
      const s = long / Math.max(baseImage.width, baseImage.height);
      return { W: Math.round(baseImage.width * s), H: Math.round(baseImage.height * s) };
    }
    return { W: 680, H: 320 }; // text-only
  }
  function drawText(ctx, W, H) {
    if (!text.value.trim()) return;
    const fontPx = Math.max(6, (text.size / 100) * H);
    ctx.font = text.weight + ' ' + fontPx + 'px "' + text.family + '", "Hanken Grotesk", sans-serif';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = text.color;
    const lines = text.value.split("\n");
    const lh = fontPx * 1.16;
    const y0 = text.y * H - (lines.length - 1) * lh / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, text.x * W, y0 + i * lh));
  }
  function render() {
    const { W, H } = designDims();
    design.width = W; design.height = H;
    const ctx = design.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    const src = baseProcessed || baseImage;
    if (src) {
      ctx.drawImage(src, 0, 0, W, H);
    } else {
      ctx.fillStyle = "#f4efe4"; ctx.fillRect(0, 0, W, H); // text-only fabric so text is visible
    }
    drawText(ctx, W, H);
    const hasContent = !!baseImage || !!text.value.trim();
    $("idle").hidden = hasContent;
    design.classList.toggle("draggable", !!text.value.trim());
    $("go").disabled = !hasContent;
  }

  // drag text
  let dragging = false;
  function pointerPos(e) {
    const r = design.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  }
  design.addEventListener("pointerdown", (e) => {
    if (!text.value.trim()) return;
    dragging = true; design.classList.add("dragging");
    design.setPointerCapture(e.pointerId);
    const p = pointerPos(e); text.x = p.x; text.y = p.y; render();
  });
  design.addEventListener("pointermove", (e) => { if (!dragging) return; const p = pointerPos(e); text.x = p.x; text.y = p.y; render(); });
  design.addEventListener("pointerup", () => { dragging = false; design.classList.remove("dragging"); });
  design.addEventListener("pointercancel", () => { dragging = false; design.classList.remove("dragging"); });

  // ---------------- machine + settings ----------------
  $("machines").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    [...$("machines").children].forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    format = b.dataset.fmt;
    $("machineNote").innerHTML = "Exports a <b>." + format.toUpperCase() + "</b> file.";
    if (lastJob) refreshDownloads();
  });
  $("hoop").addEventListener("input", () => $("hoopVal").textContent = $("hoop").value + " mm");
  $("colors").addEventListener("input", () => $("colorsVal").textContent = $("colors").value);

  // ---------------- convert ----------------
  function exportCanvas() {
    const { W, H } = designDims();
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H); // flatten transparency onto white
    const src = baseProcessed || baseImage;
    if (src) ctx.drawImage(src, 0, 0, W, H);
    drawText(ctx, W, H);
    return out;
  }

  $("go").addEventListener("click", () => {
    if ($("go").disabled) return;
    $("error").hidden = true; $("resultCard").hidden = true;
    $("spinner").hidden = false; $("go").disabled = true;

    exportCanvas().toBlob(async (blob) => {
      const fd = new FormData();
      fd.append("photo", blob, "design.png");
      fd.append("hoop_mm", $("hoop").value);
      fd.append("num_colors", $("colors").value);
      fd.append("row_spacing_mm", $("density").value);
      fd.append("smooth", $("smooth").checked ? "true" : "false");
      fd.append("remove_background", "true");
      try {
        const res = await fetch("/convert", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Conversion failed.");
        renderResult(data);
      } catch (err) {
        $("error").textContent = err.message; $("error").hidden = false;
      } finally {
        $("spinner").hidden = true; $("go").disabled = false;
      }
    }, "image/png");
  });

  function renderResult(data) {
    lastJob = data.job;
    availableFormats = data.formats.map((f) => f.ext);
    const img = $("preview");
    img.onload = () => { img.hidden = false; };
    img.src = data.preview_url + "?t=" + Date.now();
    $("stSize").innerHTML = data.width_mm + " × " + data.height_mm + " <small>mm</small>";
    $("stCount").textContent = Number(data.stitch_count).toLocaleString();
    $("stColors").textContent = data.color_count;
    const tw = $("threads"); tw.innerHTML = "";
    data.threads.forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "thread-chip";
      chip.innerHTML = '<span class="sw" style="background:' + t.hex + '"></span>' +
        t.hex.toUpperCase() + ' <span class="st">· ' + Number(t.stitches).toLocaleString() + ' st</span>';
      tw.appendChild(chip);
    });
    refreshDownloads();
    $("resultCard").hidden = false;
  }
  function refreshDownloads() {
    if (!lastJob) return;
    const main = availableFormats.includes(format) ? format : (availableFormats[0] || "pes");
    const dl = $("download");
    dl.href = "/download/" + lastJob + "/" + main;
    dl.textContent = "Download ." + main.toUpperCase();
    const alt = $("altFormats"); alt.innerHTML = "";
    availableFormats.filter((f) => f !== main).forEach((f) => {
      const a = document.createElement("a");
      a.href = "/download/" + lastJob + "/" + f;
      a.textContent = "." + f.toUpperCase();
      a.title = FMT_LABEL[f] || f.toUpperCase();
      alt.appendChild(a);
    });
  }

  // ---------------- init ----------------
  applyFont();  // preload default font + preview
  render();
})();
