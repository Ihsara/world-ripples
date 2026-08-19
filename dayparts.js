const NO_DATA = "No data baked for this hour";
export function gateDayParts(parts,dataMin,dataMax){return (Array.isArray(parts)?parts:[]).map(part=>{const anchor=Number(part.anchor_sec);const enabled=part.enabled!==false&&Number.isFinite(anchor)&&anchor>=dataMin&&anchor<=dataMax;return {...part,anchor_sec:anchor,enabled,title:enabled?`${part.label} · ${clockFromCivil(part.civil_sec)}`:(part.disabled_reason||NO_DATA)};});}
export function markerPosition(anchor,dataMin,dataMax){return Math.max(0,Math.min(1,(anchor-dataMin)/Math.max(1,dataMax-dataMin)));}
export function clockFromCivil(seconds){const s=((Number(seconds)%86400)+86400)%86400;return `${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor(s%3600/60)).padStart(2,"0")}`;}
// The readout names the hour the clock is SHOWING, so it must consider every
// day part -- not just the enabled ones. `enabled` gates whether a marker is
// CLICKABLE (its anchor is inside the baked window with the bake's 1h margin);
// it says nothing about which part of the day the current time falls in.
// Filtering to enabled parts pinned madrid/copenhagen/porto/tokyo -- whose 4h
// 09:00-13:00 bake leaves exactly one enabled part -- to that one label for the
// entire playback, so noon read "Morning rush".
export function activeDayPart(parts,t){if(!Array.isArray(parts)||!parts.length)return "";return parts.reduce((best,part)=>Math.abs(part.anchor_sec-t)<Math.abs(best.anchor_sec-t)?part:best).label;}
