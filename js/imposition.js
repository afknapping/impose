export const A4_MM = { width: 210, height: 297 };
export const A4_LANDSCAPE_MM = { width: 297, height: 210 };
export const A6_SLOT_MM = { width: 105, height: 148 };
export const A5_SLOT_MM = { width: 148.5, height: 210 };

// --- A6-ish: two folds (nested signature, 4-up) ------------------------

// Nested-signature saddle-stitch math, re-derived from the physical fold
// structure (the version ported from zinemaker's js/Imposition.js only
// happened to work for totalPages=8 — one physical sheet — and silently
// produced duplicate/missing page numbers for 16/24/32, e.g. for N=16 page
// 10 was assigned twice while page 11 was assigned to nothing at all).
//
// Physical model: N/2 leaves, 1-indexed from the outside (leaf 1 carries
// page 1 + page N, leaf 2 carries page 2 + page N-1, etc. — the defining
// property of nesting). Each physical A4 sheet, once both folds are made,
// holds 4 consecutive leaves; sheet s (1 = outermost) holds leaves
// [4s-3 .. 4s]. Within one sheet, the front face shows the outermost and
// innermost leaf of that group of 4 (accordion-folded together), the back
// shows the middle two — confirmed by matching this formula's s=1 output
// against the already-verified totalPages=8 case (identical result).
export function locatePageA6(pageNumber, totalPages) {
  const sheets = totalPages / 4; // printed sides; sheets/2 = physical A4 sheets

  for (let k = 1; k <= sheets; k++) {
    let TL, TR, BL, BR;
    if (k % 2 === 1) {
      const s = (k + 1) / 2; // physical sheet index, 1 = outermost
      TL = totalPages + 1 - 4 * s;
      TR = 4 * s;
      BL = totalPages - 4 * s + 4;
      BR = 4 * s - 3;
    } else {
      const s = k / 2;
      TL = 4 * s - 1;
      TR = totalPages - 4 * s + 2;
      BL = 4 * s - 2;
      BR = totalPages - 4 * s + 3;
    }

    const quadrants = { TL, TR, BL, BR };
    for (const [quadrant, num] of Object.entries(quadrants)) {
      if (num === pageNumber) {
        const rotated = quadrant === "TL" || quadrant === "TR";
        return { sheet: k, quadrant, rotated };
      }
    }
  }

  return null;
}

// Top-left origin, y-down mm space. Two A6 columns exactly fill the A4
// width (210mm); two A6 rows fall 1mm short of the A4 height (296 vs
// 297mm) due to ISO A-series rounding, split as a 0.5mm margin top/bottom.
// This is the fixed *slot* grid the fold lines define — actual content
// (read from the source PDF, which may be smaller) is flush-aligned
// against the fold edges within it by the caller, not centered here.
export function slotRectA6(quadrant) {
  const marginV = (A4_MM.height - 2 * A6_SLOT_MM.height) / 2;
  const slots = {
    TL: { x: 0, y: marginV },
    TR: { x: A6_SLOT_MM.width, y: marginV },
    BL: { x: 0, y: marginV + A6_SLOT_MM.height },
    BR: { x: A6_SLOT_MM.width, y: marginV + A6_SLOT_MM.height },
  };
  const { x, y } = slots[quadrant];
  return { x, y, width: A6_SLOT_MM.width, height: A6_SLOT_MM.height };
}

// Map<sheetIndex, {TL,TR,BL,BR: {pageNumber, rotated} | undefined}>
export function buildSheetMapA6(totalPages) {
  const sheets = totalPages / 4;
  const map = new Map();
  for (let k = 1; k <= sheets; k++) map.set(k, {});

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const loc = locatePageA6(pageNumber, totalPages);
    map.get(loc.sheet)[loc.quadrant] = { pageNumber, rotated: loc.rotated };
  }

  return map;
}

// --- A5-ish: one fold (simple booklet, 2-up) ----------------------------

// A single vertical fold down the spine, like an ordinary book spread —
// no nesting-into-non-adjacent-leaves complexity, and critically no
// second fold, so (unlike A6-ish) there's no closed edge that later needs
// trimming open. Printed side k (front/back of physical sheet
// ceil(k/2)), 1 = outermost: LEFT/RIGHT page numbers derived directly
// from the classic "N story-and-a-half" booklet formula. No rotation is
// ever needed — a single fold axis means every page keeps the same
// orientation throughout, unlike A6-ish's horizontal fold requiring the
// top row to be pre-rotated 180°.
export function locatePageA5(pageNumber, totalPages) {
  const printedSides = totalPages / 2;

  for (let k = 1; k <= printedSides; k++) {
    const s = Math.ceil(k / 2); // physical sheet index, 1 = outermost
    let LEFT, RIGHT;
    if (k % 2 === 1) {
      LEFT = totalPages - 2 * s + 2;
      RIGHT = 2 * s - 1;
    } else {
      LEFT = 2 * s;
      RIGHT = totalPages - 2 * s + 1;
    }

    const quadrants = { L: LEFT, R: RIGHT };
    for (const [quadrant, num] of Object.entries(quadrants)) {
      if (num === pageNumber) {
        return { sheet: k, quadrant, rotated: false };
      }
    }
  }

  return null;
}

// Top-left origin, y-down mm space, on an A4 sheet used *landscape*
// (297×210mm) — the two A5-ish columns exactly fill it, 148.5mm each,
// with the single fold running down the vertical centerline. No rounding
// slop to distribute (unlike A6-ish): 2×148.5 is exactly 297.
export function slotRectA5(quadrant) {
  const slots = {
    L: { x: 0, y: 0 },
    R: { x: A5_SLOT_MM.width, y: 0 },
  };
  const { x, y } = slots[quadrant];
  return { x, y, width: A5_SLOT_MM.width, height: A5_SLOT_MM.height };
}

// Map<sheetIndex, {L,R: {pageNumber, rotated} | undefined}>
export function buildSheetMapA5(totalPages) {
  const sheets = totalPages / 2;
  const map = new Map();
  for (let k = 1; k <= sheets; k++) map.set(k, {});

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const loc = locatePageA5(pageNumber, totalPages);
    map.get(loc.sheet)[loc.quadrant] = { pageNumber, rotated: loc.rotated };
  }

  return map;
}

// --- Pattern registry ----------------------------------------------------

// Everything format-specific in one place: the grid math, the fixed slot
// size that source pages are compared against and flush-aligned within,
// physical sheet size/orientation, how many pages a signature needs, and
// which quadrant holds the front cover (for cut marks). duplexEdge is the
// printer setting that keeps both sides right-side-up: portrait sheets
// (A6-ish) need long-edge duplex, like an ordinary book; landscape sheets
// (A5-ish) need short-edge, like a landscape document or a desk calendar
// — the wrong one leaves the back side upside-down relative to the front.
export const PATTERNS = {
  a6: {
    label: "A6-ish (2 folds)",
    slotMm: A6_SLOT_MM,
    sheetMm: A4_MM,
    pageModulus: 8,
    coverQuadrant: "BR",
    duplexEdge: "long",
    buildSheetMap: buildSheetMapA6,
    slotRect: slotRectA6,
  },
  a5: {
    label: "A5-ish (1 fold)",
    slotMm: A5_SLOT_MM,
    sheetMm: A4_LANDSCAPE_MM,
    pageModulus: 4,
    coverQuadrant: "R",
    duplexEdge: "short",
    buildSheetMap: buildSheetMapA5,
    slotRect: slotRectA5,
  },
};
