(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // format ext -> friendly machine label (from server-provided FORMATS)
  const FMT_LABEL = {};
  (window.FORMATS || []).forEach((f) => { FMT_LABEL[f.ext] = f.label; });

  let format = "pes";        // selected download format
  let lastJob = null;        // current job id (for download links)

  // ---- machine presets ----
  $("machines").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    [...$("machines").children].forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    format = b.dataset.fmt;
    $("machineNote").innerHTML = "Exports a <b>." + format.toUpperCase() + "</b> file.";
    if (lastJob) refreshDownloads();
  });

  // ---- sliders ----
  const hoop = $("hoop"), hoopVal = $("hoopVal");
  const colors = $("colors"), colorsVal = $("colorsVal");
  hoop.addEventListener("input", () => hoopVal.textContent = hoop.value + " mm");
  colors.addEventListener("input", () => colorsVal.textContent = colors.value);

  // ---- source selection ----
  const drop = $("drop"), fileInput = $("photo");
  let selectedFile = null;

  function pickFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    selectedFile = file;
    const url = URL.createObjectURL(file);
    $("thumb").src = url;
    $("thumb").hidden = false;
    $("dropMsg").hidden = true;
    drop.classList.add("has-img");
    $("go").disabled = false;
  }

  // #drop is a <label for="photo">, so a click already opens the picker natively;
  // don't call fileInput.click() too or the dialog opens twice and eats the pick.
  fileInput.addEventListener("change", (e) => pickFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
  });

  // ---- convert ----
  $("go").addEventListener("click", async () => {
    if (!selectedFile) return;

    $("error").hidden = true;
    $("resultCard").hidden = true;
    $("preview").hidden = true;
    $("idle").hidden = true;
    $("spinner").hidden = false;
    $("go").disabled = true;

    const fd = new FormData();
    fd.append("photo", selectedFile);
    fd.append("hoop_mm", hoop.value);
    fd.append("num_colors", colors.value);
    fd.append("row_spacing_mm", $("density").value);
    fd.append("smooth", $("smooth").checked ? "true" : "false");
    fd.append("remove_background", $("bg").checked ? "true" : "false");

    try {
      const res = await fetch("/convert", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Conversion failed.");
      renderResult(data);
    } catch (err) {
      $("spinner").hidden = true;
      $("idle").hidden = false;
      $("error").textContent = err.message;
      $("error").hidden = false;
    } finally {
      $("go").disabled = false;
    }
  });

  function renderResult(data) {
    lastJob = data.job;
    availableFormats = data.formats.map((f) => f.ext);

    const img = $("preview");
    img.onload = () => {
      $("spinner").hidden = true;
      img.hidden = false;
    };
    img.src = data.preview_url + "?t=" + Date.now();

    $("stSize").innerHTML = data.width_mm + " × " + data.height_mm + " <small>mm</small>";
    $("stCount").textContent = Number(data.stitch_count).toLocaleString();
    $("stColors").textContent = data.color_count;

    const tw = $("threads");
    tw.innerHTML = "";
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

  let availableFormats = [];
  function refreshDownloads() {
    if (!lastJob) return;
    // if the chosen machine's format wasn't generated, fall back to the first available
    const main = availableFormats.includes(format) ? format : (availableFormats[0] || "pes");
    const dl = $("download");
    dl.href = "/download/" + lastJob + "/" + main;
    dl.textContent = "Download ." + main.toUpperCase();

    const alt = $("altFormats");
    alt.innerHTML = "";
    availableFormats.filter((f) => f !== main).forEach((f) => {
      const a = document.createElement("a");
      a.href = "/download/" + lastJob + "/" + f;
      a.textContent = "." + f.toUpperCase();
      a.title = FMT_LABEL[f] || f.toUpperCase();
      alt.appendChild(a);
    });
  }
})();
