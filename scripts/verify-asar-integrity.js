// Post-build verification: extract fresh app.asar, ensure no truncated/empty JS and bluebird present
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const asarPath = 'release/win-unpacked/resources/app.asar';
const outDir = 'release/asar-verify';
fs.rmSync(outDir, { recursive: true, force: true });
asar.extractAll(asarPath, outDir);

const nm = path.join(outDir, 'node_modules');
let checked = 0;
const bad = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      checked++;
      const sz = fs.statSync(p).size;
      if (sz === 0) { bad.push({ f: p.replace(outDir + path.sep, ''), why: 'EMPTY' }); continue; }
      try { new vm.Script(fs.readFileSync(p, 'utf8')); }
      catch (err) { if (err instanceof SyntaxError && /end of input/i.test(err.message)) bad.push({ f: p.replace(outDir + path.sep, ''), why: 'TRUNC' }); }
    }
  }
})(nm);

// Strategy: bluebird/readable-stream/mammoth are asarUnpacked -> individual files in
// app.asar.unpacked/ which 360 does NOT corrupt (only the big merged-asar write triggers it).
// So the asar itself must have 0 bad files; victim packages live unpacked (checked by verify-unpacked.js).
const topLevelBluebirdOk = fs.existsSync(path.join(nm, 'bluebird', 'js', 'release', 'promise.js'));
console.log('checked', checked, 'js files in asar');
console.log('top-level bluebird present:', topLevelBluebirdOk);
console.log('bad files:', bad.length);
bad.slice(0, 20).forEach(b => console.log('BAD', b.why, b.f));
const ok = bad.length === 0 && topLevelBluebirdOk;
console.log(ok ? 'ASAR VERIFIED OK' : 'ASAR STILL BROKEN');
process.exit(ok ? 0 : 1);
