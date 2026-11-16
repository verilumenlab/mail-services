/** A field as the viewer shows it: page rotation applied, 0..1 from the top-left of the visible page. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The visible area of an unrotated PDF page (its crop box) plus the page rotation. */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/** Where to draw on the PDF page: bottom-left anchor in PDF user space, size, and counter-clockwise rotation. */
export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate: number;
}

export const MIN_FIELD_SIZE = 0.01;

export function normalizeRotation(deg: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** Size of the page as displayed (width/height swap for 90 and 270). */
export function displaySize(box: PageBox): { width: number; height: number } {
  const r = normalizeRotation(box.rotation);
  return r % 180 === 0 ? { width: box.width, height: box.height } : { width: box.height, height: box.width };
}

/** Keeps a rectangle inside the page and above the minimum size. */
export function clampRect(rect: NormalizedRect): NormalizedRect {
  const width = Math.min(1, Math.max(MIN_FIELD_SIZE, rect.width));
  const height = Math.min(1, Math.max(MIN_FIELD_SIZE, rect.height));
  return {
    x: Math.min(1 - width, Math.max(0, rect.x)),
    y: Math.min(1 - height, Math.max(0, rect.y)),
    width,
    height,
  };
}

/** Maps a point measured from the top-left of the displayed page (in points) to PDF user space. */
export function displayPointToPdf(box: PageBox, dx: number, dy: number): { x: number; y: number } {
  const r = normalizeRotation(box.rotation);
  switch (r) {
    case 0:
      return { x: box.x + dx, y: box.y + box.height - dy };
    case 90:
      return { x: box.x + dy, y: box.y + dx };
    case 180:
      return { x: box.x + box.width - dx, y: box.y + dy };
    case 270:
      return { x: box.x + box.width - dy, y: box.y + box.height - dx };
  }
}

/**
 * Converts a field rectangle into a pdf-lib draw placement. The content is rotated with the page so
 * it reads upright in any viewer, and it covers exactly the rectangle the sender placed.
 */
export function placementFor(box: PageBox, rect: NormalizedRect): Placement {
  const shown = displaySize(box);
  const width = rect.width * shown.width;
  const height = rect.height * shown.height;
  const left = rect.x * shown.width;
  const bottom = (rect.y + rect.height) * shown.height;
  const anchor = displayPointToPdf(box, left, bottom);
  return { x: anchor.x, y: anchor.y, width, height, rotate: normalizeRotation(box.rotation) };
}

/** Largest size with the image's aspect ratio that fits the box, centred inside it. */
export function fitContain(boxW: number, boxH: number, imgW: number, imgH: number): { width: number; height: number; offsetX: number; offsetY: number } {
  if (imgW <= 0 || imgH <= 0) return { width: boxW, height: boxH, offsetX: 0, offsetY: 0 };
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  return { width, height, offsetX: (boxW - width) / 2, offsetY: (boxH - height) / 2 };
}
