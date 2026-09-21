import { validate } from "./validate.js";
import { buildImposedPdf, buildProofSheetPdf } from "./pdfBuilder.js";
import { PATTERNS } from "./imposition.js";

const { PDFDocument } = window.PDFLib;

const settingCutMarks = document.getElementById("setting-cutmarks");
const settingCreep = document.getElementById("setting-creep");
const settingBleed = document.getElementById("setting-bleed");
const formatSelect = document.getElementById("format-select");

const BLEED_MM = 3;

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileNameEl = document.getElementById("file-name");
const makeBtn = document.getElementById("make-btn");
const messagesEl = document.getElementById("messages");
const downloadsEl = document.getElementById("downloads");
const downloadRealEl = document.getElementById("download-real");
const downloadProofEl = document.getElementById("download-proof");
const printDirectBtn = document.getElementById("print-direct-btn");
const printDirectEdgeEl = document.getElementById("print-direct-edge");

let selectedBytes = null;
let selectedFileName = "";
let currentValidation = null;
let lastRejectedValidation = null;
let imposedPdfBytes = null;

// Hidden-iframe technique so "Print Directly" triggers the browser's
// native print dialog on the imposed print-sheets PDF, without a
// download step in between.
let printFrame = null;
let printObjectUrl = null;

function printPdfBytes(bytes) {
  if (printObjectUrl) URL.revokeObjectURL(printObjectUrl);
  printObjectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  if (!printFrame) {
    printFrame = document.createElement("iframe");
    printFrame.style.display = "none";
    document.body.appendChild(printFrame);
  }
  printFrame.onload = () => {
    printFrame.contentWindow.focus();
    printFrame.contentWindow.print();
  };
  printFrame.src = printObjectUrl;
}

printDirectBtn.addEventListener("click", () => {
  if (imposedPdfBytes) printPdfBytes(imposedPdfBytes);
});

function currentPattern() {
  return PATTERNS[formatSelect.value] ?? PATTERNS.a6;
}

function updateDuplexNote() {
  printDirectEdgeEl.textContent = `${currentPattern().duplexEdge} edge`;
}
updateDuplexNote();

function clearMessages() {
  messagesEl.innerHTML = "";
}

function showMessage(kind, html) {
  const div = document.createElement("div");
  div.className = `msg msg-${kind}`;
  div.innerHTML = html;
  messagesEl.appendChild(div);
}

// Resets the message area back to just what validation currently says —
// used both after validating a fresh drop and to clear a stale build-error
// message left over from a previous failed attempt before retrying.
function renderValidationWarnings() {
  clearMessages();
  if (currentValidation?.warnings.length > 0) {
    showMessage(
      "warning",
      `<strong>Heads up:</strong><ul>${currentValidation.warnings.map((w) => `<li>${w}</li>`).join("")}</ul>`
    );
  }
}

function resetDownloads() {
  downloadsEl.hidden = true;
  if (downloadRealEl.href) URL.revokeObjectURL(downloadRealEl.href);
  if (downloadProofEl.href) URL.revokeObjectURL(downloadProofEl.href);
  downloadRealEl.removeAttribute("href");
  downloadProofEl.removeAttribute("href");
  imposedPdfBytes = null;
}

// Runs immediately on drop/select (and whenever the target format changes
// while a file is loaded) — checks the PDF and shows/hides the button
// right away, rather than waiting for a build attempt to discover problems.
async function runValidation() {
  clearMessages();
  resetDownloads();
  currentValidation = null;
  lastRejectedValidation = null;
  makeBtn.hidden = true;

  if (!selectedBytes) return;

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(selectedBytes);
  } catch (err) {
    showMessage("error", "Couldn't read that file — it may not be a valid PDF, or it's password-protected.");
    return;
  }

  const pattern = currentPattern();
  const bleedMm = settingBleed.checked ? BLEED_MM : 0;
  const validation = validate(pdfDoc, pattern.slotMm, pattern.pageModulus, bleedMm);

  if (!validation.ok) {
    lastRejectedValidation = validation;
    showMessage("error", validation.error);
    showOverrideControl(validation);
    return;
  }

  currentValidation = validation;
  renderValidationWarnings();
  makeBtn.hidden = false;
}

// Odd page counts are still rejected by default, but every count can be
// padded up to the next full signature with blank trailing pages — offered
// as an explicit opt-in rather than silently padding automatically, since
// some users do care about a clean booklet and shouldn't get pages added
// without asking.
function showOverrideControl(validation) {
  const blanksNeeded = validation.paddedPageCount - validation.pageCount;
  const div = document.createElement("div");
  div.className = "msg msg-warning";

  const text = document.createElement("p");
  text.className = "override-text";
  text.textContent = `Just want it printed? Pad with ${blanksNeeded} blank page${
    blanksNeeded === 1 ? "" : "s"
  } to make a ${validation.paddedPageCount}-page booklet and continue.`;
  div.appendChild(text);

  const btn = document.createElement("button");
  btn.className = "override-btn";
  btn.textContent = `Print anyway (pad to ${validation.paddedPageCount} pages)`;
  btn.addEventListener("click", () => applyOverride(validation));
  div.appendChild(btn);

  messagesEl.appendChild(div);
}

function applyOverride(validation) {
  const paddedPages = [...validation.pages];
  for (let i = validation.pageCount; i < validation.paddedPageCount; i++) {
    // Blank filler pages have no real bleed to trim — trim size is just
    // the target itself.
    paddedPages.push({ index: i, actualMm: { ...validation.target }, trimMm: { ...validation.target }, bleedMm: 0, scale: 1 });
  }

  currentValidation = {
    ok: true,
    pageCount: validation.paddedPageCount,
    target: validation.target,
    pages: paddedPages,
    warnings: validation.warnings,
  };
  lastRejectedValidation = null;

  renderValidationWarnings();
  showMessage(
    "warning",
    `Padded from ${validation.pageCount} to ${validation.paddedPageCount} pages — ${
      validation.paddedPageCount - validation.pageCount
    } blank page(s) added at the end.`
  );
  makeBtn.hidden = false;
}

async function handleFile(file) {
  selectedFileName = file.name;
  fileNameEl.textContent = file.name;
  selectedBytes = new Uint8Array(await file.arrayBuffer());
  await runValidation();
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) handleFile(file);
});

["dragenter", "dragover"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

formatSelect.addEventListener("change", () => {
  updateDuplexNote();
  if (selectedBytes) runValidation();
});

settingBleed.addEventListener("change", () => {
  if (selectedBytes) runValidation();
});

function setButtonWorking(working) {
  makeBtn.disabled = working;
  makeBtn.innerHTML = working ? '<span class="spinner"></span> Working…' : "Make Print Sheets";
}

async function offerDownloads(sourceBytes, validation, baseName) {
  const patternKey = formatSelect.value;
  const [imposedBytes, proofBytes] = await Promise.all([
    buildImposedPdf(sourceBytes, validation, {
      pattern: patternKey,
      cutMarks: settingCutMarks.checked,
      creepPerSheet: parseFloat(settingCreep.value) || 0,
    }),
    buildProofSheetPdf(validation.pageCount, patternKey),
  ]);

  downloadRealEl.href = URL.createObjectURL(new Blob([imposedBytes], { type: "application/pdf" }));
  downloadRealEl.download = `${baseName}-print-sheets.pdf`;
  downloadProofEl.href = URL.createObjectURL(new Blob([proofBytes], { type: "application/pdf" }));
  downloadProofEl.download = `${baseName}-proof-sheet.pdf`;
  imposedPdfBytes = imposedBytes;
  downloadsEl.hidden = false;
}

makeBtn.addEventListener("click", async () => {
  if (!selectedBytes || !currentValidation) return;

  resetDownloads();
  renderValidationWarnings();
  setButtonWorking(true);

  try {
    await offerDownloads(selectedBytes, currentValidation, selectedFileName.replace(/\.pdf$/i, ""));
  } catch (err) {
    console.error("Impose: build failed", err);
    showMessage("error", `Something went wrong while generating the print sheets: ${err.message || err}`);
  } finally {
    setButtonWorking(false);
  }
});

// --- Document setup calculator (trim / safe area / bleed) ----------------
// Purely a design-time reference tool for setting up the source document
// before export — independent of the imposition pipeline above. Impose
// doesn't apply bleed/clipping itself yet; this just does the arithmetic
// so you know what size to make things in Keynote (or wherever).

const PT_PER_MM_CALC = 72 / 25.4;
const BLEED_MARGIN_MM = 3;
const SAFE_MARGIN_MM = 3;

// width/height in mm — presets are trim (finished) sizes.
const BLEED_PRESETS = {
  a4: { width: 210, height: 297 },
  a5: { width: 148, height: 210 },
  "a5-backpocket": { width: 130, height: 190 },
  a6: { width: 105, height: 148 },
  a7: { width: 74, height: 105 },
  "half-a5": { width: 65, height: 90 },
  pocket: { width: 3.5 * 25.4, height: 5.5 * 25.4 }, // Field Notes, 3.5x5.5in
};

const bleedPresetSelect = document.getElementById("bleed-preset");
const bleedTrimWidthInput = document.getElementById("bleed-trim-width");
const bleedTrimHeightInput = document.getElementById("bleed-trim-height");
const bleedOutSafeEl = document.getElementById("bleed-out-safe");
const bleedOutFullMmEl = document.getElementById("bleed-out-full-mm");
const bleedOutFullPtEl = document.getElementById("bleed-out-full-pt");
const bleedCopyPtBtn = document.getElementById("bleed-copy-pt-btn");
const bleedCopySafeBtn = document.getElementById("bleed-copy-safe-btn");

let bleedFullPtW = 0;
let bleedFullPtH = 0;
let bleedSafeW = 0;
let bleedSafeH = 0;

function updateBleedCalc() {
  const trimW = parseFloat(bleedTrimWidthInput.value) || 0;
  const trimH = parseFloat(bleedTrimHeightInput.value) || 0;

  bleedSafeW = trimW - 2 * SAFE_MARGIN_MM;
  bleedSafeH = trimH - 2 * SAFE_MARGIN_MM;
  const fullW = trimW + 2 * BLEED_MARGIN_MM;
  const fullH = trimH + 2 * BLEED_MARGIN_MM;

  bleedFullPtW = fullW * PT_PER_MM_CALC;
  bleedFullPtH = fullH * PT_PER_MM_CALC;

  bleedOutSafeEl.textContent = `${bleedSafeW.toFixed(1)} × ${bleedSafeH.toFixed(1)} mm`;
  bleedOutFullMmEl.textContent = `${fullW.toFixed(1)} × ${fullH.toFixed(1)} mm`;
  bleedOutFullPtEl.textContent = `${bleedFullPtW.toFixed(2)} × ${bleedFullPtH.toFixed(2)}pt`;
}

// Copies just the two numbers, space-separated, no units — ready to paste
// into two separate width/height fields elsewhere.
function wireCopyButton(btn, getValues) {
  btn.addEventListener("click", async () => {
    try {
      const [a, b] = getValues();
      await navigator.clipboard.writeText(`${a} ${b}`);
      btn.textContent = "Copied!";
    } catch (err) {
      console.error("Impose: clipboard write failed", err);
      btn.textContent = "Copy failed";
    } finally {
      setTimeout(() => {
        btn.textContent = "Copy";
      }, 1200);
    }
  });
}

wireCopyButton(bleedCopyPtBtn, () => [bleedFullPtW.toFixed(2), bleedFullPtH.toFixed(2)]);
wireCopyButton(bleedCopySafeBtn, () => [
  (bleedSafeW / 10).toFixed(1).replace(".", ","),
  (bleedSafeH / 10).toFixed(1).replace(".", ","),
]);

bleedPresetSelect.addEventListener("change", () => {
  const preset = BLEED_PRESETS[bleedPresetSelect.value];
  if (preset) {
    bleedTrimWidthInput.value = preset.width.toFixed(1);
    bleedTrimHeightInput.value = preset.height.toFixed(1);
  }
  updateBleedCalc();
});

// Editing trim size directly switches the preset back to "Custom" — it no
// longer matches any preset's own numbers once hand-edited.
[bleedTrimWidthInput, bleedTrimHeightInput].forEach((el) => {
  el.addEventListener("input", () => {
    bleedPresetSelect.value = "custom";
    updateBleedCalc();
  });
});

updateBleedCalc();
