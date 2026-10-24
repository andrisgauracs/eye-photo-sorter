import { Eye } from "@desert-ant-labs/eye";

const $ = (id) => document.getElementById(id);

// Large photos are scaled down before analysis: Eye works on small inputs anyway,
// and moving fewer pixels into the model keeps throughput up.
const MAX_SIDE = 1024;
const LANES = Number(new URLSearchParams(location.search).get("lanes")) || 6;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

const items = []; // { file, url, tile, analysis, ms, error, lane, t0, t1, t2 }
let eye = null;
let eyeReady = null;
let queue = [];
let running = false;
let startedAt = 0;
let finishedAt = 0;
let doneCount = 0;
let runStartDone = 0; // doneCount when the current timed run began
let duplicateGroups = [];
let duplicateExtras = new Set();
let bestShots = new Set();
let view = "all";
const lastCounts = {};
const perf = { backend: "", gpu: "", loadMs: 0, singleMs: 0, rateSamples: [], peak: 0, bytes: 0 };

// ---------- categories ----------

// Group shots often have one face sitting right at the 0.5 cutoff; 0.75 keeps the clear cases.
const eyesClosed = (a) => (a.confidence("eyes_closed") ?? 0) >= 0.75;

const isPhoto = (a) => a.kind === "photo" || a.kind === "selfie" || a.kind === null;

const CATEGORIES = [
  { id: "all", label: "All", test: () => true },
  { id: "receipt", label: "Receipts", test: (a) => a.kind === "receipt" || a.has("receipt") },
  { id: "screenshot", label: "Screenshots", test: (a) => a.kind === "screenshot" || a.has("screenshot") },
  { id: "document", label: "Documents", test: (a) => ["document", "whiteboard", "id_card"].some((t) => a.kind === t || a.has(t)) },
  { id: "people", label: "People", test: (a) => isPhoto(a) && (a.has("people") || (a.faces?.length ?? 0) > 0) },
  { id: "pets", label: "Pets", test: (a) => isPhoto(a) && (a.has("pet") || (a.pets?.length ?? 0) > 0) },
  { id: "blurry", label: "Blurry", test: (a) => isPhoto(a) && a.has("blurry") },
  { id: "eyes", label: "Eyes closed", test: (a) => eyesClosed(a) },
  { id: "dupes", label: "Duplicates", test: (a, it) => duplicateGroups.some((g) => g.includes(it.index)) },
  { id: "best", label: "Best shots", test: (a, it) => bestShots.has(it.index) },
  { id: "cleanup", label: "Safe to delete", test: (a, it) => duplicateExtras.has(it.index) || (isPhoto(a) && a.has("blurry")) },
];

// ---------- model ----------

async function pickBackend() {
  const asked = new URLSearchParams(location.search).get("backend");
  if (asked === "wasm" || asked === "webgpu") return asked;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) {
      const info = adapter.info ?? {};
      perf.gpu = [info.vendor, info.architecture].filter(Boolean).join(" · ");
      return "webgpu";
    }
  } catch {}
  return "wasm";
}

function warmupImage(w = 384, h = 384) {
  // A plain gradient: enough to compile every kernel so the first real photo isn't slow.
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#88a"); grad.addColorStop(1, "#334");
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}

async function loadEye(accelerator) {
  const loaded = await Eye.load({
    accelerator,
    litertWasmDir: new URL("litert/", location.href).href,
    onProgress: (f) => {
      $("load-bar").style.width = `${Math.round(f * 100)}%`;
      $("load-text").textContent = `Downloading model… ${Math.round(f * 100)}%`;
    },
  });
  $("load-text").textContent = "Warming up…";
  const img = warmupImage();
  await loaded.analyze(img);
  await loaded.analyze(img);
  // One photo alone, at the size real photos are analyzed at: the honest single-photo latency.
  const probe = warmupImage(MAX_SIDE, Math.round(MAX_SIDE * 0.75));
  const t = performance.now();
  await loaded.analyze(probe);
  perf.singleMs = performance.now() - t;
  return loaded;
}

async function initModel() {
  $("load").hidden = false;
  const t0 = performance.now();
  let backend = await pickBackend();
  try {
    eye = await loadEye(backend);
  } catch (err) {
    if (backend !== "webgpu") throw err;
    console.warn("WebGPU failed, falling back to WebAssembly", err);
    backend = "wasm";
    eye = await loadEye(backend);
  }
  if (import.meta.env.DEV) window.eye = eye;
  const pill = $("backend");
  pill.textContent = backend === "webgpu" ? "WebGPU" : "WebAssembly (CPU)";
  pill.className = `pill ${backend === "webgpu" ? "gpu" : "cpu"}`;
  perf.backend = backend;
  perf.loadMs = performance.now() - t0;
  $("model").textContent = `model ready in ${(perf.loadMs / 1000).toFixed(1)}s`;
  $("load").hidden = true;
  renderMeta();
}

// ---------- files ----------

async function filesFromDrop(dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

function addFiles(files) {
  const images = files
    .filter((f) => !f.name.startsWith(".") && (f.type.startsWith("image/") || IMAGE_EXT.test(f.name)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!images.length) return;

  $("drop").hidden = true;
  $("run").hidden = false;

  for (const file of images) {
    const item = { index: items.length, file, url: URL.createObjectURL(file), analysis: null, ms: 0, error: null };
    item.tile = makeTile(item);
    items.push(item);
    queue.push(item);
  }
  render();
  run();
}

async function decode(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = MAX_SIDE / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) return bitmap;
  const small = await createImageBitmap(bitmap, {
    resizeWidth: Math.round(bitmap.width * scale),
    resizeHeight: Math.round(bitmap.height * scale),
    resizeQuality: "high",
  });
  bitmap.close();
  return small;
}

// ---------- pipeline ----------

async function run() {
  if (running) return;
  running = true;
  await eyeReady;
  // Time from the first photo the model sees, not from the drop, so model loading isn't counted.
  startedAt = performance.now();
  runStartDone = doneCount;
  tick();
  // A few photos in flight at once: one decodes while others run on the GPU,
  // which keeps the GPU busy (about 2.5x the throughput of one at a time on an M-series Mac).
  $("lanes-n").textContent = LANES;
  $("summary").hidden = true;
  perf.rateSamples = [];
  perf.peak = 0;
  await Promise.all(Array.from({ length: LANES }, (_, i) => lane(i)));
  finishedAt = performance.now();
  running = false;
  recompute();
  render();
  updateStats();
  drawCharts();
  renderMeta();
  renderSummary();
}

async function lane(laneIndex) {
  while (queue.length) {
    const item = queue.shift();
    item.lane = laneIndex;
    item.t0 = performance.now();
    try {
      const bitmap = await decode(item.file);
      item.t1 = performance.now();
      try {
        item.analysis = await eye.analyze(bitmap);
      } finally {
        bitmap.close();
      }
      item.t2 = performance.now();
      item.ms = item.t2 - item.t1;
      perf.bytes += item.file.size;
    } catch (err) {
      item.t2 = performance.now();
      item.error = err;
      console.warn(item.file.name, err);
    }
    doneCount++;
    updateTile(item);
    if (doneCount % 20 === 0) recompute();
    scheduleRender();
  }
}

function recompute() {
  const done = items.filter((it) => it.analysis);
  // Only camera photos count as bursts; two receipts from the same shop aren't duplicates to delete.
  const photos = done.filter((it) => isPhoto(it.analysis));
  duplicateGroups = Eye.duplicates(photos.map((it) => it.analysis)).map((g) => g.map((i) => photos[i].index));
  duplicateExtras = new Set(duplicateGroups.flatMap((g) => g.slice(1)));

  const ranked = done
    .filter((it) => isPhoto(it.analysis) && !it.analysis.has("blurry") && !eyesClosed(it.analysis)
      && !duplicateExtras.has(it.index) && it.analysis.scores)
    .sort((a, b) => b.analysis.scores.aesthetic - a.analysis.scores.aesthetic);
  bestShots = new Set(ranked.slice(0, Math.max(6, Math.round(done.length * 0.1))).map((it) => it.index));
  for (const it of done) updateTile(it);
}

// ---------- rendering ----------

function makeTile(item) {
  const el = document.createElement("button");
  el.className = "tile";
  el.innerHTML = `<img loading="lazy" decoding="async" alt="">`;
  el.querySelector("img").src = item.url;
  el.title = item.file.name;
  el.addEventListener("click", () => showDetail(item));
  return el;
}

function updateTile(item) {
  const el = item.tile;
  const a = item.analysis;
  el.classList.toggle("done", !!a || !!item.error);
  el.querySelectorAll(".badge, .flags, .ms").forEach((n) => n.remove());
  if (item.error) {
    el.insertAdjacentHTML("beforeend", `<span class="badge">unreadable</span>`);
    return;
  }
  if (!a) return;
  if (a.kind && a.kind !== "photo") {
    el.insertAdjacentHTML("beforeend", `<span class="badge ${a.kind}">${a.kind.replaceAll("_", " ")}</span>`);
  }
  const flags = [];
  if (isPhoto(a) && a.has("blurry")) flags.push(`<span class="flag">blurry</span>`);
  if (eyesClosed(a)) flags.push(`<span class="flag">eyes closed</span>`);
  if (duplicateExtras.has(item.index)) flags.push(`<span class="flag">duplicate</span>`);
  if (view === "dupes" && duplicateGroups.some((g) => g[0] === item.index)) flags.push(`<span class="flag keep">keep</span>`);
  if (view === "best" && a.scores) flags.push(`<span class="flag score">★ ${Math.round(a.scores.aesthetic * 100)}</span>`);
  if (flags.length) el.insertAdjacentHTML("beforeend", `<span class="flags">${flags.join("")}</span>`);
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function matching(cat) {
  return items.filter((it) => it.analysis && cat.test(it.analysis, it));
}

function renderChips() {
  const nav = $("chips");
  if (!nav.children.length) {
    for (const cat of CATEGORIES) {
      const b = document.createElement("button");
      b.className = "chip";
      b.dataset.id = cat.id;
      b.innerHTML = `<span>${cat.label}</span><span class="n">0</span>`;
      b.addEventListener("click", () => { view = cat.id; items.forEach(updateTile); render(); });
      nav.append(b);
    }
  }
  for (const cat of CATEGORIES) {
    const b = nav.querySelector(`[data-id="${cat.id}"]`);
    const n = cat.id === "all" ? items.length : matching(cat).length;
    const label = b.querySelector(".n");
    if (lastCounts[cat.id] !== n) {
      label.textContent = n;
      if (lastCounts[cat.id] !== undefined && cat.id !== "all") {
        b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump");
      }
      lastCounts[cat.id] = n;
    }
    b.setAttribute("aria-pressed", String(view === cat.id));
    b.classList.toggle("empty", n === 0 && cat.id !== "all");
  }
}

function grid(list) {
  const g = document.createElement("div");
  g.className = "grid";
  g.append(...list.map((it) => it.tile));
  return g;
}

function render() {
  renderChips();
  updateStats();
  const host = $("view");
  const cat = CATEGORIES.find((c) => c.id === view);
  let content;

  if (view === "all") {
    content = grid(items);
  } else if (view === "dupes") {
    content = document.createElement("div");
    content.className = "groups";
    duplicateGroups.forEach((g, i) => {
      const box = document.createElement("div");
      box.className = "group";
      box.innerHTML = `<h3>Burst ${i + 1} · ${g.length} near-identical photos · keeping the best one</h3>`;
      box.append(grid(g.map((idx) => items[idx])));
      content.append(box);
    });
  } else if (view === "best") {
    content = grid(matching(cat).sort((a, b) => b.analysis.scores.aesthetic - a.analysis.scores.aesthetic));
  } else {
    content = grid(matching(cat));
  }

  if (view !== "all" && !content.querySelector(".tile")) {
    content = document.createElement("p");
    content.className = "empty-note";
    content.textContent = running ? "Nothing here yet…" : "Nothing in this folder.";
  }
  host.replaceChildren(content);
}

function updateStats() {
  const end = running || !finishedAt ? performance.now() : finishedAt;
  const elapsed = startedAt ? (end - startedAt) / 1000 : 0;
  $("s-done").textContent = doneCount;
  $("s-total").textContent = `/ ${items.length}`;
  $("s-time").textContent = elapsed.toFixed(1);
  $("s-rate").textContent = elapsed > 0 ? ((doneCount - runStartDone) / elapsed).toFixed(1) : "0";
  const ran = doneCount - runStartDone;
  $("s-ms").textContent = ran ? Math.round((elapsed * 1000) / ran) : 0;
  $("progress").style.width = items.length ? `${(doneCount / items.length) * 100}%` : "0";
}

function tick() {
  updateStats();
  sampleRate();
  drawCharts();
  if (running) requestAnimationFrame(tick);
}

// ---------- performance panel ----------

const RATE_WINDOW = 1000; // photos/s over the last second

function sampleRate() {
  const now = performance.now();
  const recent = items.filter((it) => it.t2 && it.t2 > now - RATE_WINDOW && it.t2 >= startedAt).length;
  // Always divide by the full window: it ramps up from zero instead of spiking when the first batch lands together.
  const rate = (recent * 1000) / RATE_WINDOW;
  perf.rateSamples.push({ t: now - startedAt, rate });
  perf.peak = Math.max(perf.peak, rate);
  $("peak").textContent = `peak ${perf.peak.toFixed(1)}/s`;
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function canvasCtx(id) {
  const c = $(id);
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function drawCharts() {
  const end = running ? performance.now() : finishedAt;
  const total = Math.max(2000, end - startedAt);
  drawRate(total);
  drawLanes(total);
}

function drawRate(total) {
  const { g, w, h } = canvasCtx("c-rate");
  const pts = perf.rateSamples;
  const top = Math.max(4, Math.ceil(perf.peak * 1.25));
  const x = (t) => (t / total) * w;
  const y = (r) => h - 4 - (r / top) * (h - 18);

  g.strokeStyle = css("--line");
  g.fillStyle = css("--muted");
  g.font = '11px "JetBrains Mono", monospace';
  g.lineWidth = 1;
  for (const r of [top / 2, top]) {
    const yy = Math.round(y(r)) + 0.5;
    g.beginPath(); g.moveTo(0, yy); g.lineTo(w, yy); g.stroke();
    g.fillText(`${Math.round(r)}/s`, 4, yy - 4);
  }
  if (pts.length < 2) return;

  const accent = css("--accent-2");
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `${accent}59`); // ~35% alpha; --accent-2 is a 6-digit hex
  grad.addColorStop(1, `${accent}00`);
  g.beginPath();
  g.moveTo(x(pts[0].t), h);
  for (const p of pts) g.lineTo(x(p.t), y(p.rate));
  g.lineTo(x(pts.at(-1).t), h);
  g.closePath();
  g.fillStyle = grad;
  g.fill();

  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.rate)) : g.moveTo(x(p.t), y(p.rate))));
  g.strokeStyle = accent;
  g.lineWidth = 2;
  g.stroke();
}

function drawLanes(total) {
  const { g, w, h } = canvasCtx("c-lanes");
  const rows = LANES;
  const gap = 4;
  const rowH = (h - gap * (rows - 1)) / rows;
  const now = performance.now();
  const x = (t) => ((t - startedAt) / total) * w;

  g.fillStyle = css("--panel-2");
  for (let r = 0; r < rows; r++) g.fillRect(0, r * (rowH + gap), w, rowH);

  const accent = css("--accent");
  for (const it of items) {
    if (it.lane == null || it.t0 < startedAt) continue;
    const yy = it.lane * (rowH + gap);
    const decodeEnd = it.t1 ?? now;
    g.fillStyle = "#3a4152";
    g.fillRect(x(it.t0), yy, Math.max(1, x(decodeEnd) - x(it.t0)), rowH);
    if (it.t1) {
      g.fillStyle = it.error ? css("--bad") : accent;
      g.globalAlpha = it.t2 ? 1 : 0.55;
      g.fillRect(x(it.t1) + 0.5, yy, Math.max(1, x(it.t2 ?? now) - x(it.t1) - 1), rowH);
      g.globalAlpha = 1;
    }
  }
}

function fmtBytes(n) {
  return n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

function renderMeta() {
  const chips = [
    ["Runtime", perf.backend === "webgpu" ? "LiteRT.js · WebGPU" : "LiteRT.js · WebAssembly"],
    perf.gpu && ["GPU", perf.gpu],
    ["Model ready", `${(perf.loadMs / 1000).toFixed(1)} s`],
    ["One photo alone", `${Math.round(perf.singleMs)} ms`],
    ["In flight", `${LANES} photos`],
    ["Analyzed at", `${MAX_SIDE}px`],
    perf.bytes && ["Read", fmtBytes(perf.bytes)],
    ["Uploaded", "0 photos"],
  ].filter(Boolean);
  $("meta").innerHTML = chips.map(([k, v]) => `<span>${k} <b>${escape(v)}</b></span>`).join("");
}

function renderSummary() {
  const ran = items.filter((it) => it.t0 >= startedAt && it.t2);
  if (!ran.length) return;
  const secs = (finishedAt - startedAt) / 1000;
  const rate = ran.length / secs;
  const tenK = 10000 / rate;
  const tenKText = tenK < 90 ? `${Math.round(tenK)} s` : `${Math.round(tenK / 60)} min`;
  $("summary").innerHTML = `
    <h2><b>${ran.length} photos</b> sorted in <b>${secs.toFixed(1)} s</b></h2>
    <div class="facts">
      <div class="fact"><b>${rate.toFixed(1)}</b><span>photos / s</span></div>
      <div class="fact"><b>${Math.round(rate * 60)}</b><span>photos / min</span></div>
      <div class="fact"><b>${tenKText}</b><span>for 10,000 photos</span></div>
      <div class="fact"><b>0</b><span>photos uploaded</span></div>
    </div>`;
  $("summary").hidden = false;
}

addEventListener("resize", () => { if (startedAt) drawCharts(); });

// ---------- detail panel ----------

const pct = (v) => `${Math.round(v * 100)}`;

function showDetail(item) {
  const a = item.analysis;
  $("detail-img").src = item.url;
  const body = $("detail-body");
  if (!a) {
    body.innerHTML = `<h2>${escape(item.file.name)}</h2><p class="empty-note">${item.error ? "Could not read this file." : "Not analyzed yet."}</p>`;
  } else {
    const tags = Object.entries(a.confidences).filter(([, v]) => v >= 0.5).sort((x, y) => y[1] - x[1]).slice(0, 14);
    const meters = tags.map(([k, v]) =>
      `<div class="meter"><span>${k.replaceAll("_", " ")}</span><i><b style="width:${pct(v)}%"></b></i><span>${pct(v)}%</span></div>`).join("");
    const s = a.scores;
    body.innerHTML = `
      <h2>${escape(item.file.name)}</h2>
      <div class="kv">
        <span>Type</span><span>${a.kind ?? "—"}</span>
        <span>Model latency</span><span>${Math.round(item.ms)} ms</span>
        <span>Faces</span><span>${a.faces?.length ?? 0}</span>
        ${s ? `<span>Aesthetic</span><span>${pct(s.aesthetic)} / 100</span>
        <span>Keeper</span><span>${pct(s.keeper)} / 100</span>` : ""}
      </div>
      <h2>Tags</h2>${meters || `<p class="empty-note">No confident tags.</p>`}`;
  }
  $("detail").hidden = false;
}

function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

$("detail-close").addEventListener("click", () => { $("detail").hidden = true; });
addEventListener("keydown", (e) => { if (e.key === "Escape") $("detail").hidden = true; });

// ---------- input ----------

$("pick-folder").addEventListener("change", (e) => addFiles([...e.target.files]));
$("pick-files").addEventListener("change", (e) => addFiles([...e.target.files]));

// Show the overlay while dragover keeps firing; enter/leave counting gets stuck on some drags.
let veilTimer = 0;
function setVeil(on) {
  $("dropveil").hidden = !on;
  $("drop").classList.toggle("over", on);
}
addEventListener("dragover", (e) => {
  e.preventDefault();
  setVeil(true);
  clearTimeout(veilTimer);
  veilTimer = setTimeout(() => setVeil(false), 150);
});
addEventListener("drop", async (e) => {
  e.preventDefault();
  clearTimeout(veilTimer);
  setVeil(false);
  addFiles(await filesFromDrop(e.dataTransfer));
});

// Start downloading the model right away so it's ready before the first drop.
eyeReady = initModel().catch((err) => {
  console.error(err);
  $("load").hidden = false;
  $("load-text").textContent = `Could not load Eye: ${err.message}`;
  $("backend").textContent = "error";
});
