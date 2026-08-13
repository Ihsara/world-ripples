// edgepulse.js — the travelling head that runs stop A -> stop B along a leg.
//
// WHY THIS EXISTS. A ripple blooms at a stop from an arrival event, and
// corridors are a STATIC silhouette (corridors.js). Nothing ever connected the
// two, so the network read as scattered independent droplets that happen to sit
// near each other rather than as something PROPAGATING. This module supplies the
// missing link: a bright head that travels the leg during its real travel time,
// arriving exactly when the stop's own ripple fires.
//
// The chaining ("the origin of each edge is the endpoint of the previous one")
// needs no new data and no new bake — it is already implicit in the breakpoints.
// Within a trip, leg k's END breakpoint IS leg k+1's START breakpoint, so simply
// walking consecutive breakpoint pairs yields a connected chain by construction.
//
// Everything here is pure (no WebGL, no DOM) so it can be unit-tested headlessly;
// field.js owns the drawing and app.js owns the per-frame budget.
import { pointAtDistance, shapePolyline } from "./vehicles.js?v=963df69525";

// PULSE_BUDGET — max travelling heads considered in one frame.
//
// The whole-city peak of concurrent in-flight legs on the shipped Helsinki
// bundle is 5,574 (sim t=18480s == 08:08 civil, since sim_origin_sec=10800;
// mean over the day is 2,862). Drawing all of them is affordable on the GPU
// (5 instanced draw calls) but NOT in JS: benchmarked on the real bundle, the
// per-frame cost of walking every leg is
//
//   cap 5574 -> 14.5 ms/frame      cap 1200 -> 1.1 ms/frame
//   cap 2000 ->  2.2 ms/frame      cap  800 -> 0.7 ms/frame
//
// 14.5 ms of JS is most of a 60 fps budget spent before the ripple restamp --
// the pass that is actually the subject -- has run at all.
//
// 1,200 sits at the knee: 13x cheaper than uncapped, and still far more heads
// than are individually legible in one frame. activeLegs returns NEWEST-started
// first, so the cap drops pulses that have nearly arrived rather than ones just
// setting out, which is the less visible loss.
export const PULSE_BUDGET = 1200;

// Tail length behind the head, in the SHAPE'S OWN DISTANCE UNIT.
//
// 🚨 shape_cumdist / trip_bp_dist are NOT metres — they are DEGREES. Measured
// against the true great-circle length of Helsinki's polylines, one unit is
// ~110,900 m. A "180" here was therefore read as 180 DEGREES (~20,000 km), so
// every tail covered its entire leg and the pulses rendered as solid ribbons
// laid over the corridors instead of travelling heads. That is a silent failure:
// the geometry is valid, the units are wrong, and only the live frame shows it.
//
// Keep the constant in the same unit the data uses and convert at the boundary,
// so the tail can never be compared against a raw metre value again.
const METRES_PER_SHAPE_UNIT = 110900;

// 250 m. Measured leg lengths on the shipped Helsinki bundle are p10 232 m /
// median 512 m / p90 1121 m, so a 250 m tail spans a whole leg for only 11.8%
// of legs — the head stays a head rather than filling its edge.
export const PULSE_TAIL_METRES = 250;
export const PULSE_TAIL = PULSE_TAIL_METRES / METRES_PER_SHAPE_UNIT;

// Per-city leg index, built once and memoised. Keyed on the two typed arrays it
// derives from, so switching cities drops the old index with the old bundle
// instead of pinning it (same WeakMap idiom as vehicles.js's _polyCache).
const indexes = new WeakMap();

// legIndex — flatten every trip's breakpoints into a flat array of legs, sorted
// by start time, so a frame can binary-search instead of scanning all trips.
//
// Helsinki is 122,137 trips / 3,021,086 legs: a per-frame linear scan over trips
// is exactly the cost the rAF loop cannot absorb, which is why this is built
// once at load rather than per frame.
function legIndex(trips, bpTime) {
  let byTrips = indexes.get(bpTime);
  if (!byTrips) { byTrips = new WeakMap(); indexes.set(bpTime, byTrips); }
  const hit = byTrips.get(trips);
  if (hit) return hit;

  let count = 0;
  for (const trip of trips) count += Math.max(0, (trip.bcount | 0) - 1);

  const tripNo = new Uint32Array(count), bp = new Uint32Array(count);
  const start = new Uint32Array(count), end = new Uint32Array(count);
  let n = 0;
  for (let ti = 0; ti < trips.length; ti++) {
    const trip = trips[ti];
    for (let k = trip.b0; k < trip.b0 + trip.bcount - 1; k++, n++) {
      tripNo[n] = ti; bp[n] = k; start[n] = bpTime[k]; end[n] = bpTime[k + 1];
    }
  }

  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => start[a] - start[b] || a - b);

  // prefixMaxEnd[i] = the latest END time among the first i+1 legs in start
  // order. Legs are sorted by START, but a query needs "still running at tNow",
  // and a long early leg can outlive many later short ones — so scanning
  // backwards from the start cursor cannot stop at the first expired leg. This
  // running maximum gives a sound early-exit: once the max end time among all
  // remaining candidates is below tNow, none of them can still be in flight.
  const prefixMaxEnd = new Uint32Array(count);
  let maxEnd = 0;
  for (let i = 0; i < count; i++) {
    maxEnd = Math.max(maxEnd, end[order[i]]);
    prefixMaxEnd[i] = maxEnd;
  }

  const built = { tripNo, bp, start, end, order, prefixMaxEnd };
  byTrips.set(trips, built);
  return built;
}

// activeLegs — the legs in flight at tNow, newest-started first, capped at
// `budget`. Newest-first matters under the cap: those are the pulses nearest
// their origin stop, so a truncated frame drops the oldest (nearly-arrived)
// pulses rather than the ones just setting out.
export function activeLegs(trips, bpTime, tNow, budget = PULSE_BUDGET) {
  if (!trips || !bpTime || budget <= 0) return [];
  const ix = legIndex(trips, bpTime);

  // Upper bound: first leg whose start time exceeds tNow.
  let lo = 0, hi = ix.order.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ix.start[ix.order[mid]] <= tNow) lo = mid + 1; else hi = mid;
  }

  const out = [];
  for (let i = lo - 1; i >= 0 && out.length < budget; i--) {
    if (ix.prefixMaxEnd[i] < tNow) break; // no earlier leg can still be running
    const j = ix.order[i];
    if (ix.end[j] < tNow) continue;
    out.push({
      trip: trips[ix.tripNo[j]], tripIndex: ix.tripNo[j], bpIndex: ix.bp[j],
      startTime: ix.start[j], endTime: ix.end[j],
    });
  }
  return out;
}

// pulseHead — fraction 0..1 of the leg travelled at tNow. Linear in time, the
// same model vehiclePosition uses, so a pulse head and a vehicle dot on the same
// trip stay together instead of drifting apart.
export function pulseHead(leg, tNow) {
  const span = leg.endTime - leg.startTime;
  if (span <= 0) return tNow < leg.startTime ? 0 : 1; // zero-duration leg: never divide
  return Math.max(0, Math.min(1, (tNow - leg.startTime) / span));
}

// headDistance — where the head sits in metres along the shape.
function headDistance(leg, tNow, data) {
  const k = leg.bpIndex, d0 = data.bpDist[k], d1 = data.bpDist[k + 1];
  return d0 + (d1 - d0) * pulseHead(leg, tNow);
}

// pulseHeadPoint — the head's [lon, lat], without emitting any geometry.
// Exists so the caller can viewport-cull BEFORE spending scratch-buffer space
// on a pulse it would only rewind (see the cull comment in app.js). Returns null
// when the leg's route is missing from the bundle.
export function pulseHeadPoint(leg, tNow, data) {
  const route = data.routes[leg.trip.shape];
  if (!route) return null;
  const [coords, cum] = shapePolyline(route, data);
  return pointAtDistance(coords, cum, headDistance(leg, tNow, data));
}

// pulseGeometry — emit the head + trailing tail as line segments into a
// caller-owned scratch array, returning the new write offset.
//
// Layout per segment: [ax, ay, bx, by, distA, distB], where dist* is metres
// BEHIND the tail end, so the shader can fade the tail out with a single
// smoothstep against tailLen.
//
// The tail is cut at every shape vertex it crosses rather than drawn as one
// straight chord, so a pulse rounding a curve follows the true track alignment.
// Writing stops at the array bound instead of overrunning it: a truncated tail
// on a pathologically dense shape is invisible, and the caller detects a full
// buffer by seeing the offset fail to advance.
export function pulseGeometry(leg, tNow, data, out, offset = 0, tailLen = PULSE_TAIL) {
  const route = data.routes[leg.trip.shape];
  if (!route) return offset;

  const k = leg.bpIndex, d0 = data.bpDist[k], d1 = data.bpDist[k + 1];
  const head = headDistance(leg, tNow, data);
  // A shape's cumulative distance may run either way relative to the leg, so
  // the tail trails "backwards" in whichever direction travel is going.
  const forward = d1 >= d0;
  const tail = forward ? Math.max(d0, head - tailLen) : Math.min(d0, head + tailLen);

  const [coords, cum] = shapePolyline(route, data);
  const cuts = [tail];
  if (forward) {
    for (const d of cum) if (d > tail && d < head) cuts.push(d);
  } else {
    for (let i = cum.length - 1; i >= 0; i--) if (cum[i] < tail && cum[i] > head) cuts.push(cum[i]);
  }
  cuts.push(head);

  let a = pointAtDistance(coords, cum, cuts[0]);
  for (let i = 1; i < cuts.length; i++) {
    if (offset + 6 > out.length) return offset; // full: stop at the bound
    const b = pointAtDistance(coords, cum, cuts[i]);
    out[offset++] = a[0];       out[offset++] = a[1];
    out[offset++] = b[0];       out[offset++] = b[1];
    out[offset++] = Math.abs(cuts[i - 1] - tail);
    out[offset++] = Math.abs(cuts[i] - tail);
    a = b;
  }
  return offset;
}
