// Byte-safe re-apply of logo changes to src/index.html (avoids PS/editor encoding pitfalls)
const fs = require('fs');
const p = 'src/index.html';
let html = fs.readFileSync(p, 'utf8');
const before = html.length;

// 1) optimized i-logo symbol (bigger nodes r=2.5, thicker lines sw=2, 3-wave book)
const oldLogo = '<symbol id="i-logo" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="5.5" r="2.2" fill="currentColor" stroke="none"/><circle cx="18.5" cy="5.5" r="2.2" fill="currentColor" stroke="none"/><circle cx="12" cy="16.5" r="2.2" fill="currentColor" stroke="none"/><path d="M7.5 5.5h9"/><path d="M6.9 7.1l3.7 7.4"/><path d="M17.1 7.1l-3.7 7.4"/><path d="M4 20.5c2.5-1.5 5.5-1.5 8 0 2.5-1.5 5.5-1.5 8 0"/></g></symbol>';
const newLogo = '<symbol id="i-logo" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="5.5" r="2.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="5.5" r="2.5" fill="currentColor" stroke="none"/><circle cx="12" cy="16.5" r="2.5" fill="currentColor" stroke="none"/><path d="M7.5 5.5h9" stroke-width="2"/><path d="M6.9 7.1l3.7 7.4" stroke-width="2"/><path d="M17.1 7.1l-3.7 7.4" stroke-width="2"/><path d="M3 19.5c1.5-1 3.5-1.5 5.5-1.5 1.5 0 2.8.3 3.5.8.7-.5 2-.8 3.5-.8 2 0 4 .5 5.5 1.5" stroke-width="1.5"/></g></symbol>';
if (!html.includes(oldLogo)) { console.error('FAIL: old i-logo symbol not found'); process.exit(1); }
html = html.replace(oldLogo, newLogo);
console.log('1) i-logo symbol updated');

// 2) editor-empty icon: #i-notes -> #i-logo
const oldEmpty = '<div class="empty-icon"><svg class="ico" width="44" height="44" style="margin:0"><use href="#i-notes"/></svg></div>';
const newEmpty = '<div class="empty-icon"><svg class="ico" width="44" height="44" style="margin:0"><use href="#i-logo"/></svg></div>';
if (!html.includes(oldEmpty)) { console.error('FAIL: editor-empty with #i-notes not found'); process.exit(1); }
html = html.replace(oldEmpty, newEmpty);
console.log('2) editor-empty icon switched to #i-logo');

// 3) cache bust: renderer scripts ?v=20260828e -> ?v=20260828f
const n = (html.match(/\?v=20260828e/g) || []).length;
html = html.split('?v=20260828e').join('?v=20260828f');
console.log('3) cache version bumped on', n, 'script tags');

fs.writeFileSync(p, html, 'utf8');

// verify
const v = fs.readFileSync(p, 'utf8');
const fffd = (v.match(/\uFFFD/g) || []).length;
const open = (v.match(/<div\b/g) || []).length;
const close = (v.match(/<\/div>/g) || []).length;
console.log('VERIFY: length', before, '->', v.length, '| U+FFFD:', fffd, '| div', open + '/' + close);
console.log('empty uses logo:', v.includes('<use href="#i-logo"/></svg></div>'));
if (fffd !== 0 || open !== close) { console.error('VERIFY FAILED'); process.exit(1); }
console.log('ALL OK');
