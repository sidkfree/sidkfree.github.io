// DocScan Pro — Web app. 100% browser-side: camera → JPEG → PDF (jsPDF) → OCR (Tesseract).
// Storage: IndexedDB.

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

// ─── Tiny IndexedDB wrapper ──────────────────────────────────────────────
const DB_NAME = "docscan_pro_web";
const STORE = "documents";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        s.createIndex("updatedAt", "updatedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAdd(doc) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const r = tx.objectStore(STORE).add(doc);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result.sort((a, b) => b.updatedAt - a.updatedAt));
    r.onerror = () => reject(r.error);
  });
}
async function dbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function dbUpdate(doc) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readwrite").objectStore(STORE).put(doc);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// ─── App state ──────────────────────────────────────────────────────────
const state = {
  view: "library",
  capturedPages: [], // {dataUrl, w, h}
  ocrText: "",
  folder: "",
  currentDocId: null,
  stream: null,
};

// ─── Toast ───────────────────────────────────────────────────────────────
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");
  setTimeout(() => { t.hidden = true; }, 2400);
}

// ─── View routing ────────────────────────────────────────────────────────
function showView(name) {
  state.view = name;
  document.body.dataset.view = name;
  $$(".view").forEach(v => v.hidden = v.dataset.viewId !== name);
  if (name === "library") refreshLibrary();
  if (name === "scan") startCamera();
  else stopCamera();
  if (name === "settings") loadSettings();
}

$$("[data-back]").forEach(b => b.addEventListener("click", () => showView(b.dataset.back)));
$("#btn-scan").addEventListener("click", () => {
  state.capturedPages = [];
  state.ocrText = "";
  state.folder = "";
  showView("scan");
});
$("#btn-settings").addEventListener("click", () => showView("settings"));

// ─── Library ─────────────────────────────────────────────────────────────
async function refreshLibrary(filter = "") {
  const docs = await dbAll();
  const grid = $("#doc-grid");
  const empty = $("#empty-state");
  grid.innerHTML = "";
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? docs.filter(d => (d.title.toLowerCase().includes(f) || (d.ocrText || "").toLowerCase().includes(f)))
    : docs;
  if (filtered.length === 0) {
    empty.classList.add("show");
    return;
  }
  empty.classList.remove("show");
  for (const d of filtered) {
    const row = document.createElement("div");
    row.className = "doc-row";
    row.innerHTML = `
      <div class="doc-thumb"></div>
      <div class="doc-meta">
        <h3></h3>
        <p class="sub"></p>
        <div class="tags"></div>
      </div>
    `;
    row.querySelector("h3").textContent = d.title;
    row.querySelector(".sub").textContent =
      `${d.pages.length} page${d.pages.length > 1 ? "s" : ""} · ${formatDate(d.updatedAt)}`;
    const tags = row.querySelector(".tags");
    if (d.folder) {
      const t = document.createElement("span");
      t.className = "folder-tag";
      t.textContent = d.folder;
      tags.appendChild(t);
    }
    if (d.locked) {
      const lb = document.createElement("span");
      lb.className = "lock-badge";
      lb.textContent = "Protected";
      tags.appendChild(lb);
    }
    row.addEventListener("click", () => openDetail(d.id));
    grid.appendChild(row);
  }
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

$("#search-input").addEventListener("input", e => refreshLibrary(e.target.value));

// ─── Camera scan ─────────────────────────────────────────────────────────
async function startCamera() {
  try {
    if (state.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    $("#cam-preview").srcObject = stream;
    state.stream = stream;
    $("#cam-hint").textContent = "Point your camera at the document";
  } catch (err) {
    $("#cam-hint").textContent = "Camera unavailable — use 'Pick image' below";
  }
}
function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
    $("#cam-preview").srcObject = null;
  }
}

$("#btn-capture").addEventListener("click", () => {
  const v = $("#cam-preview");
  if (!v.videoWidth) {
    toast("Camera not ready yet");
    return;
  }
  const c = $("#cam-canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  const dataUrl = c.toDataURL("image/jpeg", 0.9);
  addCapturedPage(dataUrl, c.width, c.height);
});

$("#btn-add-from-file").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", async e => {
  for (const file of e.target.files) {
    const dataUrl = await fileToDataUrl(file);
    const dim = await imageDims(dataUrl);
    addCapturedPage(dataUrl, dim.w, dim.h);
  }
  e.target.value = "";
});

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function imageDims(dataUrl) {
  return new Promise(resolve => {
    const i = new Image();
    i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight });
    i.src = dataUrl;
  });
}

function addCapturedPage(dataUrl, w, h) {
  state.capturedPages.push({ dataUrl, w, h });
  const strip = $("#captured-strip");
  strip.hidden = false;
  $("#strip-label").textContent =
    `${state.capturedPages.length} page${state.capturedPages.length > 1 ? "s" : ""} captured`;
  const row = $("#strip-row");
  row.innerHTML = "";
  state.capturedPages.forEach(p => {
    const img = document.createElement("img");
    img.src = p.dataUrl;
    img.alt = "page";
    row.appendChild(img);
  });
  $("#btn-finish-scan").disabled = state.capturedPages.length === 0;
}

$("#btn-finish-scan").addEventListener("click", () => {
  state.ocrText = "";
  $("#editor-summary").textContent =
    `${state.capturedPages.length} page${state.capturedPages.length > 1 ? "s" : ""} captured`;
  $("#editor-title").value = "Doc " + new Date().toLocaleString();
  $("#folder-value").textContent = "No folder";
  $("#ocr-preview").textContent = "No text yet — run OCR to extract text from this document.";
  showView("editor");
});

// ─── Editor ──────────────────────────────────────────────────────────────
$("#folder-row").addEventListener("click", () => {
  const f = prompt("Folder name (leave empty for none):", state.folder);
  if (f === null) return;
  state.folder = f.trim();
  $("#folder-value").textContent = state.folder || "No folder";
});

$("#btn-run-ocr").addEventListener("click", async () => {
  if (state.capturedPages.length === 0) {
    toast("No pages to OCR");
    return;
  }
  if (typeof Tesseract === "undefined") {
    toast("OCR engine still loading — try again in a moment");
    return;
  }
  $("#btn-run-ocr").disabled = true;
  $("#ocr-preview").textContent = "Reading text on-device…";
  let combined = "";
  try {
    for (let i = 0; i < state.capturedPages.length; i++) {
      const p = state.capturedPages[i];
      const { data } = await Tesseract.recognize(p.dataUrl, "eng+fra");
      if (data.text.trim()) {
        combined += `--- Page ${i + 1} ---\n${data.text.trim()}\n\n`;
      }
    }
    state.ocrText = combined.trim();
    $("#ocr-preview").textContent = state.ocrText || "No text detected.";
  } catch (err) {
    $("#ocr-preview").textContent = "OCR failed: " + err.message;
  } finally {
    $("#btn-run-ocr").disabled = false;
  }
});

function buildPdfBytes() {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "px", format: "a4", compress: true });
  state.capturedPages.forEach((p, i) => {
    if (i > 0) pdf.addPage("a4");
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const ratio = Math.min(pageW / p.w, pageH / p.h);
    const w = p.w * ratio;
    const h = p.h * ratio;
    pdf.addImage(p.dataUrl, "JPEG", (pageW - w) / 2, (pageH - h) / 2, w, h);
  });
  return pdf.output("blob");
}

async function buildPdfFromDoc(doc) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "px", format: "a4", compress: true });
  doc.pages.forEach((p, i) => {
    if (i > 0) pdf.addPage("a4");
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const ratio = Math.min(pageW / p.w, pageH / p.h);
    const w = p.w * ratio;
    const h = p.h * ratio;
    pdf.addImage(p.dataUrl, "JPEG", (pageW - w) / 2, (pageH - h) / 2, w, h);
  });
  return pdf.output("blob");
}

$("#btn-save").addEventListener("click", async () => {
  if (state.capturedPages.length === 0) return;
  const title = $("#editor-title").value.trim() || "Document";
  const now = Date.now();
  await dbAdd({
    title,
    pages: state.capturedPages,
    pageCount: state.capturedPages.length,
    ocrText: state.ocrText,
    folder: state.folder,
    locked: false,
    createdAt: now,
    updatedAt: now,
  });
  toast("Document saved");
  state.capturedPages = [];
  state.ocrText = "";
  state.folder = "";
  showView("library");
});

$("#btn-share-editor").addEventListener("click", async () => {
  if (state.capturedPages.length === 0) {
    toast("Capture at least one page first");
    return;
  }
  const title = $("#editor-title").value.trim() || "Document";
  await sharePdfOrText(buildPdfBytes(), state.ocrText, title);
});

async function sharePdfOrText(pdfBlob, text, title) {
  const choice = await pickShare(text);
  if (!choice) return;
  if (choice === "pdf") {
    const file = new File([pdfBlob], `${slug(title)}.pdf`, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
    // Fallback: download
    triggerDownload(file);
  } else if (choice === "text") {
    if (!text) {
      toast("No text to share — run OCR first");
      return;
    }
    if (navigator.share) {
      try {
        await navigator.share({ title, text });
        return;
      } catch (e) {}
    }
    // Fallback: clipboard
    try {
      await navigator.clipboard.writeText(text);
      toast("Text copied to clipboard");
    } catch (e) {
      toast("Could not share text");
    }
  }
}
function pickShare(textAvailable) {
  return new Promise(resolve => {
    const choice = confirm(
      `Share which?\n\n[OK] = PDF file\n[Cancel] = Extracted text${textAvailable ? "" : " (no OCR text yet — run OCR first)"}`
    );
    resolve(choice ? "pdf" : "text");
  });
}
function slug(s) { return s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "document"; }
function triggerDownload(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── Detail ──────────────────────────────────────────────────────────────
async function openDetail(id) {
  const d = await dbGet(id);
  if (!d) return;
  state.currentDocId = id;
  $("#detail-title").textContent = d.title;
  $("#detail-meta").textContent =
    `${d.pages.length} page${d.pages.length > 1 ? "s" : ""} · Updated ${formatDate(d.updatedAt)}`;
  $("#detail-folder").textContent = d.folder || "—";
  $("#detail-ocr").textContent = d.ocrText || "No extracted text yet — open in editor to run OCR.";
  $("#row-lock-label").textContent = d.locked ? "Remove password" : "Protect with password";
  showView("detail");
}

$("#btn-open-pdf").addEventListener("click", async () => {
  const d = await dbGet(state.currentDocId);
  if (!d) return;
  const blob = await buildPdfFromDoc(d);
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$("#row-share").addEventListener("click", async () => {
  const d = await dbGet(state.currentDocId);
  if (!d) return;
  const blob = await buildPdfFromDoc(d);
  await sharePdfOrText(blob, d.ocrText, d.title);
});

$("#row-lock").addEventListener("click", async () => {
  const d = await dbGet(state.currentDocId);
  if (!d) return;
  d.locked = !d.locked;
  d.updatedAt = Date.now();
  await dbUpdate(d);
  $("#row-lock-label").textContent = d.locked ? "Remove password" : "Protect with password";
  toast(d.locked ? "Marked as protected" : "Protection removed");
});

$("#row-delete").addEventListener("click", async () => {
  if (!confirm("Delete this document? This cannot be undone.")) return;
  await dbDelete(state.currentDocId);
  toast("Deleted");
  showView("library");
});

// ─── Settings ────────────────────────────────────────────────────────────
const PREFS = {
  get(k, fallback) { return localStorage.getItem("docscan_" + k) || fallback; },
  set(k, v) { localStorage.setItem("docscan_" + k, v); },
};

function loadSettings() {
  $("#theme-value").textContent = PREFS.get("theme", "Pure black");
  $("#quality-value").textContent = PREFS.get("quality", "High");
  $("#format-value").textContent = PREFS.get("format", "PDF");
}
$("#row-theme").addEventListener("click", () => {
  const opts = ["Pure black", "Dim grey"];
  const cur = PREFS.get("theme", "Pure black");
  const next = opts[(opts.indexOf(cur) + 1) % opts.length];
  PREFS.set("theme", next);
  document.documentElement.style.setProperty("--bg", next === "Dim grey" ? "#0A0A0A" : "#000");
  loadSettings();
});
$("#row-quality").addEventListener("click", () => {
  const opts = ["High", "Medium", "Low"];
  const cur = PREFS.get("quality", "High");
  const next = opts[(opts.indexOf(cur) + 1) % opts.length];
  PREFS.set("quality", next);
  loadSettings();
});
$("#row-format").addEventListener("click", () => {
  const opts = ["PDF", "JPG"];
  const cur = PREFS.get("format", "PDF");
  const next = opts[(opts.indexOf(cur) + 1) % opts.length];
  PREFS.set("format", next);
  loadSettings();
});

// ─── Initial load ────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Apply saved theme
  if (PREFS.get("theme") === "Dim grey") {
    document.documentElement.style.setProperty("--bg", "#0A0A0A");
  }
  refreshLibrary();
});

// Stop camera if user navigates away
window.addEventListener("pagehide", stopCamera);
