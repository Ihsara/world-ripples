// Dwell state machine for media-player-style chrome.
//
// Pure logic, no DOM: it takes distances and timestamps and returns a state
// per surface. app.js feeds it real pointer events; the capture path calls
// forceAwake(). Kept free of `document` so node:test can drive it directly,
// exactly like chrome.js.
//
// Surfaces are INDEPENDENT on purpose: waking the rail must not wake the
// bottom bar, or crossing the map twitches the whole screen.
export const DWELL_SURFACES = ["control-rail", "chrome"];

export const WAKE_MS = 80;        // near-instant, so it never feels laggy
export const SLEEP_MS = 1200;     // slow enough to survive overshooting a button
export const WAKE_ZONE_PX = 120;  // how far past a surface still counts as "near"

// On a narrow viewport a resting mouse near the CENTRE of the screen can
// already sit within WAKE_ZONE_PX of the collapsed rail's edge -- with no
// further pointermove events, `near` would stay true forever and the rail
// could never sleep (a real failure mode: a desktop browser resized narrow,
// or responsive devtools; not just touch, which uses a different path).
// Below this width, shrink the effective wake zone so the viewport centre
// clears it. Pure function of a width, no DOM -- callers pass
// window.innerWidth.
const NARROW_VIEWPORT_PX = 480;
// The collapsed rail's width, mirroring `#control-rail[data-dwell="dormant"]`
// in app.css. Kept in sync by tests/test_dwell_markup.py.
export const DORMANT_RAIL_PX = 44;
export function wakeZonePx(viewportWidth) {
  if (typeof viewportWidth !== "number" || !Number.isFinite(viewportWidth)) {
    return WAKE_ZONE_PX;
  }
  if (viewportWidth >= NARROW_VIEWPORT_PX) return WAKE_ZONE_PX;
  // Half the narrow breakpoint's width, floored, never above the base zone
  // and never below a small usable minimum.
  return Math.max(24, Math.min(WAKE_ZONE_PX, Math.floor(viewportWidth / 4)));
}

export function createDwell({ now = 0 } = {}) {
  const s = new Map();
  for (const id of DWELL_SURFACES) {
    s.set(id, { state: "dormant", since: now, near: false, hold: false, forced: false });
  }
  const get = (id) => {
    const v = s.get(id);
    if (!v) throw new Error(`unknown dwell surface: ${id}`);
    return v;
  };

  return {
    state: (id) => get(id).state,

    // zonePx defaults to WAKE_ZONE_PX; callers on a narrow viewport pass a
    // smaller zone from wakeZonePx() so a resting pointer near the screen
    // centre doesn't pin a surface awake forever (see wakeZonePx above).
    pointerAt(id, distancePx, zonePx = WAKE_ZONE_PX) {
      const v = get(id);
      const near = distancePx <= zonePx;
      if (near !== v.near) { v.near = near; v.since = v.lastTick ?? v.since; }
    },

    setHold(id, held) { get(id).hold = Boolean(held); },

    forceAwake(id) {
      const v = get(id);
      v.forced = true;
      v.state = "awake";
    },

    release(id) { get(id).forced = false; },

    tick(nowMs) {
      for (const v of s.values()) {
        v.lastTick = nowMs;
        if (v.forced) { v.state = "awake"; continue; }
        const wake = v.near || v.hold;
        if (wake) {
          if (v.state === "dormant" && nowMs - v.since >= WAKE_MS) v.state = "awake";
          if (v.state === "awake") v.since = nowMs;
        } else if (v.state === "awake" && nowMs - v.since >= SLEEP_MS) {
          v.state = "dormant";
          v.since = nowMs;
        }
      }
    },
  };
}

// Euclidean distance from a point to a rect; 0 when inside. Euclidean and
// not manhattan so a corner approach feels the same as an edge approach.
export function distanceToRect(rect, x, y) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

// The capture-command row is AUTHOR tooling: a 339px `node tools/capture.mjs
// --city=... ` string does not belong in a public data-story's chrome. It
// stays available to the author behind ?dev=1.
export function isDevMode(search) {
  return new URLSearchParams(search || "").get("dev") === "1";
}

// Re-sample every surface from the LAST KNOWN pointer position against each
// surface's CURRENT rect.
//
// This exists because proximity used to be evaluated only inside the
// pointermove handler, against whatever rect the surface had at that instant.
// A surface CHANGES SIZE when it collapses, so a verdict computed against the
// wide land-awake rail (156px) stays latched after the rail shrinks to 44px --
// and with a mouse resting still, no further pointermove ever arrives to
// correct it. On a narrow viewport the screen centre is inside the wide rail's
// zone but outside the collapsed one, so the rail would never sleep.
//
// Feeding this on every tick (not just on pointermove) closes that gap: the
// distance is always measured against the geometry the user can actually see.
// `pointer` is null until the first real pointer event, which is the headless
// / touch-only case -- there is no pointer to be near, so we leave state alone.
export function resampleDwell(dwell, surfaces, pointer, zonePx) {
  if (!pointer) return;
  for (const [id, rect] of surfaces) {
    if (rect) {
      dwell.pointerAt(
        id, distanceToRect(restingRect(id, rect), pointer.x, pointer.y), zonePx);
    }
  }
}

// The footprint a surface RESTS at, derived from its live rect.
//
// Measuring against the live rect is circular: the rail only shrinks to
// DORMANT_RAIL_PX once it is dormant, but it cannot become dormant while the
// pointer counts as near its EXPANDED self. On a 390px viewport the awake rail
// reaches x=166 and a 97px zone pushes the wake band to x=263 -- past the
// screen centre -- so a mouse resting mid-screen pinned it awake forever and
// no amount of re-sampling could ever produce a collapsed rect to escape with.
//
// Anchoring to the resting footprint breaks the loop: "near" means near where
// the rail LIVES, which is the same band whether it is currently open or shut.
export function restingRect(id, rect) {
  if (id !== "control-rail") return rect;
  // Read the four edges EXPLICITLY rather than spreading. A live
  // getBoundingClientRect() returns a DOMRect whose edges are getters on
  // DOMRect.prototype, not own enumerable properties -- so `{...rect}` copies
  // NOTHING and every edge silently becomes undefined, making distanceToRect
  // return NaN and the rail unwakeable. Plain object literals in unit tests do
  // not reproduce that, so this must stay explicit.
  return {
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
    right: Math.min(rect.right, rect.left + DORMANT_RAIL_PX),
  };
}
