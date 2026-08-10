// solar.js — NOAA solar position. PURE: no DOM, no GL, no wall clock, no RNG.
// Captures must be deterministic, so nothing here may read a wall clock.
//
// The clock this feeds is CIVIL local time (every city manifest uses
// sim_origin_sec=10800 and GTFS departure times are local wall time). Solar
// position depends on LONGITUDE. The civil->solar correction below is what
// reconciles the two; dropping it shifts Madrid's solar noon by ~85 minutes.

const RAD = Math.PI / 180;

// The four astronomical seasons. Solstices and equinoxes are the same instants
// worldwide, so one shared set yields per-city seasons via latitude alone.
export const SEASONS = [
  { key: "mar", label: "Mar 20", dayOfYear: 79 },
  { key: "jun", label: "Jun 21", dayOfYear: 172 },
  { key: "sep", label: "Sep 22", dayOfYear: 265 },
  { key: "dec", label: "Dec 21", dayOfYear: 355 },
];

// NOAA fractional-year expansion -> equation of time (minutes) + declination (radians).
function orbital(dayOfYear) {
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const eqTimeMin = 229.18 * (0.000075
    + 0.001868 * Math.cos(g)     - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const declRad = 0.006918
    - 0.399912 * Math.cos(g)     + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148  * Math.sin(3 * g);
  return { eqTimeMin, declRad };
}

// Civil minutes-since-midnight at which the sun crosses the local meridian.
// 4 min per degree of longitude; the utcOffsetHours term converts the
// longitude-based solar clock back onto the city's civil clock.
function solarNoonMinutes(lon, utcOffsetHours, eqTimeMin) {
  return 720 - 4 * lon - eqTimeMin + utcOffsetHours * 60;
}

export function solarElevation({ lat, lon, utcOffsetHours, dayOfYear, civilSecondsSinceMidnight }) {
  const { eqTimeMin, declRad } = orbital(dayOfYear);
  const noonMin = solarNoonMinutes(lon, utcOffsetHours, eqTimeMin);
  // Hour angle: 0 at solar noon, 15 degrees per hour away from it.
  const hourAngleDeg = (civilSecondsSinceMidnight / 60 - noonMin) * 0.25;
  const latRad = lat * RAD;
  const sinAlt = Math.sin(latRad) * Math.sin(declRad)
               + Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourAngleDeg * RAD);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
}

export function sunTimes({ lat, lon, utcOffsetHours, dayOfYear }) {
  const { eqTimeMin, declRad } = orbital(dayOfYear);
  const noonMin = solarNoonMinutes(lon, utcOffsetHours, eqTimeMin);
  const solarNoonSec = Math.round(noonMin * 60);
  // 90.833 degrees = the standard sunrise/sunset zenith (refraction + solar radius).
  const cosH = (Math.cos(90.833 * RAD) - Math.sin(lat * RAD) * Math.sin(declRad))
             / (Math.cos(lat * RAD) * Math.cos(declRad));
  // Polar night / midnight sun: the sun never crosses the horizon. No city in
  // the current 12 hits this on the four chosen dates (Helsinki at 60.25N still
  // has a real sunrise on Jun 21), but a future Arctic city must not get NaN.
  if (cosH > 1 || cosH < -1) return { sunriseSec: null, solarNoonSec, sunsetSec: null };
  const halfDayMin = (Math.acos(cosH) / RAD) * 4;
  return {
    sunriseSec: Math.round((noonMin - halfDayMin) * 60),
    solarNoonSec,
    sunsetSec: Math.round((noonMin + halfDayMin) * 60),
  };
}
