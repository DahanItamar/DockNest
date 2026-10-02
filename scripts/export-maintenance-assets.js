import {readFile,writeFile} from 'node:fs/promises';
import {renderMaintenancePage,maintenanceDefaults} from '../shared/maintenance-design.js';
const font=await readFile('public/fonts/Roboto-Latin.woff2');
const html=renderMaintenancePage(maintenanceDefaults,{font:'data:font/woff2;base64,'+font.toString('base64')});
await writeFile('remote/maintenance.html',html);
await writeFile('docs/design/maintenance-system/visitor-default.html',html);
console.log('Exported self-contained animated visitor page with embedded font.');
