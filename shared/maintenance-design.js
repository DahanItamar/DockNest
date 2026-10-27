export const maintenanceDefaults=Object.freeze({title:'A short pause. A smooth return.',message:'We are giving this site a little care. Thank you for your patience. This page will return automatically when everything is ready.',color:'#5E35B1',layout:'studio',theme:'light',typeScale:'balanced'});
export const maintenancePresets=[
 {name:'Studio pause',description:'An animated website scene with a clear, welcoming message.',settings:maintenanceDefaults},
 {name:'Editorial',description:'Centered typography and a quieter visual composition.',settings:{...maintenanceDefaults,title:'Good things take a moment.',message:'This site is receiving some care. We will be back shortly. Thank you for your patience.',layout:'editorial'}},
 {name:'Essential',description:'A focused message with the fewest distractions.',settings:{...maintenanceDefaults,title:"We'll be right back.",message:'This site is briefly unavailable. Please check back shortly.',layout:'compact'}}
];
export function normalizeMaintenance(value={}){
 const defaults=maintenanceDefaults;
 return {title:typeof value.title==='string'&&value.title.trim()?value.title.slice(0,150):defaults.title,message:typeof value.message==='string'&&value.message.trim()?value.message.slice(0,1000):defaults.message,color:/^#[0-9a-f]{6}$/i.test(value.color||'')?value.color:defaults.color,layout:['studio','editorial','compact'].includes(value.layout)?value.layout:defaults.layout,theme:'light',typeScale:['balanced','bold'].includes(value.typeScale)?value.typeScale:defaults.typeScale};
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderMaintenancePage(value={},options={}){
 const settings=normalizeMaintenance(value);
 const font=options.font||'/fonts/Roboto-Latin.woff2';
 const safeFont=/^(?:\/fonts\/Roboto-Latin\.woff2|data:font\/woff2;base64,[A-Za-z0-9+/=]+)$/.test(font)?font:'/fonts/Roboto-Latin.woff2';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="dbm-maintenance" content="dbm-maintenance-v1"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(settings.title)}</title>
<style>
@font-face{font-family:Roboto;src:url('${safeFont}') format('woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}body{margin:0;--bg:#EEF2F6;--paper:#FFFFFF;--ink:#364152;--secondary:#667284;--line:#E3E8EF;--accent:${settings.color};background:var(--bg);color:var(--ink);font-family:Roboto,system-ui,sans-serif;min-height:100vh}

.shell{max-width:1240px;min-height:100dvh;margin:0 auto;padding:36px 48px;display:flex;flex-direction:column}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:24px;font-size:12px;color:var(--secondary)}
.status{display:inline-flex;align-items:center;gap:10px;color:var(--ink);font-weight:500}
.status:before{content:'';width:7px;height:7px;border-radius:50%;background:var(--accent)}
.layout{flex:1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:64px;align-items:center;padding:64px 0}
.copy{min-width:0}.eyebrow{text-transform:uppercase;letter-spacing:1.5px;font-size:10px;color:var(--secondary);margin:0 0 24px}
h1{font-size:clamp(36px,4.8vw,60px);font-weight:600;line-height:1.12;letter-spacing:-2px;margin:0 0 24px;overflow-wrap:anywhere}
.bold h1{font-size:clamp(40px,5.8vw,76px);font-weight:700}
.message{font-size:16px;line-height:1.8;max-width:42ch;color:var(--secondary);white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 32px}
.retry{display:inline-flex;gap:16px;align-items:center;min-height:48px;border:1px solid var(--ink);border-radius:10px;padding:12px 20px;font:600 13px Roboto,system-ui;cursor:pointer;background:var(--ink);color:var(--paper)}
.retry:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.retry:hover{opacity:.85}.retry svg{width:16px;height:16px}
.availability{font-size:11px;line-height:1.6;color:var(--secondary);margin:20px 0 0}
.scene{margin:0;min-width:0;position:relative;aspect-ratio:1;display:flex;align-items:center;justify-content:center;background:transparent;border:0}
.scene svg{display:block;width:100%;height:auto;overflow:visible}.scene figcaption{position:absolute;bottom:0;font-size:12px;letter-spacing:.2px;color:var(--secondary)}
.site-window{transform-origin:260px 240px;animation:site-float 6s cubic-bezier(.45,0,.55,1) infinite}
.signal{transform-origin:260px 260px;animation:signal-orbit 12s linear infinite}
.signal-back{animation-direction:reverse;animation-duration:18s}
.content-line{transform-box:fill-box;transform-origin:left center;animation:site-breathe 4s cubic-bezier(.45,0,.55,1) infinite}
.content-line.second{animation-delay:1s}.content-line.third{animation-delay:2s}
@keyframes site-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
@keyframes signal-orbit{to{transform:rotate(360deg)}}
@keyframes site-breathe{0%,100%{transform:scaleX(1)}50%{transform:scaleX(.88)}}
footer{border-top:1px solid var(--line);padding-top:24px;font-size:10px;line-height:1.6}
footer .powered{color:inherit;font-weight:600;text-decoration:none}footer .powered:hover,footer .powered:focus-visible{text-decoration:underline}
.editorial .layout{grid-template-columns:1fr;gap:32px;padding:48px 0;text-align:center}.editorial .copy{grid-row:2;max-width:800px;margin:auto}.editorial .message{margin-left:auto;margin-right:auto}.editorial .scene{grid-row:1;width:240px;min-height:200px;aspect-ratio:auto;margin:auto;border:0;background:transparent;padding:0}.editorial .scene svg{max-height:220px}.editorial .scene:before,.editorial .scene figcaption{display:none}
.compact .layout{grid-template-columns:1fr;text-align:center}.compact .copy{max-width:760px;margin:0 auto}.compact .scene{display:none}.compact .message{margin-left:auto;margin-right:auto}
@media(max-width:640px){.shell{padding:24px}header{font-size:10px;gap:12px}header>span{display:none}.status{padding:8px 12px}.layout{grid-template-columns:1fr;gap:32px;padding:48px 0 32px}.copy{text-align:center}h1{font-size:36px;letter-spacing:-1.2px}.bold h1{font-size:40px}.message{font-size:14px;line-height:1.7;margin:0 auto 24px}.scene{max-width:320px;width:100%;aspect-ratio:auto;min-height:250px;margin:auto;padding:20px}.scene svg{max-height:280px;width:100%}.scene figcaption{bottom:20px}.scene:before{top:20px;left:20px}footer{gap:16px;font-size:9px}.editorial .layout{padding-top:24px}.editorial .scene svg{max-height:190px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto;animation:none!important}}
</style></head><body class="${settings.layout} ${settings.theme} ${settings.typeScale}">
<div class="shell"><header><span class="status">Maintenance in progress</span><span>A little care goes a long way.</span></header><main class="layout"><section class="copy"><p class="eyebrow">A MOMENT TO RESET</p><h1>${escape(settings.title)}</h1><p class="message">${escape(settings.message)}</p><button class="retry" type="button"${options.interactive===false?' disabled':' onclick="location.reload()"'}>Try again<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></button><p class="availability">This page checks availability automatically.</p></section><figure class="scene" aria-label="Website receiving scheduled care"><svg class="maintenance-animation" viewBox="0 0 520 520" role="img" aria-label="Animated website window with a pause symbol">
<circle cx="260" cy="260" r="204" fill="none" stroke="#D8D1EB" stroke-width="1" stroke-dasharray="3 9"/>
<circle cx="260" cy="260" r="174" fill="none" stroke="#D5E7F4" stroke-width="1"/>
<g class="signal"><circle cx="260" cy="56" r="9" fill="#2196F3"/></g>
<g class="signal signal-back"><circle cx="86" cy="260" r="6" fill="var(--accent)"/></g>
<g class="site-window"><rect x="116" y="151" width="288" height="218" rx="14" fill="#FFF"/><path d="M116 199h288" stroke="#EEF2F6" stroke-width="2"/>
<circle cx="137" cy="176" r="4" fill="#C5CEE0"/><circle cx="151" cy="176" r="4" fill="#C5CEE0"/><circle cx="165" cy="176" r="4" fill="#C5CEE0"/>
<rect x="213" y="167" width="146" height="18" rx="5" fill="#F1F4F8"/>
<rect x="139" y="224" width="78" height="121" rx="8" fill="#EDE7F6"/><rect x="155" y="242" width="46" height="5" rx="2.5" fill="#B39DDB"/><rect x="155" y="257" width="32" height="5" rx="2.5" fill="#D1C4E9"/>
<rect class="content-line" x="237" y="233" width="131" height="9" rx="4.5" fill="#C5DDF0"/><rect class="content-line second" x="237" y="254" width="100" height="6" rx="3" fill="#DEE6EF"/><rect class="content-line third" x="237" y="271" width="121" height="6" rx="3" fill="#DEE6EF"/>
<rect x="237" y="299" width="62" height="46" rx="6" fill="#E3F2FD"/><rect x="309" y="299" width="62" height="46" rx="6" fill="#EDE7F6"/>
<circle cx="396" cy="354" r="36" fill="var(--accent)"/><path d="M387 342v24m18-24v24" stroke="#FFF" stroke-width="6" stroke-linecap="round"/></g>
</svg><figcaption>A brief pause for a better website.</figcaption></figure></main><footer><span>Thank you for your patience.</span><a class="powered" href="https://github.com/DahanItamar/DockNest" target="_blank" rel="noopener">Powered by DockNest</a></footer></div>
${options.interactive===false?'':`<script>if(document.referrer||location.href){setInterval(async()=>{try{const response=await fetch('/__backup_status',{cache:'no-store',signal:AbortSignal.timeout(4000)});if(response.ok)location.replace(location.href)}catch{}},15000)}</script>`}
</body></html>`;
}
