import { PATTERNS } from "./imposition.js";
import { mmToPt, ptToMm } from "./validate.js";

const { PDFDocument, degrees, rgb, StandardFonts, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } =
  window.PDFLib;

// Converts a slot placement (top-left, y-down mm, on the sheet) plus a
// content size and rotation into the anchor point pdf-lib's rotate expects.
// pdf-lib rotates drawn content around (x,y) with the content's own local
// origin (0,0) mapped to (x,y) *before* rotation. For 180°, that means the
// far corner ends up at (x - w, y - h) — so to make a 180°-rotated block
// occupy the same bounding box a 0° block would, anchor at its top-right
// instead of its bottom-left.
function pdfAnchor(destPageHeightMm, topLeftMm, sizeMm, rotated) {
  const bottomLeftPt = {
    x: mmToPt(topLeftMm.x),
    y: mmToPt(destPageHeightMm - (topLeftMm.y + sizeMm.height)),
  };
  if (!rotated) return bottomLeftPt;
  return {
    x: bottomLeftPt.x + mmToPt(sizeMm.width),
    y: bottomLeftPt.y + mmToPt(sizeMm.height),
  };
}

// Trim guide for the whole bound booklet, drawn once on page 1's own
// quadrant (front cover) — the booklet gets cut on all layers at once
// after binding, so only the outermost visible page needs the guide.
// Positioned relative to the *actual rendered content's* edges
// (contentTopLeftMm/contentSizeMm — post alignToFold, i.e. where the page
// really ends up), not the nominal slot: those diverge whenever the
// source page is smaller than the slot, since alignToFold pushes all of
// that slack onto the outer edges. Each line sits in whatever blank
// margin actually exists beyond that edge, capped at 1mm.

// A6-ish: no mark on the left (binding) edge. Right/bottom offsets are
// measured against the sheet's own edge; top is measured against the
// neighboring TR slot's boundary (BR's own fold-facing edge).
function drawCoverCutMarksA6(destPage, sheetMm, trSlot, contentTopLeftMm, contentSizeMm) {
  const maxOffsetMm = 1;

  const contentRight = contentTopLeftMm.x + contentSizeMm.width;
  const contentBottom = contentTopLeftMm.y + contentSizeMm.height;
  const contentTop = contentTopLeftMm.y;
  const contentLeft = contentTopLeftMm.x;

  const rightOffset = Math.max(0, Math.min(maxOffsetMm, sheetMm.width - contentRight));
  const bottomOffset = Math.max(0, Math.min(maxOffsetMm, sheetMm.height - contentBottom));
  const topOffset = Math.max(0, Math.min(maxOffsetMm, contentTop - (trSlot.y + trSlot.height)));

  drawCutLines(destPage, sheetMm, { contentLeft, contentRight, contentTop, contentBottom, rightOffset, bottomOffset, topOffset });
}

// A5-ish: only one fold (the spine), so the cover quadrant (R) has three
// outer-facing edges instead of two — top and bottom are ordinary sheet
// edges here (not shared with a neighboring quadrant the way A6-ish's
// BR/TR are), so their offsets are measured straight against the sheet's
// own top/bottom rather than a neighbor's slot.
function drawCoverCutMarksA5(destPage, sheetMm, contentTopLeftMm, contentSizeMm) {
  const maxOffsetMm = 1;

  const contentRight = contentTopLeftMm.x + contentSizeMm.width;
  const contentBottom = contentTopLeftMm.y + contentSizeMm.height;
  const contentTop = contentTopLeftMm.y;
  const contentLeft = contentTopLeftMm.x;

  const rightOffset = Math.max(0, Math.min(maxOffsetMm, sheetMm.width - contentRight));
  const bottomOffset = Math.max(0, Math.min(maxOffsetMm, sheetMm.height - contentBottom));
  const topOffset = Math.max(0, Math.min(maxOffsetMm, contentTop));

  drawCutLines(destPage, sheetMm, { contentLeft, contentRight, contentTop, contentBottom, rightOffset, bottomOffset, topOffset });
}

function drawCutLines(destPage, sheetMm, { contentLeft, contentRight, contentTop, contentBottom, rightOffset, bottomOffset, topOffset }) {
  const dashPt = mmToPt(0.8);
  const lineOpts = { thickness: 0.5, color: rgb(0.35, 0.35, 0.35), dashArray: [dashPt, dashPt] };
  const toPdfY = (topDownYMm) => mmToPt(sheetMm.height - topDownYMm);

  const rightX = mmToPt(contentRight + rightOffset);
  destPage.drawLine({
    start: { x: rightX, y: toPdfY(contentTop) },
    end: { x: rightX, y: toPdfY(contentBottom) },
    ...lineOpts,
  });

  const bottomY = toPdfY(contentBottom + bottomOffset);
  destPage.drawLine({
    start: { x: mmToPt(contentLeft), y: bottomY },
    end: { x: mmToPt(contentRight), y: bottomY },
    ...lineOpts,
  });

  const topY = toPdfY(contentTop - topOffset);
  destPage.drawLine({
    start: { x: mmToPt(contentLeft), y: topY },
    end: { x: mmToPt(contentRight), y: topY },
    ...lineOpts,
  });
}

// When a page's content is smaller than its slot (a deliberately smaller
// source page, or a downscaled oversized one), it must NOT be centered
// horizontally — that would split the slack evenly across both left and
// right edges, including the one that meets the fold line with the
// neighboring quadrant, throwing off registration across the fold once
// printed and folded. Instead, flush the content against whichever edge
// of the slot is the spine and let all the horizontal slack land on the
// outer, trimmable edge.
//
// Vertically there's no such registration constraint — every quadrant on
// a sheet shares the same slot size and (per the "all pages are the same
// size" assumption) the same content size, so centering divides the
// vertical slack identically for every quadrant; the gaps on either side
// of the horizontal fold still match each other exactly, just with
// whitespace straddling the fold instead of content butting against it.
function alignToFold(patternKey, quadrant, slot, renderedMm) {
  const isLeftCol = patternKey === "a6" ? quadrant === "TL" || quadrant === "BL" : quadrant === "L";
  return {
    x: isLeftCol ? slot.x + slot.width - renderedMm.width : slot.x,
    y: slot.y + (slot.height - renderedMm.height) / 2,
  };
}

// Creep (aka shingling / push-out): each physical sheet wraps around every
// sheet nested inside it, so outer sheets "spend" some of their own width
// wrapping around that extra thickness — leaving inner sheets sticking out
// further at the fore-edge before trimming. A single flush trim then cuts
// more off inner sheets. Compensate by shifting inner-sheet content toward
// the spine, growing with nesting depth: zero on the outermost physical
// sheet (s=1), largest on the innermost (s=S). Applies to both patterns —
// nesting multiple sheets together is what causes creep, not the number
// of folds each sheet gets. creepPerSheetMm is exposed directly as a
// tunable value (mm of shift per sheet of nesting depth) rather than
// derived from paper thickness + a guessed multiplier, since in practice
// this gets calibrated empirically per paper stock anyway — verify with a
// real test print (the proof sheet) before trusting it.
function creepShiftMm(sheetIndexS, creepPerSheetMm) {
  return creepPerSheetMm * (sheetIndexS - 1);
}

function isLeftOfSpine(patternKey, quadrant) {
  return patternKey === "a6" ? quadrant === "TL" || quadrant === "BL" : quadrant === "L";
}

function applyCreep(topLeftMm, isLeftCol, shiftMm) {
  return { ...topLeftMm, x: topLeftMm.x + (isLeftCol ? shiftMm : -shiftMm) };
}

// With bleed, the drawn page is the *full* bleed-inclusive content, but
// only its trim box is registered against the fold — the bleed strip on
// the spine-facing side necessarily overhangs past the fold line into the
// neighboring quadrant's territory (that's just what "flush the trim edge
// to the fold" implies once there's extra content beyond the trim edge).
// Unlike the outer edges (where that overhang is the whole point of
// bleed, hanging safely past the eventual trim cut), the fold is never
// cut — it's a permanent crease — so an unclipped overhang there would be
// a real, permanent printing defect: one page's bleed overlapping the
// next page's live content forever, not something a later trim removes.
// Clip the draw to the fold line on that one edge only; the other three
// edges draw unclipped, all the way out to the physical sheet.
function drawPageClippedToFold(destPage, embedded, drawOpts, sheetMm, isLeftCol, foldXMm) {
  const clipXMm = isLeftCol ? 0 : foldXMm;
  const clipWidthMm = isLeftCol ? foldXMm : sheetMm.width - foldXMm;

  destPage.pushOperators(
    pushGraphicsState(),
    rectangle(mmToPt(clipXMm), 0, mmToPt(clipWidthMm), mmToPt(sheetMm.height)),
    clip(),
    endPath()
  );
  destPage.drawPage(embedded, drawOpts);
  destPage.pushOperators(popGraphicsState());
}

async function embedAllPages(outPdf, srcPdf) {
  // pdf-lib's embedPdf refuses a page with no content stream at all (a
  // genuinely blank page, e.g. a design left empty on purpose) — force one
  // to exist with a zero-opacity no-op draw, harmless on pages that
  // already have real content.
  srcPdf.getPages().forEach((page) => {
    page.drawLine({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, thickness: 0, opacity: 0 });
  });

  const indices = srcPdf.getPages().map((_, i) => i);
  return outPdf.embedPdf(srcPdf, indices);
}

// options: { pattern: 'a6'|'a5', cutMarks, creepPerSheet }
export async function buildImposedPdf(srcBytes, validation, options = {}) {
  const pattern = PATTERNS[options.pattern];
  const srcPdf = await PDFDocument.load(srcBytes);
  const outPdf = await PDFDocument.create();
  const embeddedPages = await embedAllPages(outPdf, srcPdf);

  const sheetMap = pattern.buildSheetMap(validation.pageCount);
  const sheets = [...sheetMap.keys()].sort((a, b) => a - b);
  const trSlotA6 = options.pattern === "a6" ? pattern.slotRect("TR") : null;

  for (const k of sheets) {
    const destPage = outPdf.addPage([mmToPt(pattern.sheetMm.width), mmToPt(pattern.sheetMm.height)]);
    const quadrants = sheetMap.get(k);

    for (const [quadrant, entry] of Object.entries(quadrants)) {
      if (!entry) continue;
      const { pageNumber, rotated } = entry;
      // Overridden (non-multiple-of-modulus) page counts get padded up to
      // the next full signature — any pageNumber beyond the real source
      // PDF has no embedded page and no size info, and is simply left
      // blank.
      const embedded = embeddedPages[pageNumber - 1];
      if (!embedded) continue;
      const pageInfo = validation.pages[pageNumber - 1];
      const slot = pattern.slotRect(quadrant);
      const isLeftCol = isLeftOfSpine(options.pattern, quadrant);

      // Trim box first — this is what's registered against the fold and
      // what the cut marks trace, exactly as before bleed existed.
      const renderedTrimMm = {
        width: pageInfo.trimMm.width * pageInfo.scale,
        height: pageInfo.trimMm.height * pageInfo.scale,
      };
      let topLeftMm = alignToFold(options.pattern, quadrant, slot, renderedTrimMm);
      if (options.creepPerSheet) {
        const sheetIndexS = Math.ceil(k / 2);
        const shift = creepShiftMm(sheetIndexS, options.creepPerSheet);
        topLeftMm = applyCreep(topLeftMm, isLeftCol, shift);
      }

      // The actually-drawn page is the full bleed-inclusive content,
      // surrounding the trim box symmetrically on every edge.
      const bleedRenderedMm = pageInfo.bleedMm * pageInfo.scale;
      const fullTopLeftMm = { x: topLeftMm.x - bleedRenderedMm, y: topLeftMm.y - bleedRenderedMm };
      const fullRenderedMm = {
        width: renderedTrimMm.width + 2 * bleedRenderedMm,
        height: renderedTrimMm.height + 2 * bleedRenderedMm,
      };
      const anchor = pdfAnchor(pattern.sheetMm.height, fullTopLeftMm, fullRenderedMm, rotated);
      const drawOpts = {
        x: anchor.x,
        y: anchor.y,
        xScale: pageInfo.scale,
        yScale: pageInfo.scale,
        rotate: degrees(rotated ? 180 : 0),
      };

      if (pageInfo.bleedMm > 0) {
        const foldXMm = isLeftCol ? slot.x + slot.width : slot.x;
        drawPageClippedToFold(destPage, embedded, drawOpts, pattern.sheetMm, isLeftCol, foldXMm);
      } else {
        destPage.drawPage(embedded, drawOpts);
      }

      if (options.cutMarks && pageNumber === 1 && quadrant === pattern.coverQuadrant) {
        if (options.pattern === "a6") {
          drawCoverCutMarksA6(destPage, pattern.sheetMm, trSlotA6, topLeftMm, renderedTrimMm);
        } else {
          drawCoverCutMarksA5(destPage, pattern.sheetMm, topLeftMm, renderedTrimMm);
        }
      }
    }
  }

  return outPdf.save();
}

export async function buildProofSheetPdf(totalPages, patternKey) {
  const pattern = PATTERNS[patternKey];
  const outPdf = await PDFDocument.create();
  const font = await outPdf.embedFont(StandardFonts.HelveticaBold);

  const sheetMap = pattern.buildSheetMap(totalPages);
  const sheets = [...sheetMap.keys()].sort((a, b) => a - b);

  for (const k of sheets) {
    const destPage = outPdf.addPage([mmToPt(pattern.sheetMm.width), mmToPt(pattern.sheetMm.height)]);
    const quadrants = sheetMap.get(k);

    for (const [quadrant, entry] of Object.entries(quadrants)) {
      if (!entry) continue;
      const { pageNumber, rotated } = entry;
      const slot = pattern.slotRect(quadrant);
      const anchor = pdfAnchor(pattern.sheetMm.height, slot, pattern.slotMm, rotated);

      destPage.drawRectangle({
        x: anchor.x,
        y: anchor.y,
        width: mmToPt(pattern.slotMm.width),
        height: mmToPt(pattern.slotMm.height),
        rotate: degrees(rotated ? 180 : 0),
        borderColor: rgb(0.7, 0.7, 0.7),
        borderWidth: 1,
      });

      // Both labels below are positioned in the slot's own *local* frame —
      // i.e. where they'd sit on an unrotated page — and passed through the
      // same pdfAnchor(..., rotated) used for real content. Rotation alone
      // (not a manual per-case offset) is what flips them to the correct
      // spot on the flat sheet, exactly as it would for real page content.
      const label = `${pageNumber}`;
      const labelSize = 28;
      const labelWidthMm = ptToMm(font.widthOfTextAtSize(label, labelSize));
      const labelHeightMm = ptToMm(labelSize);
      const labelTopLeftMm = {
        x: slot.x + (pattern.slotMm.width - labelWidthMm) / 2,
        y: slot.y + (pattern.slotMm.height - labelHeightMm) / 2,
      };
      const labelAnchor = pdfAnchor(
        pattern.sheetMm.height,
        labelTopLeftMm,
        { width: labelWidthMm, height: labelHeightMm },
        rotated
      );

      destPage.drawText(label, {
        x: labelAnchor.x,
        y: labelAnchor.y,
        size: labelSize,
        font,
        color: rgb(0, 0, 0),
        rotate: degrees(rotated ? 180 : 0),
      });

      // "TOP" marker sits near the slot's *local* top edge (where a real
      // page's top would be); rotation flips it to the slot's physical
      // bottom on the flat sheet for rotated slots, same as real content.
      const topLabel = "^ TOP ^";
      const topLabelSize = 9;
      const topLabelWidthMm = ptToMm(font.widthOfTextAtSize(topLabel, topLabelSize));
      const topLabelHeightMm = ptToMm(topLabelSize);
      const topLabelTopLeftMm = {
        x: slot.x + (pattern.slotMm.width - topLabelWidthMm) / 2,
        y: slot.y + 6,
      };
      const topLabelAnchor = pdfAnchor(
        pattern.sheetMm.height,
        topLabelTopLeftMm,
        { width: topLabelWidthMm, height: topLabelHeightMm },
        rotated
      );

      destPage.drawText(topLabel, {
        x: topLabelAnchor.x,
        y: topLabelAnchor.y,
        size: topLabelSize,
        font,
        color: rgb(0.4, 0.4, 0.4),
        rotate: degrees(rotated ? 180 : 0),
      });
    }

    destPage.drawText(`Sheet ${k}${k % 2 === 1 ? " (front)" : " (back)"}`, {
      x: mmToPt(4),
      y: mmToPt(4),
      size: 8,
      font,
      color: rgb(0.6, 0.6, 0.6),
    });
  }

  return outPdf.save();
}
