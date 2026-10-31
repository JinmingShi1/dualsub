// Send one batch to Google Translate the same way the extension does.
// Usage: node scripts/smoke-translate.mjs [googleLangCode]
const tl = process.argv[2] || 'zh-CN';

// French sample with a sentence split across lines and some spoken register.
const lines = [
  'Bon, ça fait un moment que je voulais vous parler',
  "de ce truc, mais franchement j'ai toujours",
  'repoussé ça à la dernière minute.',
  '[Rires]',
  "Ce qui, si vous me connaissez, n'est pas très étonnant.",
  "Bref, on s'y met ?",
];

const t0 = Date.now();
const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  body: new URLSearchParams({ q: lines.join('\n') }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const out = (await res.json())[0].map((seg) => seg[0] || '').join('').split('\n');

lines.forEach((line, i) => console.log(`${line}\n  → ${out[i]}`));
console.log(`\n${out.length}/${lines.length} lines aligned, ${Date.now() - t0} ms`);
