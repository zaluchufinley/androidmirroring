// Window geometry for a phone-shaped window. Pure functions (no Electron), ported from the sizing code in
// Sources/main.swift. Coordinates are screen coordinates with y growing downwards (Windows/Electron).

export const BASE_SHORT_SIDE = 340;
export const DEFAULT_VIDEO = { width: 1080, height: 2400 };

/** height / width of the phone screen */
export const aspectOf = (size) => size.height / size.width;

export const minWidthFor = (aspect) => (aspect >= 1 ? 300 : 300 / aspect);

/** Largest width at which the whole phone still fits on screen (so there are never black bars or clipping). */
export const maxWidthFor = (aspect, workArea) =>
  Math.floor(Math.min(workArea.width - 16, (workArea.height - 16) / aspect));

/** Width that gives the "actual size" the phone opens at: 340 px on the short side. */
export const baseWidthFor = (aspect) => (aspect >= 1 ? BASE_SHORT_SIDE : BASE_SHORT_SIDE / aspect);

export const easeOutQuart = (p) => 1 - (1 - p) ** 4;

/**
 * The frame for a window `width` wide (clamped), keeping the phone's aspect ratio and the top-left corner, and keeping
 * the window on screen.
 */
export function frameForWidth(current, width, aspect, workArea) {
  const w = Math.round(Math.max(minWidthFor(aspect), Math.min(maxWidthFor(aspect, workArea), width)));
  const h = Math.round(w * aspect);
  let { x, y } = current;
  const bottom = workArea.y + workArea.height;
  const right = workArea.x + workArea.width;
  if (y + h > bottom) y = bottom - h;
  if (y < workArea.y) y = workArea.y;
  if (x + w > right) x = right - w;
  if (x < workArea.x) x = workArea.x;
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

/** A frame part-way (0..1) from `from` to `to`; the height always follows the width so the ratio holds every frame. */
export function interpolateFrame(from, to, p, aspect) {
  if (p >= 1) return { ...to };
  const e = easeOutQuart(p);
  const width = Math.round(from.width + (to.width - from.width) * e);
  return {
    x: Math.round(from.x + (to.x - from.x) * e),
    y: Math.round(from.y + (to.y - from.y) * e),
    width,
    height: Math.round(width * aspect),
  };
}

/** What a finished swipe means for the notification panel: true = opened, false = closed, null = no change. */
export function panelAfterSwipe(from, to) {
  if (from < 0.06 && to - from > 0.12) return true;  // a pull down from the top edge opens the panel
  if (from - to > 0.12) return false;                // a push up closes it
  return null;
}
