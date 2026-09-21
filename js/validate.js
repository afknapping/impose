const PT_PER_MM = 72 / 25.4;
const SIZE_TOLERANCE_SCALE = 0.999; // ignore sub-mm float noise as "exact"

export function ptToMm(pt) {
  return pt / PT_PER_MM;
}

export function mmToPt(mm) {
  return mm * PT_PER_MM;
}

// pdfDoc: a pdf-lib PDFDocument. target: {width, height} in mm — the
// pattern's fixed slot size (see imposition.js PATTERNS), not a
// user-chosen output size: the actual output size is the source PDF's own
// page size (assuming, for now, that every page is the same size), scaled
// down only if it's bigger than the slot. pageModulus: how many pages one
// full signature needs for the chosen pattern (8 for A6-ish's two folds,
// 4 for A5-ish's one). bleedMm: per-edge bleed to assume the source page
// already includes (0 = none, page size is trim size as-is) — the actual
// *trim* size (actualMm minus 2×bleedMm per dimension) is what's compared
// against the slot and positioned/scaled, not the raw bleed-inclusive page.
// Always computes page sizing info and a paddedPageCount (next multiple
// of pageModulus) regardless of whether pageCount itself is already a
// clean multiple — the caller (main.js) uses paddedPageCount to offer an
// explicit "print anyway" override for odd page counts instead of a hard
// reject, since not every use case needs a clean saddle-stitch signature.
// Returns { ok, pageCount, paddedPageCount, target, pages, warnings, error? }
// where pages[i] = { index, actualMm: {width,height}, trimMm: {width,height},
// bleedMm, scale } — actualMm is the raw source page size, trimMm is
// actualMm shrunk by bleedMm per edge (equal to actualMm when bleedMm is 0).
export function validate(pdfDoc, target, pageModulus, bleedMm = 0) {
  const pageCount = pdfDoc.getPageCount();
  const paddedPageCount =
    pageCount % pageModulus === 0 ? pageCount : Math.ceil(pageCount / pageModulus) * pageModulus;

  const pages = [];

  pdfDoc.getPages().forEach((page, index) => {
    const { width, height } = page.getSize();
    const actualMm = { width: ptToMm(width), height: ptToMm(height) };
    const trimMm = { width: actualMm.width - 2 * bleedMm, height: actualMm.height - 2 * bleedMm };
    const scale = Math.min(1, target.width / trimMm.width, target.height / trimMm.height);
    pages.push({ index, actualMm, trimMm, bleedMm, scale });
  });

  const warnings = summarizeOversizedPages(pages, target);

  if (pageCount % pageModulus !== 0) {
    return {
      ok: false,
      pageCount,
      paddedPageCount,
      target,
      pages,
      warnings,
      error: `This PDF has ${pageCount} page${
        pageCount === 1 ? "" : "s"
      }. This format needs a multiple of ${pageModulus} pages.`,
    };
  }

  return { ok: true, pageCount, paddedPageCount: pageCount, target, pages, warnings };
}

// Collapses one-warning-per-page into one line per distinct (size, scale)
// combination, e.g. "Pages 1–16 are ... Scaled down to fit (×0.453)."
// instead of the same line repeated 16 times.
function summarizeOversizedPages(pages, target) {
  const groups = new Map();

  pages.forEach((p) => {
    if (p.scale >= SIZE_TOLERANCE_SCALE) return;
    const key = `${p.trimMm.width.toFixed(1)}x${p.trimMm.height.toFixed(1)}@${p.scale.toFixed(3)}`;
    if (!groups.has(key)) groups.set(key, { trimMm: p.trimMm, scale: p.scale, indices: [] });
    groups.get(key).indices.push(p.index);
  });

  return [...groups.values()].map(({ trimMm, scale, indices }) => {
    const isSingle = indices.length === 1;
    const label = isSingle ? "Page" : "Pages";
    const verb = isSingle ? "is" : "are";
    return `${label} ${formatPageRanges(indices)} ${verb} ${trimMm.width.toFixed(1)}×${trimMm.height.toFixed(
      1
    )}mm (trim) — larger than the ${target.width}×${target.height}mm target. Scaled down to fit (×${scale.toFixed(
      3
    )}).`;
  });
}

// 0-based indices -> "1, 2, 5–8, 10" (1-indexed, contiguous runs collapsed).
function formatPageRanges(indices) {
  const nums = [...indices].map((i) => i + 1).sort((a, b) => a - b);
  const ranges = [];
  let start = nums[0];
  let prev = nums[0];

  for (let k = 1; k < nums.length; k++) {
    const n = nums[k];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  ranges.push(start === prev ? `${start}` : `${start}–${prev}`);

  return ranges.join(", ");
}
