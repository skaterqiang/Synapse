// Verify the packaged asar contains the fixed index.html (new i-logo + #i-logo empty state)
const asar = require('@electron/asar');
const buf = asar.extractFile('release/win-unpacked/resources/app.asar', 'src/index.html');
const html = buf.toString('utf8');
console.log('asar index.html length:', html.length);
console.log('has new i-logo (r=2.5):', html.includes('cx="5.5" cy="5.5" r="2.5"'));
console.log('empty uses #i-logo:', html.includes('href="#i-logo"'));
console.log('cache v=f script tags:', (html.match(/\?v=20260828f/g) || []).length);
console.log('U+FFFD count:', (html.match(/\uFFFD/g) || []).length);
const ok = html.includes('cx="5.5" cy="5.5" r="2.5"') && html.includes('href="#i-logo"');
console.log(ok ? 'VERIFIED: package embeds the fixed logo' : 'FAIL: package still has old logo');
process.exit(ok ? 0 : 1);
