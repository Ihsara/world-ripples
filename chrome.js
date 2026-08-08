// The ONE list of overlay ids hidden for a clean canvas-only image.
//
// This list is consumed by BOTH tools/capture.mjs (--chrome=none) and the
// in-app PNG export. Do not fork it. Two elements have already ridden into
// committed captures because the list was maintained by hand: #tierbar
// (caught in review) and #mode-rail (caught 2026-08-08, already live in the
// helsinki loops -- app.js unhides the rail only for a city with baked Life
// data, so helsinki was the ONLY city that showed it and nine clean loops
// made the tenth look fine).
//
// tests/test_capture_chrome_hidden.py reads this array out of THIS file and
// asserts it covers every visible top-level overlay in the real HTML.
export const CHROME_OVERLAY_IDS = [
  "chrome", "district-panel", "status", "stepper", "intro", "tierbar",
  "mode-rail",
];

// Takes `doc` rather than reaching for a global `document` so this runs
// unchanged inside page.evaluate(), in the app, and under node:test.
export function hideChrome(doc) {
  const hidden = [];
  for (const id of CHROME_OVERLAY_IDS) {
    const el = doc.getElementById(id);
    if (el) { el.style.display = "none"; hidden.push(id); }
  }
  return hidden;
}
