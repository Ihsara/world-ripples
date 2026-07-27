// data.js — fetch baked binaries into typed arrays. Fetches are RELATIVE
// (Pages-safe). dtype maps to the little-endian packing from src/packing.py.
const CTOR = { f32: Float32Array, u32: Uint32Array, u16: Uint16Array, i32: Int32Array };

export async function loadManifest(dir) {
  const r = await fetch(`${dir}/manifest.json`);
  if (!r.ok) throw new Error(`Failed to fetch manifest.json: ${r.status} ${r.statusText}`);
  return r.json();
}
export async function loadBin(dir, name, dtype) {
  // Percent-encode the FILENAME (not `dir`, which carries real path separators).
  // Bin names are built from subarea names, and Zurich is the first city whose
  // subarea is non-ASCII: `street_Zürich_seg.bin`. Served raw, that path 404s —
  // verified against a local static server, where the raw form returned 404 and
  // the percent-encoded form returned 200. Browsers often normalize this for you;
  // "often" is not a deploy guarantee.
  const r = await fetch(`${dir}/${encodeURIComponent(name)}.bin`);
  if (!r.ok) throw new Error(`Failed to fetch ${name}.bin: ${r.status} ${r.statusText}`);
  const buf = await r.arrayBuffer();
  return new CTOR[dtype](buf);
}
// Bounded LRU cache of loaded city bundles, so switching back to a city you
// just viewed is instant instead of a full re-download and re-parse.
//
// BOUNDED ON PURPOSE. Each bundle is ~4-24 MB of typed arrays; an unbounded
// cache would re-create exactly the leak the teardown work fixed (the panel's
// AbortController was pinning a "~20 MB data bundle" via detached row
// handlers -- app.js:609-612). Two entries covers the common A-to-B-and-back
// switch without letting seven cities pile up.
export function makeCityCache(limit) {
  const m = new Map(); // Map preserves insertion order -> cheap LRU
  return {
    has: (slug) => m.has(slug),
    size: () => m.size,
    get(slug) {
      if (!m.has(slug)) return undefined;
      const v = m.get(slug);
      m.delete(slug); m.set(slug, v);   // refresh recency
      return v;
    },
    set(slug, bundle) {
      if (m.has(slug)) m.delete(slug);  // replace, don't duplicate
      m.set(slug, bundle);
      while (m.size > limit) m.delete(m.keys().next().value); // evict LRU
    },
  };
}

export async function loadAll(dir) {
  const manifest = await loadManifest(dir);
  const [stops, stopMode, stopCity, stampEdge, stampDelay, stampIntensity,
         stampIndex, eventStop, eventTime] = await Promise.all([
    loadBin(dir, "stops", "f32"), loadBin(dir, "stop_mode", "u16"),
    loadBin(dir, "stop_city", "u16"), loadBin(dir, "stamp_edge", "u32"),
    loadBin(dir, "stamp_delay", "u16"), loadBin(dir, "stamp_intensity", "u16"),
    loadBin(dir, "stamp_index", "u32"), loadBin(dir, "event_stop", "u32"),
    loadBin(dir, "event_time", "u32"),
  ]);
  // Parallel, not sequential: this was an `await` inside a `for`, so Helsinki's
  // four street bins cost four serial round-trips for no reason.
  const streets = {};
  const cityNames = Object.keys(manifest.cities);
  const streetBins = await Promise.all(
    cityNames.map((city) => loadBin(dir, `street_${city}_seg`, "f32"))
  );
  cityNames.forEach((city, i) => { streets[city] = streetBins[i]; });
  // Vehicle bins (Task 9, Option A: sim-in-JS interpolation, no baked
  // per-frame table). Guarded: an older bake without vehicle bins must
  // still run the app (ripples-only, no moving dots).
  const [vehicleTripBpTime, vehicleTripBpDist, vehicleShapeCoords, vehicleShapeCumdist] =
    await Promise.all([
      loadBin(dir, "trip_bp_time", "u32").catch(() => null),
      loadBin(dir, "trip_bp_dist", "f32").catch(() => null),
      loadBin(dir, "shape_coords", "f32").catch(() => null),
      loadBin(dir, "shape_cumdist", "f32").catch(() => null),
    ]);
  // Districts (Task 5 bake, Task 6 UI): optional chrome, not core data — an
  // older deploy without districts.json must not break the app.
  let districts = null;
  try {
    const r = await fetch(`${dir}/districts.json`);
    if (r.ok) districts = await r.json();
  } catch (_) { /* districts are optional chrome, not core data */ }

  return { manifest, stops, stopMode, stopCity, stampEdge, stampDelay,
           stampIntensity, stampIndex, eventStop, eventTime, streets,
           vehicleTripBpTime, vehicleTripBpDist, vehicleShapeCoords, vehicleShapeCumdist,
           routes: manifest.routes || null, trips: manifest.trips || null,
           districts };
}
