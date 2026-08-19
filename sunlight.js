// Pure solar-elevation colour adaptation. Maths ported from tools/derive_sun_palette.mjs.
const srgbToLin=c=>c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4),linToSrgb=c=>c<=.0031308?12.92*c:1.055*Math.pow(c,1/2.4)-.055;
function rgbToOklab([r,g,b]){const R=srgbToLin(r),G=srgbToLin(g),B=srgbToLin(b),l=Math.cbrt(.4122214708*R+.5363325363*G+.0514459929*B),m=Math.cbrt(.2119034982*R+.6806995451*G+.1073969566*B),s=Math.cbrt(.0883024619*R+.2817188376*G+.6299787005*B);return[.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s]}
function oklabToRgb([L,a,b]){const l=(L+.3963377774*a+.2158037573*b)**3,m=(L-.1055613458*a-.0638541728*b)**3,s=(L-.0894841775*a-1.291485548*b)**3;return[4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s].map(linToSrgb)}
const inGamut=x=>x.every(c=>c>=-.001&&c<=1.001),clamp01=x=>x.map(c=>Math.max(0,Math.min(1,c))),toLCh=([L,a,b])=>[L,Math.hypot(a,b),(Math.atan2(b,a)*180/Math.PI+360)%360],fromLCh=([L,C,h])=>[L,C*Math.cos(h*Math.PI/180),C*Math.sin(h*Math.PI/180)],parseHex=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255);
export const NIGHT_RGB=parseHex('#0a0d16'),DEFAULT_RGB=[.063,.078,.125];
const nightLCh=toLCh(rgbToOklab(NIGHT_RGB)),DAY_LCh=[.86,.035,250],DAWN_LCh=[.58,.105,55],smoothstep=t=>t*t*(3-2*t);
export const DAY_RGB=clamp01(oklabToRgb(fromLCh(DAY_LCh)));
function lerpHue(a,b,t){let d=((b-a+540)%360)-180;return(a+d*t+360)%360}
export function groundColorFor(elev){if(elev<=-6)return NIGHT_RGB.slice();if(elev>=10)return DAY_RGB.slice();const t=smoothstep(Math.max(0,Math.min(1,(elev+6)/16))),warm=Math.max(0,1-Math.abs(elev)/6),L=nightLCh[0]+(DAY_LCh[0]-nightLCh[0])*t,baseH=lerpHue(nightLCh[2],DAY_LCh[2],t),baseC=nightLCh[1]+(DAY_LCh[1]-nightLCh[1])*t,h=lerpHue(baseH,DAWN_LCh[2],warm*.85),C=baseC+(DAWN_LCh[1]-baseC)*warm*.85,Ld=L+(DAWN_LCh[0]-L)*warm*.30;return clamp01(oklabToRgb(fromLCh([Ld,C,h])))}
export const groundLightness=e=>rgbToOklab(groundColorFor(e))[0];
const names=['metro','train','tram','bus','ferry'],hexes=['#ff9933','#b266ff','#33cc66','#8fb8e6','#8fb8e6'];
export const NIGHT_MODE_RGB=hexes.map(parseHex);
const hues=names.map((k,i)=>k==='ferry'?205:toLCh(rgbToOklab(NIGHT_MODE_RGB[i]))[2]);
function maxChroma(L,h){let lo=0,hi=.4;for(let i=0;i<40;i++){const mid=(lo+hi)/2;if(inGamut(oklabToRgb(fromLCh([L,mid,h]))))lo=mid;else hi=mid}return lo}
const relLum=([r,g,b])=>.2126*srgbToLin(r)+.7152*srgbToLin(g)+.0722*srgbToLin(b),contrast=(a,b)=>(Math.max(relLum(a),relLum(b))+.05)/(Math.min(relLum(a),relLum(b))+.05),dayGround=groundColorFor(55);
export const DAY_MODE_RGB=hues.map(h=>{for(let L=.8;L>=.2;L-=.005){const C=Math.min(maxChroma(L,h),.16),rgb=clamp01(oklabToRgb(fromLCh([L,C,h])));if(contrast(rgb,dayGround)>=4.5)return rgb}throw Error('Unable to solve daylight mode colour')});
const GROUND_L_NIGHT=.161,GROUND_L_DAY=.86,MIN_L_GAP=.30,lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
function enforceGap(rgb,groundL){const[L,a,b]=rgbToOklab(rgb);if(Math.abs(L-groundL)>=MIN_L_GAP)return clamp01(oklabToRgb([L,a,b]));const target=groundL>.5?groundL-MIN_L_GAP:groundL+MIN_L_GAP,[,C,h]=toLCh([L,a,b]),C2=Math.min(C,maxChroma(target,h));return clamp01(oklabToRgb(fromLCh([target,C2,h])))}
export function modeColorFor(code,elev){const night=NIGHT_MODE_RGB[code],day=DAY_MODE_RGB[code];if(!night||!day)return NIGHT_MODE_RGB[3].slice();const gl=groundLightness(elev),t=smoothstep(Math.max(0,Math.min(1,(gl-GROUND_L_NIGHT)/(GROUND_L_DAY-GROUND_L_NIGHT))));return enforceGap(lerp(night,day,t),gl)}
export function daylightBlendFor(elev){const gl=groundLightness(elev);return smoothstep(Math.max(0,Math.min(1,(gl-GROUND_L_NIGHT)/(GROUND_L_DAY-GROUND_L_NIGHT))))}
