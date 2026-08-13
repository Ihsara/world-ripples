// Pure mode-visibility logic for the ripple view's transport filter.
//
// Lives outside app.js deliberately: app.js has NO test harness, so any logic
// placed there is covered only by the live browser gate. Everything decidable
// without a GPU belongs here, where node --test can reach it.

// Index = mode code, matching every city's manifest.mode_codes and the
// MODE_COLORS table in app.js. Pinned here rather than read from the manifest
// so a malformed feed cannot rename a mode out from under the legend.
export const MODE_NAMES = ["metro", "train", "tram", "bus", "ferry"];

/**
 * Mode codes that actually occur in this city's stops, sorted ascending.
 *
 * 🚨 manifest.mode_codes is a fixed 5-slot table in EVERY city, so it says
 * nothing about what a city runs. Measured 2026-08-13: porto has only
 * metro+bus, madrid no train or ferry, paris no ferry. Building a fixed
 * five-button row would ship dead toggles in three of five cities.
 *
 * Codes outside MODE_NAMES are dropped: a toggle for one would index
 * MODE_COLORS out of bounds and paint `undefined`.
 */
export function presentModes(stopMode) {
  const seen = new Set();
  for (let i = 0; i < stopMode.length; i++) {
    const m = stopMode[i];
    if (m >= 0 && m < MODE_NAMES.length) seen.add(m);
  }
  return [...seen].sort((a, b) => a - b);
}

/** A fresh all-visible set. One byte per mode; index is the mode code. */
export function newVisibility() {
  return new Uint8Array(MODE_NAMES.length).fill(1);
}

export function isVisible(vis, mode) {
  return vis[mode] === 1;
}

export function setVisible(vis, mode, on) {
  vis[mode] = on ? 1 : 0;
}

/** Names of currently-hidden modes, for the setColourMode error message. */
export function hiddenModeNames(vis) {
  const out = [];
  for (let m = 0; m < MODE_NAMES.length; m++) {
    if (vis[m] !== 1) out.push(MODE_NAMES[m]);
  }
  return out;
}
