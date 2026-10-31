// Service worker: translation for the content script. Several keyless Google
// endpoints are tried in order and a throttled one is skipped until its backoff
// expires, so switching is silent. If every endpoint is throttled the content
// script falls back to Chrome's on-device translator.
importScripts('shared.js');

const MAX_BACKOFF = 10 * 60 * 1000;

const googleTarget = (lang) => DUALSUB_LANGS[lang]?.google || lang;

// Google wants "fr", not "fr-CA"; Chinese keeps its script variant.
function googleSource(lang) {
  const l = dualsubNormLang(lang);
  if (l === 'zh-hans') return 'zh-CN';
  if (l === 'zh-hant') return 'zh-TW';
  return l || 'auto';
}

function rateLimited() {
  const err = new Error('翻译服务暂时限流');
  err.rateLimited = true;
  return err;
}

// A throttled IP gets 429 or a redirect to a captcha page, never real data.
async function post(path, body) {
  let res;
  try {
    res = await fetch(`https://translate.googleapis.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      redirect: 'manual',
    });
  } catch {
    throw new Error('无法连接翻译服务');
  }
  if (res.status === 429 || res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw rateLimited();
  }
  if (!res.ok) throw new Error(`翻译服务 ${res.status}`);
  return res.json();
}

// translate_a/single: lines joined by newlines, Google keeps them.
async function viaSingle(lines, tl) {
  const text = async (q) => {
    const data = await post(`/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t`, new URLSearchParams({ q }));
    return data[0].map((seg) => seg[0] || '').join('');
  };
  const out = (await text(lines.join('\n'))).split('\n');
  if (out.length === lines.length) return out;
  // Line count drifted (rare): one request per line.
  return Promise.all(lines.map(text));
}

// translate_a/t: one q per line, one result per line. Throttled separately
// from /single, so it keeps working when /single is rate limited.
async function viaT(lines, tl) {
  const body = new URLSearchParams();
  lines.forEach((line) => body.append('q', line));
  const data = await post(`/translate_a/t?client=gtx&sl=auto&tl=${tl}`, body);
  const out = (typeof data === 'string' ? [data] : data).map((x) => (Array.isArray(x) ? x[0] : x));
  if (out.length !== lines.length) throw new Error('翻译结果行数不一致');
  return out;
}

const engines = [
  { name: 'single', run: viaSingle, fails: 0, pausedUntil: 0 },
  { name: 't', run: viaT, fails: 0, pausedUntil: 0 },
];

async function withFailover(fn) {
  let lastErr = rateLimited();
  for (const engine of engines) {
    if (Date.now() < engine.pausedUntil) continue;
    try {
      const out = await fn(engine);
      engine.fails = 0;
      return out;
    } catch (err) {
      lastErr = err;
      engine.fails++;
      engine.pausedUntil = Date.now() + Math.min(MAX_BACKOFF, 10000 * 2 ** (engine.fails - 1));
      console.warn(`[DualSub] ${engine.name} failed, pausing`, err.message);
    }
  }
  throw lastErr.rateLimited ? lastErr : rateLimited();
}

async function translate({ lines, targetLang }) {
  const tl = googleTarget(targetLang);
  const out = await withFailover((engine) => engine.run(lines, tl));
  return { translations: out.map((s) => String(s).trim()) };
}

// Word lookup. The main translation comes from the engine chain; part of
// speech and definitions come from Wiktionary (free, not throttled like Google),
// translated into the target language, so the card looks the same whichever
// Google endpoint is up. /single adds alternative translations when available.
async function lookup({ word, srcLang, targetLang }) {
  const tl = googleTarget(targetLang);
  const [main, dict] = await Promise.all([lookupMain(word, srcLang, tl), wiktionary(word, srcLang, tl)]);
  let definitions = dict;
  if (dict.length && !tl.startsWith('en')) {
    try {
      const translated = await withFailover((engine) => engine.run(dict.map((d) => d.gloss), tl));
      definitions = dict.map((d, i) => ({ ...d, original: d.gloss, gloss: String(translated[i] || d.gloss).trim() }));
    } catch {
      // keep the English definitions
    }
  }
  if (!definitions.length) definitions = main.definitions;
  return { word, translation: main.translation, alternatives: main.alternatives, definitions, complete: main.complete };
}

async function lookupMain(word, srcLang, tl) {
  const single = engines[0];
  if (Date.now() >= single.pausedUntil) {
    try {
      const data = await post(
        `/translate_a/single?client=gtx&sl=${googleSource(srcLang)}&tl=${tl}&hl=${tl}&dt=t&dt=at&dt=md&dj=1`,
        new URLSearchParams({ q: word }),
      );
      return { ...parseLookup(word, data), complete: true };
    } catch (err) {
      if (!err.rateLimited) throw err;
      single.fails++;
      single.pausedUntil = Date.now() + Math.min(MAX_BACKOFF, 10000 * 2 ** (single.fails - 1));
    }
  }
  const [translation] = await withFailover((engine) => engine.run([word], tl));
  return { word, translation: String(translation).trim(), alternatives: [], definitions: [], complete: false };
}

function parseLookup(word, data) {
  const translation = (data.sentences || []).map((s) => s.trans || '').join('').trim();
  const alternatives = [
    ...new Set(
      (data.alternative_translations || [])
        .flatMap((a) => a.alternative || [])
        .map((a) => (a.word_postproc || '').trim())
        .filter((w) => w && w !== translation),
    ),
  ].slice(0, 5);
  const definitions = (data.definitions || [])
    .flatMap((d) => (d.entry || []).slice(0, 2).map((e) => ({ pos: d.pos || '', gloss: e.gloss || '' })))
    .filter((d) => d.gloss)
    .slice(0, 3);
  return { word, translation, alternatives, definitions };
}

const POS_ZH = {
  noun: '名词', 'proper noun': '专有名词', verb: '动词', participle: '分词', adjective: '形容词',
  adverb: '副词', pronoun: '代词', preposition: '介词', conjunction: '连词', interjection: '感叹词',
  article: '冠词', determiner: '限定词', numeral: '数词', contraction: '缩合词', phrase: '短语',
};

// English Wiktionary's REST API: entries keyed by language code, HTML glosses.
async function wiktionary(word, srcLang, tl) {
  const lang = dualsubNormLang(srcLang).split('-')[0];
  const strip = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  for (const w of [...new Set([word, word.toLowerCase()])]) {
    let data;
    try {
      const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}`);
      if (!res.ok) continue;
      data = await res.json();
    } catch {
      return [];
    }
    const entries = data[lang] || [];
    const defs = entries.slice(0, 3).flatMap((e, i) =>
      (e.definitions || [])
        .map((d) => strip(d.definition || ''))
        .filter(Boolean)
        .slice(0, i === 0 ? 2 : 1)
        .map((gloss) => {
          const pos = (e.partOfSpeech || '').toLowerCase();
          return { pos: tl.startsWith('zh') ? POS_ZH[pos] || e.partOfSpeech : e.partOfSpeech, gloss };
        }),
    );
    if (defs.length) return defs.slice(0, 3);
  }
  return [];
}

// Chrome doesn't inject content scripts into tabs that were already open, and
// the copies from before an update are orphaned. Inject the current ones.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://ici.tou.tv/*'] });
  for (const tab of tabs) {
    const target = { tabId: tab.id };
    try {
      await chrome.scripting.insertCSS({ target, files: ['content.css'] });
      await chrome.scripting.executeScript({
        target,
        files: ['shared.js', 'captions.js', 'content.js', 'lookup.js', 'transcript.js'],
      });
    } catch (err) {
      console.warn('[DualSub] could not inject into tab', tab.id, err.message);
    }
  }
});

// YouTube's caption track list lives in the page's JS (player response), which
// content scripts can't see. Read it with a one-off MAIN-world function; nothing
// on the page is patched.
async function ytTracks(_msg, sender) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id },
    world: 'MAIN',
    func: () => {
      const pr = document.getElementById('movie_player')?.getPlayerResponse?.();
      const r = pr?.captions?.playerCaptionsTracklistRenderer;
      // `name` tells same-language tracks apart (e.g. broadcast "CC1" vs "DTVCC1").
      const tracks = (r?.captionTracks || []).map((t) => ({
        code: t.languageCode,
        kind: t.kind || '',
        name: new URL(t.baseUrl, location.href).searchParams.get('name') || '',
      }));
      const audio = r?.audioTracks?.[r.defaultAudioTrackIndex ?? 0];
      const defaultTrack = audio?.defaultCaptionTrackIndex != null ? tracks[audio.defaultCaptionTrackIndex] : null;
      return { videoId: pr?.videoDetails?.videoId || null, tracks, defaultTrack: defaultTrack || null };
    },
  });
  return result || { videoId: null, tracks: [] };
}

const handlers = { translate, lookup, ytTracks };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (err) =>
    sendResponse({ error: err.message || String(err), rateLimited: !!err.rateLimited }));
  return true; // async response
});
