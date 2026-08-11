// Spatial zoom views: CAMERA presets over one baked bundle.
//
// A view never changes what data is loaded -- only where the camera starts.
// An unknown slug therefore falls back to a real framing rather than leaving
// the canvas empty: a mis-typed URL should show the city, not nothing.

export function pickView(entry, slug) {
  const views = (entry && entry.views) || [];
  if (slug) {
    const hit = views.find((v) => v.slug === slug);
    if (hit) return hit.bbox;
    // Unknown slug: still show a real view rather than nothing.
    if (views.length) return views[0].bbox;
  }
  if (entry && entry.region_bbox) return entry.region_bbox;
  return views.length ? views[0].bbox : null;
}
