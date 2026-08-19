const NO_DATA = "No data baked for this hour";
export function gateDayParts(parts,dataMin,dataMax){return (Array.isArray(parts)?parts:[]).map(part=>{const anchor=Number(part.anchor_sec);const enabled=part.enabled!==false&&Number.isFinite(anchor)&&anchor>=dataMin&&anchor<=dataMax;return {...part,anchor_sec:anchor,enabled,title:enabled?`${part.label} · ${clockFromCivil(part.civil_sec)}`:(part.disabled_reason||NO_DATA)};});}
export function markerPosition(anchor,dataMin,dataMax){return Math.max(0,Math.min(1,(anchor-dataMin)/Math.max(1,dataMax-dataMin)));}
export function clockFromCivil(seconds){const s=((Number(seconds)%86400)+86400)%86400;return `${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor(s%3600/60)).padStart(2,"0")}`;}
export function activeDayPart(parts,t){const available=parts.filter(part=>part.enabled);if(!available.length)return "";return available.reduce((best,part)=>Math.abs(part.anchor_sec-t)<Math.abs(best.anchor_sec-t)?part:best).label;}
