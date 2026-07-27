// web/vehicles.js — pure GTFS shape_dist_traveled interpolation, ported 1:1 from
// ripplesim/vehicles.py (vehicle_position/point_at_distance). The web player calls
// vehiclePosition(trip, s, data) each frame for every live trip (Option A: sim-in-JS,
// no baked per-frame table). Keep this math identical to the Python reference.
export function pointAtDistance(coordsXY, cumdist, d) {
  const n = cumdist.length;
  if (d <= cumdist[0]) return coordsXY[0];
  if (d >= cumdist[n - 1]) return coordsXY[n - 1];
  // segment [j, j+1] containing d (upper_bound - 1)
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (cumdist[mid] <= d) lo = mid + 1; else hi = mid; }
  const j = lo - 1;
  const seg = cumdist[j + 1] - cumdist[j];
  const f = seg <= 0 ? 0 : (d - cumdist[j]) / seg;
  const [ax, ay] = coordsXY[j], [bx, by] = coordsXY[j + 1];
  return [ax + (bx - ax) * f, ay + (by - ay) * f];
}

// Memo cache for shapePolyline. The rAF loop calls it once per live trip per
// frame (8,520 trips for NYC, 32,197 for Helsinki) and it rebuilt the whole
// polyline as fresh nested arrays every time. Keyed on the shape's slice
// identity (v0:vcount) within a city's flat shapeCoords array; a WeakMap on
// `data.shapeCoords` holds the per-city caches so a city switch drops them
// with the data instead of pinning the old bundle.
const _polyCache = new WeakMap();

export function shapePolyline(route, data) {
  const { v0, vcount } = route;
  const sc = data.shapeCoords, scd = data.shapeCumdist;
  let byShape = _polyCache.get(sc);
  if (byShape === undefined) { byShape = new Map(); _polyCache.set(sc, byShape); }
  const key = v0 + ":" + vcount;
  const hit = byShape.get(key);
  if (hit !== undefined) return hit;
  const coords = [], cum = [];
  for (let i = 0; i < vcount; i++) {
    coords.push([sc[2 * (v0 + i)], sc[2 * (v0 + i) + 1]]);
    cum.push(scd[v0 + i]);
  }
  const pts = [coords, cum];
  byShape.set(key, pts);
  return pts;
}

export function vehiclePosition(trip, s, data) {
  const { b0, bcount } = trip;
  const bt = data.bpTime, bd = data.bpDist;
  const tLo = bt[b0], tHi = bt[b0 + bcount - 1];
  if (s < tLo || s > tHi) return null;
  let k = b0;
  while (k < b0 + bcount - 1 && bt[k + 1] < s) k++;
  const span = bt[k + 1] - bt[k];
  const f = span <= 0 ? 0 : (s - bt[k]) / span;
  const d = bd[k] + (bd[k + 1] - bd[k]) * f;
  const route = data.routes[trip.shape];
  const [coords, cum] = shapePolyline(route, data);
  return pointAtDistance(coords, cum, d);
}
