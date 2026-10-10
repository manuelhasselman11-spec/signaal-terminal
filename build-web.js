#!/usr/bin/env node
/**
 * Puts the shared code of the bot into the website, so both always run exactly the same logic.
 *   node build-web.js            → updates public/index.html (or ./index.html)
 *   node build-web.js --check    → only checks; exits with 1 if the website is out of date
 * Shared: patterns.js (chart patterns + SOL market filter) and parseSwap from copyTrade.js.
 */
'use strict';
const fs = require('fs'), path = require('path');
const htmlPath = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f));
if (!htmlPath){ console.error('index.html niet gevonden'); process.exit(1); }
const indent = txt => txt.split('\n').map(l => l.trim() ? '  ' + l : '').join('\n');
function patternsBlock(){
  const src = fs.readFileSync(path.join(__dirname, 'patterns.js'), 'utf8');
  return indent(src.split("'use strict';")[1].replace(/if \(typeof module !== 'undefined'\) module\.exports = [^\n]*\n?/, '').trim());
}
function parseSwapBlock(){
  const src = fs.readFileSync(path.join(__dirname, 'copyTrade.js'), 'utf8');
  const m = src.match(/\/\*\* Find what a wallet bought[^\n]*\n(function parseSwap\(tx, wallet\)\{[\s\S]*?\n\})\n/);
  if (!m) throw new Error('parseSwap niet gevonden in copyTrade.js');
  return indent(m[1]);
}
function fill(html, name, body){
  const re = new RegExp('(  // <shared:' + name + '>[^\\n]*\\n)[\\s\\S]*?(\\n  // </shared:' + name + '>)');
  if (!re.test(html)) throw new Error('markering <shared:' + name + '> ontbreekt in index.html');
  return html.replace(re, (_, a, b) => a + body + b);
}
const before = fs.readFileSync(htmlPath, 'utf8');
let after = fill(before, 'patterns', patternsBlock());
after = fill(after, 'parseSwap', parseSwapBlock());
if (process.argv.includes('--check')){
  if (after !== before){ console.error('index.html loopt achter op de bot-code — draai: node build-web.js'); process.exit(1); }
  console.log('index.html is gelijk aan de bot-code ✓'); process.exit(0);
}
fs.writeFileSync(htmlPath, after);
console.log(after === before ? 'index.html was al gelijk ✓' : 'index.html bijgewerkt ✓');
