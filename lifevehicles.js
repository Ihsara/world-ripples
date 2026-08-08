// web/lifevehicles.js — pure logic for Life mode's vehicle dots.
// No WebGL, no DOM, no closure state — unit-testable in Node, exactly like
// lifeview.js. The drawing itself lives in app.js because it needs the
// closure-scoped field/camera/data.

import { lifeSplit } from "./app.js?v=edd3cdbe99";

/**
 * Sim-seconds for a fractional Life position.
 *
 * WHY FRACTIONAL MATTERS: the street field snaps to whole generations, but
 * `state.lifePos` is a float. Feeding the FRACTIONAL time to vehiclePosition
 * is what makes dots glide continuously between generations instead of
 * teleporting once per stride. Truncating to whole generations here would
 * still "work" -- dots would appear in the right places -- while silently
 * destroying the smoothness this feature exists to deliver.
 *
 * Returns null when the stream's meta lacks the clock fields, matching
 * lifeWallClock's guard: better no dots than dots at a fabricated time.
 */
export function lifeSimSec(lifePos, nFrames, meta) {
  if (!meta || typeof meta.t0_sec !== "number" || typeof meta.stride_sec !== "number") {
    return null;
  }
  const { gen, frac } = lifeSplit(lifePos, nFrames);
  return meta.t0_sec + (gen + frac) * meta.stride_sec;
}

// Rarity is loudness. Indexed by mode code (0 metro, 1 train, 2 tram, 3 bus,
// 4 ferry), matching manifest.mode_codes and MODE_COLORS.
//
// Measured justification (Helsinki, the Life window): bus is 80-84% of live
// vehicles at every clock, while metro grows 90 -> 198 across the window and
// IS the story of 03:00-05:00. Drawing every mode at one size reproduces, in
// dot form, exactly the bus flood the street field was criticized for.
//
// Ferry shares bus's row because MODE_COLORS already gives them the identical
// hex -- the palette settled this before the encoding did.
export const VEHICLE_STYLE = Object.freeze([
  Object.freeze({ size: 7.0, alpha: 0.95 }), // 0 metro
  Object.freeze({ size: 6.5, alpha: 0.90 }), // 1 train
  Object.freeze({ size: 4.5, alpha: 0.70 }), // 2 tram
  Object.freeze({ size: 2.5, alpha: 0.40 }), // 3 bus
  Object.freeze({ size: 2.5, alpha: 0.40 }), // 4 ferry -- shares bus
]);

const BUS_SLOT = 3;

/**
 * Style for a mode code. An unknown or out-of-range code falls back to BUS,
 * never to slot 0 -- a zero/garbage code must not be promoted to metro, the
 * loudest style. Same failure class as argmax-over-an-all-zero-column in the
 * bake, which silently painted unattributed cells metro.
 */
export function vehicleStyleFor(mode) {
  const m = Number.isInteger(mode) ? mode : BUS_SLOT;
  return (m >= 0 && m < VEHICLE_STYLE.length) ? VEHICLE_STYLE[m] : VEHICLE_STYLE[BUS_SLOT];
}
