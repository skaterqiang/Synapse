// Verify unpacked bluebird/readable-stream files are intact (not corrupted by 360)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const asar = require('@electron/asar');

const base = 'release/win-unpacked/resources/app.asar.unpacked/node_modules';
let checked = 0;
const bad = [];

function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.js')) continue;
    checked++;
    const sz = fs.statSync(p).size;
    if (sz === 0) { bad.push({ f: p, why: 'EMPTY' }); continue; }
    try { new vm.Script(fs.readFileSync(p, 'utf8')); }
    catch (err) { if (err instanceof SyntaxError) bad.push({ f: p, why: 'SYNTAX: ' + err.message }); }
  }
}

for (const pkg of ['bluebird', 'readable-stream', 'mammoth']) {
  const d = path.join(base, pkg);
  if (fs.existsSync(d)) { console.log('walking', pkg); walk(d); }
  else console.log('MISSING', pkg);
}
// nested copies too
const nested = [
  path.join(base, 'mammoth', 'node_modules', 'bluebird'),
  path.join(base, 'duplexer2', 'node_modules', 'readable-stream'),
  path.join(base, 'jszip', 'node_modules', 'readable-stream'),
  path.join(base, 'lazystream', 'node_modules', 'readable-stream'),
];
for (const d of nested) { if (fs.existsSync(d)) { console.log('walking nested', d); walk(d); } }

console.log('checked', checked, 'js files in unpacked');
console.log('bad:', bad.length);
bad.slice(0, 20).forEach(b => console.log('BAD', b.why, b.f));

// also verify asar entries for these are marked unpacked (paths need leading slash)
try {
  const stat = asar.statFile('release/win-unpacked/resources/app.asar', '/node_modules/bluebird/js/release/promise.js');
  console.log('asar entry promise.js unpacked flag:', stat.unpacked);
  const stat2 = asar.statFile('release/win-unpacked/resources/app.asar', '/node_modules/readable-stream/lib/internal/streams/buffer_list.js');
  console.log('asar entry buffer_list.js unpacked flag:', stat2.unpacked);
} catch (e) { console.log('statFile check skipped:', e.message); }

process.exit(bad.length === 0 ? 0 : 1);
