// sunstate.js — the throttle + cache between the pure solar math and the
// renderer. The field draws continuously; solar position changes far too
// slowly to justify per-frame trigonometry, so it is recomputed at most once
// per SIMULATED minute and the resulting colour is cached.
import { solarElevation, SEASONS } from "./solar.js?v=4564b7c5c6";
import { groundColorFor, DEFAULT_RGB } from "./sunlight.js?v=4564b7c5c6";

export function makeSunState({ lat, lon, utcOffsetHours, seasonKey }) {
  const season = SEASONS.find((s) => s.key === seasonKey) || SEASONS[0];
  let lastMinute = null;
  let cached = DEFAULT_RGB.slice();
  return {
    recomputes: 0,
    seasonKey: season.key,
    baseFor(civilSecondsSinceMidnight, enabled) {
      // A copy, not the module-level DEFAULT_RGB by reference: field.js
      // aliases the same export as its own fallback, so handing back the
      // singleton would let a future mutating caller corrupt both -- the
      // same shared-mutable-state invariant groundColorFor's own test
      // protects (sunlight.test.mjs).
      if (!enabled) return DEFAULT_RGB.slice();
      const minute = Math.floor(civilSecondsSinceMidnight / 60);
      if (minute !== lastMinute) {
        lastMinute = minute;
        this.recomputes++;
        const elev = solarElevation({
          lat, lon, utcOffsetHours,
          dayOfYear: season.dayOfYear,
          civilSecondsSinceMidnight: minute * 60,
        });
        cached = groundColorFor(elev);
      }
      return cached;
    },
  };
}

// Deeplink: the DEFAULT state emits nothing, so ordinary URLs stay clean and
// every previously-shared link keeps meaning exactly what it meant.
export function parseSunLink(params) {
  const season = params.get("season");
  return {
    sunEnabled: params.get("sun") !== "off",
    sunSeason: SEASONS.some((s) => s.key === season) ? season : "mar",
  };
}

export function sunLinkParams({ sunEnabled, sunSeason }) {
  const out = {};
  if (!sunEnabled) out.sun = "off";
  if (sunSeason && sunSeason !== "mar") out.season = sunSeason;
  return out;
}
