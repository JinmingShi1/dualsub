// Caption parsing: YouTube json3 / srv3 / srv1 -> [{ start, end, text }] in ms.

(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // Sentence breaking for word streams (YouTube ASR, TOU.TV roll-up). End at
  // sentence punctuation; past SOFT_WORDS a comma is enough; HARD_WORDS is the
  // last resort. A 14-word hard cap used to cut ~40% of sentences in half, so
  // the line vanished mid-sentence and each half was translated on its own.
  const SOFT_WORDS = 18;
  const HARD_WORDS = 30;
  const PAUSE_MS = 1800;
  const SENTENCE_END = /[.?!…。？！]["»”)]?$/;
  const CLAUSE_END = /[,;:，；：]$/;
  const endsCue = (word, count) =>
    (SENTENCE_END.test(word) && count >= 3) || (count >= SOFT_WORDS && CLAUSE_END.test(word));

  // Auto-generated (ASR) tracks arrive word by word in rolling windows; regroup
  // the words into sentence-sized cues so they can be translated sensibly.
  function groupWords(words, sep) {
    const cues = [];
    let cur = null;
    const flush = (next) => {
      if (!cur) return;
      // Stay up until the source line ends, or at least 1.5s after the last
      // word starts, but never past the next cue.
      const last = cur.words[cur.words.length - 1];
      const end = Math.min(next ? next.t : Infinity, Math.max(cur.last + 1500, last.end ?? 0));
      cues.push({ start: cur.start, end, text: cur.parts.join(sep), sep, words: cur.words });
      cur = null;
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (cur && (w.t - cur.last > PAUSE_MS || cur.parts.length >= HARD_WORDS)) flush(w);
      if (!cur) cur = { start: w.t, last: w.t, parts: [], words: [] };
      cur.parts.push(w.w);
      cur.words.push(w);
      cur.last = w.t;
      if (endsCue(w.w, cur.parts.length)) flush(words[i + 1]);
    }
    flush(null);
    return cues;
  }

  function parseJson3(data, isAsr, lang) {
    const events = (data.events || []).filter((e) => e.segs && !e.aAppend);
    if (isAsr) {
      const cjk = /^(zh|ja|ko|th)/i.test(lang);
      const words = [];
      for (const e of events) {
        const eventEnd = e.tStartMs + (e.dDurationMs || 0);
        e.segs.forEach((s, j) => {
          const text = clean(s.utf8);
          if (!text) return;
          // Most ASR tracks give one word per segment with its own offset, but
          // some give a whole line per event with no offsets. Split those into
          // words and spread them over the line's duration.
          const tokens = cjk ? [text] : text.split(' ');
          const from = e.tStartMs + (s.tOffsetMs || 0);
          const next = e.segs[j + 1];
          const to = next?.tOffsetMs ? e.tStartMs + next.tOffsetMs : Math.max(from, eventEnd);
          const step = tokens.length > 1 ? ((to - from) * 0.9) / tokens.length : 0;
          tokens.forEach((w, k) => words.push({ t: from + k * step, w, end: eventEnd }));
        });
      }
      return groupWords(words, cjk ? '' : ' ');
    }
    return events
      .map((e) => ({
        start: e.tStartMs,
        end: e.tStartMs + (e.dDurationMs || 0),
        text: clean(e.segs.map((s) => s.utf8 || '').join('')),
      }))
      .filter((c) => c.text);
  }

  function parseXml(body) {
    const doc = new DOMParser().parseFromString(body, 'text/xml');
    const ps = [...doc.querySelectorAll('p')];
    if (ps.length) {
      return ps
        .map((p) => {
          const start = +p.getAttribute('t');
          return { start, end: start + +(p.getAttribute('d') || 0), text: clean(p.textContent) };
        })
        .filter((c) => c.text);
    }
    // srv1: <text start="1.2" dur="3.4">, text is HTML-escaped once more.
    const decode = (s) => new DOMParser().parseFromString(s, 'text/html').documentElement.textContent;
    return [...doc.querySelectorAll('text')]
      .map((n) => {
        const start = parseFloat(n.getAttribute('start')) * 1000;
        const end = start + parseFloat(n.getAttribute('dur') || 0) * 1000;
        return { start, end, text: clean(decode(n.textContent)) };
      })
      .filter((c) => c.text);
  }

  // Regroup a timed word stream into sentences: break at sentence punctuation,
  // before a speaker dash, on long pauses, or when a line gets too long.
  function groupSentences(words) {
    const cues = [];
    let cur = null;
    const flush = (next) => {
      if (!cur) return;
      const last = cur.words[cur.words.length - 1];
      const end = Math.min(next ? next.t : Infinity, Math.max(last.end ?? 0, last.t + 1500));
      cues.push({ start: cur.words[0].t, end, text: cur.words.map((w) => w.w).join(' '), sep: ' ', words: cur.words });
      cur = null;
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const dash = /^[-–—]$/.test(w.w);
      if (cur && (dash || w.t - cur.last > PAUSE_MS || cur.words.length >= HARD_WORDS)) flush(w);
      if (dash) continue; // the speaker-change marker itself isn't worth showing
      if (!cur) cur = { words: [], last: w.t };
      cur.words.push(w);
      cur.last = w.t;
      if (endsCue(w.w, cur.words.length)) flush(words[i + 1]);
    }
    flush(null);
    return cues;
  }

  // CEA-608 roll-up captions (TOU.TV) arrive as a sliding window: each cue
  // repeats the tail of the previous one plus a few new words. Keep only the
  // new words, then regroup them into sentences.
  function mergeRollUp(raw) {
    const words = [];
    let prev = [];
    let prevEnd = -Infinity;
    for (const c of raw) {
      const toks = c.text.split(' ').filter(Boolean);
      if (c.start - prevEnd > 3000) prev = []; // a gap (e.g. after seeking): no overlap
      // Longest suffix of prev equal to a prefix of toks. Require 2+ words so a
      // coincidental repeated word ("de ... de") isn't mistaken for overlap.
      let k = Math.min(prev.length, toks.length);
      for (; k >= 2; k--) {
        let same = true;
        for (let j = 0; j < k && same; j++) same = prev[prev.length - k + j] === toks[j];
        if (same) break;
      }
      if (k < 2) k = 0;
      const fresh = toks.slice(k);
      // New words appear together; spread them a little so the highlight sweeps.
      const step = fresh.length > 1 ? Math.min(250, (c.end - c.start) / fresh.length) : 0;
      fresh.forEach((w, j) => words.push({ t: c.start + j * step, w, end: c.end }));
      prev = toks;
      prevEnd = c.end;
    }
    return groupSentences(words);
  }

  function parseCaptions(body, isAsr, lang) {
    const text = (body || '').trim();
    let cues = [];
    if (text.startsWith('{')) cues = parseJson3(JSON.parse(text), isAsr, lang);
    else if (text.startsWith('<')) cues = parseXml(text);
    return cues.sort((a, b) => a.start - b.start);
  }

  // Mixed-language videos: the uploader's captions may cover only some parts
  // (ARTE: French narration subtitled, English interviews not). Keep every
  // primary cue and add secondary (ASR) cues only where nothing primary plays.
  function fillGaps(primary, secondary, slack = 300) {
    const overlapsPrimary = (c) => primary.some((p) => c.start < p.end - slack && c.end > p.start + slack);
    return [...primary, ...secondary.filter((c) => !overlapsPrimary(c))].sort((a, b) => a.start - b.start);
  }

  const foldWord = (w) => w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  // Human captions of live TV are typed seconds behind the speech (~6.5s on a
  // Radio-Canada broadcast), while ASR timing follows the audio. Pair up
  // distinctive words (6+ letters, said once in the ASR track), measure how far
  // the human cues trail, and shift each cue by the median delay of the pairs
  // within WINDOW_MS of it, since the delay drifts over a broadcast.
  const ALIGN_MIN_PAIRS = 20;
  const ALIGN_MIN_SHIFT_MS = 1000;
  const ALIGN_WINDOW_MS = 90000;

  function alignToAsr(cues, asrCues) {
    const asrTime = new Map();
    const repeated = new Set();
    for (const c of asrCues) {
      for (const w of c.words || []) {
        const k = foldWord(w.w);
        if (k.length < 6) continue;
        if (asrTime.has(k)) repeated.add(k);
        else asrTime.set(k, w.t);
      }
    }
    // A word in a 5s caption line is usually spoken mid-line, not at its start;
    // comparing line starts made well-timed captions look ~2s early (and got
    // them wrongly shifted). Estimate each word's time from its position in the
    // line, the same way the word highlight does.
    const seen = new Set();
    const pairs = [];
    for (const c of cues) {
      const span = Math.max(0, c.end - c.start) * 0.9;
      let pos = 0;
      for (const raw of c.text.split(' ')) {
        const at = c.start + span * ((pos + raw.length / 2) / c.text.length);
        pos += raw.length + 1;
        const k = foldWord(raw);
        if (k.length < 6 || seen.has(k)) continue;
        seen.add(k);
        if (asrTime.has(k) && !repeated.has(k)) pairs.push({ t: asrTime.get(k), d: at - asrTime.get(k) });
      }
    }
    if (pairs.length < ALIGN_MIN_PAIRS) return cues;
    const overall = median(pairs.map((p) => p.d));
    if (Math.abs(overall) < ALIGN_MIN_SHIFT_MS) return cues;
    return cues
      .map((c) => {
        const near = pairs.filter((p) => Math.abs(p.t - c.start) <= ALIGN_WINDOW_MS).map((p) => p.d);
        const d = near.length >= 5 ? median(near) : overall;
        return { ...c, start: Math.max(0, c.start - d), end: Math.max(0, c.end - d) };
      })
      .sort((a, b) => a.start - b.start);
  }

  // Attach a human translation track (e.g. TED's zh-Hans) to the source cues.
  // The two are segmented differently, so pair by time: each translated line
  // goes to the source line containing its midpoint (or the one just before,
  // within 1.5s), and several lines landing on one source line are joined.
  // Uses the source's own timing (srcStart/srcEnd), the timeline the
  // translation was made against, even if alignToAsr has shifted the cues.
  // Sets cue.human = { lang, text } in place and returns how many got one.
  function attachTranslations(cues, targetCues, lang) {
    for (const c of cues) delete c.human;
    const src = cues
      .map((c) => ({ c, s: c.srcStart ?? c.start, e: c.srcEnd ?? c.end }))
      .sort((a, b) => a.s - b.s);
    const parts = new Map();
    for (const t of targetCues) {
      const mid = (t.start + t.end) / 2;
      let lo = 0, hi = src.length - 1, i = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (src[m].s <= mid) { i = m; lo = m + 1; } else hi = m - 1;
      }
      if (i < 0 || mid > src[i].e + 1500) continue;
      if (!parts.has(src[i].c)) parts.set(src[i].c, []);
      parts.get(src[i].c).push(t.text);
    }
    const sep = /^(zh|ja|ko|th)/i.test(lang) ? '' : ' ';
    for (const [c, texts] of parts) c.human = { lang, text: texts.join(sep) };
    return parts.size;
  }

  self.DualSubCaptions = { parseCaptions, mergeRollUp, fillGaps, alignToAsr, attachTranslations };
})();
