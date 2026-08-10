// sunlight.js — solar elevation -> ground colour. PURE: no DOM, no GL, no wall clock, no RNG.
//
// Astronomy lives in solar.js and is pinned to the almanac; it must never move
// for aesthetic reasons. THIS file is the tunable half.
//
// dataviz-design: the register is the dark luminous canvas (#101420 is named
// for glow subjects) and colour's job here is DATA, so VALUE carries the
// quantity -- a night->day lightness ramp with a small warm lift near the
// horizon, never a hue cycle. The ripples are the marks; they stay brightest.

export const NIGHT_RGB   = [0.039, 0.051, 0.086]; // #0a0d16
export const DAY_RGB     = [0.110, 0.133, 0.200]; // #1c2233
export const DEFAULT_RGB = [0.063, 0.078, 0.125]; // #101420 -- today's literal

// Civil twilight (-6deg) is full night; +10deg is full day.
const NIGHT_ELEV = -6;
const DAY_ELEV = 10;
// The warm lift peaks at the horizon and is gone by full day. Small on purpose:
// it should read as dawn, not as an orange filter.
const WARM_PEAK = [0.030, 0.014, -0.006];
const WARM_HALF_WIDTH = 6;

const smoothstep = (t) => t * t * (3 - 2 * t);

export function groundColorFor(elevationDeg) {
  if (elevationDeg <= NIGHT_ELEV) return NIGHT_RGB.slice();
  if (elevationDeg >= DAY_ELEV) return DAY_RGB.slice();
  const t = smoothstep((elevationDeg - NIGHT_ELEV) / (DAY_ELEV - NIGHT_ELEV));
  // Triangular warm weight centred on the horizon (0deg).
  const warm = Math.max(0, 1 - Math.abs(elevationDeg) / WARM_HALF_WIDTH);
  return [0, 1, 2].map((i) => {
    const v = NIGHT_RGB[i] + (DAY_RGB[i] - NIGHT_RGB[i]) * t + WARM_PEAK[i] * warm;
    return Math.max(0, Math.min(1, v));
  });
}
