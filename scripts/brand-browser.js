import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5175';
const output=process.env.BRAND_EVIDENCE_DIR||'data/homebird-verification';
await mkdir(output,{recursive:true});
const manifest=JSON.parse(await readFile('public/brand/asset-manifest.json','utf8'));
for(const asset of manifest.outputs){
 const bytes=await readFile('public/brand/'+asset.filename);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
}
const ico=await readFile('public/favicon.ico');
assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),3);
assert.deepEqual([ico[6],ico[22],ico[38]],[16,32,48]);
const browser=await chromium.launch({channel:'chrome',headless:true});
const records=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:960},deviceScaleFactor:2});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(process.env.BRAND_LIVE!=='true')await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:false,setupRequired:false}}));
 await page.goto(base);await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
 const favicon=await page.locator('link[rel="icon"]').getAttribute('href');
 const apple=await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
 assert.ok(favicon.includes(manifest.version));assert.ok(apple.includes(manifest.version));
 assert.equal(await page.locator('link[rel="apple-touch-icon"]').getAttribute('sizes'),'180x180');
 assert.equal(await page.locator('meta[name="apple-mobile-web-app-title"]').getAttribute('content'),'DockNest');
 const app=await(await page.request.get(new URL(await page.locator('link[rel="manifest"]').getAttribute('href'),base).href)).json();
 assert.equal(app.name,'DockNest');assert.equal(app.display,'standalone');assert.equal(app.start_url,'/');
 assert.equal(app.icons.find(i=>i.purpose==='maskable').sizes,'512x512');
 for(const [href,size,opaque,maskable] of [[favicon,32,false,false],[apple,180,true,false],...app.icons.map(i=>[i.src,Number(i.sizes.split('x')[0]),true,i.purpose==='maskable'])]){
  const response=await page.request.get(new URL(href,base).href);assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/image/);
  const stats=await page.evaluate(async({href,maskable})=>{
   const img=new Image();img.src=href;await img.decode();
   const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
   const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);const p=ctx.getImageData(0,0,c.width,c.height).data;
   let transparent=0,nonOpaque=0,blue=0,maxRadius=0;
   for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
    const i=(y*c.width+x)*4;if(p[i+3]===0)transparent++;if(p[i+3]!==255)nonOpaque++;
    if(p[i+2]>p[i]+30&&p[i+3]>64){blue++;if(maskable)maxRadius=Math.max(maxRadius,Math.hypot(x+.5-c.width/2,y+.5-c.height/2));}
   }
   return{width:c.width,height:c.height,transparent,nonOpaque,blue,maxRadius};
  },{href:new URL(href,base).href,maskable});
  assert.deepEqual([stats.width,stats.height],[size,size]);assert.ok(stats.blue>size*size*.08);
  if(opaque)assert.equal(stats.nonOpaque,0);else assert.ok(stats.transparent>size*size*.2);
  if(maskable)assert.ok(stats.maxRadius<=size*.4,'Bird fits maskable safe circle');
  records.push({href,...stats});
 }
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:960});await page.reload();await page.locator('.brand-image').evaluate(img=>img.decode());
  const brand=await page.locator('.brand-image').evaluate(async img=>{const resource=new Image();resource.src=img.currentSrc;await resource.decode();return{src:img.currentSrc,native:[resource.naturalWidth,resource.naturalHeight],width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height};});
  assert.ok(brand.src.includes(manifest.version));assert.ok(brand.native[0]>=brand.width*2);
  assert.ok(Math.abs(brand.width/brand.height-2015/395)<.06,'Header logo preserves its proportions');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollbarWidth),'none');
  await page.screenshot({path:output+'/signin-'+width+'.png',animations:'disabled'});
  records.push({viewport:width,brand});
 }
 if(process.env.BRAND_LIVE!=='true'){
  await page.unroute('**/api/auth/status');
  await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{id:'admin',name:'Administrator',role:'admin'}}}));
  await page.route('**/api/state',r=>r.fulfill({json:{servers:[],sites:[],backups:[],jobs:[],policies:[],audit:[],storage:{}}}));
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:960});await page.reload();await page.locator('.dash-growth').waitFor();await page.locator('.brand-image').evaluate(img=>img.decode());
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:output+'/dashboard-'+width+'.png',animations:'disabled'});
  }
 }
 assert.deepEqual(errors,[]);
 await writeFile(output+'/verification.json',JSON.stringify({base,version:manifest.version,records,pageErrors:errors,icoSizes:[16,32,48]},null,2)+'\n');
 console.log('Homebird passed: asset hashes, native transparency, Apple opaque icon, PWA mask safe area, ICO sizes, retina header and 1440/390/320px layouts.');
}finally{await browser.close();}
