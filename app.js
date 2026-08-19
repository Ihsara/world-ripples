// app.js — the ripples app: boot, region-wide rAF loop, DOM chrome.
//
// Orchestration only: pure logic (projection, band brightness, stamp
// windowing, the WebGL field) lives in field.js; vehicle interpolation in
// vehicles.js; binary loading in data.js. This module wires those to the DOM
// and drives one requestAnimationFrame loop that plays the region-wide
// ripple field on sim-time.
//
// Model (Task 9): each frame the field is CLEARED then every in-flight
// event's edges are RE-STAMPED with that event's current age; the band
// shader (field.js STAMP_FS) recomputes crest/wake brightness per-edge from
// (delay, age) every frame — there's no accumulate/decay step. Moving
// vehicle dots are interpolated in JS at playback (Option A) and impact dots
// flash at a stop the instant its event fires.

import { loadAll, makeCityCache } from "./data.js?v=81c2d071e8";
import { activeDayPart, gateDayParts, markerPosition } from "./dayparts.js?v=81c2d071e8";
import { loadLife } from "./life.js?v=81c2d071e8";
import { cellAlpha, precomputeDeaths, precomputeLastMode } from "./lifeview.js?v=81c2d071e8";
import { makeProjection, eventsInWindow, RippleField, realAge, clampSkip,
         rippleLifeHorizon, nextEventInView, whisperText,
         normalizeStampIntensity } from "./field.js?v=81c2d071e8";
import { vehiclePosition } from "./vehicles.js?v=81c2d071e8";
import { activeLegs, pulseGeometry, pulseHeadPoint, PULSE_BUDGET,
         PULSE_TAIL } from "./edgepulse.js?v=81c2d071e8";
import { deriveCorridorWeights, buildCorridorGeometry, corridorWidth,
         corridorBrightness, edgeModeCounts, overlapColour, MODE_RANK,
         COLOUR_MODES } from "./corridors.js?v=81c2d071e8";
import { lifeSimSec, vehicleStyleFor } from "./lifevehicles.js?v=81c2d071e8";
import { createCamera, cameraProjection, panBy, zoomAboutPoint, resizeCamera,
         startFlyTo, stepFlyTo, visibleBbox, viewWidthKm, projectInto,
         inflateBbox, fitBboxScale } from "./camera.js?v=81c2d071e8";
import { createPlacePanel } from "./panel.js?v=81c2d071e8";
import { SEASONS } from "./solar.js?v=81c2d071e8";
import { makeSunState, parseSunLink } from "./sunstate.js?v=81c2d071e8";
import { modeColorFor, NIGHT_MODE_RGB, daylightBlendFor, groundLightness } from "./sunlight.js?v=81c2d071e8";
import { desertAvailable, desertLabel, drawDeserts, rankSubareas,
         unpackDesertBits } from "./deserts.js?v=81c2d071e8";
import { findById, flattenTree } from "./places.js?v=81c2d071e8";
import { loadCities, resolveSlug } from "./cities.js?v=81c2d071e8";
import { exportFilename, capturePng, captureCommand, normalizeClock } from "./export.js?v=81c2d071e8";
import { CHROME_OVERLAY_IDS } from "./chrome.js?v=81c2d071e8";
import { pickView } from "./viewswitch.js?v=81c2d071e8";
import { MODE_NAMES, newVisibility, isVisible, setVisible, hiddenModeNames,
         presentModes } from "./modefilter.js?v=81c2d071e8";

// ---- AOI bboxes (lon/lat), mirrored from src/region.py EXACTLY -----------
// Helsinki-specific subareas (fly-to chips + the guided intro's zoomed-in
// snapshot). These are NOT the camera's initial framing anymore — Task 15b:
// the camera and the guided intro's fallback both come from the ACTIVE
// CITY's region_bbox (cities.json), so a non-Helsinki city (e.g. Amsterdam,
// which has no subareas) still gets a correctly-framed camera instead of
// inheriting Helsinki's bbox and rendering a blank canvas. AOIS.region is
// kept only as the last-resort fallback for the no-registry/no-cities.json
// boot path (see cameraBboxFor below) — it is EXACTLY Helsinki's
// region_bbox, so that fallback leaves Helsinki's framing unchanged.
const AOIS = {
  region:     [24.40, 60.05, 25.35, 60.45],
  Helsinki:   [24.78, 60.13, 25.06, 60.24],
  Espoo:      [24.50, 60.13, 24.83, 60.34],
  Vantaa:     [24.80, 60.24, 25.15, 60.35],
  Kauniainen: [24.71, 60.20, 24.76, 60.23],
};
const REGION_ONLY_CITY_CODE = 0xffff; // stop has no per-city street buffer

// Mode slots are fixed; their colours adapt to the current solar elevation.
const MODE_COLORS = NIGHT_MODE_RGB;

// Phase B: the bundle root holds cities.json plus one directory per city
// slug, so the per-city data dir is DERIVED from the active slug rather than
// being a single fixed path.
//
// PRIVATE TIERS: the private page (index-private.html) serves the same app off
// the 600 s / 900 s bundles by setting `window.__wrDataRoot` in a CLASSIC
// script BEFORE this module loads.
//
// Why a pre-set global and not an exported setter: initApp() runs at IMPORT
// time (see the boot guard at the foot of this file), so anything importing
// app.js and then calling a setter is already too late — the registry fetch has
// begun against ./data. Reading the value here, at module-eval, is the only
// ordering that cannot race.
//
// Deliberately read ONCE and never reassigned: a live mid-session change would
// leave half a city's .bin files fetched from one horizon and half from
// another. Switching tiers is a page navigation, which reuses boot()'s existing
// fetch-then-teardown path rather than inventing a second one.
const DATA_ROOT =
  (typeof window !== "undefined" && typeof window.__wrDataRoot === "string" && window.__wrDataRoot)
    ? window.__wrDataRoot
    : "./data";
const dataDirFor = (slug) => `${DATA_ROOT}/${slug}`;
const SPAWN_BUDGET = 200; // max stamped events per frame, even at 300x
// PULSE_BRIGHTNESS — additive light added by a travelling head.
//
// TUNED AGAINST THE LIVE FRAME, not guessed. The first value (0.12) was ~5x the
// static corridor's 0.025 + 0.025*log2(w) ramp, and at Helsinki morning rush the
// pulses stopped reading as heads and became thick ribbons that outshone the
// ripple blooms — exactly the "corridors must not drown the subject" risk the
// design note flagged. The ripple is the subject; a pulse is the thing that
// DELIVERS a ripple, so it must sit just above the silhouette and below a bloom.
const PULSE_BRIGHTNESS = 0.05;

// The speed ladder. Stepping (not 4 chips) keeps the bar to one row and scales
// if a speed is ever added. Clamps rather than wraps: wrapping from 300x back
// to 1x is a surprise, not a convenience.
export const SPEEDS = [1, 30, 60, 300];

export function stepSpeed(current, dir) {
  const i = SPEEDS.indexOf(current);
  if (i === -1) {
    // Unknown speed: snap to the nearest rung in the direction of travel.
    const next = dir > 0 ? SPEEDS.find((s) => s > current) : [...SPEEDS].reverse().find((s) => s < current);
    return next ?? (dir > 0 ? SPEEDS[SPEEDS.length - 1] : SPEEDS[0]);
  }
  return SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + dir))];
}

// Build a region-only fallback root when places.json is missing or malformed.
// Must include a `ring` array because ringPath() iterates ring.length unguarded
// (line 478); a ring-less node throws when the root row is clicked/hovered. The
// fallback's shape must match the real baked root: ['id','name','bbox','ring','children'].
export function regionOnlyRoot(slug, regionBbox, displayName) {
  return { id: `region:${slug}`, name: displayName, bbox: regionBbox, ring: [], children: [] };
}

// Load one city's place tree. A missing/broken places.json must NOT break the
// app: fall back to a region-only root so navigation still works.
async function loadPlaces(slug, regionBbox, displayName) {
  try {
    const resp = await fetch(`${dataDirFor(slug)}/places.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    return payload.root;
  } catch (err) {
    console.warn(`places.json unavailable for ${slug}; region-only`, err);
    return regionOnlyRoot(slug, regionBbox, displayName);
  }
}

// Deep-link contract (world-ripples): ?city=<slug>&area=<AOI>&t=HH:MM&speed=1|30|60|300.
// NOTE the Phase B split: `?city=` now selects the CITY BUNDLE; the sub-area
// moved to `?area=`. There is deliberately NO aliasing — an unknown ?city=
// falls back to the landing default (spec §3.2). Invalid values are ignored,
// leaving normal boot unchanged.
export function parseDeepLink(search, aoiNames) {
  const q = new URLSearchParams(search);

  const areaParam = q.get("area");
  const area = areaParam
    ? aoiNames.find((n) => n.toLowerCase() === areaParam.toLowerCase()) || null
    : null;

  // ?place=<node id>. Ids contain a colon ("osm:404538"), which is legal
  // unencoded in a query value. Raw pass-through; the caller resolves it
  // against the loaded tree and ignores an unknown id.
  const placeRaw = q.get("place");
  const place = placeRaw && placeRaw.trim() ? placeRaw.trim() : null;

  const tRaw = q.get("t") || "";
  const m = /^(\d{2}):(\d{2})$/.exec(tRaw);
  const timeHHMM = m && Number(m[1]) < 24 && Number(m[2]) < 60 ? tRaw : null;

  const speedParam = Number(q.get("speed"));
  const speed = [1, 30, 60, 300].includes(speedParam) ? speedParam : null;

  return { city: q.get("city"), area, place, timeHHMM, speed };
}

// mode name -> code, matching ripplesim.vehicles._MODE_CODE / bake_ripples._MODE_CODE.
const MODE_CODE = (name) => ({ metro: 0, train: 1, tram: 2, bus: 3, ferry: 4 }[name] ?? 3);

// Recent-events look-back window (sim-sec) for the "impact dot" flash at a
// stop the instant it fires — independent of the ripple horizon (which is
// much longer). Dot alpha fades linearly to 0 over this window.
const IMPACT_FADE_SIM_SEC = 8;
const VEHICLE_DOT_BUDGET = 6000; // cap on stamped vehicle dots per frame (cost bound)

// ---- Life mode playback (Task 4, driven by real timetable data since Task 6) --
// Life runs on its OWN clock: a generation index, not sim-time directly. But
// unlike the original seeded-once design, the CA is now DRIVEN every
// generation by the real timetable (see worldripples/bake_life.py) and each
// generation is bound to a real morning wall-clock minute (life.json
// t0_sec=10800 == 03:00, stride_sec=60, n_gens=120, so the stream runs
// 03:00 -> 05:00). Generation g really "is" 03:00 + g minutes — lifeClockText
// reads that mapping, not an abstract counter. What IS still reused from the
// ripple UI is every CONTROL: the scrubber, play/pause, ±15m and the speed
// chips all drive lifePos below, so Life adds no new widget beyond the mode
// toggle itself.
//
// LIFE_GENS_PER_SEC — generations per WALL-CLOCK second at the default 60x
// speed chip. 6 gen/s runs the whole 121-frame stream in ~20 s, which is long
// enough to watch and short enough to sit through. It is also what makes the
// afterglow legible: lifeview's fade horizon is ~0.5 s of wall clock, so a
// dying cell trails for ~3 generations and is GONE by the third — the horizon
// is a visibility horizon, not a time constant (see lifeview.js). Much faster
// (say 30 gen/s) and the afterglow collapses to a sub-frame flicker; much
// slower and the population band — which barely changes generation to
// generation — reads as a still.
//
// The ~3 generations is 0.5 s x this rate, so it scales with the speed chip
// while the wall-clock duration stays fixed: 1.5 gens at 30x, 15 gens at 300x.
// The FEEL of the fade is therefore identical at every chip, which is the
// property that matters — see drawLifeFrame's playbackRate argument.
const LIFE_GENS_PER_SEC = 6;
// The speed ladder still means something in Life mode: rate scales with the
// chip relative to the 60x default, so 1x is a slow-motion crawl (0.1 gen/s)
// and 300x is a 5x-faster sweep. Same chips, same direction of travel.
const LIFE_SPEED_REF = 60;
// Generation 0 is the SEED. Measured (Helsinki, life.json "population"):
// gen 0 = 18,521 live cells, gen 1 = 20,105 — population RISES, because the
// CA is now driven every generation by the real timetable instead of running
// undriven from a single seed. (The undriven design's 95% collapse in one
// step was the bug this branch fixed; it is no longer what happens.) The
// hold below therefore no longer exists to soften a collapse — it was
// originally justified as a RENDERING concession to keep a collapsing seed
// from reading as a glitch, and that justification no longer holds under the
// driven model. Whether a generation-0 hold is still wanted (e.g. to let a
// viewer read the seed before playback starts) is a product-feel call, not
// one this comment can settle — flagged for a human decision; the constant's
// value is left unchanged pending that call.
const LIFE_SEED_HOLD_SEC = 1.5;
// Sized above the largest measured per-generation drawn-cell count across the
// four Helsinki-region subareas. The buffer grows-and-copies if exceeded, so
// this is a perf floor, not a correctness bound.
const LIFE_SEG_CAP = 120000; // edges; vertices = 2x this
// Life reuses the RIPPLE band shader rather than adding a GL program. The
// shader computes b = (crest + wakeLevel*wake) * exp(-age/lifeTau) with
// crest = max(1 - |T - age*frontSpeed| / thickness, 0). Feeding it
// age = 1, frontSpeed = 1, thickness = 1, wakeLevel = 0, lifeTau = huge
// collapses that to b = max(1 - |T - 1|, 0), so a per-vertex T of `alpha`
// (0..1) renders as exactly `alpha`. Verified against field.js's own
// bandBrightness() reference implementation: max error 1e-9 over alpha 0..1.
// See pushLifeCell() for where the per-vertex alpha is written.
const LIFE_PARAMS = { frontSpeed: 1, thickness: 1, wakeTau: 1, wakeLevel: 0, lifeTau: 1e9 };
const LIFE_AGE = 1; // the `age` attribute every Life vertex carries (see above)
// Life is coloured by MODE_COLORS, the same palette ripple mode uses, so a
// viewer switching modes sees the same colour mean the same service.
//
// The comment this replaces argued against exactly that: "a Life cell is a
// street cell, not a metro/tram/bus event, and colouring it like one would
// imply a mode attribution the data does not carry". That objection is
// answered rather than deleted, by making the claim precise. A cell's colour
// says:
//
//   the highest-order service that reached this street during this
//   generation's window -- or, for a cell the timetable did not reach, the
//   service that reached the neighbours it was born from.
//
// That is a defensible statement about a street segment: not that the segment
// IS a tram, but that a tram got there, and that where several services did,
// the rarer one is the one worth naming. Multi-mode cells are 8-12% of stamped
// cells (measured), so the rank rule decides a minority, not the board.
//
// See docs/superpowers/specs/2026-07-31-life-colour-by-mode-design.md.
const LIFE_MODE_SLOTS = 4;
// Life's stamps go through the SAME additive blend + tonemap as ripples, where
// overlap brightening is the whole point (more ripples = brighter). For Life it
// is noise: a cell is alive or dead, and one cell overlapping another must not
// read as "more alive". At full alpha the pipeline
// (alpha x STAMP_BRIGHTNESS=1.6, then 1-exp(-c*b*2.2)) clips a live cell to
// pure white, crushing its MODE_COLORS hue to (255,255,255) and erasing which
// service lit it. Scaling alpha to 0.5625 puts a full-alpha cell at b=0.9,
// which tonemaps to roughly 60-85% of each channel: bright and clearly
// tinted by its MODE_COLORS slot, with headroom left so an overlap brightens
// instead of clipping.
//
// This is a RENDERING gain constant. It scales what a given alpha looks like,
// never which cells are alive or what alpha the view model computed.
const LIFE_STAMP_GAIN = 0.5625;

// Map a scrubber fraction (0..1) onto a generation position, and back.
// Exported for unit test: the round-trip is what makes scrub-then-play
// resume from where the user dropped the handle instead of snapping.
export function lifeFracToPos(frac, nFrames) {
  const last = Math.max(0, nFrames - 1);
  if (!Number.isFinite(frac)) return 0;
  return Math.min(1, Math.max(0, frac)) * last; // clamp the FRACTION to 0..1
}
export function lifePosToFrac(pos, nFrames) {
  const last = Math.max(0, nFrames - 1);
  if (last === 0 || !Number.isFinite(pos)) return 0;
  return Math.min(1, Math.max(0, pos / last));
}
// Advance the Life clock by `dGen` generations, wrapping at the end of the
// stream. Returns { pos, wrapped }.
//
// STRICT `>`, deliberately, matching ripple playback's `tNext > dataMax` wrap
// (frame() below). A `>=` here wraps AT the last generation, so free playback
// would step 199 -> (>=200, wrap) -> 0 and NEVER SHOW gen 200 — the final
// frame would be reachable only by scrubbing to 1.0 or skipping forward. That
// is an off-by-one against the documented 121-frame mapping, and it silently
// contradicts the endpoint behaviour ripple mode already has.
//
// The strict `>` alone is NOT sufficient, and the test caught it: the step is
// `remaining * lifeGensPerSec()`, which never lands on an exact integer, so
// stepping 199.0 by 0.1 reaches 199.9 and then 200.00000000000003 — a hair
// PAST `last`, wrapping without gen 200 ever being displayed. So a step that
// would overshoot CLAMPS to `last` first, and the wrap happens on the step
// after that. Costs one extra frame at the end of a ~20 s loop; guarantees the
// final generation is actually shown at any step size.
//
// Extracted from frame() so the boundary is unit-testable: the wrap decision
// is exactly the kind of predicate that a browser-only code path hides.
export function lifeAdvance(pos, dGen, nFrames) {
  const last = Math.max(0, nFrames - 1);
  const p = Number.isFinite(pos) ? pos : 0;
  const d = Number.isFinite(dGen) ? dGen : 0;
  const next = p + d;
  if (next > last) {
    // Already showing the final generation -> this step is the wrap.
    if (p >= last) return { pos: 0, wrapped: true };
    // Otherwise stop ON the final generation so it gets at least one frame.
    return { pos: last, wrapped: false };
  }
  return { pos: Math.max(0, next), wrapped: false };
}

// Split a generation position into the integer generation + sub-generation
// fraction cellAlpha() wants. Guards NaN/Infinity at the boundary: cellAlpha
// throws a TypeError on a non-finite `gen`, and lifePos is computed from a
// division that an empty/degenerate stream could make NaN.
export function lifeSplit(pos, nFrames) {
  const last = Math.max(0, nFrames - 1);
  const p = Number.isFinite(pos) ? Math.min(last, Math.max(0, pos)) : 0;
  const gen = Math.min(last, Math.floor(p));
  const frac = Math.min(1, Math.max(0, p - gen));
  return { gen, frac };
}

// The Life clock is real sim-time, not a generation counter: one generation is
// stride_sec of the city's actual morning. This is what makes the stream read
// as 03:00 -> 05:00 rather than as 121 abstract steps.
export function lifeWallClock(gen, meta) {
  if (!meta || typeof meta.t0_sec !== "number" || typeof meta.stride_sec !== "number") {
    return `gen ${gen}`;
  }
  const sec = meta.t0_sec + gen * meta.stride_sec;
  const hh = String(Math.floor(sec / 3600) % 24).padStart(2, "0");
  const mm = String(Math.floor(sec / 60) % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Refcounted show/hide for the shared busy indicator. Two independent loads
// can be in flight at once — boot()'s city bundle and setMode("life")'s Life
// stream — and with a plain boolean the first to finish hides the spinner the
// other still needs.
//
// Returns the next count. Clamped at 0 so an unbalanced release cannot drive
// it negative and wedge the indicator OFF: with a naive `count - 1`, one extra
// release would leave -1, and the next acquire would only bring it back to 0,
// so "visible" would never be reached again.
//
// Exported purely so this rule is unit-testable; initApp() owns the actual
// counter, since the element it drives is per-app-instance.
export function nextLoadingCount(count, on) {
  return on ? count + 1 : Math.max(0, count - 1);
}

function bboxObj(arr) {
  return { minX: arr[0], minY: arr[1], maxX: arr[2], maxY: arr[3] };
}

// binary search helpers (eventTime is sorted ascending per the bake contract).
function lowerBound(arr, value) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Scripted stops for the guided intro (Task 10). Picked from the baked
// Helsinki data: two real, nearby stops (~90m apart, different modes —
// tram + bus) whose 3-min isochrones overlap enough to make the additive
// interference bloom visible without swamping the whole street network.
const STORY_STOP_SOLO = 1893;   // tram stop, cnt=337 stamps
const STORY_STOP_PAIR = [1893, 2841]; // tram + bus, ~90m apart

async function initApp() {
  const canvas = document.getElementById("map");
  const statusEl = document.getElementById("status");
  if (statusEl && new URLSearchParams(location.search).get("debug") === "1") {
    statusEl.hidden = false;
  }
  const loadingEl = document.getElementById("loading");
  // REFCOUNTED, not a boolean. Two independent loads can be in flight at once:
  // boot()'s city bundle and setMode("life")'s 0.87 MB Life stream. With a
  // plain boolean the FIRST to finish hides the spinner the OTHER still needs
  // — enter Life mode, click a city chip while the Life fetch is in flight,
  // and the resolving Life load hides the new city's still-active spinner. The
  // session-staleness guards protect app STATE correctly, but a superseded
  // session must not touch the current one's UI on its way out either.
  //
  // Counting owners instead makes the release order irrelevant: the spinner is
  // visible while at least one loader holds it, and every caller releases
  // exactly what it acquired. Clamped at 0 so an unbalanced release can never
  // drive the count negative and wedge the spinner on.
  let loadingCount = 0;
  const showLoading = (on) => {
    loadingCount = nextLoadingCount(loadingCount, on);
    if (loadingEl) loadingEl.hidden = loadingCount === 0;
  };
  const clockEl = document.getElementById("clock");
  const clockDaypartEl = document.getElementById("clock-daypart");
  const daypartMarkersEl = document.getElementById("daypart-markers");
  const whisperEl = document.getElementById("whisper");
  const scrubberEl = document.getElementById("scrubber");
  const playPauseEl = document.getElementById("play-pause");
  const skipBackEl = document.getElementById("skip-back");
  const skipFwdEl = document.getElementById("skip-fwd");
  const speedReadout = document.getElementById("speed-readout");
  const chromeEl = document.getElementById("chrome");
  const introEl = document.getElementById("intro");
  const introBeginEl = document.getElementById("intro-begin");
  const stepperEl = document.getElementById("stepper");
  const stepNumEl = document.getElementById("step-num");
  const stepCaptionEl = document.getElementById("step-caption");
  const stepNextEl = document.getElementById("step-next");
  const stepExploreEl = document.getElementById("step-explore");
  const modeRailEl = document.getElementById("mode-rail");
  const controlRailEl = document.getElementById("control-rail");
  const modeRipplesEl = document.getElementById("mode-ripples");
  const modeLifeEl = document.getElementById("mode-life");
  const sunRailEl = document.getElementById("sun-rail");
  const sunToggleEl = document.getElementById("sun-toggle");
  const sunSeasonEls = document.querySelectorAll("#sun-seasons button[data-season]");
  const viewRailEl = document.getElementById("view-rail");
  const modeDesertsEl = document.getElementById("mode-deserts");
  const modeFilterEl = document.getElementById("mode-filter");
  const helpBtnEl = document.getElementById("help-btn");
  const creditsBtnEl = document.getElementById("credits-btn");
  const creditsEl = document.getElementById("credits");
  const creditsCloseEl = document.getElementById("credits-close");
  const INTRO_SEEN_KEY = "hr-intro-seen";

  // ---- Pixel basis: CSS px vs device px ----------------------------------
  // Two bases coexist and must not be mixed up:
  //   CSS px    - camera, projection, pointer events (e.clientX/Y), hit-testing
  //   device px - canvas backing buffers, gl.viewport, RippleField textures
  // canvas.clientWidth is CSS px; canvas.width is device px. Assigning one from
  // the other (the pre-fix code) makes the browser upscale a too-small buffer.
  //
  // FIELD_DPR_CAP: the GL field allocates 2 full-screen float textures, so cost
  // scales with dpr^2 — an uncapped DPR-3 phone would pay 9x the fill rate and
  // texture memory. Capping at 2 keeps ~all the perceptual win for 4x, not 9x.
  // The 2D overlay (text/rings) is cheap, so it gets the real DPR and stays
  // fully crisp.
  const FIELD_DPR_CAP = 2;
  function rawDpr() {
    const d = window.devicePixelRatio;
    return Number.isFinite(d) && d > 0 ? d : 1;
  }
  function fieldDpr() { return Math.min(rawDpr(), FIELD_DPR_CAP); }
  // clientWidth reads 0 before layout settles (a real risk on mobile), and the
  // old `|| window.innerWidth` fallback silently swapped in a DIFFERENT basis
  // when it did. Fall back only on a non-positive read, and keep it explicit.
  function cssWidth() {
    const w = canvas.clientWidth;
    return w > 0 ? w : window.innerWidth;
  }
  function cssHeight() {
    const h = canvas.clientHeight;
    return h > 0 ? h : window.innerHeight;
  }

  // ---- WebGL2 availability check (self-review requirement) --------------
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    if (statusEl) statusEl.textContent = "This visualization needs WebGL2 with float render targets.";
    return;
  }

  // ---- Re-entrant boot bookkeeping (Phase B) ------------------------------
  // Every resource acquired by boot() must be released in teardown(), or a
  // city switch leaks: two rAF loops double-step the clock, GL programs and
  // buffers accumulate, and duplicate DOM listeners stack (a double-firing
  // scrubber or speed button). ORDER MATTERS — see teardown().
  let currentSession = null;

  function teardown() {
    if (!currentSession) return;
    const s = currentSession;
    currentSession = null;
    // 1. Stop the loop FIRST. A live frame() touching a disposed field would
    //    call GL methods on deleted programs/buffers.
    if (s.rafHandle !== null) cancelAnimationFrame(s.rafHandle);
    // 2. Drop every DOM listener the session registered, in one shot.
    s.abort.abort();
    // 3. Free GL resources (programs, buffers, textures, framebuffers).
    if (s.field) s.field.dispose();
    s.field = null;
    // 4. Release the baked bundle (~20 MB of typed arrays).
    s.data = null;
    // 4.5. Release the Life streams (Task 2, extended Task 5), if they were
    //    ever loaded. Life is lazy (only fetched once Life mode is entered),
    //    so most sessions have s.life === null here and this is a no-op —
    //    but a session that DID enter Life mode is holding one decoded
    //    Uint8Array frame set PER SUBAREA (~27 MiB total across the four
    //    Helsinki-region subareas) that must not survive a city switch, or
    //    repeated switches accumulate one stale frame set per prior city
    //    (the same leak class step 4 guards against for `data`).
    s.life = null;
    s.lifePromise = null;
    s.lifeMeta = null;
    // 4.6. Release the desert bitmaps, same contract as 4.5. One Uint8Array of
    //    one byte per cell per subarea (~255 KB across the four Helsinki
    //    subareas, ~84 KB for a single-subarea city) — small next to Life, but
    //    it is still a per-city resource and nothing per-city may survive a
    //    switch. The manifest goes too: it is what the rail's visibility rule
    //    reads, and a stale one would describe the previous city's coverage.
    s.deserts = null;
    s.desertBits = null;
    s.desertPromise = null;
    // 5. Drop the panel handle. Its listeners died with step 2; this stops the
    //    session object itself from pointing at the detached row elements.
    s.panel = null;
    // 6. Clear the idle-hide timer. abort() does not cancel pending timers, so
    //    a stale timer must be cleared explicitly to prevent it from hiding the
    //    new city's chrome after a switch.
    if (s.idleTimer !== null) clearTimeout(s.idleTimer);
  }

  // Guards against overlapping switches: two boots awaiting loadAll() at once
  // would both proceed to teardown+init, and the loser's field/rAF would be
  // orphaned (disposed out from under a session that had already installed
  // itself). Only the most recent request is allowed to commit.
  let bootSeq = 0;

  // Bounded LRU of loaded city bundles (2 entries -- see data.js's
  // makeCityCache doc comment for why the bound is not optional). Created
  // once, at module scope beside bootSeq, so it survives across switches.
  const cityCache = makeCityCache(2);

  // Sun state is a user CHOICE, not per-city page data, so it must survive a
  // city switch the same way cityCache does: created once at module scope,
  // read/written by boot() below. Starts null so the very first boot falls
  // through to the ?sun=/?season= deep-link (or its defaults) unmodified;
  // populated after the first boot so every SUBSEQUENT switch carries the
  // user's last choice forward instead of silently reverting to the URL.
  let sunPersist = null;

  // The active city's region_bbox (cities.json), or AOIS.region as a last
  // resort when the registry failed to load (no cities.json / malformed —
  // same defensive posture as resolveSlug/loadCities). AOIS.region IS
  // Helsinki's region_bbox, so that fallback path renders Helsinki exactly
  // as before Task 15b.
  function cameraBboxFor(slug) {
    const entry = cityEntry(slug);
    return (entry && entry.region_bbox) || AOIS.region;
  }

  // The centre is COMPUTED from region_bbox, never stored separately -- a
  // duplicated centre drifts. utc_offset_hours is a 4-element array indexed
  // by SEASONS order (mar/jun/sep/dec); falls back to all-zero (UTC) so a
  // registry entry without the field still boots instead of throwing.
  function buildSunState(slug, seasonKey) {
    const entry = cityEntry(slug);
    const bbox = (entry && entry.region_bbox) || AOIS.region;
    const offsets = (entry && entry.utc_offset_hours) || [0, 0, 0, 0];
    const idx = Math.max(0, SEASONS.findIndex((s) => s.key === seasonKey));
    return makeSunState({
      lat: (bbox[1] + bbox[3]) / 2,
      lon: (bbox[0] + bbox[2]) / 2,
      utcOffsetHours: offsets[idx],
      seasonKey,
    });
  }

  async function boot(slug) {
    const mySeq = ++bootSeq;
    // FETCH FIRST, tear the old city down only on success. Teardown-then-fetch
    // would leave the user staring at a black screen if the network fails
    // mid-switch; this way the previous city stays rendered and the error is
    // reported into #status.
    let d;
    showLoading(true);
    try {
      d = cityCache.get(slug) || await loadAll(dataDirFor(slug));
      cityCache.set(slug, d);
    } catch (err) {
      // Only the newest request owns the status line; a stale failure must not
      // overwrite a newer city's message.
      if (statusEl && mySeq === bootSeq) statusEl.textContent = `Could not load ${slug}: ${err.message}`;
      return false; // previous city stays rendered
    } finally {
      showLoading(false);
    }
    // A newer boot() started while this one was fetching — abandon this result
    // rather than tearing down the city the user actually asked for last.
    if (mySeq !== bootSeq) return false;
    // A live session at this point means this boot is a SWITCH, not the
    // page's first boot — captured before teardown() clears it.
    const isSwitch = currentSession !== null;
    teardown();

    const abort = new AbortController();
    const session = { rafHandle: null, abort, field: null, data: d, panel: null, idleTimer: null,
                       life: null, lifePromise: null, lifeMeta: null,
                       deserts: null, desertBits: null, desertPromise: null };
    currentSession = session;

  // The deserts MANIFEST is fetched eagerly, the BITMAPS are not. The rail's
  // visibility rule below runs synchronously during boot and asks
  // desertAvailable(session.deserts, ...) — so the tiny JSON (<1 KB, one per
  // city) has to be in hand by then or every city would boot with the button
  // disabled and only enable it after some later event that does not exist.
  // The desert_<Sub>.bin files (the expensive half, 14 KB–88 KB per subarea)
  // stay lazy in loadDesertsForSession, entered only when the mode is.
  //
  // A missing or malformed deserts.json is NOT an error: it means this city
  // has no desert bake, and desertAvailable(null, ...) === false already says
  // exactly that. So this swallows rather than throws — an unbaked city must
  // still boot into Ripples.
  try {
    const resp = await fetch(`${dataDirFor(slug)}/deserts.json`);
    if (resp.ok) session.deserts = await resp.json();
  } catch (err) {
    console.warn(`deserts: no manifest for '${slug}'`, err);
  }
  // A newer boot() can start while that fetch is in flight — same guard the
  // bundle fetch above uses, for the same reason: a superseded boot must not
  // go on to install its chrome over the city the user actually asked for.
  if (mySeq !== bootSeq) return false;

  const manifest = d.manifest;
  const activeEntry = cityEntry(slug);
  const placeTree = await loadPlaces(slug, cameraBboxFor(slug),
    activeEntry ? activeEntry.display_name : slug);
  const placeNames = flattenTree(placeTree).map((r) => r.name);
  const dataMin = manifest.data_min;
  const dataMax = manifest.data_max;
  const dataSpan = Math.max(1, dataMax - dataMin);
  const dayParts = gateDayParts(manifest.day_parts, dataMin, dataMax);
  // Note: manifest.tau_sec is the physics isochrone decay constant baked into
  // stamp_delay/stamp_intensity at bake time. Display fade is now driven
  // live by the band shader's life_tau (see RIPPLE_PARAMS below, sourced
  // from manifest.ripple.life_tau) — there is no separate visual half-life
  // constant anymore (the old decay-accumulate model's RIPPLE_HALF_LIFE_SIM_SEC
  // was retired in Task 9's clear+re-stamp rewrite).

  // city code -> name, matching the bake's city_list.index(city) order.
  // Derived from the manifest (not hardcoded) so a bake reorder can't
  // silently mis-map a stop to the wrong city's street buffer.
  const CITY_NAMES = Object.keys(manifest.cities);

  // stampIndex is a flat [off0,cnt0, off1,cnt1, ...] per stop.
  const stampIndex = d.stampIndex;
  const stampEdge = d.stampEdge;
  const stampIntensity = d.stampIntensity;
  const stampDelay = d.stampDelay;
  const stopMode = d.stopMode;
  const stopCity = d.stopCity;
  const eventStop = d.eventStop;
  const eventTime = d.eventTime;
  const streets = d.streets;
  const stops = d.stops; // flat [x0,y0, x1,y1, ...] per stop (lon/lat)
  const horizonSec = manifest.horizon_sec;

  // Publish the LOADED horizon for the private tier bar. It must come from the
  // manifest, never from ?tier=: the URL states an intent, the manifest states
  // what actually got fetched. If those ever disagree (a stale bundle, a
  // hand-edited link, a tier that was never baked), the honesty line has to
  // follow the bytes on screen — otherwise the page captions itself wrongly,
  // which is the exact failure this whole tier UI exists to prevent.
  // Reassigned on every city switch, so it tracks the live session.
  if (typeof window !== "undefined") {
    window.__wrManifest = { horizon_sec: horizonSec, slug };
  }

  // Capacity constant for un-quantizing stampIntensity (Task 3 fix round 1).
  // `cp.max_mode_weight` is the SAME divisor bake_ripples.py used to
  // renormalize stamp_intensity before quantizing into uint16 (see
  // pushEdge's stampIntensity comment below, and normalizeStampIntensity's
  // own doc comment in field.js, for the full derivation) -- it must be READ
  // from the manifest, not hardcoded, because a per-city `capacity_override`
  // can change the effective max weight and the client would otherwise have
  // no way to know. Falls back to today's known value (10.0, metro's weight)
  // so an older cached manifest without the `capacity` block reproduces the
  // exact behavior this fix round shipped with, matching the existing
  // `manifest.ripple_real || {}` fallback idiom above. `manifest.capacity.
  // reference_weight` (always 1.0 by construction today) is emitted too but
  // not consumed here -- normalizeStampIntensity's math only needs the max;
  // the reference weight is documentation for the manifest's own reader and
  // a seam for a future per-city assertion, not dead weight in this file.
  // The fallback is LOUD on purpose. A bundle baked before capacity weighting
  // has no `capacity` block, so this silently multiplied already-renormalized
  // stamp intensities by 10.0 and rendered ~5.8x too bright -- it did not
  // crash, it rendered plausibly-wrong, which is the failure shape that cost
  // a whole session to find. A stale bundle must announce itself.
  const cp = manifest.capacity || {};
  if (cp.max_mode_weight == null) {
    console.warn(
      "[world-ripples] manifest.capacity.max_mode_weight is MISSING -- this " +
      "city's bundle predates capacity weighting. Falling back to 10.0; " +
      "ripple intensities will render far too bright until it is re-baked."
    );
  }
  const MAX_MODE_WEIGHT = cp.max_mode_weight ?? 10.0;

  // v2.1: band params are REAL-seconds tuned (see field.js realAge). Prefer
  // the manifest's ripple_real block; fall back to the same values hardcoded
  // so an older cached manifest can't resurrect the sim-seconds blink.
  const rp = manifest.ripple_real || {};
  const RIPPLE_PARAMS = {
    frontSpeed: rp.front_speed ?? 36.0,
    thickness: rp.thickness ?? 14.0,
    wakeTau: rp.wake_tau ?? 45.0,
    wakeLevel: rp.wake_level ?? 0.35,
    lifeTau: rp.life_tau ?? 3.0,
  };

  // 1x: the 14 s real-time horizon is otherwise eaten by lifeTau=3
  // (exp(-14/3) ≈ 0.9%); at 1x the ripple should linger as a visible glow.
  const RIPPLE_PARAMS_1X = { ...RIPPLE_PARAMS, lifeTau: 6.0 };

  // Guided-intro snapshot params: same band, but life decay disabled so the
  // whole isochrone reads at crest brightness (age varies per edge; without
  // this the far edges dim to ~0.19 of the near ones under life_tau=3).
  const INTRO_PARAMS = { ...RIPPLE_PARAMS, lifeTau: 1e9 };

  // Vehicle data (Task 9, Option A: sim-in-JS interpolation). Guarded: an
  // older bake without vehicle bins/manifest.vehicle leaves vehData null,
  // and the vehicle-dot pass below is skipped entirely — ripples-only.
  const vehicleMeta = manifest.vehicle || null; // {mode:"sim-in-js", window:[t0,t1]}
  const vehData = (d.trips && d.routes && d.vehicleTripBpTime && d.vehicleTripBpDist &&
                   d.vehicleShapeCoords && d.vehicleShapeCumdist) ? {
    routes: d.routes, trips: d.trips,
    shapeCoords: d.vehicleShapeCoords, shapeCumdist: d.vehicleShapeCumdist,
    bpTime: d.vehicleTripBpTime, bpDist: d.vehicleTripBpDist,
  } : null;
  // One caller-owned hot-loop buffer, reused by all five mode passes rather
  // than allocating a Float32Array per pulse (or per frame).
  //
  // SIZING, measured on the shipped Helsinki bundle (908 routes scanned): a
  // 250 m tail spans 4.5 shape vertices on average and 8 at the very worst, so
  // a pulse is a handful of segments, not a long strip. PULSE_BUDGET is the
  // whole-city peak BEFORE viewport culling, and only pulses that survive the
  // cull are ever written, so sizing the full budget at the WORST-case segment
  // count is already generous and still costs well under a megabyte.
  //
  // pulseGeometry stops at the array bound rather than overrunning it, so an
  // undersized buffer degrades to a dropped pulse, never to corruption.
  const PULSE_SEGMENTS_WORST = 8;
  const pulseScratch = new Float32Array(PULSE_BUDGET * PULSE_SEGMENTS_WORST * 6);
  // Per-mode leg buckets, allocated once and emptied (length = 0) each frame so
  // the hot loop never allocates. Indexed by mode code, matching MODE_COLORS.
  const pulseByMode = MODE_COLORS.map(() => []);

  // ---- Life mode: lazy load + decode (Task 2, extended Task 5) -------------
  // Life covers every subarea the city's manifest declares -- the same extent
  // ripple mode draws. It used to be Helsinki-only, which made the Life board
  // a visibly smaller map than the ripple board.
  //
  // The manifest is keyed by SUBAREA NAME, not slug ("Helsinki", not
  // "helsinki"), and names can be non-ASCII (life_Zürich.bin), which is why
  // life.js percent-encodes them.
  //
  // Memoized on the session (session.lifePromise) so repeated calls within
  // one boot don't re-fetch, and teardown() (step 4.5) drops both
  // session.life and session.lifePromise on city switch — the same
  // "no resource survives a switch" contract data/field/panel get.
  //
  // cellCount is verified PER SUBAREA against TWO independent sources before
  // anything is trusted: life.json's own manifest entry (cell_count, decoded
  // from the .bin's header) and the geometry it's meant to render 1:1 onto
  // (streets[name].length / 4 — the plan's "cell i -> seg[4i:4i+4]" fact). A
  // mismatch here means the geometry assumption the renderer depends on has
  // silently broken (e.g. a re-bake reordered/resized either side), so this
  // throws rather than let the renderer draw garbage against a misaligned
  // buffer.
  function loadLifeForSession(citySlug) {
    if (session.lifePromise) return session.lifePromise;
    session.lifePromise = (async () => {
      const dir = dataDirFor(citySlug);
      const lifeManifest = await fetch(`${dir}/life.json`).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch life.json: ${r.status} ${r.statusText}`);
        return r.json();
      });
      const names = Object.keys(lifeManifest);
      if (names.length === 0) throw new Error(`life: no baked subareas for '${citySlug}'`);

      const streams = new Map();
      await Promise.all(names.map(async (name) => {
        const life = await loadLife(dir, name);
        const expected = lifeManifest[name] && lifeManifest[name].cell_count;
        const streetSeg = d.streets[name];
        const geomCells = streetSeg ? streetSeg.length / 4 : NaN;
        if (life.cellCount !== expected) {
          throw new Error(
            `life: ${name} decoded cellCount ${life.cellCount} != life.json cell_count ${expected} ` +
            "— the .bin and its manifest disagree; refusing to use a mismatched stream."
          );
        }
        if (life.cellCount !== geomCells) {
          throw new Error(
            `life: ${name} decoded cellCount ${life.cellCount} != street_${name}_seg.bin/4 ${geomCells} ` +
            "— the 1:1 cell<->edge geometry assumption is broken; refusing to render garbage."
          );
        }
        streams.set(name, life);
      }));

      const refMeta = lifeManifest[names[0]];
      for (const name of names) {
        const m = lifeManifest[name];
        if (m.t0_sec !== refMeta.t0_sec || m.stride_sec !== refMeta.stride_sec) {
          throw new Error(
            `life: ${name} clock (t0_sec=${m.t0_sec}, stride_sec=${m.stride_sec}) != ` +
            `${names[0]} (t0_sec=${refMeta.t0_sec}, stride_sec=${refMeta.stride_sec}) ` +
            "— subareas must share one generation clock; refusing to label them with a mismatched one."
          );
        }
      }

      session.life = streams;
      session.lifeMeta = refMeta; // clock params: verified identical across subareas above
      return streams;
    })();
    // A rejected load must not poison future attempts (e.g. a transient
    // fetch failure) — clear the memo so the next call retries instead of
    // replaying the same rejection forever.
    session.lifePromise.catch(() => { session.lifePromise = null; });
    return session.lifePromise;
  }

  // The desert BITMAPS. Same shape as loadLifeForSession above and for the
  // same reasons — memoized on the session (session.desertPromise), dropped by
  // teardown() (step 4.6), and a rejection clears the memo so a transient
  // fetch failure does not poison every later attempt.
  //
  // Differences from Life, all forced by the data:
  //
  //  * The MANIFEST is already loaded. boot() fetched deserts.json eagerly
  //    because the rail's visibility rule needs it synchronously, so this only
  //    fetches the .bin half and reads session.deserts for cell counts.
  //  * Only COVERED subareas are loaded. A subarea with coverage_ok:false has
  //    no honest desert claim to make (Tokyo: 149 stops for 705k edges), and
  //    bake_deserts writes no .bin for it — fetching one would 404. This is
  //    also why an all-uncovered city throws rather than rendering an empty
  //    layer that would read as "no deserts here".
  //  * cellCount is not carried in the .bin (the wire format is a bare
  //    packbits payload with no header), so it comes from deserts.json's
  //    `cells` and is cross-checked against the geometry it must render 1:1
  //    onto (street_<Sub>_seg.bin length / 4) — the same "cell i -> seg[4i]"
  //    identity Life asserts, checked here for the same reason: a re-bake that
  //    resized either side must fail loudly, not draw a network offset by one.
  function loadDesertsForSession(citySlug) {
    if (session.desertPromise) return session.desertPromise;
    session.desertPromise = (async () => {
      const json = session.deserts;
      if (!json || !json.subareas) {
        throw new Error(`deserts: no baked manifest for '${citySlug}'`);
      }
      const names = Object.keys(json.subareas)
        .filter((n) => json.subareas[n].coverage_ok === true);
      if (names.length === 0) {
        throw new Error(
          `deserts: no subarea of '${citySlug}' passes the coverage floor — ` +
          "the feed is too sparse to support the desert claim honestly."
        );
      }

      const dir = dataDirFor(citySlug);
      const bits = new Map();
      await Promise.all(names.map(async (name) => {
        // Subarea names are non-ASCII in the shipped bake (desert_Zürich.bin),
        // so the path is percent-encoded exactly as life.js encodes its own.
        const r = await fetch(`${dir}/${encodeURIComponent(`desert_${name}`)}.bin`);
        if (!r.ok) {
          throw new Error(`Failed to fetch desert_${name}.bin: ${r.status} ${r.statusText}`);
        }
        const buf = await r.arrayBuffer();
        const nCells = json.subareas[name].cells;
        const streetSeg = d.streets[name];
        const geomCells = streetSeg ? streetSeg.length / 4 : NaN;
        if (nCells !== geomCells) {
          throw new Error(
            `deserts: ${name} manifest cells ${nCells} != street_${name}_seg.bin/4 ${geomCells} ` +
            "— the 1:1 cell<->edge geometry assumption is broken; refusing to render garbage."
          );
        }
        // packbits rounds up to whole bytes; anything shorter means a
        // truncated download, which unpackDesertBits would silently zero-fill
        // into "everything is reached" — the most flattering possible lie.
        if (buf.byteLength * 8 < nCells) {
          throw new Error(
            `deserts: ${name} bitmap holds ${buf.byteLength * 8} bits for ${nCells} cells ` +
            "— the .bin is truncated; refusing to under-report deserts."
          );
        }
        bits.set(name, unpackDesertBits(buf, nCells));
      }));

      session.desertBits = bits;
      return bits;
    })();
    session.desertPromise.catch(() => { session.desertPromise = null; });
    return session.desertPromise;
  }
  // Debug hooks (?debug=1 only), mirroring the window.__wrCapture pattern so
  // production never exposes mutable internals.
  //
  // Task 4 replaced Task 2's pair of scaffolding hooks. __wrLifeDebug is GONE:
  // it existed only because Task 2 had no UI trigger, and its one job —
  // proving teardown() released the stream — is now covered by the same
  // `state` object the renderer reads, reported through __wrLife below.
  // __wrLoadLife SURVIVES but is repointed at the real entry path
  // (setMode("life")), so a headless driver exercises exactly what the button
  // does rather than a parallel loader that could drift from it.
  if (new URLSearchParams(location.search).get("debug") === "1") {
    window.__wrLoadLife = () => setMode("life");
    // Read live off `session`/`state`, never a snapshot, so it reflects
    // teardown() and the render loop the instant it is called.
    //
    // This closure retains ONE boot's `state`/`session` for as long as the
    // page lives: each city switch reassigns window.__wrLife to a NEW
    // closure, but nothing ever deletes the old one's captured references,
    // so at most one stale boot's state stays pinned in memory. Debug-gated
    // only (?debug=1) — production never installs this hook — and bounded at
    // one, so this is left as-is rather than restructured; the gate reads
    // numbers through it.
    window.__wrLife = () => ({
      mode: state.mode,
      hasLife: session.life !== null,
      hasPromise: session.lifePromise !== null,
      lifePos: state.lifePos,
      liveCells: state.lifeLiveCells,
      drawnCells: state.lifeDrawnCells,
      vehicleDots: state.lifeVehicleDots,
      vehicleClipped: state.lifeVehicleClipped,
    });
  }

  // Boot-time sanity check (T10 rollup / final-review item 7): the guided
  // intro hardcodes two baked stop indices (STORY_STOP_SOLO/PAIR). If a
  // future re-bake reorders stops, these could silently point at a stop
  // with no street buffer, and the "one ripple" teaching step would just
  // show nothing with no error. Warn loudly rather than fail silently;
  // don't hard-crash the whole app over a demo-step data mismatch.
  for (const idx of [STORY_STOP_SOLO, ...STORY_STOP_PAIR]) {
    if (stampIndex[2 * idx + 1] === 0) {
      console.warn(
        `STORY stop index ${idx} has an empty stamp slice (stampIndex[2*${idx}+1]===0) — ` +
        "the guided intro's seeded ripple will render nothing for this stop. " +
        "Likely cause: a re-bake reordered/renumbered stops; re-pick STORY_STOP_SOLO/PAIR."
      );
    }
  }

  // ---- mutable app state --------------------------------------------------
  const state = {
    t: 18000, // 08:00 sim-sec — a busy frame, inside [dataMin, dataMax]
    speed: 60,
    paused: false,
    // "additive" | "identity" | "overlap" — see corridors.js COLOUR_MODES.
    // Defaults to the shipped additive behaviour so this is opt-in.
    colourMode: "additive",
    // Per-mode visibility for the ripple view, indexed by mode code.
    // The SINGLE source of truth -- every draw site reads this array directly
    // rather than keeping its own copy, so a toggle can never drift out of sync
    // with what is drawn.
    modeVisible: newVisibility(),
    district: null, // null | place-tree node {id, name, bbox, ring} — the highlighted place
    sePtr: 0,
    proj: null,
    lastFrameTs: null,
    // ---- Life mode (Task 4) ----
    // "ripples" | "life". Ripples is the default and the ONLY mode a
    // first-time visitor can land in — there is no ?mode= deep link, so the
    // landing experience is byte-identical to before this task.
    mode: "ripples",
    sunEnabled: true,      // ON by default -- the user's explicit call
    sunSeason: "mar",      // Mar 20 equinox: every city ~12.1h, so cities compare fairly
    sun: null,             // makeSunState(...), rebuilt on city or season change
    lifePos: 0,        // float generation position, 0 .. nFrames-1
    lifeHoldSec: 0,    // wall-sec still owed to the generation-0 hold
    lifeLiveCells: 0,  // instrumentation only (#status + __wrLife)
    lifeDrawnCells: 0, // cells actually stamped (alive + still glowing)
    lifeDeaths: new Map(),    // subarea name -> DeathIndex from precomputeDeaths()
    lifeDeathsFor: new Map(), // subarea name -> the exact stream its index came from
    lifeModes: new Map(),     // subarea name -> per-gen last-live-mode arrays (precomputeLastMode)
    lifeModesFor: new Map(),  // subarea name -> the exact stream its index came from
    lifeVehicleDots: 0,     // dots stamped this frame (live gate reads this)
    lifeVehicleClipped: false, // true once VEHICLE_DOT_BUDGET truncated a frame
  };
  // ?sun=off / ?season=<key> — parsed once at page load, beside the other
  // deep-link params below, and applied here (rather than left to defaults)
  // so the rail's initial button states can reflect them at boot. `state`
  // itself is rebuilt fresh on every boot() (city switch included), the same
  // way `state.mode` always resets to "ripples" on a switch — but unlike
  // `state.mode`, the sun choice is explicitly CARRIED OVER a switch via
  // `sunPersist` (module scope, above): only the first boot reads the URL;
  // every later boot restores whatever the user last chose, so turning the
  // sun off and then switching city does not silently turn it back on.
  if (sunPersist) {
    state.sunEnabled = sunPersist.sunEnabled;
    state.sunSeason = sunPersist.sunSeason;
  } else {
    const sunLink = parseSunLink(new URLSearchParams(window.location.search));
    state.sunEnabled = sunLink.sunEnabled;
    state.sunSeason = sunLink.sunSeason;
  }
  sunPersist = { sunEnabled: state.sunEnabled, sunSeason: state.sunSeason };
  // MUST run after state exists (state.sun is read/written by name below) and
  // after the ?sun=/?season= link above resolves state.sunSeason. This used
  // to sit before `const state = {...}`, which is a TDZ ReferenceError on
  // every boot — the sun feature never actually rendered a frame; caught here
  // while wiring the season buttons in Task 7.
  state.sun = buildSunState(slug, state.sunSeason);
  // Publish the RESOLVED sun state onto the same __wrManifest hook capture.mjs
  // already reads horizon_sec from (see the assignment above). Getters, not a
  // static snapshot, so a caller that reads this after the sun-rail toggle or
  // a season click (state.sunEnabled/state.sunSeason can change post-boot —
  // see the click handlers below) observes the CURRENT state, not the
  // boot-time one. capture.mjs never clicks those controls, but the manifest
  // must record what was actually shown, not what was assumed.
  if (typeof window !== "undefined" && window.__wrManifest) {
    Object.defineProperty(window.__wrManifest, "sun_enabled", {
      configurable: true,
      get: () => state.sunEnabled,
    });
    Object.defineProperty(window.__wrManifest, "sun_season", {
      configurable: true,
      get: () => state.sunSeason,
    });
  }
  // Deep-link params describe how the PAGE was opened, so they are applied
  // on the first boot only. Re-applying them on a city switch would yank the
  // clock/speed/framing back to the URL every time a chip is clicked, undoing
  // wherever the user had navigated to. (sim_origin_sec is per-city, which is
  // why the time conversion has to live inside boot rather than above it.)
  const link = parseDeepLink(window.location.search, placeNames);
  const deepLinkArea = isSwitch ? null : link.area; // back-compat ?area=<name> framing
  const deepLinkPlace = isSwitch ? null : link.place; // precise ?place=<id> framing
  const deepLinkSpeed = isSwitch ? null : link.speed;
  const deepLinkTime = (!isSwitch && link.timeHHMM)
    ? Number(link.timeHHMM.slice(0, 2)) * 3600 + Number(link.timeHHMM.slice(3, 5)) * 60 - manifest.sim_origin_sec
    : null;
  if (deepLinkTime !== null) state.t = Math.min(dataMax, Math.max(dataMin, deepLinkTime));

  // ---- Task 12: rolling FPS meter -----------------------------------------
  // Rolling average over the last ~30 frame samples (not instantaneous),
  // so the on-page readout is a real, pollable measurement the controller
  // can screenshot under CPU throttle, not a jittery single-frame number.
  const FPS_WINDOW = 30;
  const fpsSamples = []; // recent per-frame dt (ms), oldest first
  let fpsValue = 0;
  function recordFrameDt(dtMs) {
    if (dtMs <= 0) return; // paused / hidden-tab frames don't count
    fpsSamples.push(dtMs);
    if (fpsSamples.length > FPS_WINDOW) fpsSamples.shift();
    const avgMs = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
    fpsValue = avgMs > 0 ? 1000 / avgMs : 0;
  }

  // ---- Task 12: status write throttle -------------------------------------
  // Rebuilding + writing #status every rAF (60/sec) is wasted DOM work and
  // makes the FPS digits an unreadable blur. Update the readout on a fixed
  // ~4x/sec cadence, and only touch the DOM when the string actually changed.
  const STATUS_INTERVAL_MS = 250;
  let lastStatusTs = 0;
  let lastStatusStr = null;
  function maybeUpdateStatus(ts) {
    if (!statusEl) return;
    if (ts - lastStatusTs < STATUS_INTERVAL_MS) return;
    lastStatusTs = ts;
    const widthKm = viewWidthKm(camera);
    const widthText = widthKm < 10 ? widthKm.toFixed(1) : String(Math.round(widthKm));
    const lifeStr = state.mode === "life"
      ? " | life gen " + lifeSplit(state.lifePos, lifeNFrames()).gen +
        " live " + state.lifeLiveCells + " drawn " + state.lifeDrawnCells
      : "";
    const str = "view " + widthText + " km | speed " + state.speed + "x" +
      (state.paused ? " | paused" : "") + lifeStr +
      " | " + Math.round(fpsValue) + " fps";
    if (str !== lastStatusStr) {
      lastStatusStr = str;
      statusEl.textContent = str;
    }

    // 1x whisper (spec §4): only at real time, only while playing; human
    // phrasing, never engine terms. delta is SIM seconds, which at 1x IS
    // real seconds.
    // The whisper counts down to the next transit event, which has no meaning
    // in Life mode — nor in Deserts, whose whole claim is that no event ever
    // arrives at these streets. Leave it blank in both rather than narrating a
    // clock the user is not looking at (in Deserts it would be worse than
    // noise: a countdown to an arrival, over a plate about the absence of
    // arrivals).
    let w = "";
    if (state.mode === "ripples" && state.speed === 1 && !state.paused) {
      const nxt = nextEventInView(eventTime, eventStop, stops, state.sePtr, viewBbox());
      if (nxt) {
        const dsec = Math.max(0, Math.round(nxt.simSec - state.t));
        w = whisperText(dsec);
      }
    }
    if (whisperEl && w !== whisperEl.textContent) whisperEl.textContent = w;
  }

  // ---- WebGL field + projection ------------------------------------------
  let field;
  try {
    // Device px: the field's textures and gl.viewport are device-pixel sized.
    field = new RippleField(gl, { width: Math.round(cssWidth() * fieldDpr()),
                                   height: Math.round(cssHeight() * fieldDpr()) });
  } catch (err) {
    if (statusEl) statusEl.textContent = "This visualization needs WebGL2 with float render targets.";
    console.error("RippleField init failed", err);
    // The session owns nothing yet (no field, no rAF, no listeners), but it
    // must not stay installed as `currentSession` — a later boot() would
    // otherwise abort a controller nothing is attached to and, worse, a
    // future teardown would believe a city is live when none is.
    currentSession = null;
    session.data = null;
    return false;
  }
  // The session owns the field from here on; teardown() disposes it.
  session.field = field;

  // Route geometry already ships for vehicle interpolation. Prepare its
  // capacity-weighted corridor segments once per bundle and upload one STATIC
  // VBO; the vertex shader expands each instance into its six quad corners.
  // Only projection uniforms change while the camera moves.
  if (d.routes && d.vehicleShapeCoords) {
    const weights = deriveCorridorWeights(manifest, stopMode, stampIndex, stampIntensity);
    const geometry = buildCorridorGeometry(d.routes, d.vehicleShapeCoords, weights);
    field.setCorridors(geometry.vertices, geometry.batches);
  }
  let frameModeColors = NIGHT_MODE_RGB.map((c) => c.slice());
  const corridorColors = Object.fromEntries(Object.entries(manifest.mode_codes || {})
    .map(([mode, code]) => [mode, frameModeColors[code]]));

  // The mode filter must gate the static corridor silhouette too, or hiding
  // bus removes its wavefronts/dots/flashes but leaves the bus NETWORK still
  // lit underneath -- a visible lie about what the filter does. field.js's
  // drawCorridors skips any batch whose mode key is absent from the colours
  // object it is given (web/field.js:438), so filtering is just a matter of
  // handing it a colours object missing the hidden modes' keys.
  //
  // corridorColors above is memoised ONCE per bundle and reused every frame
  // -- mutating it in place would be unrecoverable the moment a mode is
  // re-shown. This derives a second, filtered view instead, and caches it
  // keyed by a snapshot of state.modeVisible so an unchanged filter (the
  // overwhelmingly common case: every frame between two clicks) costs one
  // cheap byte-array comparison rather than rebuilding an object.
  let visibleCorridorColorsCache = null;
  let visibleCorridorColorsSig = null;
  function visibleCorridorColors() {
    const vis = state.modeVisible;
    // The length check is belt-and-braces: newVisibility() always returns a
    // Uint8Array of exactly MODE_NAMES.length, so the signature and `vis` are
    // the same fixed size today. Without it, though, `every` is asymmetric --
    // a signature SHORTER than `vis` would compare only its own entries and
    // report a stale cache as fresh, which is a silently-wrong frame rather
    // than a crash. Cheap enough to not depend on that invariant holding.
    if (visibleCorridorColorsSig && visibleCorridorColorsSig.length === vis.length &&
        visibleCorridorColorsSig.every((v, i) => v === vis[i])) {
      return visibleCorridorColorsCache;
    }
    visibleCorridorColorsCache = {};
    for (const mode of Object.keys(corridorColors)) {
      const color = frameModeColors[MODE_NAMES.indexOf(mode)] || frameModeColors[3];
      const code = MODE_NAMES.indexOf(mode);
      if (code < 0 || isVisible(vis, code)) visibleCorridorColorsCache[mode] = color;
    }
    visibleCorridorColorsSig = Uint8Array.from(vis);
    return visibleCorridorColorsCache;
  }

  // Per-edge colour-mode lookups, computed ONCE per bundle (not per frame).
  // `edgeWinner[e]` = the mode CODE that owns edge e under identity mode;
  // `edgeModeN[e]`  = how many distinct modes serve edge e, for overlap mode.
  const modeNamesByCode = [];
  for (const [name, code] of Object.entries(manifest.mode_codes || {})) modeNamesByCode[code] = name;
  const edgeModeN = edgeModeCounts(stopMode, stampIndex, stampEdge, modeNamesByCode);
  const edgeWinner = new Int16Array(edgeModeN.length).fill(-1);
  {
    const rankOf = (code) => MODE_RANK[modeNamesByCode[code]] ?? Infinity;
    const stops = stampIndex.length / 2;
    for (let stop = 0; stop < stops; stop++) {
      const mode = stopMode[stop], off = stampIndex[2 * stop], cnt = stampIndex[2 * stop + 1];
      for (let k = off; k < off + cnt; k++) {
        const e = stampEdge[k], cur = edgeWinner[e];
        if (cur === -1 || rankOf(mode) < rankOf(cur)) edgeWinner[e] = mode;
      }
    }
  }

  // The guided intro confines its snapshot projection (introProj) to the TOP
  // portion of the canvas (clear of the bottom-anchored #stepper-card) so a
  // seeded ripple never lands directly underneath opaque UI chrome — see
  // STORY_TOP_FRAC / STORY_STEPS below. Free-explore's camera always uses
  // the full canvas height.
  const overlay = document.getElementById("overlay");
  const octx = overlay.getContext("2d");

  // ---- v2.2 free camera ----------------------------------------------------
  // Task 15b: framed on the ACTIVE CITY's region_bbox (not a Helsinki-only
  // constant) — this is what makes Amsterdam render instead of a blank
  // canvas (the camera used to always sit over Helsinki's bbox regardless
  // of which city's data was loaded).
  const regionBbox = cameraBboxFor(slug);
  // Task 7 (Paris, v2.5): a city can declare `views` in cities.json (spatial
  // zoom presets over the SAME baked bundle -- Paris core/petite/grande). The
  // ?view= URL param picks one; pickView() falls back to regionBbox with no
  // slug or an unknown one, so a mis-typed URL still shows the city.
  const viewSlug = new URLSearchParams(location.search).get("view");
  const framedBbox = pickView(activeEntry, viewSlug) || regionBbox;
  // CSS px: the camera shares a basis with the pointer events that drive it.
  const camera = createCamera(framedBbox, cssWidth(), cssHeight(), 24);
  // Guided-intro framing is generated from CityConfig. Helsinki's generated
  // value remains its Helsinki subarea byte-for-byte; a region-only city uses
  // its sole named subarea (which is the region bbox).
  const introBbox = (activeEntry && activeEntry.intro_bbox) || regionBbox;
  let flyAnim = null;   // in-flight fly-to animation or null
  let introProj = null; // guided-intro override projection (top-cropped) or null
  const STORY_TOP_FRAC = 0.55;

  // viewBbox — the current VIEWPORT extent (spec Q4-A): culling follows the
  // camera, not an AOI/district selection. Districts are navigation only.
  function viewBbox() {
    return visibleBbox(camera);
  }

  // Set once the export row is wired (further down, where activeSlug and the
  // clock label are both in scope). A null hook keeps every camera move above
  // that point — the initial fit, in particular — from having to care.
  //
  // Two triggers, because the emitted capture command carries BOTH a --bbox
  // (camera) and a --start (clock) and either can go stale on its own. The
  // clock one is throttled to the displayed minute: the label is HH:MM, so
  // re-rendering the command on every rAF would rebuild an identical string
  // 60x a second.
  let onCameraChanged = null;
  let onClockChanged = null;

  function syncProjection() {
    state.proj = introProj || cameraProjection(camera);
    drawDistrictOutline();
    if (onCameraChanged) onCameraChanged();
  }

  function fitProjection() {
    const w = cssWidth();
    const h = cssHeight();
    // Backing buffer in DEVICE pixels, CSS box left alone: without this the
    // canvas allocates a CSS-pixel-sized buffer that the browser then upscales
    // by devicePixelRatio, which is why the map looked crisp on a DPR-1 desktop
    // and blurry on a DPR-2.5+ phone. Camera/projection stay in CSS pixels
    // because the pointer handlers feed them raw e.clientX/clientY (CSS px) —
    // scaling those too would break panning and zoom.
    const dpr = fieldDpr();
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    field.resize(canvas.width, canvas.height);
    resizeCamera(camera, w, h);
    if (introProj !== null) {
      introProj = makeProjection(bboxObj(introBbox), w, h * STORY_TOP_FRAC, 24);
    }
    if (flyAnim && !flyAnim.done) {
      flyAnim = startFlyTo(camera, flyAnim.bbox, 600);
    }
    syncProjection();
  }
  window.addEventListener("resize", () => fitProjection(), { signal: abort.signal });

  // ---- --chrome-clear: #control-rail's clearance over #chrome --------------
  // #control-rail is pinned above #chrome with `bottom: calc(var(--chrome-clear)
  // + 8px)`. #chrome's height is NOT a constant -- it measured 177.4px at
  // 1280x900 but 253.3px at 375x667, because its rows wrap -- so a hardcoded
  // offset is exactly the guess that buried the rail under the bar in the first
  // place (up to 167px of a 177px rail at 1366x768). Publishing the MEASURED
  // height instead means the rail is positioned by the box it must clear.
  //
  // A ResizeObserver rather than a resize listener: #chrome also changes height
  // without the window changing size (the AOI/city picker rows re-wrap when a
  // city with more/longer chip labels loads), and those are precisely the cases
  // a resize handler never sees.
  if (typeof ResizeObserver === "function") {
    const publishChromeClear = () => {
      // offsetHeight, not getBoundingClientRect: #chrome carries no transform,
      // and the rounded integer avoids rewriting the custom property on
      // sub-pixel jitter, which would invalidate style on every frame.
      const h = chromeEl.offsetHeight;
      // `hidden` collapses #chrome to 0; keeping the last real value would
      // strand the rail mid-screen, and 0 would let it sit at the very bottom
      // edge, so fall back to the CSS default by clearing the property.
      if (h > 0) document.documentElement.style.setProperty("--chrome-clear", `${h}px`);
      else document.documentElement.style.removeProperty("--chrome-clear");
    };
    const chromeRO = new ResizeObserver(publishChromeClear);
    chromeRO.observe(chromeEl);
    publishChromeClear();
    // ResizeObserver is not a DOM listener, so `abort` does not reach it; a
    // city switch builds a new session and would otherwise leak one observer
    // per switch, all writing the same property.
    abort.signal.addEventListener("abort", () => chromeRO.disconnect());
  }

  // flyToBbox — animated camera move (spec §1). NO field clear, NO sePtr
  // resync: playback and camera are orthogonal; the world keeps rippling
  // while the camera moves.
  function flyToBbox(bbox) {
    flyAnim = startFlyTo(camera, bbox, 600);
  }

  // drawDistrictOutline — static 2D overlay: the SELECTED district's ring
  // (soft white) + the HOVERED row's ring (brighter pre-glow). Redrawn on
  // camera change / selection / hover — never per rAF frame. The selection
  // ring fades out once the camera center leaves its bbox by more than one
  // bbox-width (it is a hint, not a mode — spec §3).
  function ringPath(ring) {
    octx.beginPath();
    for (let i = 0; i < ring.length; i++) {
      const [px, py] = state.proj.fn(ring[i][0], ring[i][1]);
      if (i === 0) octx.moveTo(px, py); else octx.lineTo(px, py);
    }
    octx.closePath();
  }
  function selectionAlpha(bbox) {
    const cx = camera.cx, cy = camera.cy;
    const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
    const dx = Math.max(0, Math.max(bbox[0] - cx, cx - bbox[2])) / Math.max(w, 1e-9);
    const dy = Math.max(0, Math.max(bbox[1] - cy, cy - bbox[3])) / Math.max(h, 1e-9);
    return Math.max(0, 1 - Math.max(dx, dy)); // 1 inside, 0 one bbox-width away
  }
  function drawDistrictOutline() {
    // The overlay carries text and hairline rings, so it gets the FULL device
    // ratio (not the field's capped one) — it is cheap 2D and blurry letterforms
    // are the most visible artifact. Buffer is device px; the ring geometry comes
    // from state.proj in CSS px, so scale the context by dpr and keep drawing in
    // CSS coordinates. setTransform (not scale) so repeated calls don't compound.
    const dpr = rawDpr();
    const cw = cssWidth(), ch = cssHeight();
    overlay.width = Math.round(cw * dpr);
    overlay.height = Math.round(ch * dpr);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, cw, ch);
    if (!state.proj) return;
    // The desert plate rides on THIS canvas, under the rings, and nowhere
    // else. It is static geometry — it changes only when the camera does,
    // which is exactly this function's repaint trigger — so drawing it per
    // rAF frame in the GL path would re-project ~100k–630k segments 60x a
    // second to produce an identical image. Off-mode this is a no-op, so the
    // ripple and Life paths are untouched in both directions.
    drawDesertLayer();
    if (state.district) {
      const a = selectionAlpha(state.district.bbox);
      if (a > 0.01) {
        octx.strokeStyle = `rgba(255,255,255,${(0.14 * a).toFixed(3)})`;
        octx.lineWidth = 1;
        ringPath(state.district.ring);
        octx.stroke();
      }
    }
    if (state.hoverDistrict && state.hoverDistrict !== state.district) {
      octx.strokeStyle = "rgba(111,211,230,0.35)"; // #6fd3e6 pre-glow
      octx.lineWidth = 1.5;
      ringPath(state.hoverDistrict.ring);
      octx.stroke();
    }
  }

  // ---- the desert plate ----------------------------------------------------
  //
  // Deserts mode's one visual decision, named here rather than inlined at the
  // call site so the whole register is reviewable in one place.
  //
  // #8a8578 is a warm grey — desaturated, no hue that reads as a warning, and
  // far from the palette's cyan/amber service colours so it can never be
  // mistaken for a mode. At alpha 0.55 over the #101420 canvas it settles just
  // above the ground rather than sitting on top of it. 0.8 px is at or under
  // the ripple layer's stroke weight, so the inverted plate is never the
  // busier of the two images.
  //
  // Deliberately NOT alarm-coloured. A desert here means "more than a
  // horizon_sec walk from any stop" (300 s == 5 minutes in the shipped bake) —
  // a statement about walking distance, not about danger or unreachability.
  const DESERT_STYLE = { colour: "#8a8578", alpha: 0.55, width: 0.8 };

  // The register is ABSENCE (workspace rule #7 / the spec's §3.4). Deserts are
  // a muted warm grey at low alpha over the dark canvas — a ground the eye
  // reads as unlit, not a hazard overlay. Two consequences worth stating
  // because they look like omissions:
  //
  //   * REACHED STREETS ARE NOT DRAWN. The negative space IS the image. A
  //     "here is the network, and here is the hole in it" two-layer plate
  //     would make the hole a highlight, which is the reading this mode
  //     exists to avoid.
  //   * The stroke is 0.8 px, at or under the ripple layer's weight, so
  //     inverting the mode does not make the plate busier than the mode it
  //     inverts.
  //
  // Called only from drawDistrictOutline (the overlay's one repaint path), so
  // it must be a cheap no-op in every other mode and before the bitmaps land.
  function drawDesertLayer() {
    if (state.mode !== "deserts") return;
    const bits = session.desertBits;
    if (!bits || bits.size === 0) return;
    const project = state.proj.fn;
    for (const [name, cellBits] of bits) {
      const segs = d.streets[name];
      if (!segs) continue; // a subarea with a bitmap but no geometry: skip, do not throw mid-paint
      drawDeserts(octx, segs, cellBits, project, DESERT_STYLE);
    }
  }

  // ---- the subarea ranking -------------------------------------------------
  //
  // Rendered into the EXISTING #district-panel body rather than a parallel
  // panel, and out of the panel's own classes (.dp-city for the heading,
  // .dp-empty's muted register for the rows) — a second right-hand panel would
  // fight the place navigator for the same edge.
  //
  // PER SUBAREA, not per district: districts.json exists for Helsinki alone,
  // so a district ranking would be a Helsinki-only feature wearing a
  // twelve-city name. Helsinki shows four rows; every other city shows one.
  // That is a deliberate, narrower substitution, stated in the spec (§3.4).
  //
  // Idempotent and self-removing: it drops any previously rendered block
  // first, so leaving the mode (or re-entering it) can call it unconditionally.
  //
  // It also OWNS THE PANEL'S OPEN STATE while Deserts is active, because
  // rendering the rows is not the same as showing them: #district-panel is
  // collapsed by default (it is the vertical "PLACES" tab), so the first
  // version of this shipped a correct #dp-deserts measuring 0x0 that no user
  // would ever see. Presence is not visibility — the live gate now measures a
  // rect, not an element.
  //
  // The user's own preference is remembered in desertPanelWasOpen and put back
  // on the way out, so entering and leaving Deserts leaves the panel exactly as
  // they had it. Auto-open goes through placePanel.setOpen() rather than poking
  // `hidden`, so the body/.open/aria triple stays consistent (panel.js owns it).
  let desertPanelWasOpen = null; // null = we have not auto-opened
  function renderDesertPanel() {
    const body = panelRoot ? panelRoot.querySelector("#dp-body") : null;
    if (!body) return;
    body.querySelector("#dp-deserts")?.remove();
    if (state.mode !== "deserts") {
      // Leaving: restore whatever the user had before we auto-opened. Only
      // ever touches the panel if WE were the one who opened it.
      if (desertPanelWasOpen !== null) {
        if (!desertPanelWasOpen) placePanel.setOpen(false);
        desertPanelWasOpen = null;
      }
      return;
    }
    const listEl = body.querySelector("#dp-list");
    const rows = rankSubareas(session.deserts);
    if (rows.length === 0) return;

    const wrap = document.createElement("div");
    wrap.id = "dp-deserts";
    const head = document.createElement("div");
    head.className = "dp-city";
    head.textContent = "Desert share";
    wrap.appendChild(head);

    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "dp-desert-row";
      const name = document.createElement("span");
      name.className = "dp-desert-name";
      name.textContent = r.name;
      const pct = document.createElement("span");
      pct.className = "dp-desert-pct";
      pct.textContent = `${(r.fraction * 100).toFixed(1)}%`;
      const cells = document.createElement("span");
      cells.className = "dp-desert-cells";
      // desert / total, both stated: a bare percentage of an unstated
      // denominator invites comparing Kauniainen's 2,521 cells with
      // Helsinki's 117,343 as if they were the same kind of number.
      cells.textContent =
        `${r.desert.toLocaleString()} / ${r.cells.toLocaleString()}`;
      row.append(name, pct, cells);
      wrap.appendChild(row);
    }
    // Inserted BEFORE #dp-list, as its sibling. Both halves of that matter:
    //
    //   * before — this is the mode's headline number, and Helsinki's place
    //     list is ~80 rows inside a scrolling panel. Appended to the end it
    //     rendered correctly and was invisible without a long scroll, which
    //     is the same as not shipping it. Verified by looking at the open
    //     panel, not by asserting the rows exist in the DOM.
    //   * sibling, not child — panel.js's render() does `listEl.textContent =
    //     ""` on every search keystroke and every row click. Anything placed
    //     INSIDE #dp-list would be wiped by the next keypress; a sibling of it
    //     is untouched.
    body.insertBefore(wrap, listEl ?? null);

    // Now make it visible. Remember the user's state on the FIRST auto-open
    // only (re-entering the mode without leaving must not overwrite the
    // remembered value with our own opened state), and never focus the search
    // box — the user asked for a mode, not a text field, and stealing focus
    // there would swallow the next Space as a keystroke instead of a pause.
    if (desertPanelWasOpen === null) desertPanelWasOpen = placePanel.isOpen();
    placePanel.setOpen(true);
  }

  // ---- place tree panel: navigation + highlight only ----------------------
  state.hoverDistrict = null; // pre-glow outline (hover), independent of selection

  // setHighlightOutline/setHoverOutline take a place-tree node (same
  // {bbox, ring} shape the old schema-2 district entries had), so
  // drawDistrictOutline needs no change.
  function setHighlightOutline(node) {
    state.district = node;
    drawDistrictOutline();
  }
  function setHoverOutline(node) {
    state.hoverDistrict = node;
    drawDistrictOutline();
  }

  const panelRoot = document.getElementById("district-panel");
  const placePanel = createPlacePanel(panelRoot, {
    tree: placeTree,
    cities: registry ? registry.cities : [],
    activeSlug: slug,
    onSelect: (node) => focusPlace(node),
    onCity: (nextSlug) => onSelectCity(nextSlug),
    onHover: (node) => setHoverOutline(node),
    // Session-scoped: without this the detached rows from the previous city
    // keep their handlers alive, pinning the old boot scope (and its ~20 MB
    // data bundle) even after teardown() nulls session.data.
    signal: abort.signal,
  });
  session.panel = placePanel;

  // The #overlay canvas persists across boots, so the previous city's district
  // ring would stay painted until some later hover/selection repaint. state is
  // fresh here (no district, no hover), so this call clears and draws nothing.
  drawDistrictOutline();

  fitProjection();

  // ---- camera input: drag = pan, wheel = zoom-about-cursor, pinch = zoom.
  // Attached to #overlay's parent stack via window-level pointer events on
  // the canvas (the overlay canvas is pointer-events:none). Any manual
  // camera input cancels an in-flight fly-to (the user grabbed the wheel).
  // Camera is LOCKED while the intro card or the guided tour is showing (the
  // canvas still receives pointer events under that chrome).
  const pointers = new Map(); // pointerId -> {x, y}
  let lastPinchDist = null;

  canvas.addEventListener("pointerdown", (e) => {
    if (!introEl.hidden || !stepperEl.hidden) return; // camera locked during intro/tour
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    flyAnim = null;
  }, { signal: abort.signal });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      panBy(camera, -(e.clientX - p.x), -(e.clientY - p.y));
      syncProjection();
    } else if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY; // update first, measure both below
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinchDist !== null && dist > 0) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        zoomAboutPoint(camera, mx, my, dist / lastPinchDist);
        syncProjection();
      }
      lastPinchDist = dist;
      return; // don't fall through to the single-pointer position update
    }
    p.x = e.clientX; p.y = e.clientY;
  }, { signal: abort.signal });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinchDist = null;
  };
  canvas.addEventListener("pointerup", endPointer, { signal: abort.signal });
  canvas.addEventListener("pointercancel", endPointer, { signal: abort.signal });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault(); // always stop page-scroll, even while locked
    if (!introEl.hidden || !stepperEl.hidden) return; // camera locked during intro/tour
    flyAnim = null;
    const factor = Math.exp(-e.deltaY * 0.0015); // smooth, ~1.16x per notch
    zoomAboutPoint(camera, e.clientX, e.clientY, factor);
    syncProjection();
  }, { passive: false, signal: abort.signal });

  canvas.addEventListener("dblclick", (e) => {
    if (!introEl.hidden || !stepperEl.hidden) return; // camera locked during intro/tour
    flyAnim = null;
    zoomAboutPoint(camera, e.clientX, e.clientY, 1.6);
    syncProjection();
  }, { signal: abort.signal });

  // ---- clock / scrubber formatting ---------------------------------------
  function formatClock(t) {
    const s = t + manifest.sim_origin_sec; // seconds since midnight
    const hh = Math.floor(s / 3600) % 24;
    const mm = Math.floor((s % 3600) / 60);
    return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
  }
  // The scrubber is SHARED: in ripple mode its fraction is a position in the
  // sim-time window; in Life mode it is a position in the 121-frame
  // (120-generation) stream. One widget, two axes, selected by state.mode — this is what lets
  // Life ship with no new UI beyond the toggle.
  function updateScrubberFromT() {
    if (state.mode === "life") {
      scrubberEl.value = String(lifePosToFrac(state.lifePos, lifeNFrames()));
      return;
    }
    const frac = (state.t - dataMin) / dataSpan;
    scrubberEl.value = String(Math.min(1, Math.max(0, frac)));
  }

  const DAYPART_ICONS = { sun: "☀", rise: "↗", midday: "●", fall: "↘", moon: "☾" };
  function syncDaypartChrome() {
    const rippleMode = state.mode === "ripples";
    if (daypartMarkersEl) daypartMarkersEl.hidden = !rippleMode;
    if (clockDaypartEl) clockDaypartEl.textContent = rippleMode ? activeDayPart(dayParts, state.t) : "";
  }
  function jumpRippleTo(t) {
    state.t = Math.min(dataMax, Math.max(dataMin, t));
    state.sePtr = lowerBound(eventTime, state.t);
    field.resize(canvas.width, canvas.height);
    clearActiveEvents();
    updateScrubberFromT();
    clockEl.textContent = formatClock(state.t);
    syncDaypartChrome();
  }
  if (daypartMarkersEl) {
    daypartMarkersEl.replaceChildren();
    for (const part of dayParts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "daypart-marker";
      button.textContent = DAYPART_ICONS[part.icon] || "•";
      button.style.setProperty("--pos", String(markerPosition(part.anchor_sec, dataMin, dataMax)));
      button.title = part.title;
      button.setAttribute("aria-label", part.title);
      button.disabled = !part.enabled;
      if (part.enabled) button.addEventListener("click", () => jumpRippleTo(part.anchor_sec), { signal: abort.signal });
      daypartMarkersEl.append(button);
    }
  }
  syncDaypartChrome();
  // scrubber -> t (hard jump: clear the field, resync sePtr)
  scrubberEl.addEventListener("input", () => {
    const frac = parseFloat(scrubberEl.value);
    // No time axis in Deserts (see skipBy) — a drag there must not silently
    // move the ripple clock under a plate that does not depend on it. The
    // handle is left wherever the user dragged it; updateScrubberFromT() puts
    // it back on state.t the moment Ripples is re-entered.
    if (state.mode === "deserts") return;
    if (state.mode === "life") {
      // Life scrub: reposition the generation clock. No field clear is needed
      // (Life re-stamps from scratch every frame from the frame data alone,
      // carrying no in-flight state), but the seed hold is cancelled — a user
      // who deliberately dragged the handle has asked to be somewhere, and
      // holding them at generation 0 afterwards would fight the input.
      state.lifePos = lifeFracToPos(frac, lifeNFrames());
      state.lifeHoldSec = 0;
      clockEl.textContent = lifeClockText();
      return;
    }
    jumpRippleTo(dataMin + frac * dataSpan);
  }, { signal: abort.signal });

  // ---- speed / pause controls ---------------------------------------------
  function applySpeed(next) {
    state.speed = next;
    if (speedReadout) speedReadout.textContent = `${next}×`;
  }
  document.getElementById("speed-up")?.addEventListener("click",
    () => applySpeed(stepSpeed(state.speed, +1)), { signal: abort.signal });
  document.getElementById("speed-down")?.addEventListener("click",
    () => applySpeed(stepSpeed(state.speed, -1)), { signal: abort.signal });

  // ---- Life mode: clock + mode switching (Task 4, extended Task 5) ---------
  // session.life is a Map<subareaName, decodedStream> (Task 5); every subarea
  // has the same nFrames (Task 4's bake pins all four to one generation
  // clock), so any one stream in the Map answers "how many generations".
  function lifeNFrames() {
    if (!session.life || session.life.size === 0) return 1;
    return session.life.values().next().value.nFrames;
  }

  // Generations per WALL-CLOCK second at the current speed chip. The chips
  // keep their meaning (faster is faster) without letting 300x turn 121 frames
  // into a 0.1 s strobe: the rate is anchored so the DEFAULT chip (60x) plays
  // at LIFE_GENS_PER_SEC.
  function lifeGensPerSec() {
    const s = Number.isFinite(state.speed) && state.speed > 0 ? state.speed : LIFE_SPEED_REF;
    return LIFE_GENS_PER_SEC * (s / LIFE_SPEED_REF);
  }

  // Clock readout while Life is active. When bound to a real timetable, the wall
  // clock reads as the sim-time (e.g. 03:47). When no timetable meta is available,
  // falls back to a bare generation label.
  function lifeClockText() {
    if (!session.life || session.life.size === 0) return "Life…";
    const nFrames = lifeNFrames();
    const { gen } = lifeSplit(state.lifePos, nFrames);
    const label = gen === 0
      ? `Seed · ${lifeWallClock(0, session.lifeMeta)}`
      : lifeWallClock(gen, session.lifeMeta);
    return label;
  }

  // Three modes now, so "active" can no longer be derived from one boolean:
  // `!isLife` used to mean Ripples, and with Deserts on the rail that would
  // light Ripples up while Deserts is showing. Each button compares against
  // state.mode directly.
  function syncModeButtons() {
    const pairs = [
      [modeRipplesEl, "ripples"],
      [modeLifeEl, "life"],
      [modeDesertsEl, "deserts"],
    ];
    for (const [el, mode] of pairs) {
      if (!el) continue;
      const on = state.mode === mode;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
    }
  }

  // Enter/leave a non-Ripples mode. Leaving is the important half: it must put
  // ripple mode back exactly as it was, which means resyncing the sim cursor to
  // state.t (it stopped advancing while the other mode owned the clock, so
  // every event between sePtr and now is stale) and dropping any in-flight
  // wavefronts, the same hard-jump idiom the scrubber and ±15m handlers use.
  // Nothing about the ripple render path itself is touched, in any direction.
  //
  // THREE branches now, and the shape matters: "life" and "deserts" each own
  // their enter path, and the `else` REMAINS the single ripples-restore path.
  // Deserts stops the ripple clock exactly as Life does — it is a static plate
  // with no time axis at all — so it needs the same restore on the way out,
  // and gets it by falling into the same else. Any future mode must be added
  // as another named branch above, never by widening the else.
  async function setMode(next) {
    if (next === state.mode) return;
    if (next === "life") {
      state.mode = "life";
      syncModeButtons();
      syncDaypartChrome();
      // showLoading is REFCOUNTED, so acquire and release must be BALANCED:
      // the spinner is only taken when this call will actually fetch, and the
      // `finally` guarantees it is handed back exactly once on every exit path
      // (success, throw, or an early return added later). An unbalanced pair
      // here would leak a count and pin the spinner on forever.
      const spinning = session.life === null;
      if (spinning) showLoading(true);
      let streams;
      try {
        streams = await loadLifeForSession(slug);
      } catch (err) {
        console.error("life: load failed", err);
        if (statusEl) statusEl.textContent = `Life unavailable: ${err.message}`;
        setMode("ripples"); // fall back to what definitely works
        return;
      } finally {
        if (spinning) showLoading(false);
      }
      // A mode flip (or a city switch) while the fetch was in flight — do not
      // clobber whatever the user asked for last. With the refcount above, a
      // superseded session releasing its own spinner cannot hide the spinner
      // the CURRENT session is still holding.
      if (currentSession !== session || state.mode !== "life") return;
      // precomputeDeaths is a ONE-TIME O(nFrames x cellCount) pass. Building it
      // per frame would reintroduce exactly the cost lifeview.js's contract
      // exists to prevent, so it is memoized. One DeathIndex per subarea. Still
      // keyed on the STREAM OBJECT it was derived from, not merely on
      // presence: an index is only valid for the frames it was built from, so
      // identity-keying stops a re-fetched or swapped stream from silently
      // reusing the wrong index. With four subareas the key must be per-name —
      // a single memo would hand whichever subarea was built last to all of
      // them.
      for (const [name, stream] of streams) {
        if (state.lifeDeathsFor.get(name) !== stream) {
          state.lifeDeaths.set(name, precomputeDeaths(stream));
          state.lifeDeathsFor.set(name, stream);
        }
        // precomputeLastMode is the afterglow-colour fix: the wire format
        // never carries a dead cell's mode (pack_modes is sparse over LIVE
        // cells only), so a fading cell's true colour has to be remembered
        // by the renderer across generations, not read from that frame's
        // mode section. Same memoization shape as lifeDeaths above.
        if (state.lifeModesFor.get(name) !== stream) {
          state.lifeModes.set(name, precomputeLastMode(stream));
          state.lifeModesFor.set(name, stream);
        }
      }
      state.lifePos = 0;
      state.lifeHoldSec = LIFE_SEED_HOLD_SEC;
      // The field carries ripple light from the last ripple frame; clear it so
      // Life does not open on a fading ghost of the other mode.
      field.resize(canvas.width, canvas.height);
      updateScrubberFromT();
      clockEl.textContent = lifeClockText();
      syncDaypartChrome();
      // Life can be entered FROM Deserts, so the desert plate and its ranking
      // rows have to be taken down here too, not only on the way to Ripples.
      renderDesertPanel();
      drawDistrictOutline();
    } else if (next === "deserts") {
      state.mode = "deserts";
      syncModeButtons();
      syncDaypartChrome();
      // Same refcounted-spinner contract as the Life branch above: take the
      // spinner only when this call will actually fetch, and hand it back
      // exactly once on EVERY exit path via `finally`.
      const spinning = session.desertBits === null;
      if (spinning) showLoading(true);
      try {
        await loadDesertsForSession(slug);
      } catch (err) {
        console.error("deserts: load failed", err);
        if (statusEl) statusEl.textContent = `Deserts unavailable: ${err.message}`;
        setMode("ripples"); // fall back to what definitely works
        return;
      } finally {
        if (spinning) showLoading(false);
      }
      // A mode flip or city switch landed while the fetch was in flight.
      if (currentSession !== session || state.mode !== "deserts") return;
      // Deserts is a STATIC plate: it has no clock, so the ripple field must
      // go dark rather than sit frozen on the last lit frame. state.t is left
      // untouched — the else-branch below is what resyncs sePtr on the way
      // back, exactly as it does for Life.
      field.resize(canvas.width, canvas.height);
      field.present();
      clockEl.textContent = desertLabel(session.deserts?.horizon_sec ?? 300);
      syncDaypartChrome();
      renderDesertPanel();
      // The desert layer lives on the #overlay canvas, which is only repainted
      // on camera change / selection / hover — nothing about entering a mode
      // moves the camera, so the first paint has to be asked for explicitly.
      drawDistrictOutline();
    } else {
      state.mode = "ripples";
      syncModeButtons();
      renderDesertPanel();   // tears the ranking rows back out of the panel
      drawDistrictOutline(); // and the desert layer off the overlay
      // Hand the ripple clock back cleanly: state.t never moved while Life or
      // Deserts was showing, but sePtr is where it was left, and any
      // activeEvents are from before the detour. Same three lines
      // skipBy()/the scrubber use.
      state.sePtr = lowerBound(eventTime, state.t);
      field.resize(canvas.width, canvas.height);
      clearActiveEvents();
      updateScrubberFromT();
      clockEl.textContent = formatClock(state.t);
      syncDaypartChrome();
    }
  }

  // The rail is shown when ANY mode beyond Ripples is available for this city.
  // It used to be `slug !== "helsinki"` because Life is Helsinki-only; Deserts
  // is baked for 11 of 12 cities, so a Helsinki-only rule would hide a mode
  // that works. Each button is enabled independently below.
  //
  // NOTE: #mode-rail is in CHROME_OVERLAY_IDS and now shows for nearly every
  // city, so tests/test_capture_chrome_hidden.py is what keeps it out of
  // captures. It leaked into nine committed loops the last time this was
  // maintained by eye.
  const lifeOk = slug === "helsinki";
  // The subarea names come from the MANIFEST, not from `placeNames`.
  //
  // This block was written (Task 5) against `placeNames`, and that source is
  // wrong in a way no unit test could catch, because the JS test mirrors this
  // rule rather than importing it: `placeNames` is flattenTree(placeTree), and
  // flattenTree deliberately SKIPS the root — it walks `node.children` only
  // (places.js:9). Every deserts subarea name IS a root name ("Helsinki",
  // "Zürich", "Berlin"), so the intersection was empty for all 12 cities and
  // desertAvailable() returned false everywhere. The button was disabled in
  // every city, including the 11 with a good bake; found by driving the live
  // page, not by the suite.
  //
  // manifest.cities is the right source and is exactly the axis the bake
  // partitions on: bake_deserts enumerates subareas from manifest.json's
  // `cities` keys, so these names match deserts.json's `subareas` keys
  // one-for-one by construction, for every city (verified across all 12).
  const subareaNames = Object.keys(manifest.cities || {});
  const desertsOk = desertAvailable(session.deserts, subareaNames);
  if (modeRailEl) {
    modeRailEl.hidden = !(lifeOk || desertsOk);
  }
  if (modeLifeEl) {
    modeLifeEl.disabled = !lifeOk;
    modeLifeEl.setAttribute("aria-disabled", String(!lifeOk));
  }
  if (modeDesertsEl) {
    modeDesertsEl.disabled = !desertsOk;
    modeDesertsEl.setAttribute("aria-disabled", String(!desertsOk));
    modeDesertsEl.title = desertsOk
      ? desertLabel(session.deserts?.horizon_sec ?? 300)
      : "Not available — this city's feed is too sparse to map deserts honestly";
  }
  // Sunlight, unlike Life, applies to EVERY city (per-city latitude is the
  // whole point) — unhide unconditionally rather than mirroring the
  // Helsinki-only restriction above.
  if (sunRailEl) {
    sunRailEl.hidden = false;
    controlRailEl.hidden = false;
  }
  syncModeButtons();
  modeRipplesEl?.addEventListener("click", () => { setMode("ripples"); }, { signal: abort.signal });
  modeLifeEl?.addEventListener("click", () => { setMode("life"); }, { signal: abort.signal });
  modeDesertsEl?.addEventListener("click", () => { setMode("deserts"); }, { signal: abort.signal });

  // Every mode starts visible. This is an INVARIANT MARKER, not a live fix: a
  // city switch tears the whole session down and boot() builds a fresh `state`
  // whose initializer already sets `modeVisible: newVisibility()`, so this
  // assignment is a no-op today and cannot be observed. It is kept so the
  // reset stays adjacent to the row rebuild below -- if `state` ever becomes
  // durable across switches, a stale filter from the previous city (bus hidden
  // in Helsinki, then switching to Porto, which has no bus toggle to restore
  // it with) would be a real bug, and this line is where it is already handled.
  state.modeVisible = newVisibility();

  // Built per CITY, not once at boot: mode_codes is a fixed 5-slot table in
  // every city, so it cannot say what a city runs. Measured 2026-08-13 --
  // porto is metro+bus only, madrid has no train or ferry, paris no ferry.
  // A fixed five-button row would ship dead toggles in three of five cities.
  function buildModeFilter() {
    if (!modeFilterEl) return;
    const present = presentModes(stopMode);
    modeFilterEl.replaceChildren();
    const label = document.createElement("div");
    label.className = "rail-label";
    label.textContent = "Transport";
    modeFilterEl.append(label);
    if (present.length < 2) {
      // One mode (or none) means nothing to filter -- a lone toggle that can
      // only blank the screen is not a control, it is a trap.
      modeFilterEl.hidden = true;
      return;
    }
    for (const m of present) {
      const name = MODE_NAMES[m];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-btn";
      btn.dataset.mode = name;
      btn.setAttribute("aria-pressed", String(isVisible(state.modeVisible, m)));
      btn.setAttribute("aria-label", `Toggle ${name}`);
      btn.title = `Show or hide ${name}`;
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.dataset.modeCode = String(m);
      const [r, g, b] = frameModeColors[m];
      sw.style.setProperty("--swatch",
        `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`);
      btn.append(sw, document.createTextNode(name));
      modeFilterEl.append(btn);
    }
    modeFilterEl.hidden = false;
  }
  buildModeFilter();

  // Delegated listener, registered once per boot() (cleaned up via
  // abort.signal on the next city switch, same idiom as the mode-rail
  // buttons above) rather than once per buildModeFilter() call -- the row is
  // rebuilt on every city switch, so a listener added inside the builder
  // would stack a fresh copy per switch.
  modeFilterEl?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-mode]");
    if (!btn) return;
    const mode = MODE_NAMES.indexOf(btn.dataset.mode);
    if (mode < 0) return;
    const on = !isVisible(state.modeVisible, mode);
    setVisible(state.modeVisible, mode, on);
    btn.setAttribute("aria-pressed", String(on));
    resetModeScratch();
    field.clearField();
  }, { signal: abort.signal });

  // Sun rail: reflects state.sunEnabled/state.sunSeason, which may already be
  // non-default here — either from ?sun=off / ?season=<key> on the FIRST
  // boot, or (on any later boot) restored from `sunPersist`, which carries
  // the user's last click across a city switch (see the state-construction
  // block above). Sync the buttons to the CURRENT state rather than
  // hardcoding the defaults.
  if (sunToggleEl) {
    sunToggleEl.classList.toggle("active", state.sunEnabled);
    sunToggleEl.setAttribute("aria-pressed", String(state.sunEnabled));
  }
  if (sunRailEl) {
    sunRailEl.dataset.sun = state.sunEnabled ? "on" : "off";
  }
  for (const b of sunSeasonEls) {
    const on = b.dataset.season === state.sunSeason;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  sunToggleEl?.addEventListener("click", () => {
    state.sunEnabled = !state.sunEnabled;
    // Keep the module-level carry-over in sync with the click, not just
    // `state` — `state` itself is discarded on the next boot(), so if this
    // choice isn't also written to `sunPersist` here it would still be lost
    // on the very next city switch.
    sunPersist = { sunEnabled: state.sunEnabled, sunSeason: state.sunSeason };
    sunToggleEl.classList.toggle("active", state.sunEnabled);
    sunToggleEl.setAttribute("aria-pressed", String(state.sunEnabled));
    if (sunRailEl) sunRailEl.dataset.sun = state.sunEnabled ? "on" : "off";
  }, { signal: abort.signal });
  for (const btn of sunSeasonEls) {
    btn.addEventListener("click", () => {
      state.sunSeason = btn.dataset.season;
      // Season is baked into the sun state object at construction time, so
      // merely setting state.sunSeason would leave the visuals on the old
      // season — the buttons would appear to do nothing. Rebuild it here,
      // using the SAME slug this boot() call is building for (the `slug`
      // parameter, not a nonexistent state.slug).
      state.sun = buildSunState(slug, state.sunSeason);
      // See the sunToggleEl handler above: persist the choice past this
      // session so the next city switch does not revert it.
      sunPersist = { sunEnabled: state.sunEnabled, sunSeason: state.sunSeason };
      for (const b of sunSeasonEls) {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      }
    }, { signal: abort.signal });
  }

  // View rail: camera-only presets (Task 7, Paris v2.5). Rendered fresh each
  // boot() -- rebuilding rather than diffing is fine, this is at most a
  // handful of buttons and boot() already tears down and rebuilds every other
  // per-city control. Hidden unconditionally (not just left empty) when the
  // active city declares no views, so the twelve cities without one show no
  // new UI at all -- this is the blast-radius requirement for the task.
  const cityViews = (activeEntry && activeEntry.views) || [];
  if (viewRailEl) {
    viewRailEl.textContent = "";
    viewRailEl.hidden = cityViews.length === 0;
    for (const v of cityViews) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-btn";
      btn.textContent = v.label;
      btn.dataset.viewSlug = v.slug;
      const on = v.slug === viewSlug;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
      btn.addEventListener("click", () => {
        const url = new URL(location.href);
        url.searchParams.set("view", v.slug);
        history.replaceState(null, "", url);
        flyToBbox(v.bbox);
        for (const b of viewRailEl.querySelectorAll("button")) {
          const active = b === btn;
          b.classList.toggle("active", active);
          b.setAttribute("aria-pressed", String(active));
        }
      }, { signal: abort.signal });
      viewRailEl.appendChild(btn);
    }
  }

  function setPaused(p) {
    state.paused = p;
    playPauseEl.textContent = p ? "▶" : "⏸";
    playPauseEl.title = p ? "Play (Space)" : "Pause (Space)";
    playPauseEl.setAttribute("aria-pressed", String(p));
  }
  playPauseEl.addEventListener("click", () => setPaused(!state.paused), { signal: abort.signal });
  setPaused(false);
  applySpeed(60);
  if (deepLinkSpeed !== null) applySpeed(deepLinkSpeed);

  // ---- ±15min skip: identical hard-jump idiom to the scrubber handler
  // above (clear the field, resync sePtr, drop stale in-flight wavefronts).
  // In Life mode the ±15m buttons step the GENERATION clock instead. 15 min of
  // sim-time is 1/16 of the ripple window, so the Life step is the same
  // proportion of the Life stream (~12 of 121 frames) — the buttons keep
  // their felt meaning ("jump a chunk") without pretending a generation is a
  // minute. Their labels stay "−15m/+15m"; retitling them per mode would mean
  // new UI, which this task deliberately avoids (see the report).
  const LIFE_SKIP_GENS = 12;

  function skipBy(deltaSec) {
    // Deserts has NO time axis — the plate is a structural statement about the
    // whole baked window, not a moment in it. Skipping there would silently
    // move state.t under a mode that never shows it AND overwrite the desert
    // label on the clock with an HH:MM the image does not correspond to.
    if (state.mode === "deserts") return;
    if (state.mode === "life") {
      const last = Math.max(0, lifeNFrames() - 1);
      const step = Math.sign(deltaSec) * LIFE_SKIP_GENS;
      state.lifePos = Math.min(last, Math.max(0, Math.round(state.lifePos) + step));
      state.lifeHoldSec = 0;
      updateScrubberFromT();
      clockEl.textContent = lifeClockText();
      return;
    }
    state.t = clampSkip(state.t, deltaSec, dataMin, dataMax);
    state.sePtr = lowerBound(eventTime, state.t);
    field.resize(canvas.width, canvas.height); // clears both textures
    clearActiveEvents();
    updateScrubberFromT();
    clockEl.textContent = formatClock(state.t);
  }
  skipBackEl.addEventListener("click", () => skipBy(-900), { signal: abort.signal });
  skipFwdEl.addEventListener("click", () => skipBy(900), { signal: abort.signal });

  // ---- Space toggles pause, unless the user is interacting with an input
  // or a button (native Space-activates-focused-button behavior wins there
  // so we don't fight it / double-toggle).
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "BUTTON") return;
    e.preventDefault();
    setPaused(!state.paused);
  }, { signal: abort.signal });

  // Fly to any node. The ROOT is the region, so "all of <city>" needs no
  // special case -- which is precisely why the Region chip is gone.
  function focusPlace(node) {
    if (!node || !node.bbox) return;
    flyToBbox(node.bbox);
    placePanel.setActive(node.id);
    setHighlightOutline(node);
  }

  // ---- initial cursor position --------------------------------------------
  state.sePtr = lowerBound(eventTime, state.t);
  updateScrubberFromT();
  clockEl.textContent = formatClock(state.t);

  // Headless frame capture hook. Kept behind an explicit query flag so the
  // production app does not expose mutable internals.
  if (new URLSearchParams(location.search).get("capture") === "1") {
    window.__wrCamera = camera;
    // Exposed for the corridor gate's --only=<mode> diagnostic: a faint line
    // cannot be told from its neighbours by eye, so the gate isolates one
    // mode's batches to prove which geometry is actually on screen.
    window.__wrField = field;
    window.__wrCapture = {
      fit(bbox) {
        camera.cx = (bbox[0] + bbox[2]) / 2;
        camera.cy = (bbox[1] + bbox[3]) / 2;
        camera.scale = fitBboxScale(
          bbox, camera.w, camera.h, camera.margin, camera.kx);
        syncProjection();
      },
      // Animated camera move for cinematic captures. Deliberately NOT
      // flyToBbox(): that hardcodes 600ms, and a shot plan chooses its own
      // pacing per keyframe.
      //
      // No field clear and no sePtr resync, matching flyToBbox's own
      // invariant (see its comment above): playback and camera are
      // orthogonal, so the city keeps rippling while the camera travels.
      flyTo(bbox, durationMs) {
        flyAnim = startFlyTo(camera, bbox, durationMs);
      },
      seekClock(secondsSinceMidnight) {
        state.t = Math.min(dataMax, Math.max(
          dataMin, secondsSinceMidnight - manifest.sim_origin_sec));
        state.sePtr = lowerBound(eventTime, state.t);
        field.resize(canvas.width, canvas.height);
        clearActiveEvents();
        updateScrubberFromT();
        clockEl.textContent = formatClock(state.t);
        state.lastFrameTs = performance.now();
      },
      setSpeed(speed) {
        applySpeed(speed);
      },
      // Runtime A/B for the colour-mode comparison. Clears the field so the
      // next frame is drawn wholly in the new mode rather than compositing
      // over stamps accumulated under the previous one.
      setColourMode(mode) {
        if (!COLOUR_MODES.includes(mode)) throw new Error(`unknown colour mode: ${mode}`);
        // The mode filter is defined ONLY for additive. Under identity a shared
        // edge is drawn once by the highest-ranked mode, so hiding that mode
        // would not reveal the others that serve the same edge; under overlap
        // the "how many modes serve this edge" count stops being true the
        // moment one is hidden. Throwing beats silently resetting the filter:
        // this is called by capture tooling, and a silent reset would produce
        // frames that disagree with the operator's filter, discoverable only by eye.
        const hidden = hiddenModeNames(state.modeVisible);
        if (hidden.length) {
          throw new Error(
            `cannot switch colour mode while modes are hidden (${hidden.join(", ")}); ` +
            `reset the mode filter first`);
        }
        state.colourMode = mode;
        resetModeScratch();
        field.clearField();
      },
      // Drives the filter from the live gate and from capture scripts. Takes a
      // NAME rather than a code so a capture script reads legibly and cannot
      // silently target the wrong mode if codes ever move.
      setModeVisible(name, on) {
        const mode = MODE_NAMES.indexOf(name);
        if (mode < 0) throw new Error(`unknown mode: ${name}`);
        setVisible(state.modeVisible, mode, on);
        // Clear so the next frame is drawn wholly under the new filter rather
        // than compositing over stamps accumulated under the old one -- the
        // same reason setColourMode clears.
        resetModeScratch();
        field.clearField();
      },
      getModeVisible() {
        const out = {};
        for (let m = 0; m < MODE_NAMES.length; m++) {
          out[MODE_NAMES[m]] = isVisible(state.modeVisible, m);
        }
        return out;
      },
    };
  }

  // v2.1 intro: ONE dismissible card, sim PLAYING behind it, remembered.
  // The 3-step guided tour still exists — now opt-in behind the ? button.
  function dismissIntro() {
    introEl.hidden = true;
    chromeEl.hidden = false;
    try { localStorage.setItem(INTRO_SEEN_KEY, "1"); } catch (_) {}
    playPauseEl.focus();
  }
  let introSeen = false;
  try { introSeen = localStorage.getItem(INTRO_SEEN_KEY) === "1"; } catch (_) {}
  // A city SWITCH must never re-open the intro card or leave a half-finished
  // guided tour on screen pointing at the previous city's seeded stops: the
  // user already pressed a picker chip, which is an explore action. Only the
  // very first boot of the page consults INTRO_SEEN_KEY.
  if (isSwitch) {
    introEl.hidden = true;
    stepperEl.hidden = true;
    chromeEl.hidden = false;
  } else if (introSeen) {
    introEl.hidden = true;
    chromeEl.hidden = false;
  } else {
    introBeginEl.focus();
  }
  if (deepLinkArea !== null || deepLinkPlace !== null || deepLinkTime !== null) {
    introEl.hidden = true;
    chromeEl.hidden = false;
  }
  if (deepLinkPlace !== null) {
    const node = findById(placeTree, deepLinkPlace);
    if (node) focusPlace(node);
  } else if (deepLinkArea !== null) {
    // Back-compat: ?area=<name>, case-insensitive, first match wins.
    const want = deepLinkArea.toLowerCase();
    const hit = flattenTree(placeTree).find((r) => r.name.toLowerCase() === want);
    if (hit) focusPlace(hit.node);
  }
  introBeginEl.addEventListener("click", dismissIntro, { signal: abort.signal });

  helpBtnEl.addEventListener("click", () => {
    const wasPaused = state.paused;
    chromeEl.hidden = true;
    // The guided tour teaches RIPPLES — it seeds stop isochrones, which the
    // Life branch of frame() would never draw. Leave Life first so the tour
    // shows what its captions describe instead of a blank field.
    setMode("ripples");
    beginStory(); // 3-step tour; steps 1-2 pause (as designed, now opt-in)
    tourResumePaused = wasPaused;
  }, { signal: abort.signal });

  // Credits: a licence obligation (HSL = CC BY 4.0, streets = ODbL), so the
  // dialog must stay reachable. Unlike the tour it does NOT touch the clock or
  // the chrome — it overlays, so dismissing it returns you exactly where you
  // were. Listeners carry abort.signal so a city switch tears them down with
  // everything else (the Phase B leak lesson).
  if (creditsBtnEl && creditsEl) {
    const closeCredits = () => { creditsEl.hidden = true; creditsBtnEl.focus(); };
    creditsBtnEl.addEventListener("click", () => {
      creditsEl.hidden = false;
      if (creditsCloseEl) creditsCloseEl.focus(); // keyboard users land inside
    }, { signal: abort.signal });
    if (creditsCloseEl) {
      creditsCloseEl.addEventListener("click", closeCredits, { signal: abort.signal });
    }
    creditsEl.addEventListener("click", (e) => {
      if (e.target === creditsEl) closeCredits(); // click the backdrop to dismiss
    }, { signal: abort.signal });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !creditsEl.hidden) closeCredits();
    }, { signal: abort.signal });
  }

  // Fullscreen. requestFullscreen rejects if not user-initiated; a click
  // handler satisfies that, and a rejection must not break playback.
  const fsBtn = document.getElementById("fullscreen-btn");
  fsBtn?.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch((e) =>
      console.warn("fullscreen refused", e));
  }, { signal: abort.signal });

  function wakeChrome() {
    document.body.classList.remove("chrome-hidden");
    clearTimeout(session.idleTimer);
    if (document.fullscreenElement) {
      session.idleTimer = setTimeout(() => document.body.classList.add("chrome-hidden"), 2600);
    }
  }
  document.addEventListener("mousemove", wakeChrome, { signal: abort.signal });
  document.addEventListener("fullscreenchange", wakeChrome, { signal: abort.signal });

  // ---- guided intro: 3-step click-stepper (Task 10) -----------------------
  // Bremer/Visual Cinnamon click-stepper: a step counter + a single "Next"
  // button. The user drives the pace; nothing hijacks scroll or auto-advances
  // on a timer. Each step is a small script over the SAME state/field the
  // free-explore chrome uses, so "Explore" at the end is a plain handoff —
  // no separate demo mode to fall out of sync with.
  // Guided steps 1-2 confine the projection to the TOP portion of the canvas
  // (clear of the bottom-anchored #stepper-card) so the seeded Helsinki-stop
  // ripple never lands directly underneath the opaque card — it lit up
  // correctly all along, just hidden behind the chrome. See STORY_TOP_FRAC.
  const STORY_STEPS = [
    {
      caption: "One stop, one ripple — the streets a rider can reach on foot in three minutes.",
      run() {
        setPaused(true);
        // Top-cropped STATIC projection for the seeded ripple (clear of the
        // bottom stepper card) — the camera is bypassed during the tour.
        introProj = makeProjection(bboxObj(introBbox), cssWidth(),
                                   cssHeight() * STORY_TOP_FRAC, 24);
        syncProjection();
        field.resize(canvas.width, canvas.height);
        seedStopRipple(STORY_STOP_SOLO);
      },
    },
    {
      caption: "Where two ripples meet, they add — brighter means more reachable. This tram stop and bus stop sit metres apart; their walking-reach overlaps.",
      run() {
        setPaused(true);
        // stays focused on Helsinki from step 1 (same top-cropped projection);
        // re-stamp fresh so the solo ripple's decay doesn't dim the pair
        // unevenly.
        field.resize(canvas.width, canvas.height);
        seedStopRipple(STORY_STOP_PAIR);
      },
    },
    {
      caption: "Now the whole morning — thousands of ripples, the city breathing in light.",
      run() {
        introProj = null;         // hand the view back to the free camera
        focusPlace(placeTree);    // the root IS the region -- no special case
        applySpeed(60);
        setPaused(false);
      },
    },
  ];
  let storyStep = 0;
  let tourResumePaused = false;

  function renderStep() {
    stepNumEl.textContent = String(storyStep + 1);
    const step = STORY_STEPS[storyStep];
    stepCaptionEl.textContent = step.caption;
    step.run();
    const isLast = storyStep === STORY_STEPS.length - 1;
    stepNextEl.hidden = isLast;
    stepExploreEl.hidden = !isLast;
    (isLast ? stepExploreEl : stepNextEl).focus();
  }

  function beginStory() {
    introEl.hidden = true;
    stepperEl.hidden = false;
    storyStep = 0;
    renderStep();
  }

  function endStory() {
    // A user who exits the tour early via Explore (mid step 1/2) must get
    // the free camera back — introProj may still be set to the top-cropped
    // override.
    introProj = null;
    syncProjection();
    stepperEl.hidden = true;
    chromeEl.hidden = false;
    // Hand off cleanly to free-explore: resync the sim cursor to "now" so
    // playback continues forward from state.t instead of re-sweeping
    // whatever the scripted steps left sePtr pointing at.
    state.sePtr = lowerBound(eventTime, state.t);
    setPaused(tourResumePaused); // restore whatever play state ? was clicked in
    playPauseEl.focus();
  }

  stepNextEl.addEventListener("click", () => {
    if (storyStep < STORY_STEPS.length - 1) {
      storyStep++;
      renderStep();
    }
  }, { signal: abort.signal });
  stepExploreEl.addEventListener("click", endStory, { signal: abort.signal });

  // Per-mode scratch buffers -- PRE-SIZED Float32Arrays plus explicit write
  // indices, NOT plain JS arrays.
  //
  // These were `[[], [], ...]` and flushStamps did Float32Array.from() on each
  // one, so the "reused across frames" claim was defeated: up to 15 fresh
  // typed arrays were allocated and copied EVERY frame. Now the arrays are
  // allocated once and only the write index resets. Capacity grows on demand
  // (doubling) and never shrinks, so it self-tunes to the worst-case city and
  // is allocation-free in steady state.
  //
  // modeCount[m] counts VERTICES (2 per edge), matching what field.stamp()
  // needs for gl.drawArrays. segs holds 2 floats per vertex; delays/ages hold
  // 1 float per vertex.
  const MODE_N = 5;
  const segCap = 4096; // initial capacity, vertices
  const modeSegs = Array.from({ length: MODE_N }, () => new Float32Array(segCap * 2));
  const modeDelays = Array.from({ length: MODE_N }, () => new Float32Array(segCap));
  const modeAges = Array.from({ length: MODE_N }, () => new Float32Array(segCap));
  // Per-vertex capacity-weighted intensity (Task 3), same footing as
  // modeDelays/modeAges: pre-sized, grown-never-shrunk, one float per vertex.
  // Normalized to 0..1 in pushEdge (see the stampIntensity comment there).
  const modeIntens = Array.from({ length: MODE_N }, () => new Float32Array(segCap));
  const modeCount = new Uint32Array(MODE_N); // vertices written this pass

  // Grow mode m's buffers to hold at least `needVerts` vertices, preserving
  // what is already written (a frame can outgrow capacity mid-pass).
  function ensureModeCap(m, needVerts) {
    if (needVerts <= modeDelays[m].length) return;
    let cap = modeDelays[m].length;
    while (cap < needVerts) cap *= 2;
    const s = new Float32Array(cap * 2); s.set(modeSegs[m]); modeSegs[m] = s;
    const d = new Float32Array(cap); d.set(modeDelays[m]); modeDelays[m] = d;
    const a = new Float32Array(cap); a.set(modeAges[m]); modeAges[m] = a;
    const it = new Float32Array(cap); it.set(modeIntens[m]); modeIntens[m] = it;
  }

  // ---- Overlap-mode scratch ------------------------------------------------
  // Same discipline as the per-mode buffers above (allocate once, explicit
  // cursor, grow by doubling, never shrink). Bucketed by OVERLAP CLASS -- how
  // many distinct modes serve the edge (1..4) -- not by mode, so every batch is
  // homogeneous in class and one uniform colour is truthful for it. Only
  // populated while state.colourMode === "overlap"; otherwise it stays at its
  // initial allocation and costs nothing per frame.
  const OVERLAP_N = 4;
  const overlapSegs = Array.from({ length: OVERLAP_N }, () => new Float32Array(segCap * 2));
  const overlapDelays = Array.from({ length: OVERLAP_N }, () => new Float32Array(segCap));
  const overlapAges = Array.from({ length: OVERLAP_N }, () => new Float32Array(segCap));
  const overlapIntens = Array.from({ length: OVERLAP_N }, () => new Float32Array(segCap));
  const overlapCount = new Uint32Array(OVERLAP_N);

  function ensureOverlapCap(c, needVerts) {
    if (needVerts <= overlapDelays[c].length) return;
    let cap = overlapDelays[c].length;
    while (cap < needVerts) cap *= 2;
    const s = new Float32Array(cap * 2); s.set(overlapSegs[c]); overlapSegs[c] = s;
    const d = new Float32Array(cap); d.set(overlapDelays[c]); overlapDelays[c] = d;
    const a = new Float32Array(cap); a.set(overlapAges[c]); overlapAges[c] = a;
    const it = new Float32Array(cap); it.set(overlapIntens[c]); overlapIntens[c] = it;
  }

  // Reset all write indices. Replaces the three `for (const arr of ...)
  // arr.length = 0` loops -- the buffers are retained, only the cursor moves.
  function resetModeScratch() {
    modeCount.fill(0);
    overlapCount.fill(0);
  }

  // ---- Life scratch buffers (Task 4) --------------------------------------
  // Same shape and same discipline as the per-mode ripple scratch above:
  // Float32Arrays allocated ONCE with an explicit write cursor, grown by
  // doubling, never shrunk, never re-allocated per frame. Colour is a
  // per-draw-call uniform (field.js's gl.uniform3fv), so per-mode colour
  // needs one stamp() call per mode -- Life gets the SAME array-of-slots
  // shape as the ripple path's modeSegs/modeDelays/modeAges above, indexed
  // by LIFE_MODE_SLOTS rather than MODE_N.
  //
  // Life is a SEPARATE buffer set rather than borrowing modeSegs[] because the
  // two passes coexist in the frame ordering below: keeping them apart means
  // the ripple path's buffers are never touched in Life mode, which is what
  // makes "switch to Life and back" provably not corrupt ripple state.
  const lifeSegs = Array.from({ length: LIFE_MODE_SLOTS }, () => new Float32Array(LIFE_SEG_CAP * 4));
  const lifeAlphas = Array.from({ length: LIFE_MODE_SLOTS }, () => new Float32Array(LIFE_SEG_CAP * 2));
  const lifeAges = Array.from({ length: LIFE_MODE_SLOTS }, () => {
    const a = new Float32Array(LIFE_SEG_CAP * 2);
    a.fill(LIFE_AGE);
    return a;
  });
  const lifeCounts = new Uint32Array(LIFE_MODE_SLOTS); // vertices written this frame, per slot

  function ensureLifeCap(m, needVerts) {
    if (needVerts <= lifeAlphas[m].length) return;
    let cap = lifeAlphas[m].length;
    while (cap < needVerts) cap *= 2;
    const s = new Float32Array(cap * 2); s.set(lifeSegs[m]); lifeSegs[m] = s;
    const a = new Float32Array(cap); a.set(lifeAlphas[m]); lifeAlphas[m] = a;
    // lifeAges[m] is a constant field, so it is refilled wholesale rather than
    // copied — every vertex carries the same LIFE_AGE.
    lifeAges[m] = new Float32Array(cap); lifeAges[m].fill(LIFE_AGE);
  }

  // Alpha below which a cell is not worth a draw call's worth of vertices.
  //
  // The threshold is on the RENDERED contribution, not the raw view-model
  // alpha, so it must account for LIFE_STAMP_GAIN: a raw alpha of 1/255 leaves
  // the shader at 1/255 * 0.5625, which the 8-bit present output rounds to
  // zero — it would cost two vertices to draw nothing. Dividing the 1/255
  // display floor by the gain puts the cut exactly where a cell stops being
  // able to colour a pixel.
  //
  // HISTORICAL NOTE, kept because it explains why this constant is written the
  // way it is. This epsilon is also the value lifeview.js sizes its afterglow
  // decay against, and the two used to disagree: lifeview treated its 0.5 s
  // "horizon" as the exponential TIME CONSTANT, so cells only reached this
  // floor after ln(1/EPS) = 4.97 time constants = 2.48 s. Measured in the
  // browser, that kept ~69,000 cells drawn for ~15 generations after they
  // died, and made generation 1 render identically to the generation-0 seed
  // (IoU 0.986). lifeview.js now divides by ln(1/EPS) so the horizon is a true
  // visibility horizon; the two constants agree, and the tail is ~3
  // generations at 6 gen/s as documented at LIFE_GENS_PER_SEC above.
  //
  // If LIFE_STAMP_GAIN changes, lifeview.js's RENDER_ALPHA_EPS must change with
  // it — web/tests/lifeview.test.mjs pins both to the same value.
  const LIFE_ALPHA_EPS = (1 / 255) / LIFE_STAMP_GAIN;

  // Push one cell's street edge into the Life scratch. Cell i maps 1:1 onto
  // street_Helsinki_seg.bin[4i .. 4i+4] — that identity is asserted at load
  // time by loadLifeForSession (decoded cellCount vs seg.length/4), so no
  // spatial join and no bounds check is needed here beyond the alpha gate.
  //
  // `alpha` rides in on the shader's `delay` attribute; see LIFE_PARAMS for
  // why that renders as exactly `alpha`.
  //
  // `slot` selects which of the LIFE_MODE_SLOTS buckets this cell's vertices
  // land in -- exactly one bucket, never several, which is what keeps
  // LIFE_STAMP_GAIN's no-blow-out property intact (see LIFE_MODE_SLOTS above).
  function pushLifeCell(segArr, i, alpha, slot) {
    const base = 4 * i;
    const ax = segArr[base], ay = segArr[base + 1];
    const bx = segArr[base + 2], by = segArr[base + 3];

    // Same conservative viewport cull as pushEdge: reject only when the edge's
    // own bbox lies wholly outside the inflated view.
    if (cullBbox !== null) {
      const [cw, cs, ce, cn] = cullBbox;
      if ((ax < cw && bx < cw) || (ax > ce && bx > ce) ||
          (ay < cs && by < cs) || (ay > cn && by > cn)) return;
    }

    const n = lifeCounts[slot];
    ensureLifeCap(slot, n + 2);
    const cam = state.proj.cam;
    if (cam) {
      projectInto(cam, ax, ay, lifeSegs[slot], n * 2);
      projectInto(cam, bx, by, lifeSegs[slot], n * 2 + 2);
    } else {
      const [pax, pay] = state.proj.fn(ax, ay);
      const [pbx, pby] = state.proj.fn(bx, by);
      lifeSegs[slot][n * 2] = pax; lifeSegs[slot][n * 2 + 1] = pay;
      lifeSegs[slot][n * 2 + 2] = pbx; lifeSegs[slot][n * 2 + 3] = pby;
    }
    // The shader's `delay` attribute carries the GAIN-SCALED alpha (see
    // LIFE_STAMP_GAIN). The caller's cull/epsilon test uses the raw alpha, so
    // "is this cell worth drawing" stays a question about the view model and
    // this stays purely about how bright the answer looks.
    const a = alpha * LIFE_STAMP_GAIN;
    lifeAlphas[slot][n] = a; lifeAlphas[slot][n + 1] = a;
    lifeCounts[slot] = n + 2;
  }

  // Draw one Life frame across EVERY subarea. Reads the BORROWED Float32Array
  // cellAlpha returns per-subarea and consumes it immediately inside this
  // function — it is never stored on `state`, never returned, and never
  // survives to the next call, which is the contract lifeview.js documents.
  function drawLifeFrame() {
    const streams = session.life;
    if (!streams || streams.size === 0) return;

    // lifeSplit() guards the non-finite gen that cellAlpha throws a TypeError
    // on — lifePos comes out of a division, and an empty-duration edge case
    // could otherwise hand it a NaN and kill the render loop. nFrames is the
    // same across every subarea (Task 4), so any one stream's is authoritative.
    const anyLife = streams.values().next().value;
    const { gen, frac } = lifeSplit(state.lifePos, anyLife.nFrames);

    lifeCounts.fill(0);
    let drawn = 0;
    let live = 0;

    for (const [name, life] of streams) {
      const segArr = streets[name];
      if (!segArr) continue;
      const alphas = cellAlpha(life, gen, frac, {
        // The Life clock advances at `lifeGensPerSec()` generations per WALL
        // second, so telling cellAlpha playbackRate = that rate and speed = 1
        // makes its afterglow horizon land on real wall-clock seconds. Passing
        // state.speed here instead would double-count the speed chip, which is
        // already folded into lifeGensPerSec().
        playbackRate: lifeGensPerSec(),
        speed: 1,
        deathGen: state.lifeDeaths.get(name),
      });
      const n = life.cellCount;
      const frame = life.frames[gen];
      // modes[gen] is the SAME frame index just used for frame/alphas above --
      // dense per-cell mode bytes for the generation actually being drawn, not
      // a stale or boot-time snapshot (Task 4's decodeLife output). It is only
      // meaningful for cells ALIVE this generation: the wire format never
      // stores a dead cell's mode (pack_modes is sparse over live cells), so
      // this array reads 255 for every currently-dead index.
      const modeFrame = life.modes[gen];
      // lastMode[gen] is the afterglow colour: each cell's most recently-seen
      // LIVE mode at or before this generation (precomputeLastMode). A fading
      // (just-died) cell reads its colour from here, not from modeFrame,
      // which cannot carry it. A cell that has never been alive still reads
      // NO_MODE from this array too, so it cannot borrow slot 0.
      const lastModeFrame = state.lifeModes.get(name)[gen];
      for (let i = 0; i < n; i++) {
        const alive = frame[i] === 1;
        if (alive) live++;
        const a = alphas[i];
        if (a < LIFE_ALPHA_EPS) continue;
        // Alive cells take this frame's own mode; dying/afterglow cells keep
        // the mode of the service that last lit them. NO_MODE (255, a cell
        // that has never been alive at or before this generation) falls back
        // to slot 3 (bus/ferry) -- see the LIFE_MODE_SLOTS comment.
        const mode = alive ? modeFrame[i] : lastModeFrame[i];
        const slot = mode === 255 ? 3 : mode;
        pushLifeCell(segArr, i, a, slot);
        drawn++;
      }
    }
    state.lifeDrawnCells = drawn;
    state.lifeLiveCells = live;

    for (let m = 0; m < LIFE_MODE_SLOTS; m++) {
      const n = lifeCounts[m];
      if (n > 0) {
        field.stamp(lifeSegs[m], lifeAlphas[m], lifeAges[m], frameModeColors[m], LIFE_PARAMS, n);
      }
    }

    drawLifeVehicles();
  }

  // ---- Life vehicle dots ---------------------------------------------------
  // Real vehicles moving over the Life street field. Two deliberate
  // departures from ripple's equivalent block (app.js ~2118):
  //
  // 1. DRAWS WHILE PAUSED. Ripple skips vehicles when paused because its
  //    state.t stops advancing, leaving no meaningful "live" set. Life's clock
  //    is derived from lifePos, which is well-defined paused or playing, so a
  //    paused frame shows every vehicle at its true position for that
  //    generation. Scrubbing is a primary Life interaction and every gate
  //    screenshot is paused -- dropping dots when paused would make the
  //    feature unverifiable by the method used to verify the rest of Life.
  //
  // 2. ONE DRAW CALL PER MODE. stampDots takes size as a per-call UNIFORM
  //    (field.js:294), so per-mode sizing cannot be done in a single call.
  //    Points are bucketed by mode, exactly as the street path above buckets
  //    by colour slot. Ripple's single call works only because it uses one
  //    size for every mode.
  function drawLifeVehicles() {
    if (!vehData || !vehicleMeta) return;   // older bake without vehicle bins
    const simSec = lifeSimSec(state.lifePos, lifeNFrames(), session.lifeMeta);
    if (simSec === null) return;            // stream meta has no clock

    const MODE_N_V = MODE_COLORS.length;
    const pts = Array.from({ length: MODE_N_V }, () => []);
    const cols = Array.from({ length: MODE_N_V }, () => []);
    const bb = viewBbox();
    let pushed = 0;

    for (let ti = 0; ti < vehData.trips.length && pushed < VEHICLE_DOT_BUDGET; ti++) {
      const trip = vehData.trips[ti];
      const pos = vehiclePosition(trip, simSec, vehData);
      if (!pos) continue;
      const [x, y] = pos;
      // Viewport cull on UNPROJECTED coords -- cheaper than projecting first.
      if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
      const mode = MODE_CODE(vehData.routes[trip.shape].mode);
      const slot = (mode >= 0 && mode < MODE_N_V) ? mode : 3;
      if (!isVisible(state.modeVisible, slot)) continue;
      const [px, py] = state.proj.fn(x, y);
      const c = frameModeColors[slot];
      const st = vehicleStyleFor(slot);
      pts[slot].push(px, py);
      cols[slot].push(c[0], c[1], c[2], st.alpha);
      pushed++;
    }

    // Budget clipping must be VISIBLE, not silent: a truncated frame that
    // reports nothing reads as "covered everything" when it did not.
    if (pushed >= VEHICLE_DOT_BUDGET) {
      state.lifeVehicleClipped = true;
    }
    state.lifeVehicleDots = pushed;

    // Draw rarest LAST so the loudest dots land on top of the bus wash.
    for (let m = MODE_N_V - 1; m >= 0; m--) {
      if (pts[m].length === 0) continue;
      field.stampDots(Float32Array.from(pts[m]), Float32Array.from(cols[m]),
                      vehicleStyleFor(m).size);
    }
  }

  // Cull bbox for the ripple path, recomputed once per frame (NOT per edge).
  // null means "cull disabled" -- see updateCullBbox.
  let cullBbox = null;

  // Recompute the inflated cull bbox for this frame.
  //
  // DISABLED (null) whenever introProj is active: state.proj is then a
  // TOP-CROPPED projection over a different bbox (see introProj assignment
  // above), while visibleBbox() reads the free camera. Culling one against
  // the other would wrongly drop visible intro edges. The intro is a
  // bounded, paused snapshot, so culling buys nothing there anyway.
  function updateCullBbox() {
    if (introProj !== null) { cullBbox = null; return; }
    const bb = viewBbox();
    // Band half-width in CSS px -> world units, via the camera's own scale.
    // thickness is the full band width in px; kx corrects lon for latitude.
    const halfPx = RIPPLE_PARAMS.thickness;
    const padY = halfPx / camera.scale;
    const padX = padY / camera.kx;
    cullBbox = inflateBbox(bb, padX, padY);
  }

  // Resolve one edge (stamp-slice entry k, belonging to `stop`) into a
  // projected line segment + its baked delay + the event's current age,
  // pushed into the per-mode scratch buffers. Shared by both the all-at-once
  // seed path and the live wavefront path below — the only difference
  // between them is WHICH k's get pushed (and what age is passed), not how
  // a k becomes pixels.
  //
  // Band-shader model (Task 8/9): brightness at an edge is recomputed EVERY
  // FRAME from (delay, age) by the shader, not accumulated by decay(). So
  // `delay` here is the RAW stampDelay[k] value in seconds (the walking-time
  // offset at which this edge sits on the wavefront) — NOT divided by 65535;
  // that /65535 normalization was for the old scalar intensity model, which
  // the band model no longer uses.
  //
  // stampIntensity[k], unlike stampDelay, DOES need de-quantizing (Task 3,
  // fixed round 1 after review caught the original version dimming the
  // WHOLE scene). It is a capacity-weighted uint16 baked by
  // projects/helsinki-ripples/src/bake_ripples.py (Task 2 — a DIFFERENT
  // project from this shader) as:
  //   w = weight_for(mode, override) / MAX_MODE_WEIGHT      # bake_ripples.py:213
  //   stamp_intensity = _quant_u16(inten * w, 65535, 0xFFFF) # bake_ripples.py:217
  // Two separate operations happened, so de-quantizing needs to undo BOTH:
  //   1. `_quant_u16(x, 65535, ...)` scaled a 0..1 float up by 65535 before
  //      storing as uint16 -- undo with `/ 65535.0`.
  //   2. `weight_for(mode) / MAX_MODE_WEIGHT` renormalized the capacity
  //      weight DOWN by the heaviest mode's weight (10.0, metro) so nothing
  //      clipped at bake time -- undo by multiplying back UP by that same
  //      MAX_MODE_WEIGHT, recovering weight_for(mode) itself (bus=1.0,
  //      metro=10.0, ...), not the renormalized 0.1..1.0 fraction.
  // Doing only step 1 (the bug this comment used to describe) leaves every
  // vertex multiplied by `weight_for(mode)/MAX_MODE_WEIGHT` instead of
  // `weight_for(mode)` -- i.e. the WHOLE scene dims by MAX_MODE_WEIGHT
  // (10x), because even bus (the reference mode, weight 1.0) is left at
  // 1/10 instead of 1.0. Doing both steps restores bus to exactly the
  // brightness it rendered at before this attribute existed (weight 1.0)
  // and lets metro reach 10x that -- the actual "rail brighter than bus"
  // goal, not "bus 10x darker than it used to be".
  //
  // MAX_MODE_WEIGHT is READ from the manifest (see `cp` above), never
  // hardcoded: `cfg.capacity_override` can change the effective max weight
  // per city, and a hardcoded client constant would silently desync from a
  // bake that used a different one.
  //
  // Multiplying bus back up to 1.0 necessarily pushes metro (10x) into
  // territory the existing `1-exp(-x*glowStrength)` present-shader tonemap
  // was not tuned for -- that is the accumulation-saturation risk the plan
  // reserves `log1p` for (applied in PRESENT_FS, not here: this file only
  // produces the per-vertex intensity that gets additively accumulated;
  // the compression happens once, at the point where the accumulated sum is
  // read back for display).
  //
  // Every stop stamps unconditionally (v2.2 retired AOI/district admission
  // filtering — spec Q4-A): resolveStopBuffer only decides WHICH city street
  // buffer a stop's edges live in (via the baked stopCity code — never
  // re-derived from bbox containment client-side, since Kauniainen's bbox
  // nests entirely inside Espoo's), not WHETHER to stamp it.
  function pushEdge(segArr, mode, k, age) {
    const edgeIdx = stampEdge[k];
    // Colour-mode gate. Under "identity" a shared edge is drawn ONCE, by the
    // highest-capacity mode present, so additive accumulation can never sum two
    // hues into a colour that names no mode (measured: 27% of lit edges carry
    // 2+ modes). Every other mode simply skips the edge -- it is not dimmed or
    // blended, it is not drawn, which is what keeps the surviving hue pure.
    if (state.colourMode === "identity" && edgeWinner && edgeWinner[edgeIdx] !== mode) return;
    const base = 4 * edgeIdx;
    const ax = segArr[base], ay = segArr[base + 1];
    const bx = segArr[base + 2], by = segArr[base + 3];

    // Viewport cull (W2b). Test the UNPROJECTED endpoints: cheaper than
    // projecting first, and it skips the buffer writes entirely. Conservative
    // -- rejects only when the edge's own bbox lies wholly outside the
    // inflated view, so a kept-but-invisible edge is possible (correct, just
    // slower) while a culled-but-visible edge is not.
    if (cullBbox !== null) {
      const [cw, cs, ce, cn] = cullBbox;
      if ((ax < cw && bx < cw) || (ax > ce && bx > ce) ||
          (ay < cs && by < cs) || (ay > cn && by > cn)) return;
    }

    // Overlap mode writes into the class-bucketed scratch instead of the
    // per-mode scratch; everything below is otherwise identical, so the two
    // colour modes share one projection/delay/intensity path and cannot drift.
    const ov = state.colourMode === "overlap";
    const slot = ov ? Math.min(OVERLAP_N, Math.max(1, edgeModeN[edgeIdx] || 1)) - 1 : mode;
    const segs = ov ? overlapSegs : modeSegs;
    const delays = ov ? overlapDelays : modeDelays;
    const ages = ov ? overlapAges : modeAges;
    const intens = ov ? overlapIntens : modeIntens;
    const counts = ov ? overlapCount : modeCount;

    const n = counts[slot];
    if (ov) ensureOverlapCap(slot, n + 2); else ensureModeCap(slot, n + 2); // 2 verts/edge
    // state.proj is introProj (top-cropped) during the guided intro, else the
    // free camera -- project through whichever is live, exactly as before.
    const cam = state.proj.cam;
    if (cam) {
      projectInto(cam, ax, ay, segs[slot], n * 2);
      projectInto(cam, bx, by, segs[slot], n * 2 + 2);
    } else {
      // introProj has no `cam` -- fall back to the allocating path. The intro
      // is a paused, bounded snapshot, so its allocation cost is irrelevant.
      const [pax, pay] = state.proj.fn(ax, ay);
      const [pbx, pby] = state.proj.fn(bx, by);
      segs[slot][n * 2] = pax; segs[slot][n * 2 + 1] = pay;
      segs[slot][n * 2 + 2] = pbx; segs[slot][n * 2 + 3] = pby;
    }
    const delay = stampDelay[k];
    delays[slot][n] = delay; delays[slot][n + 1] = delay;
    ages[slot][n] = age;     ages[slot][n + 1] = age;
    const inten = normalizeStampIntensity(stampIntensity[k], MAX_MODE_WEIGHT);
    intens[slot][n] = inten; intens[slot][n + 1] = inten;
    counts[slot] = n + 2;
  }

  // Resolve a stop's city street-buffer + mode. Returns null if this stop
  // cannot be stamped at all (no street buffer or an empty stamp slice) —
  // NOT an AOI/district admission test: v2.2 retired admission filtering
  // (spec Q4-A). Districts and AOI chips are navigation-only; culling is by
  // the live viewport (see viewBbox/visibleBbox), not by selection.
  function resolveStopBuffer(stop) {
    const cnt = stampIndex[2 * stop + 1];
    if (cnt === 0) return null;
    const cityCode = stopCity[stop];
    if (cityCode === REGION_ONLY_CITY_CODE) return null; // no street buffer for this stop
    const cityName = CITY_NAMES[cityCode];
    const segArr = streets[cityName];
    if (!segArr) return null;
    return { segArr, mode: stopMode[stop], off: stampIndex[2 * stop], cnt };
  }

  // Stamp a stop's ENTIRE isochrone at once, full intensity, no wavefront —
  // the didactic "here's everything reachable in 3 minutes" snapshot used
  // ONLY by the paused guided-intro steps (see seedStopRipple below). Live
  // playback never calls this; it uses the live re-stamp path instead.
  //
  // Age choice for the paused snapshot: pass age = each edge's OWN delay
  // (age === T), which sits every edge exactly AT its own crest (T === front
  // in the band formula, since front = age*frontSpeed and frontSpeed==1 by
  // default gives front===delay). That lights every edge in the isochrone at
  // full crest brightness simultaneously — the "here's everything reachable"
  // snapshot the caption describes — without needing a running demo clock.
  function stampEventAllAtOnce(stop) {
    const buf = resolveStopBuffer(stop);
    if (!buf) return;
    for (let k = buf.off; k < buf.off + buf.cnt; k++) {
      const age = stampDelay[k] / RIPPLE_PARAMS.frontSpeed;
      pushEdge(buf.segArr, buf.mode, k, age);
    }
  }

  // Draw whatever pushEdge() has accumulated into modeSegs/modeDelays/modeAges,
  // grouped by mode (one draw call per mode, additive blend). Shared by
  // the rAF loop and the scripted intro (seedStopRipple).
  function flushStamps(params = RIPPLE_PARAMS) {
    // Overlap mode re-colours the SAME per-mode batches by how many distinct
    // modes serve each edge. The geometry is untouched -- only the uniform
    // colour changes -- so this costs one extra draw call per (mode, class)
    // pair and no additional buffer traffic. Edges are already grouped by mode,
    // and an edge's class is fixed for the bundle, so a stable per-mode class
    // split is enough; no re-sorting per frame.
    if (state.colourMode === "overlap") {
      // Edges are bucketed by OVERLAP CLASS (1..4 distinct modes) rather than by
      // mode -- pushEdge routes into overlapSegs when this mode is active, so a
      // batch is homogeneous in class and one uniform colour is truthful for it.
      for (let c = 0; c < OVERLAP_N; c++) {
        const n = overlapCount[c];
        if (n === 0) continue;
        field.stamp(overlapSegs[c], overlapDelays[c], overlapAges[c],
                    overlapColour(c + 1), params, n, overlapIntens[c]);
      }
      return;
    }
    for (let m = 0; m < MODE_N; m++) {
      if (!isVisible(state.modeVisible, m)) continue;
      const n = modeCount[m];
      if (n === 0) continue;
      // Pass the buffers whole plus an explicit vertex count -- no
      // Float32Array.from() copy, no subarray() allocation. field.stamp
      // uploads only the first n vertices via bufferSubData.
      field.stamp(modeSegs[m], modeDelays[m], modeAges[m], frameModeColors[m], params, n, modeIntens[m]);
    }
  }

  // Seed a ripple for one or more stops on demand, bypassing the sim-time
  // event stream entirely — used by the guided intro (steps 1-2) to bloom
  // a clean, deterministic droplet (or two, for the interference demo)
  // regardless of where state.t/sePtr happen to be. Reuses the exact same
  // stamp-resolution + additive draw path as the live rAF loop so the
  // scripted ripple looks identical to a "real" one.
  //
  // Design choice (final-review item 6): these guided-intro steps are
  // PAUSED (setPaused(true)) — sim-time never advances while they're shown,
  // so a wavefront driven by `state.t - fireTime` would never animate here
  // anyway without extra machinery (a separate rAF-driven demo clock). The
  // steps' captions are explicitly about the FULL reachable area ("the
  // streets a rider can reach on foot in three minutes" / "their walking-
  // reach overlaps") — an all-at-once snapshot is exactly what they teach.
  // Only the LIVE region/AOI playback (the frame() loop below) gets the
  // propagating wavefront.
  function seedStopRipple(stopIndices) {
    const stops = Array.isArray(stopIndices) ? stopIndices : [stopIndices];
    resetModeScratch();
    for (const stop of stops) stampEventAllAtOnce(stop);
    flushStamps(INTRO_PARAMS);
    // Also persist the resolved buffers so the rAF loop's per-frame
    // field.clearField() doesn't wipe this seed on the very next frame (see
    // restampSeededStops below) — a one-shot stampEventAllAtOnce alone only
    // lasts until the next clear, which for a PAUSED intro step is the very
    // next frame. Replaces any prior seed (step 2 supersedes step 1's).
    seededStops = stops.map(resolveStopBuffer).filter((buf) => buf !== null);
  }

  // ---- Live ripple re-stamp (Task 9 rewrite) -------------------------------
  // Band-shader model (Task 8): brightness at an edge is `bandBrightness(T =
  // stampDelay[k], age, params)`, recomputed fresh every frame from `age` —
  // there is no accumulated/decaying field state to advance incrementally
  // anymore. So instead of stamping each edge ONCE when its delay is crossed
  // (the old cursor-based wavefront-crossing model) and letting field.decay()
  // fade the accumulated texture, the field is CLEARED and every edge of
  // every in-flight event is RE-STAMPED each frame with that event's current
  // age. The shader's own crest/wake formula zeros out edges outside the
  // band, so the visible result is still a moving ring, not a wash — the
  // wavefront motion now lives in the shader, not in which edges get pushed.
  //
  // activeEvents holds one entry per recently-fired event still "in flight"
  // (age < horizonSec — after that every one of its edges has decayed under
  // life_tau well past visibility, so it's dropped to bound per-frame cost).
  //
  // COST-BOUND DESIGN NOTE: per-frame cost is the SUM of edge counts over all
  // active events (not just the crossings admitted this frame), since every
  // edge of every in-flight event is pushed every frame. This is bounded by
  // (local event rate) x horizonSec x (avg edges/event) — the same resident
  // population the old cursor model was careful about growing, but now each
  // resident event costs its FULL edge count per frame instead of amortizing
  // that cost across the frames it takes to cross. This is the necessary
  // trade for switching to a per-frame-recomputed band (there's no cheaper
  // way to represent "brightness is a function of age" without baking a
  // decaying accumulator, which is exactly what produced the wash). The
  // population itself stays bounded via horizonSec + SPAWN_BUDGET admission,
  // matching prior behavior; in-flight edge totals remain the same order of
  // magnitude as before (thousands), not O(all edges) or O(all stops).
  let activeEvents = []; // { fireTime, buf: {segArr, mode, off, cnt} }

  // Persistent guided-intro seed (Task 10 fix): unlike activeEvents (live,
  // time-driven, retired by horizonSec), seededStops holds the paused
  // intro's snapshot buffers so restampSeededStops() below can re-stamp them
  // every frame — surviving the per-frame field.clearField() the same way
  // activeEvents does. At most 2 entries (STORY_STOP_SOLO / STORY_STOP_PAIR).
  let seededStops = [];

  function clearActiveEvents() {
    activeEvents = [];
    seededStops = []; // any stale guided-intro seed must not survive a scrub/AOI-change/wrap either
  }

  // Activate a newly-fired event: resolve its city/mode buffer (AOI filter
  // applied here, at activation time — matches the old stampEvent
  // semantics), and push it onto the active ring. No per-edge sort needed
  // anymore (the old cursor model sorted by delay to advance incrementally;
  // the re-stamp model pushes every edge every frame regardless of order).
  function activateEvent(stop, fireTime) {
    const buf = resolveStopBuffer(stop);
    if (!buf) return; // wrong AOI / no street buffer / empty slice — nothing to track
    activeEvents.push({ fireTime, buf });
  }

  // Re-stamp every active event's full edge set this frame, using the
  // event's current age (age = state.t - fireTime, same value for every edge
  // of that event — the band shader is what differentiates brightness across
  // edges via each edge's own stampDelay). Retires events whose age has
  // passed horizonSec. Pushes into the shared modeSegs/modeDelays/modeAges
  // scratch buffers (caller flushes).
  function restampActiveEvents() {
    const now = state.t;
    let write = 0;
    for (let i = 0; i < activeEvents.length; i++) {
      const ev = activeEvents[i];
      const age = realAge(now - ev.fireTime, state.speed);
      // retire on REAL age (visual life over) OR a sim-age cap so scrubbing
      // far ahead can't keep a huge stale population alive at high speed.
      if (age >= rippleLifeHorizon(state.speed) || now - ev.fireTime >= 5 * horizonSec) continue;
      const { segArr, mode, off, cnt } = ev.buf;
      for (let k = off; k < off + cnt; k++) pushEdge(segArr, mode, k, age);
      activeEvents[write++] = ev;
    }
    activeEvents.length = write;
  }

  // Re-stamp the guided-intro's seeded stops (see seededStops above) every
  // frame, same reason as restampActiveEvents: the field is cleared each
  // frame, so anything not re-pushed vanishes on the next frame. Age is
  // pinned to each edge's own delay (age === T, matching stampEventAllAtOnce)
  // so the full isochrone sits at crest brightness simultaneously — the
  // static "here's everything reachable" snapshot the intro captions
  // describe, not an animating wavefront.
  function restampSeededStops() {
    for (let i = 0; i < seededStops.length; i++) {
      const { segArr, mode, off, cnt } = seededStops[i];
      for (let k = off; k < off + cnt; k++) {
        const age = stampDelay[k] / RIPPLE_PARAMS.frontSpeed;
        pushEdge(segArr, mode, k, age);
      }
    }
  }

  // ---- Task 12: hidden-tab pause -------------------------------------------
  // A backgrounded tab still gets rAF callbacks (throttled by the browser,
  // but not zero), so without this guard the field keeps clearing/re-stamping
  // off-screen — wasted GPU/battery. Skip all sim work while hidden.
  //
  // On resume, reset lastFrameTs to null so the next visible frame treats
  // itself as the "first" frame (dtRealMs = 0) instead of computing a dt
  // spanning the entire hidden interval, which would otherwise produce a
  // huge dtSim jump (e.g. minutes of sim-time in one step).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) state.lastFrameTs = null;
  }, { signal: abort.signal });

  // ---- rAF loop ------------------------------------------------------------
  function frame(ts) {
    const paletteCivilSec = state.mode === "life"
      ? lifeSimSec(state.lifePos, lifeNFrames(), session.lifeMeta)
      : (state.t + manifest.sim_origin_sec) % 86400;
    const paletteElev = state.sun && paletteCivilSec !== null
      ? state.sun.elevationFor(((paletteCivilSec % 86400) + 86400) % 86400) : -90;
    const groundL = state.sunEnabled ? groundLightness(paletteElev) : groundLightness(-90);
    const groundLValue = groundL.toFixed(4);
    if (document.documentElement.style.getPropertyValue("--ground-l") !== groundLValue) {
      document.documentElement.style.setProperty("--ground-l", groundLValue);
    }
    frameModeColors = state.sunEnabled
      ? MODE_COLORS.map((_, code) => modeColorFor(code, paletteElev))
      : NIGHT_MODE_RGB.map((c) => c.slice());
    visibleCorridorColorsSig = null;
    for (const sw of modeFilterEl.querySelectorAll(".swatch")) {
      const [r, g, b] = frameModeColors[Number(sw.dataset.modeCode)] || frameModeColors[3];
      sw.style.setProperty("--swatch", `rgb(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)})`);
    }
    // A frame scheduled before teardown() can still fire after it (cancel is
    // not retroactive for an already-dispatched callback). Bail if this
    // session is no longer the live one — otherwise we'd touch a disposed
    // field and a nulled data bundle.
    if (currentSession !== session) return;

    // v2.2: advance an in-flight fly-to; sync the projection every frame the
    // camera is animating (manual input syncs eagerly in its own handlers).
    //
    // This runs ABOVE the hidden-tab guard on purpose. A fly-to is CAMERA
    // work, not sim work: it mutates {cx, cy, scale} and costs a projection
    // rebuild, no field clear and no GPU draw. Below the guard, a fly-to
    // started while the tab was hidden was created and then never stepped —
    // the district selection read back correctly (.dp-child.active) while the
    // camera sat frozen with no error and no animation, and it only resolved
    // if the tab happened to become visible again. Pan/wheel/dblclick never
    // showed this because they mutate the camera eagerly in their own
    // handlers; fly-to is the only camera move that defers to this loop.
    if (flyAnim) {
      const flying = stepFlyTo(flyAnim, camera, ts);
      if (!flying) flyAnim = null;
      syncProjection();
    }

    if (document.hidden) {
      // Don't accumulate a dt spike across the hidden interval; just wait
      // for the tab to become visible again (visibilitychange resets
      // lastFrameTs so the resume frame doesn't jump sim-time).
      session.rafHandle = requestAnimationFrame(frame);
      return;
    }

    if (state.lastFrameTs === null) state.lastFrameTs = ts;
    const dtRealMs = state.paused ? 0 : ts - state.lastFrameTs;
    state.lastFrameTs = ts;
    recordFrameDt(dtRealMs);

    // ---- Deserts mode: a static plate, so this loop does almost nothing ------
    // The image is already on the #overlay canvas, drawn by drawDistrictOutline
    // on camera change — there is nothing per-frame to redraw. This branch
    // exists only to keep the rAF loop and the fly-to stepping above alive
    // while contributing NO sim advance, NO event sweep, NO field stamp and no
    // write to state.t / state.sePtr. That containment is precisely what makes
    // returning to Ripples a resync rather than an unwind.
    //
    // The GL field is left as setMode cleared it. Re-presenting an empty field
    // every frame would only burn a draw call to produce the same black.
    if (state.mode === "deserts") {
      maybeUpdateStatus(ts);
      session.rafHandle = requestAnimationFrame(frame);
      return;
    }

    // ---- Life mode: replay baked generations ---------------------------------
    // A COMPLETE, EARLY-RETURNING branch. It shares the loop's frame pacing,
    // fly-to stepping and status readout, and nothing else: no event sweep, no
    // vehicle dots, no impact dots, no touching of state.t/state.sePtr or the
    // ripple scratch buffers. That containment is what makes "switch back to
    // ripples" a no-op for ripple state rather than an unwind.
    //
    // THE BROWSER NEVER RUNS A GENERATION. state.lifePos only indexes frames
    // the bake already produced; there is no rule, no neighbour count, and no
    // stepping anywhere in this path.
    if (state.mode === "life") {
      const streams = session.life;
      if (streams && streams.size > 0 && !state.paused && dtRealMs > 0) {
        const dtSec = dtRealMs / 1000;
        // The generation-0 hold. This is a PRESENTATION choice and nothing
        // else: at 6 gen/s a single frame would exist for only 167 ms —
        // below the threshold at which a viewer can register the seed at
        // all before playback moves on. Holding gen 0 for LIFE_SEED_HOLD_SEC
        // shows the seed as a seed before the driven playback proceeds. (See
        // LIFE_SEED_HOLD_SEC's definition above: measured population now
        // RISES from gen 0 to gen 1 under the driven model, not collapses —
        // the hold's original "soften the collapse" rationale is stale; only
        // "let the seed be seen" still applies.) No frame is altered,
        // skipped, blended or re-ordered; only the dwell time on frame 0
        // changes.
        let remaining = dtSec;
        if (state.lifeHoldSec > 0 && state.lifePos < 1) {
          const used = Math.min(state.lifeHoldSec, remaining);
          state.lifeHoldSec -= used;
          remaining -= used;
        }
        if (remaining > 0) {
          // Loop the stream, matching what ripple playback does at dataMax
          // (STRICT `>`, so the final generation is actually displayed — see
          // lifeAdvance). Re-arm the seed hold so a second pass is as legible
          // as the first. lifeAdvance also absorbs a non-finite position or
          // step, which is what keeps a NaN out of cellAlpha's finite-gen
          // contract.
          const adv = lifeAdvance(state.lifePos, remaining * lifeGensPerSec(), lifeNFrames());
          state.lifePos = adv.pos;
          if (adv.wrapped) state.lifeHoldSec = LIFE_SEED_HOLD_SEC;
        }
      }

      field.clearField();
      updateCullBbox();
      drawLifeFrame();
      // Life's true civil time is lifeSimSec (t0_sec + (gen+frac)*stride_sec)
      // -- the SAME value drawLifeVehicles() already uses to place vehicles
      // and that lifeWallClock()/lifeClockText() format for the on-screen
      // clock. state.t is a RIPPLE-mode concept (sim-seconds since
      // dataMin) and is not advanced while in Life mode, so reusing it here
      // would freeze the sun at whatever hour ripple mode was last showing.
      const lifeCivilSec = lifeSimSec(state.lifePos, lifeNFrames(), session.lifeMeta);
      const lifeSunBase = state.sun && lifeCivilSec !== null
        ? state.sun.baseFor(((lifeCivilSec % 86400) + 86400) % 86400, state.sunEnabled)
        : undefined;
      field.present(lifeSunBase, state.sunEnabled ? daylightBlendFor(paletteElev) : 0);

      clockEl.textContent = lifeClockText();
      if (onClockChanged) onClockChanged();
      if (!state.paused) updateScrubberFromT();
      maybeUpdateStatus(ts);
      session.rafHandle = requestAnimationFrame(frame);
      return;
    }

    const dtSim = (dtRealMs * state.speed) / 1000;

    if (dtSim > 0) {
      let tNext = state.t + dtSim;
      if (tNext > dataMax) {
        // Hard jump: wrap to the start of the data window and clear the
        // field (a stale, high-value field would otherwise "teleport" a
        // bright wash of un-decayed light back to t=dataMin).
        tNext = dataMin;
        field.resize(canvas.width, canvas.height);
        state.sePtr = lowerBound(eventTime, tNext);
        clearActiveEvents(); // no stale in-flight wavefronts should survive the wrap
      }
      state.t = tNext;
    }

    // Band-shader model: brightness is recomputed from age every frame, so
    // the field must be CLEARED then RE-STAMPED from scratch each frame
    // (no accumulate/decay step anymore — see restampActiveEvents' doc
    // comment). A paused frame still clears+re-stamps (so the guided-intro
    // snapshot stays lit while paused); only sim-time advancement and event
    // activation are gated on dtSim > 0 below.
    field.clearField();

    // Persistent network silhouette first; animated ripples and dots retain
    // visual priority because every later pass additively draws over it.
    // Filtered through the mode toggle (see visibleCorridorColors above) so a
    // hidden mode's silhouette does not stay lit under a filter that claims
    // to remove it.
    field.drawCorridors(state.proj, visibleCorridorColors(), corridorWidth, corridorBrightness);

    // Travelling heads sit above the static silhouette but below ripple
    // restamps. Older bundles leave vehData null and retain the old rendering.
    if (vehData) {
      const legs = activeLegs(vehData.trips, vehData.bpTime, state.t, PULSE_BUDGET);
      const bb = viewBbox();
      // Bucket the legs by mode in ONE pass, then draw each bucket.
      //
      // The obvious shape -- loop the modes on the outside and filter the legs
      // inside -- walks the whole active-leg list five times and calls
      // pulseHeadPoint (a binary search plus an interpolation) on every leg in
      // every pass, discarding ~80% of that work to the mode test. At the
      // measured peak that is ~27,870 head computations per frame instead of
      // 5,574, and it MEASURABLY doubled frame time (1073ms -> 2292ms in the
      // headless comparison against master). Cull once, bucket once.
      for (const bucket of pulseByMode) bucket.length = 0;
      for (const leg of legs) {
        const route = vehData.routes[leg.trip.shape];
        if (!route) continue;
        const mode = MODE_CODE(route.mode);
        const bucket = pulseByMode[mode];
        if (!bucket) continue;
        // Cull BEFORE writing. Culling after the write (on the emitted head
        // vertex) is correct on screen but spends buffer on pulses it then
        // rewinds, so a wide view can exhaust the scratch on off-screen legs
        // and silently drop visible ones. The head position is derivable
        // without emitting geometry, so test it first and write nothing for
        // a pulse that cannot be seen.
        const head = pulseHeadPoint(leg, state.t, vehData);
        if (!head) continue;
        if (head[0] < bb[0] || head[0] > bb[2] || head[1] < bb[1] || head[1] > bb[3]) continue;
        bucket.push(leg);
      }
      for (let mode = 0; mode < MODE_COLORS.length; mode++) {
        if (!isVisible(state.modeVisible, mode)) continue;
        const bucket = pulseByMode[mode];
        if (!bucket || !bucket.length) continue;
        let used = 0;
        for (const leg of bucket) {
          const before = used;
          used = pulseGeometry(leg, state.t, vehData, pulseScratch, used, PULSE_TAIL);
          // pulseGeometry stops at the bound rather than overrunning it, so a
          // full buffer shows up as "no progress", not as used > length.
          if (used === before) break;
        }
        field.drawPulses(pulseScratch, used, state.proj, frameModeColors[mode],
                         PULSE_TAIL, PULSE_BRIGHTNESS);
      }
    }

    resetModeScratch();

    if (dtSim > 0) {
      // Activate newly-fired events (same forward-only sweep + stride
      // sampling as before — SPAWN_BUDGET still caps how many events join
      // the active ring per frame, even at 300x). Activation does NOT
      // stamp anything yet; it just registers the event so it starts being
      // re-stamped from the NEXT line below.
      const { events, nextPtr } = eventsInWindow(eventTime, state.sePtr, state.t);
      const [lo, hi] = events;
      const pending = hi - lo;
      if (pending > 0) {
        const stride = pending > SPAWN_BUDGET ? Math.ceil(pending / SPAWN_BUDGET) : 1;
        for (let i = lo; i < hi; i += stride) {
          activateEvent(eventStop[i], eventTime[i]);
        }
      }
      state.sePtr = nextPtr; // forward-only: never re-activate an already-swept event
    }

    // Re-stamp every active event's full edge set at its current age (see
    // restampActiveEvents' doc comment for the cost-bound argument). This
    // runs even when paused (dtSim === 0) so the field stays lit between
    // frames instead of flashing empty (clearField() above wiped it).
    //
    // Live and seeded (guided-intro) stamps are flushed SEPARATELY, each with
    // its own params (RIPPLE_PARAMS for live, INTRO_PARAMS — life decay off —
    // for the paused snapshot): a single shared flush would force one lifeTau
    // on both, either blinking the live ripples or freezing the intro's decay.
    updateCullBbox();
    restampActiveEvents();
    flushStamps(state.speed === 1 ? RIPPLE_PARAMS_1X : RIPPLE_PARAMS); // live events

    resetModeScratch();

    restampSeededStops();
    flushStamps(INTRO_PARAMS);          // intro snapshot, life decay off

    // ---- Vehicle dots (Task 9 Part D, Option A) -----------------------------
    // Interpolate every live trip's XY in JS at state.t (ported, tested
    // vehiclePosition — see vehicles.js), viewport-cull, project, color by mode.
    // Guarded: an older bake without vehicle bins (vehData null) simply
    // skips this pass — ripples-only. Runs only while playing (a paused
    // frame has no meaningful "live" vehicle set — state.t isn't advancing).
    if (vehData && vehicleMeta && !state.paused) {
      const pts = [], cols = [];
      const bb = viewBbox();
      let pushed = 0;
      // 1x: vehicles are the visible life at real time — bigger, brighter (spec §4).
      const oneX = state.speed === 1;
      const oneXAlpha = oneX ? 0.8 : 0.55;
      for (let ti = 0; ti < vehData.trips.length && pushed < VEHICLE_DOT_BUDGET; ti++) {
        const trip = vehData.trips[ti];
        const pos = vehiclePosition(trip, state.t, vehData);
        if (!pos) continue;
        const [x, y] = pos;
        // Viewport cull: skip if outside the current camera bbox (cheap lon/lat test).
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
        const [px, py] = state.proj.fn(x, y);
        const mode = MODE_CODE(vehData.routes[trip.shape].mode);
        if (!isVisible(state.modeVisible, mode)) continue;
        const c = frameModeColors[mode];
        pts.push(px, py); cols.push(c[0], c[1], c[2], oneXAlpha);
        pushed++;
      }
      if (pts.length) field.stampDots(Float32Array.from(pts), Float32Array.from(cols),
                                      oneX ? 6.0 : 4.0);
    }

    // ---- Impact dots ---------------------------------------------------------
    // A bright flash at the exact stop coordinate the instant an event fires,
    // fading out linearly over IMPACT_FADE_SIM_SEC — a short, independent
    // look-back over the tail of already-activated events (bounded by how
    // many events fired in the last few sim-sec, not by activeEvents' full
    // in-flight population).
    {
      const cutoff = state.t - IMPACT_FADE_SIM_SEC;
      let lo = lowerBound(eventTime, cutoff);
      const hi = state.sePtr; // events up to (not including) the not-yet-activated tail
      const pts = [], cols = [];
      const bb = viewBbox();
      for (let i = lo; i < hi; i++) {
        const et = eventTime[i];
        if (et > state.t) continue; // defensive: shouldn't happen (sePtr is forward-only)
        const age = state.t - et;
        if (age < 0 || age >= IMPACT_FADE_SIM_SEC) continue;
        const stop = eventStop[i];
        const cityCode = stopCity[stop];
        if (cityCode === REGION_ONLY_CITY_CODE) continue;
        const x = stops[2 * stop], y = stops[2 * stop + 1];
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
        const [px, py] = state.proj.fn(x, y);
        const alpha = (1 - age / IMPACT_FADE_SIM_SEC) * 0.6;
        const mode = stopMode[stop];
        if (!isVisible(state.modeVisible, mode)) continue;
        const c = frameModeColors[mode];
        pts.push(px, py); cols.push(c[0], c[1], c[2], alpha);
      }
      if (pts.length) field.stampDots(Float32Array.from(pts), Float32Array.from(cols), 7.0);
    }

    // formatClock's own civil-seconds idiom (state.t + manifest.sim_origin_sec)
    // -- wrapped to [0, 86400) because a sim window running past midnight
    // would otherwise feed an out-of-range hour angle into solarElevation.
    const civilSec = (state.t + manifest.sim_origin_sec) % 86400;
    field.present(state.sun ? state.sun.baseFor(civilSec, state.sunEnabled) : undefined,
                  state.sunEnabled ? daylightBlendFor(paletteElev) : 0);

    clockEl.textContent = formatClock(state.t);
    syncDaypartChrome();
    if (onClockChanged) onClockChanged();
    if (!state.paused) updateScrubberFromT();
    maybeUpdateStatus(ts);

    session.rafHandle = requestAnimationFrame(frame);
  }
  session.rafHandle = requestAnimationFrame(frame);

  // ---- PNG export of the current framing -----------------------------------
  // THE ONE HARD CONSTRAINT: #map is a webgl2 context created WITHOUT
  // preserveDrawingBuffer, so its colour buffer is only readable inside the
  // same task as the draw that filled it. Read it one microtask later and
  // toBlob returns a fully transparent/BLACK PNG and throws NOTHING.
  //
  // So the export does NOT call frame() as a draw callback. frame() is a rAF
  // callback that reschedules ITSELF (`session.rafHandle = rAF(frame)`);
  // invoking it by hand would double-schedule the loop and hand the next real
  // frame a bogus dt. Instead we queue ONE rAF of our own. Callbacks queued
  // for a given frame run in FIFO order, and the loop's next `frame` was
  // queued at the end of the previous frame — i.e. BEFORE this one. So by the
  // time our callback runs, `frame` has already executed its full draw and
  // field.present() for THIS frame, and the buffer is live. We hide the chrome
  // and call toBlob synchronously in that same callback: no await, no timer,
  // no second rAF between the draw and the readback. The `draw` slot passed to
  // capturePng is therefore a no-op — the real draw is the loop's own, which
  // is the point.
  const exportBtn = document.getElementById("export-png");
  const captureCmdEl = document.getElementById("capture-cmd");
  const captureCopyEl = document.getElementById("capture-cmd-copy");

  // The bbox comes from the LIVE camera (visibleBbox), never from the selected
  // place node: after a manual pan or zoom the node's bbox no longer describes
  // what is on screen, and the emitted command would reproduce a framing the
  // user is not looking at.
  // #clock is a LABEL, not a clock: in Life mode it reads "Life…" /
  // "Seed · 08:15" / "gen 3", and before the first frame it is index.html's
  // literal "–". captureargs.mjs validates --start as HH:MM and throws on all
  // of those, and exportFilename stripped them to an empty clock. So every
  // consumer goes through normalizeClock, with formatClock(state.t) — the
  // ripple-mode source of truth, always HH:MM — as the fallback.
  function currentClock() {
    return normalizeClock(clockEl.textContent, formatClock(state.t));
  }
  function currentCaptureCommand() {
    return captureCommand({
      slug: activeSlug,
      bbox: visibleBbox(camera).map((v) => Number(v.toFixed(5))),
      start: currentClock(),
    });
  }
  function refreshCaptureCommand() {
    if (captureCmdEl) captureCmdEl.textContent = currentCaptureCommand();
  }
  refreshCaptureCommand();
  // Every camera move (pan, wheel, dblclick, fly-to step, resize) funnels
  // through syncProjection, so the emitted --bbox never lags the viewport.
  onCameraChanged = refreshCaptureCommand;
  // ...and the clock advances on its own with no camera move at all, which is
  // how the displayed --start froze at the boot time while the app played on.
  // Rebuild only when the DISPLAYED minute actually changes.
  let lastCmdClock = clockEl.textContent;
  onClockChanged = () => {
    if (clockEl.textContent === lastCmdClock) return;
    lastCmdClock = clockEl.textContent;
    refreshCaptureCommand();
  };

  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      // Snapshot the label BEFORE the frame runs: the clock in the filename
      // must match the clock the command carries and the pixels we save.
      const clockText = currentClock();
      const placeName = state.district ? state.district.name : null;
      const command = currentCaptureCommand();
      exportBtn.disabled = true;

      requestAnimationFrame(async () => {
        // Restore EXACTLY what THIS export hid, not the whole id list and not
        // "everything currently display:none". #mode-rail and #chrome both
        // ship `hidden`, and #tierbar does not exist on the public page at
        // all — blanket-clearing inline display would reveal an overlay that
        // was legitimately hidden beforehand.
        //
        // So record each element's own prior inline display FIRST, and put
        // exactly that value back. An element already inline-hidden before the
        // click is restored to "none", not to visible. (hideChrome's return
        // value names the ids it touched but not what they looked like before,
        // and it is shared with capture.mjs — so the before-state is captured
        // here rather than by changing that contract.)
        const prior = new Map();
        for (const id of CHROME_OVERLAY_IDS) {
          const el = document.getElementById(id);
          if (el) prior.set(id, el.style.display);
        }
        try {
          const blob = await capturePng(canvas, document, () => {});
          const name = exportFilename({
            slug: activeSlug, place: placeName, clock: clockText });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          a.click();
          // Revoking synchronously after click() races the Chromium download,
          // which can latch the blob a tick later and save nothing.
          setTimeout(() => URL.revokeObjectURL(url), 0);
          if (captureCmdEl) captureCmdEl.textContent = command;
        } catch (err) {
          console.error("PNG export failed", err);
        } finally {
          for (const [id, display] of prior) {
            const el = document.getElementById(id);
            if (el) el.style.display = display;
          }
          exportBtn.disabled = false;
        }
      });
    }, { signal: abort.signal });
  }

  if (captureCopyEl) {
    captureCopyEl.addEventListener("click", async () => {
      const text = captureCmdEl ? captureCmdEl.textContent : "";
      try {
        await navigator.clipboard.writeText(text);
        captureCopyEl.textContent = "Copied";
      } catch {
        // Clipboard API is origin/permission gated; the <code> is selectable
        // and tabbable, so a manual copy is always available as the fallback.
        captureCopyEl.textContent = "Select it";
      }
      setTimeout(() => { captureCopyEl.textContent = "Copy"; }, 1400);
    }, { signal: abort.signal });
  }

  return true;
  } // ---- end boot(slug) ----------------------------------------------------

  // ---- city registry + picker wiring (Phase B) ----------------------------
  const registry = await loadCities(DATA_ROOT);
  const link = parseDeepLink(window.location.search, Object.keys(AOIS));
  // resolveSlug returns null for a falsy registry; fall back to the one
  // directory we know exists so a missing/malformed cities.json still boots.
  let activeSlug = resolveSlug(registry, link.city) || "helsinki";
  // The slug actually rendered right now. Diverges from activeSlug only while
  // a switch is in flight, and is what a FAILED switch rolls the UI back to.
  let currentSlug = activeSlug;

  const noteEl = document.getElementById("coverage-note");

  function cityEntry(slug) {
    return registry ? registry.cities.find((c) => c.slug === slug) || null : null;
  }

  function showCoverageNote(slug) {
    const entry = cityEntry(slug);
    if (noteEl) noteEl.textContent = entry ? entry.coverage_note || "" : "";
    // The <title> in index.html is deliberately city-agnostic ("Cities,
    // breathing in light") since it ships before any city loads. Once a city IS
    // active, name it — the tab and any bookmark should say which city you are
    // looking at. Falls back to the static title when the registry is missing.
    document.title = entry
      ? `${entry.display_name}, breathing in light`
      : "Cities, breathing in light";
  }

  // Named function, NOT arguments.callee — this module is an ES module and
  // therefore strict mode, where arguments.callee throws.
  async function onSelectCity(slug) {
    activeSlug = slug;
    showCoverageNote(slug);
    const ok = await boot(slug);
    if (!ok) {
      // Failed switch: the PREVIOUS city is still rendered, so the note must
      // be rolled back to match what is actually on screen. The place panel
      // itself is rebuilt on every boot() (createPlacePanel with the new
      // activeSlug), so there is no separate picker to roll back here.
      activeSlug = currentSlug;
      showCoverageNote(activeSlug);
      return;
    }
    currentSlug = activeSlug;
  }

  showCoverageNote(activeSlug);

  await boot(activeSlug);
}

// Boot guard: app.js must not throw when #map is absent (e.g. a harness that
// loads this module without the app chrome).
if (typeof document !== "undefined" && document.getElementById("map")) {
  initApp().catch((err) => {
    console.error("app init failed", err);
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = "ERROR: " + (err && err.message ? err.message : err);
  });
}
