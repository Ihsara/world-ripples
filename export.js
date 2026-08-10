import { hideChrome } from "./chrome.js?v=f288c2c188";

function slugify(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
          .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// The clock LABEL is not a clock. `#clock` shows formatClock() -> "HH:MM" in
// ripple mode, but in Life mode it shows "Life…", "Seed · 08:15", or a bare
// "gen 3" (lifeWallClock with no timetable meta), and before the first frame it
// is the literal "–" from index.html. Feeding those straight through produced
// two live bugs: `--start=Seed · 08:15` throws in tools/captureargs.mjs (which
// validates against exactly the regex below), and exportFilename stripped
// "Life…" to "", so every Life export in a session overwrote one file.
//
// So normalize at the boundary: pull out an embedded HH:MM if the label has
// one, else fall back to a clock derived from real state (the caller passes
// formatClock(state.t)). The result is guaranteed to satisfy the real parser.
const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CLOCK_LAST_RESORT = "00:00";

function extractClock(label) {
  if (typeof label !== "string") return null;
  const m = label.match(/(?:[01]\d|2[0-3]):[0-5]\d/);
  return m ? m[0] : null;
}

export function normalizeClock(label, fallback) {
  const found = extractClock(label);
  if (found) return found;
  // The fallback comes from the app and should already be HH:MM, but a bad one
  // would just re-introduce the bug one layer down, so it is checked too.
  if (typeof fallback === "string" && HHMM_RE.test(fallback)) return fallback;
  return CLOCK_LAST_RESORT;
}

// Derived, not fixed, so exporting several places in one session does not
// silently overwrite the user's own earlier files.
export function exportFilename({ slug, place, clock, fallbackClock }) {
  const parts = [slug];
  if (place) parts.push(slugify(place));
  parts.push(normalizeClock(clock, fallbackClock).replace(/[^0-9]/g, ""));
  return `${parts.join("-")}.png`;
}

// `draw` MUST run immediately before the readback, in the same frame.
// A webgl2 canvas read after the buffer is cleared yields an all-black PNG
// and throws nothing -- see the plan note on this task.
export function capturePng(canvas, doc, draw) {
  hideChrome(doc);
  draw();
  return new Promise((resolve, reject) => {
    // DELIBERATE: only #map (the WebGL canvas) is read back. The separate 2D
    // #overlay carrying the selected place's white ring and hover pre-glow is
    // UI chrome, and an exported poster crop should not carry it.
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error("export produced no image")); return; }
      resolve(blob);
    }, "image/png");
  });
}

// The bbox is the one argument a user cannot reconstruct by eye, so the UI
// hands the whole command over filled in. docs/CAPTURE.md still documents the
// flags; this just saves the transcription.
//
// Flags verified against tools/captureargs.mjs on 2026-08-08:
//   --start, NOT --clock (captureargs.mjs:105)
//   --fit=data REQUIRES --bbox for every city but tokyo (captureargs.mjs:114)
//   --mode is deliberately OMITTED: capture.mjs never reads options.mode, so
//   emitting it would imply an effect it does not have (captureargs.mjs:15-22)
export function captureCommand({ slug, bbox, start }) {
  return [
    "node tools/capture.mjs",
    `--city=${slug}`,
    `--fit=data`,
    `--bbox=${bbox.join(",")}`,
    `--start=${start}`,
  ].join(" ");
}
