import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from './load.mjs';

const { DualSubCaptions, dualsubNormLang } = loadScripts('shared.js', 'captions.js');
const { parseCaptions } = DualSubCaptions;

test('manual json3 track keeps one cue per event', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello\nthere' }] },
      { tStartMs: 3500, dDurationMs: 100, segs: [{ utf8: '\n' }] },
      { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: 'second ' }, { utf8: 'line' }] },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(parseCaptions(body, false, 'en'))), [
    { start: 1000, end: 3000, text: 'Hello there' },
    { start: 4000, end: 5500, text: 'second line' },
  ]);
});

test('ASR words are regrouped into sentences', () => {
  const words = 'so today we talk about testing. it is fun and useful'.split(' ');
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, wWinId: 1 }, // window definition, no segs
      { tStartMs: 1000, segs: words.slice(0, 6).map((w, i) => ({ utf8: (i ? ' ' : '') + w, tOffsetMs: i * 300 })) },
      { tStartMs: 2800, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 2900, segs: words.slice(6).map((w, i) => ({ utf8: ' ' + w, tOffsetMs: i * 300 })) },
      // long pause starts a new cue
      { tStartMs: 9000, segs: [{ utf8: 'bye' }] },
    ],
  });
  const cues = parseCaptions(body, true, 'en');
  assert.deepEqual([...cues.map((c) => c.text)], [
    'so today we talk about testing.',
    'it is fun and useful',
    'bye',
  ]);
  assert.equal(cues[0].end, 2900); // ends where the next cue starts
});

test('CJK ASR words are joined without spaces', () => {
  const body = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: '今天' }, { utf8: '天气', tOffsetMs: 200 }] }] });
  assert.equal(parseCaptions(body, true, 'zh-Hans')[0].text, '今天天气');
});

test('language normalisation', () => {
  assert.equal(dualsubNormLang('zh-CN'), dualsubNormLang('zh-Hans'));
  assert.equal(dualsubNormLang('zh-TW'), 'zh-hant');
  assert.equal(dualsubNormLang('en-GB'), 'en');
});

test('roll-up captions are de-duplicated and regrouped into sentences', () => {
  const { mergeRollUp } = DualSubCaptions;
  // Each cue repeats the tail of the previous one, like CEA-608 roll-up on TOU.TV.
  const raw = [
    { start: 0, end: 2000, text: 'Nous sommes allés au marché' },
    { start: 2000, end: 4000, text: 'allés au marché ce matin avec' },
    { start: 4000, end: 6000, text: 'ce matin avec ma sœur. - Et alors ?' },
    { start: 6000, end: 8000, text: '- Et alors ? Il pleuvait beaucoup.' },
  ];
  const cues = mergeRollUp(raw);
  assert.deepEqual([...cues.map((c) => c.text)], [
    'Nous sommes allés au marché ce matin avec ma sœur.',
    'Et alors ?',
    'Il pleuvait beaucoup.',
  ]);
  assert.equal(cues[0].start, 0);
  // New words in one cue are spread 250ms apart; "Et" is the 4th new word.
  assert.equal(cues[1].start, 4750);
  assert.ok(cues[0].end <= cues[1].start);
  assert.equal(cues[0].words.length, 10);
});

test('a single repeated word is not treated as roll-up overlap', () => {
  const { mergeRollUp } = DualSubCaptions;
  const cues = mergeRollUp([
    { start: 0, end: 1000, text: 'il parle de' },
    { start: 1000, end: 2000, text: 'de la musique.' },
  ]);
  assert.equal(cues[0].text, 'il parle de de la musique.');
});

test('a long gap starts a new sentence without overlap matching', () => {
  const { mergeRollUp } = DualSubCaptions;
  const cues = mergeRollUp([
    { start: 0, end: 1000, text: 'bonjour à tous' },
    { start: 60000, end: 61000, text: 'à tous merci' },
  ]);
  assert.deepEqual([...cues.map((c) => c.text)], ['bonjour à tous', 'à tous merci']);
});

// Build an ASR json3 body: one event per word, 300ms apart.
const asrBody = (words) => JSON.stringify({
  events: words.map((w, i) => ({ tStartMs: i * 300, segs: [{ utf8: (i ? ' ' : '') + w }] })),
});

test('ASR: a 16-word sentence stays one cue', () => {
  const words = 'on est allés au marché samedi matin pour acheter des fruits et des légumes très frais.'.split(' ');
  assert.equal(words.length, 16);
  const cues = parseCaptions(asrBody(words), true, 'fr');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, words.join(' '));
});

test('ASR: long sentences break at a comma after 18 words, not mid-clause', () => {
  const first = 'alors je pense que quand on vit dans une grande ville comme Paris on finit toujours par courir partout,'.split(' ');
  const second = 'même le week-end.'.split(' ');
  assert.equal(first.length, 19);
  const cues = parseCaptions(asrBody([...first, ...second]), true, 'fr');
  assert.deepEqual([...cues.map((c) => c.words.length)], [19, 3]);
});

test('ASR without word offsets: whole-line segments are split and stay up', () => {
  // Some ASR tracks (e.g. this ARTE documentary) give one line per event.
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 6000, wWinId: 1, segs: [{ utf8: 'ils ont quitté les États-Unis' }] },
      { tStartMs: 6000, dDurationMs: 5000, wWinId: 1, segs: [{ utf8: 'pour une nouvelle vie en France.' }] },
      { tStartMs: 20000, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: 'Un autre départ.' }] },
    ],
  });
  const cues = parseCaptions(body, true, 'fr');
  assert.deepEqual([...cues.map((c) => c.text)], [
    'ils ont quitté les États-Unis pour une nouvelle vie en France.',
    'Un autre départ.',
  ]);
  assert.equal(cues[0].words.length, 11);
  assert.ok(cues[0].words[3].t > cues[0].words[0].t, 'words get increasing times');
  // Up at least until the source line ends (it used to vanish ~1.5s in), and
  // never overlapping the next cue.
  assert.ok(cues[0].end >= 11000 && cues[0].end <= cues[1].start);
  assert.ok(cues[1].end >= 24000);
});

test('fillGaps: human captions win, ASR only fills what they leave out', () => {
  const { fillGaps } = DualSubCaptions;
  const fr = [
    { start: 0, end: 4000, text: 'narration une', lang: 'fr' },
    { start: 20000, end: 24000, text: 'narration deux', lang: 'fr' },
  ];
  const en = [
    { start: 500, end: 3500, text: 'asr under the narration', lang: 'en' }, // overlaps: dropped
    { start: 8000, end: 12000, text: 'interview in english', lang: 'en' }, // gap: kept
    { start: 23900, end: 27000, text: 'touches the edge', lang: 'en' }, // within slack: kept
  ];
  const merged = fillGaps(fr, en);
  assert.deepEqual([...merged.map((c) => c.text)], ['narration une', 'interview in english', 'narration deux', 'touches the edge']);
  assert.deepEqual([...merged.map((c) => c.lang)], ['fr', 'en', 'fr', 'en']);
});

// Synthetic broadcast: 40 one-word lines, 5s apart, each shown for 3s. A word
// alone in its line is spoken at 0.9 * 3000 * 0.5 = 1350ms into it.
const LONG_WORDS = Array.from({ length: 40 }, (_, i) => `motlong${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
const lineStart = (i) => i * 5000;
const asrCues = LONG_WORDS.map((w, i) => ({ start: lineStart(i) + 1350, end: lineStart(i) + 2500, text: w, words: [{ t: lineStart(i) + 1350, w }] }));
const humanLines = (lagOf) => LONG_WORDS.map((w, i) => ({ start: lineStart(i) + lagOf(i), end: lineStart(i) + 3000 + lagOf(i), text: w, lang: 'fr' }));

test('alignToAsr: human captions trailing the audio are pulled back', () => {
  const { alignToAsr } = DualSubCaptions;
  // Live captions: 6s late, drifting to 8s late by the end.
  const aligned = alignToAsr(humanLines((i) => 6000 + (i / 39) * 2000), asrCues);
  aligned.forEach((c, i) => assert.ok(Math.abs(c.start - lineStart(i)) < 600, `line ${i} off by ${c.start - lineStart(i)}ms`));
  assert.equal(aligned[0].lang, 'fr');
});

test('alignToAsr: leaves well-timed or unmatched captions alone', () => {
  const { alignToAsr } = DualSubCaptions;
  // On time: the word sits mid-line, as spoken. Comparing line starts would
  // have called this 1.35s early and shifted it.
  const onTime = humanLines(() => 0);
  assert.equal(alignToAsr(onTime, asrCues), onTime);
  const unrelated = [{ start: 9000, end: 11000, text: 'rien à voir ici' }];
  assert.equal(alignToAsr(unrelated, asrCues), unrelated); // too few word pairs
});

test('attachTranslations pairs a translation track with source lines by time', () => {
  const { attachTranslations } = DualSubCaptions;
  const src = [
    { start: 0, end: 4000, text: 'So I wrote a very long sentence here' },
    { start: 4000, end: 7000, text: 'and then a short one.' },
    { start: 20000, end: 22000, text: 'Much later.' },
  ];
  const zh = [
    { start: 0, end: 2000, text: '我在这里写了' }, // two zh lines inside the first source line
    { start: 2000, end: 4000, text: '一个很长的句子' },
    { start: 4200, end: 6800, text: '然后是一个短句。' },
    { start: 22500, end: 23500, text: '很久以后。' }, // just after the line ends: within 1.5s
    { start: 40000, end: 41000, text: '没有对应' }, // nothing nearby: dropped
  ];
  assert.equal(attachTranslations(src, zh, 'zh-Hans'), 3);
  assert.deepEqual(src.map((c) => c.human?.text), ['我在这里写了一个很长的句子', '然后是一个短句。', '很久以后。']);
  assert.equal(src[0].human.lang, 'zh-Hans');
});

test('attachTranslations uses the original timing of shifted cues', () => {
  const { attachTranslations } = DualSubCaptions;
  // alignToAsr moved this cue 6s earlier; the translation track still follows
  // the caption file's own timeline.
  const src = [{ start: 4000, end: 7000, srcStart: 10000, srcEnd: 13000, text: 'hello' }];
  attachTranslations(src, [{ start: 10500, end: 12500, text: '你好' }], 'zh-Hans');
  assert.equal(src[0].human.text, '你好');
});
