import {chromium} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:2400,height:1500},deviceScaleFactor:1});
 await page.goto(new URL('preview.html',import.meta.url).href);
 await page.evaluate(async()=>Promise.all([...document.images].map(image=>image.decode())));
 await page.screenshot({path:fileURLToPath(new URL('preview-sheet.png',import.meta.url)),fullPage:true});
}finally{await browser.close();}
