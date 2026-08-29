// Full scan of SOURCE node_modules for files corrupted by 360: empty or truncated (Unexpected end of input)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nm = 'node_modules';
const bad = [];
let checked = 0, empty = 0, trunc = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      checked++;
      const sz = fs.statSync(p).size;
      if (sz === 0) { empty++; bad.push({ f: p, why: 'EMPTY' }); continue; }
      try { new vm.Script(fs.readFileSync(p, 'utf8')); }
      catch (err) { if (err instanceof SyntaxError && /end of input/i.test(err.message)) { trunc++; bad.push({ f: p, why: 'TRUNC', sz }); } }
    }
  }
})(nm);
console.log('checked', checked, '| empty:', empty, '| truncated:', trunc);
bad.slice(0, 60).forEach(b => console.log('BAD', b.why, b.sz || '', b.f));
