(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const drop = $("drop");
  const fileInput = $("photo");
  const thumb = $("thumb");
  const dropText = $("dropText");
  const convertBtn = $("convertBtn");

  let selectedFile = null;
  let lastJob = null;

  // ---- live slider readouts ----
  const hoop = $("hoop_mm"), hoopOut = $("hoop_out");
  const colors = $("num_colors"), colorsOut = $("colors_out");
  hoop.addEventListener("input", () => hoopOut.textContent = hoop.value + " mm");
  colors.addEventListener("input", () => colorsOut.textContent = colors.value);

  // ---- machine presets ----
  const formatSel = $("format");
  const presetNote = $("presetNote");
  const FMT_LABEL = {};
  (window.FORMATS || []).forEach((f) => { FMT_LABEL[f.ext] = f.label; });

  document.querySelectorAll(".preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".preset").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const fmt = btn.dataset.format;
      formatSel.value = fmt;
      if (btn.dataset.hoop) {
        hoop.value = btn.dataset.hoop;
        hoopOut.textContent = hoop.value + " mm";
      }
      presetNote.innerHTML =
        btn.textContent.trim() + " machines use <strong>." +
        fmt.toUpperCase() + "</strong> files &mdash; selected.";
    });
  });

  // Keep the preset row in sync if someone changes the advanced format manually.
  formatSel.addEventListener("change", () => {
    let matched = false;
    document.querySelectorAll(".preset").forEach((b) => {
      const on = b.dataset.format === formatSel.value;
      b.classList.toggle("is-active", on);
      if (on) matched = true;
    });
    presetNote.innerHTML = matched
      ? presetNote.innerHTML
      : "Output format: <strong>." + formatSel.value.toUpperCase() + "</strong>.";
  });

  // ---- file selection ----
  function pickFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    selectedFile = file;
    const url = URL.createObjectURL(file);
    thumb.src = url;
    thumb.hidden = false;
    dropText.hidden = true;
    convertBtn.disabled = false;
  }

  drop.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => pickFile(e.target.files[0]));

  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) pickFile(e.dataTransfer.files[0]);
  });

  // ---- convert ----
  convertBtn.addEventListener("click", async () => {
    if (!selectedFile) return;

    $("error").hidden = true;
    $("output").hidden = true;
    $("placeholder").hidden = true;
    $("spinner").hidden = false;
    convertBtn.disabled = true;

    const fd = new FormData();
    fd.append("photo", selectedFile);
    fd.append("hoop_mm", hoop.value);
    fd.append("num_colors", colors.value);
    fd.append("row_spacing_mm", $("density").value);
    fd.append("smooth", $("smooth").checked ? "true" : "false");
    fd.append("remove_background", $("remove_background").checked ? "true" : "false");

    try {
      const res = await fetch("/convert", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Conversion failed.");
      renderResult(data);
    } catch (err) {
      $("error").textContent = err.message;
      $("error").hidden = false;
      $("placeholder").hidden = false;
    } finally {
      $("spinner").hidden = true;
      convertBtn.disabled = false;
    }
  });

  function renderResult(data) {
    lastJob = data.job;
    $("preview").src = data.preview_url + "?t=" + Date.now();
    $("st_size").textContent = data.width_mm + " × " + data.height_mm + " mm";
    $("st_stitches").textContent = data.stitch_count.toLocaleString();
    $("st_colors").textContent = data.color_count;

    const tw = $("threads");
    tw.innerHTML = "";
    data.threads.forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML =
        '<span class="swatch" style="background:' + t.hex + '"></span>' +
        t.hex + " · " + t.stitches.toLocaleString() + " st";
      tw.appendChild(chip);
    });

    const chosen = $("format").value;
    const main = $("download");
    main.href = "/download/" + data.job + "/" + chosen;
    main.textContent = "Download ." + chosen.toUpperCase();

    const alt = $("altFormats");
    alt.innerHTML = "";
    data.formats.forEach((f) => {
      if (f.ext === chosen) return;
      const a = document.createElement("a");
      a.href = "/download/" + data.job + "/" + f.ext;
      a.textContent = "." + f.ext.toUpperCase();
      a.title = f.label;
      alt.appendChild(a);
    });

    $("output").hidden = false;
  }
})();
