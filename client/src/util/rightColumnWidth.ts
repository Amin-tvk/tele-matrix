// The side panel (right column) can be dragged wider or narrower on wide screens, where it sits beside the chat.
// The width is a per-device preference, so it lives in local storage

const STORAGE_KEY = 'tt-right-column-width';
// Below this window width the panel overlays the chat or fills the screen, and keeps its default width
const SIDE_BY_SIDE_MIN_WINDOW_WIDTH = 1276;
export const MIN_RIGHT_COLUMN_WIDTH = 320;
export const MAX_RIGHT_COLUMN_WIDTH = 640;
const PROPERTY = '--right-column-width';

let savedWidth: number | undefined;

function readSavedWidth() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return value >= MIN_RIGHT_COLUMN_WIDTH && value <= MAX_RIGHT_COLUMN_WIDTH ? value : undefined;
  } catch {
    return undefined;
  }
}

export function clampRightColumnWidth(width: number) {
  const maxForWindow = Math.min(MAX_RIGHT_COLUMN_WIDTH, Math.round(window.innerWidth * 0.45));
  return Math.round(Math.max(MIN_RIGHT_COLUMN_WIDTH, Math.min(width, maxForWindow)));
}

export function applyRightColumnWidth(width = savedWidth) {
  const root = document.documentElement;
  if (width && window.innerWidth >= SIDE_BY_SIDE_MIN_WINDOW_WIDTH) {
    root.style.setProperty(PROPERTY, `${clampRightColumnWidth(width)}px`);
  } else {
    root.style.removeProperty(PROPERTY);
  }
}

export function saveRightColumnWidth(width: number | undefined) {
  savedWidth = width;
  try {
    if (width) localStorage.setItem(STORAGE_KEY, String(width));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The width is kept for this session only
  }
  applyRightColumnWidth();
}

export function canResizeRightColumn() {
  return window.innerWidth >= SIDE_BY_SIDE_MIN_WINDOW_WIDTH;
}

export function initRightColumnWidth() {
  savedWidth = readSavedWidth();
  applyRightColumnWidth();
  window.addEventListener('resize', () => applyRightColumnWidth());
}
