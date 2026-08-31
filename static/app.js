(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

  const FMT_LABEL = {};
  (window.FORMATS || []).forEach((f) => { FMT_LABEL[f.ext] = f.label; });

  // ---------------- state ----------------
  let baseImage = null;      // source canvas (photo or sample); null = text-only
  let baseProcessed = null;  // base after background removal (or null)
  let reducedRaster = null;  // palette-reduced raster from the server (or null)
  let editedRaster = null;   // reducedRaster after manual palette edits (or null)
  let palette = [];          // [{src, out, deleted}] editable thread list
  let selectedPal = -1;      // index of the swatch being edited (-1 = none)
  let vectorSvg = null;      // last vectorised SVG text (for download)
  let vectorRaster = null;   // canvas rasterised from the SVG (preview + export)
  let vectorSeq = 0;         // race guard: only the newest vectorise wins
  let vectorTimer = null;    // debounce handle for the vectorise fetch
  let vectorSuggested = null; // natural distinct-colour count detected for this image
  let colorsUserSet = false;  // has the user manually chosen the thread count?
  let format = "pes";
  let lastJob = null, availableFormats = [];
  const text = { value: "", family: "Poppins", size: 28, color: "#1b2724", weight: 400, x: 0.5, y: 0.5,
                 outline: false, outlineColor: "#ffffff", outlineWidth: 12 };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
      resetPaletteAdvice();
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
      resetPaletteAdvice();
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
    // Second pass: clear "trapped" background — pockets of the background
    // colour fully enclosed by the design, which the border flood-fill can
    // never reach (e.g. white space in the middle of the logo, or inside
    // letter holes). Any still-opaque pixel within tolerance of the
    // reference colour is such a pocket, so drop it too. For embroidery this
    // is what we want: transparent means no stitching, so the hoop fabric
    // shows through instead of a stitched-in white patch.
    for (let idx = 0; idx < w * h; idx++) {
      const p = idx * 4;
      if (d[p + 3] === 0) continue;                       // already cleared
      const dr = d[p] - rr, dg = d[p + 1] - rg, db = d[p + 2] - rb;
      if (dr * dr + dg * dg + db * db <= tol2) d[p + 3] = 0;
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
    refreshProcessed();   // re-run the active palette path off the fresh base
  }

  // ---------------- reduce palette (core step) + optional vectorise ----------
  $("reduceStrength").addEventListener("input", () => { updateStrengthLabel(); refreshProcessed(); });
  $("vectorise").addEventListener("change", () => { $("vecWrap").hidden = !$("vectorise").checked; refreshProcessed(); });
  $("vecDetail").addEventListener("input", () => { $("vecDetailVal").textContent = $("vecDetail").value; refreshProcessed(); });
  $("vecDownload").addEventListener("click", () => {
    if (!vectorSvg) return;
    const blob = new Blob([vectorSvg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "stitchforge-design.svg";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function updateStrengthLabel() {
    const v = +$("reduceStrength").value;
    $("reduceStrengthVal").textContent = v <= 20 ? "Sensitive" : v <= 38 ? "Balanced" : "Aggressive";
  }

  // ---- editable thread palette ----
  const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; };
  const toHex6 = (h) => "#" + [hexToRgb(h).r, hexToRgb(h).g, hexToRgb(h).b].map((v) => v.toString(16).padStart(2, "0")).join("");

  // Adopt a fresh server palette, discarding any manual edits (the colours changed).
  function setPalette(colors) {
    palette = (colors || []).map((h) => ({ src: h, out: h, deleted: false }));
    selectedPal = -1; editedRaster = null;
    renderPalette(); $("palEditor").hidden = true;
  }

  function renderPalette() {
    const el = $("palette");
    if (el) {
      el.innerHTML = "";
      palette.forEach((p, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pal-sw" + (p.deleted ? " deleted" : "") + (i === selectedPal ? " sel" : "");
        b.style.background = p.deleted ? "transparent" : p.out;
        b.title = p.deleted ? "Removed — click to edit/restore" : p.out + " — click to edit";
        b.addEventListener("click", () => selectPalette(i));
        el.appendChild(b);
      });
    }
    const cnt = $("reduceCount");
    if (cnt) {
      const live = new Set(palette.filter((p) => !p.deleted).map((p) => p.out.toLowerCase()));
      cnt.textContent = palette.length ? (live.size ? live.size + " thread" + (live.size === 1 ? "" : "s") : "all removed") : "";
    }
  }

  function selectPalette(i) { selectedPal = i; renderPalette(); openPalEditor(); }

  function openPalEditor() {
    const p = palette[selectedPal];
    const ed = $("palEditor");
    if (!p) { ed.hidden = true; return; }
    ed.hidden = false;
    $("palEditSw").style.background = p.deleted ? "transparent" : p.out;
    $("palEditColor").value = toHex6(p.out);
    $("palEditDelete").textContent = p.deleted ? "Restore to plan" : "Remove from plan";
    const m = $("palMerge"); m.innerHTML = "";
    palette.forEach((q, j) => {
      if (j === selectedPal || q.deleted) return;
      const s = document.createElement("button");
      s.type = "button"; s.className = "pal-sw"; s.style.background = q.out;
      s.title = "Merge into " + q.out;
      s.addEventListener("click", () => { p.out = q.out; p.deleted = false; commitPaletteEdit(); });
      m.appendChild(s);
    });
    $("palMergeRow").hidden = m.children.length === 0;
  }

  // Rebuild the edited raster from the reduced one by recolouring / dropping the
  // pixels of each palette colour according to the manual edits.
  function buildEditedRaster() {
    if (!reducedRaster) { editedRaster = null; return; }
    const dirty = palette.some((p) => p.deleted || p.out.toLowerCase() !== p.src.toLowerCase());
    if (!dirty) { editedRaster = null; return; }
    const w = reducedRaster.width, h = reducedRaster.height;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); ctx.drawImage(reducedRaster, 0, 0);
    const im = ctx.getImageData(0, 0, w, h), d = im.data;
    const map = new Map();
    palette.forEach((p) => {
      const s = hexToRgb(p.src), o = hexToRgb(p.out);
      map.set((s.r << 16) | (s.g << 8) | s.b, { del: p.deleted, r: o.r, g: o.g, b: o.b });
    });
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const m = map.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      if (!m) continue;
      if (m.del) { d[i + 3] = 0; }
      else { d[i] = m.r; d[i + 1] = m.g; d[i + 2] = m.b; }
    }
    ctx.putImageData(im, 0, 0);
    editedRaster = c;
  }

  // Apply an edit: rebuild the raster, refresh UI, and re-trace if vectorising.
  function commitPaletteEdit() {
    renderPalette(); openPalEditor(); buildEditedRaster();
    if ($("vectorise").checked) { vectorRaster = null; render(); revectoriseEdited(); }
    else render();
  }

  // Re-trace the edited raster (no re-reduce) so the vector reflects manual edits.
  function revectoriseEdited() {
    const source = editedRaster || reducedRaster;
    if (!source) return;
    const seq = ++vectorSeq;
    $("vecStatus").textContent = "Smoothing…";
    source.toBlob((blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append("photo", blob, "design.png");
      fd.append("max_colors", "0");          // keep the edited palette; just smooth
      fd.append("vectorise", "true");
      fd.append("filter_speckle", $("vecDetail").value);
      fetch("/process", { method: "POST", body: fd })
        .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
          if (seq !== vectorSeq || !ok || !d.svg) return;
          vectorSvg = d.svg;
          const img = new Image();
          const url = URL.createObjectURL(new Blob([d.svg], { type: "image/svg+xml" }));
          img.onload = () => {
            URL.revokeObjectURL(url);
            if (seq !== vectorSeq) return;
            const c = document.createElement("canvas");
            c.width = img.naturalWidth || source.width; c.height = img.naturalHeight || source.height;
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            vectorRaster = c;
            $("vecStatus").textContent = "Smoothed into vectors.";
            $("vecActions").hidden = false;
            render();
          };
          img.onerror = () => { URL.revokeObjectURL(url); };
          img.src = url;
        })
        .catch(() => {});
    }, "image/png");
  }

  $("palEditColor").addEventListener("input", () => {
    const p = palette[selectedPal]; if (!p) return;
    p.out = $("palEditColor").value; p.deleted = false; commitPaletteEdit();
  });
  $("palEditDelete").addEventListener("click", () => {
    const p = palette[selectedPal]; if (!p) return;
    p.deleted = !p.deleted; commitPaletteEdit();
  });

  // Forget the auto-detected palette when the source image changes, so the next
  // reduce re-suggests a thread count for the new design.
  function resetPaletteAdvice() { vectorSuggested = null; colorsUserSet = false; }

  // The heart of the preview: reduce the design to its fewest telling threads,
  // then (optionally) smooth that into vectors. One server round-trip feeds both.
  function refreshProcessed() {
    const source = baseProcessed || baseImage;
    if (!source) {
      reducedRaster = null; editedRaster = null; vectorRaster = null; vectorSvg = null; vectorSuggested = null;
      vectorSeq++;
      $("vecActions").hidden = true; $("vecStatus").textContent = "";
      $("reduceStatus").textContent = "";
      setPalette([]); updateColorAdvice();
      render();
      return;
    }
    render();                            // show the current base while we work
    const seq = ++vectorSeq;
    const doVec = $("vectorise").checked;
    $("reduceStatus").textContent = "Reducing…";
    if (doVec) $("vecStatus").textContent = "Smoothing…";
    clearTimeout(vectorTimer);
    vectorTimer = setTimeout(() => {
      source.toBlob((blob) => {
        if (!blob) { if (seq === vectorSeq) $("reduceStatus").textContent = "Couldn’t read the image."; return; }
        const sent = +$("colors").value;
        const fd = new FormData();
        fd.append("photo", blob, "design.png");
        fd.append("max_colors", sent);                 // hard cap on threads
        fd.append("strength", $("reduceStrength").value); // how aggressively to merge
        fd.append("vectorise", doVec ? "true" : "false");
        fd.append("filter_speckle", $("vecDetail").value);
        fetch("/process", { method: "POST", body: fd })
          .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
          .then(({ ok, d }) => {
            if (seq !== vectorSeq) return;             // superseded by a newer run
            if (!ok) throw new Error(d.error || "Processing failed.");
            // The reduce tells us the image's natural distinct-colour count at
            // this strength. Adopt it as the thread default (unless the user set
            // one), re-running if we'd under-asked so the fuller palette renders.
            vectorSuggested = (d.suggested > 0) ? d.suggested : null;
            if (vectorSuggested && !colorsUserSet) {
              const slider = $("colors");
              const want = clamp(vectorSuggested, +slider.min, +slider.max);
              if (+slider.value !== want) { slider.value = want; $("colorsVal").textContent = want; }
              if (want > sent) { updateColorAdvice(); refreshProcessed(); return; }
            }
            setPalette(d.colors || []);
            updateColorAdvice();
            $("reduceStatus").textContent = "";

            // Reduced raster (always) — the base for preview, stitching and export.
            const rimg = new Image();
            rimg.onload = () => {
              if (seq !== vectorSeq) return;
              const c = document.createElement("canvas");
              c.width = rimg.naturalWidth || source.width;
              c.height = rimg.naturalHeight || source.height;
              c.getContext("2d").drawImage(rimg, 0, 0, c.width, c.height);
              reducedRaster = c;
              render();
            };
            rimg.onerror = () => {};
            rimg.src = d.png;

            // Vector (optional) — smoothed shapes traced from the reduced result.
            if (d.svg) {
              vectorSvg = d.svg;
              const vimg = new Image();
              const url = URL.createObjectURL(new Blob([d.svg], { type: "image/svg+xml" }));
              vimg.onload = () => {
                URL.revokeObjectURL(url);
                if (seq !== vectorSeq) return;
                const c = document.createElement("canvas");
                c.width = vimg.naturalWidth || source.width;
                c.height = vimg.naturalHeight || source.height;
                c.getContext("2d").drawImage(vimg, 0, 0, c.width, c.height);
                vectorRaster = c;
                $("vecStatus").textContent = "Smoothed into vectors.";
                $("vecActions").hidden = false;
                render();
              };
              vimg.onerror = () => { URL.revokeObjectURL(url); if (seq === vectorSeq) $("vecStatus").textContent = "Couldn’t render the vector."; };
              vimg.src = url;
            } else {
              vectorSvg = null; vectorRaster = null;
              $("vecActions").hidden = true; $("vecStatus").textContent = "";
            }
          })
          .catch((err) => { if (seq === vectorSeq) $("reduceStatus").textContent = err.message; });
      }, "image/png");
    }, 300);
  }

  // ---------------- fonts (scrollable preview picker) ----------------
  const fontList = $("fontList"), fontSearch = $("fontSearch");
  const loadedFonts = new Set();
  function loadFontCss(family) {
    if (!family || loadedFonts.has(family)) return;
    loadedFonts.add(family);
    try {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      // no weight axis -> always resolves; canvas applies synthetic bold if needed
      link.href = "https://fonts.googleapis.com/css2?family=" +
        encodeURIComponent(family).replace(/%20/g, "+") + "&display=swap";
      document.head.appendChild(link);
    } catch (e) { /* ignore */ }
  }
  async function ensureFont(family) {
    loadFontCss(family);
    try {
      await Promise.race([
        document.fonts.load('40px "' + family + '"'),
        new Promise((res) => setTimeout(res, 2000)),
      ]);
    } catch (e) { /* silent fallback */ }
  }

  // lazy-load each row's webfont as it scrolls into view
  const io = ("IntersectionObserver" in window)
    ? new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            const fam = en.target.dataset.fam;
            loadFontCss(fam);
            document.fonts.ready.then(() => { en.target.style.fontFamily = '"' + fam + '", sans-serif'; });
            en.target.style.fontFamily = '"' + fam + '", sans-serif';
            io.unobserve(en.target);
          }
        });
      }, { root: fontList, rootMargin: "120px" })
    : null;

  // dropdown open/close
  const fontSelect = $("fontSelect"), fontTrigger = $("fontTrigger"),
        fontPanel = $("fontPanel"), fontCurrent = $("fontCurrent");
  function openPanel() {
    fontPanel.hidden = false; fontSelect.classList.add("open");
    fontTrigger.setAttribute("aria-expanded", "true");
    fontSearch.value = ""; buildFontRows("");
    const active = fontList.querySelector(".font-row.active");
    if (active) active.scrollIntoView({ block: "nearest" });
    fontSearch.focus();
  }
  function closePanel() {
    fontPanel.hidden = true; fontSelect.classList.remove("open");
    fontTrigger.setAttribute("aria-expanded", "false");
  }
  fontTrigger.addEventListener("click", () => { fontPanel.hidden ? openPanel() : closePanel(); });
  document.addEventListener("click", (e) => { if (!fontSelect.contains(e.target)) closePanel(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });

  function selectFont(family) {
    text.family = family;
    fontCurrent.textContent = family;
    ensureFont(family).then(() => { fontCurrent.style.fontFamily = '"' + family + '", sans-serif'; render(); });
    closePanel();
  }

  let FONTS = [];
  function buildFontRows(filter) {
    fontList.innerHTML = "";
    const q = (filter || "").trim().toLowerCase();
    const shown = FONTS.filter((f) => !q || f.n.toLowerCase().includes(q));
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "font-list-empty";
      empty.textContent = q ? "No matching fonts." : "Loading fonts…";
      fontList.appendChild(empty);
      return;
    }
    shown.forEach((f) => {
      const row = document.createElement("button");
      row.type = "button"; row.className = "font-row"; row.dataset.fam = f.n;
      row.setAttribute("role", "option");
      if (f.n === text.family) row.classList.add("active");
      const name = document.createElement("span"); name.textContent = f.n;
      const cat = document.createElement("span"); cat.className = "cat"; cat.textContent = f.c;
      row.appendChild(name); row.appendChild(cat);
      row.addEventListener("click", () => selectFont(f.n));
      fontList.appendChild(row);
      if (io) io.observe(row); else { loadFontCss(f.n); row.style.fontFamily = '"' + f.n + '", sans-serif'; }
    });
  }

  fetch("/static/googlefonts.json").then((r) => r.json()).then((list) => {
    FONTS = list;
    buildFontRows("");
    ensureFont(text.family).then(render);
  }).catch(() => {});

  fontSearch.addEventListener("input", () => buildFontRows(fontSearch.value));

  $("weightSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    [...$("weightSeg").children].forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    text.weight = +b.dataset.w;
    render();
  });

  $("text").addEventListener("input", () => { text.value = $("text").value; render(); });
  $("fontSize").addEventListener("input", () => { text.size = +$("fontSize").value; $("sizeVal").textContent = text.size; render(); });
  $("textColor").addEventListener("input", () => { text.color = $("textColor").value; render(); });
  $("textOutline").addEventListener("change", () => {
    text.outline = $("textOutline").checked;
    $("outlineWidth").disabled = !text.outline;
    render();
  });
  $("outlineColor").addEventListener("input", () => { text.outlineColor = $("outlineColor").value; render(); });
  $("outlineWidth").addEventListener("input", () => { text.outlineWidth = +$("outlineWidth").value; render(); });

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
    if (text.outline) {
      ctx.lineJoin = "round";
      ctx.strokeStyle = text.outlineColor;
      ctx.lineWidth = Math.max(1, (text.outlineWidth / 100) * fontPx);
      lines.forEach((ln, i) => ctx.strokeText(ln, text.x * W, y0 + i * lh));
    }
    lines.forEach((ln, i) => ctx.fillText(ln, text.x * W, y0 + i * lh));
  }
  function render() {
    const { W, H } = designDims();
    design.width = W; design.height = H;
    const ctx = design.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    const src = vectorRaster || editedRaster || reducedRaster || baseProcessed || baseImage;
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
    updateColorAdvice();
    renderCompare();
  }

  // Side-by-side before/after for the reduce (and vectorise) step.
  function renderCompare() {
    const card = $("compareCard");
    const before = baseProcessed || baseImage;
    const after = vectorRaster || editedRaster || reducedRaster;
    if (!before || !after) { card.hidden = true; return; }
    card.hidden = false;
    const draw = (cv, src) => {
      const maxW = 320;
      const s = Math.min(1, maxW / src.width);
      cv.width = Math.max(1, Math.round(src.width * s));
      cv.height = Math.max(1, Math.round(src.height * s));
      const ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(src, 0, 0, cv.width, cv.height);
    };
    draw($("cmpBefore"), before);
    draw($("cmpAfter"), after);
  }

  // ---------------- thread-count advice ----------------
  function colorAdvice() {
    const hasText = !!text.value.trim();
    const hasImg = !!baseImage;
    const bgRemoved = hasImg && $("removeBg").checked;
    let lo, hi, why;
    if (!hasImg && hasText) { lo = 2; hi = 3; why = "text stitches cleanest in one or two colours"; }
    else if (bgRemoved) { lo = 3; hi = 5; why = "an extracted logo usually needs only a few flat colours"; }
    else if (hasImg) { lo = 6; hi = 8; why = "a full photo keeps its detail with more colours"; }
    else { lo = 3; hi = 6; why = "a good general range"; }
    if (hasText && hasImg) hi = Math.min(hi + 1, 12); // text adds ~1 colour
    return { lo, hi, why };
  }
  function updateColorAdvice() {
    const el = $("colorAdvice"); if (!el) return;
    const cur = +$("colors").value;
    // Once the reduce step has run, we know the image's actual distinct-colour
    // count — that's the most appropriate thread count, so lead with it.
    if (vectorSuggested) {
      const n = vectorSuggested;
      let html = "Best for this image: <b>" + n + "</b> thread colour" + (n === 1 ? "" : "s") +
        " — the distinct colours it actually contains.";
      if (cur !== n) html += ' <span class="nudge">You’re at ' + cur + "; " + n + " matches this design.</span>";
      el.innerHTML = html;
      return;
    }
    const a = colorAdvice();
    let html = "Suggested: <b>" + a.lo + "–" + a.hi + "</b> — " + a.why + ".";
    if (cur > a.hi + 1) html += ' <span class="nudge">You’re at ' + cur + "; try lowering it for a cleaner stitch.</span>";
    else if (cur < a.lo) html += ' <span class="nudge">You’re at ' + cur + "; try raising it for more detail.</span>";
    el.innerHTML = html;
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
  $("colors").addEventListener("input", () => { colorsUserSet = true; $("colorsVal").textContent = $("colors").value; updateColorAdvice(); refreshProcessed(); });

  // ---------------- convert ----------------
  function exportCanvas() {
    const { W, H } = designDims();
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H); // flatten transparency onto white
    const src = vectorRaster || editedRaster || reducedRaster || baseProcessed || baseImage;
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

  let animId = null;
  function animatePreview(anim) {
    if (animId) cancelAnimationFrame(animId);
    const cv = $("preview");
    const w = anim.w || 8, h = anim.h || 8;
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = 1.4;
    // flatten to per-segment line steps in stitch order
    const steps = [];
    (anim.segments || []).forEach((seg) => {
      const hex = seg[0], runs = seg[1];
      runs.forEach((run) => {
        for (let i = 2; i < run.length; i += 2) {
          steps.push([hex, run[i - 2], run[i - 1], run[i], run[i + 1]]);
        }
      });
    });
    const draw = (s) => {
      ctx.strokeStyle = s[0];
      ctx.beginPath(); ctx.moveTo(s[1], s[2]); ctx.lineTo(s[3], s[4]); ctx.stroke();
    };
    if (reduceMotion || steps.length === 0) { steps.forEach(draw); return; }
    // Slow, deliberate "watch it stitch": spread the whole path over ~14s
    // (min 1 stitch/frame), so small designs take a few seconds and large ones
    // stay bounded.
    const targetFrames = 14 * 60;
    const perFrame = Math.max(1, Math.ceil(steps.length / targetFrames));
    let i = 0;
    (function frame() {
      const end = Math.min(steps.length, i + perFrame);
      for (; i < end; i++) draw(steps[i]);
      if (i < steps.length) animId = requestAnimationFrame(frame);
    })();
  }

  function renderResult(data) {
    lastJob = data.job;
    availableFormats = data.formats.map((f) => f.ext);
    animatePreview(data.anim || { segments: [] });
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
  updateStrengthLabel();
  ensureFont(text.family).then(() => {
    $("fontCurrent").style.fontFamily = '"' + text.family + '", sans-serif';
    render();
  });
  render();
})();
