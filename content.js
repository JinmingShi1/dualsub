// Isolated-world content script: collects caption cues from the current site,
// translates them around the playhead, and renders the bilingual overlay.
(() => {
  const BATCH = 20;
  const LOOKAHEAD_MS = 3 * 60 * 1000; // only translate this far past the playhead
  const MIN_INTERVAL = 1500; // between Google requests, to stay under its rate limit
  const MAX_BACKOFF = 5 * 60 * 1000;
  const LOCAL_AHEAD_MS = 60 * 1000; // on-device drafts cover the next minute
  const LOCAL_BATCH = 8;

  // ---------- site adapters ----------

  const q = (sel) => document.querySelector(sel);

  const youtube = {
    videoId: () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null),
    player: () => document.getElementById('movie_player'),
    video: () => q('#movie_player video.html5-main-video'),
    ccOn: () => {
      const btn = q('#movie_player .ytp-subtitles-button');
      return !btn || btn.getAttribute('aria-pressed') !== 'false';
    },
    controlsShown: (player) => !player.classList.contains('ytp-autohide'),
    init: initYouTube,
  };

  // Radio-Canada's rcplayer decodes the CEA-608 captions embedded in the video
  // and exposes them as a hidden TextTrack, so we read cues from there.
  const toutv = {
    videoId: () => (q('video.rcplayer-video-tag') ? location.pathname : null),
    player: () => q('.rcplayer-container'),
    video: () => q('video.rcplayer-video-tag'),
    ccOn: () => {
      const btn = q('.rcplayer-btn-subtitles');
      return !btn || btn.classList.contains('rcplayer-active');
    },
    controlsShown: (player) => {
      const bar = player.querySelector('.rcplayer-bottom-controller');
      return !!bar && !bar.classList.contains('rcplayer-hidden');
    },
    init: initTextTracks,
  };

  const site = location.hostname === 'ici.tou.tv' ? toutv : youtube;

  // ---------- state ----------

  let settings = { ...DUALSUB_DEFAULTS };
  // { key, videoId, srcLang, cues, ids, dict: Map(source -> translation), pending: Set }
  let track = null;
  let gen = 0; // bumped whenever in-flight translations become stale
  let inflight = 0;
  let retryAt = 0;
  let failures = 0; // consecutive failed batches, drives exponential backoff
  let lastRequestAt = 0;
  let pumpTimer = null;
  let googlePausedUntil = 0; // all online engines throttled: pause the Google lane
  let localBusy = false;
  let forced = []; // lines explicitly requested (transcript panel), served before the lookahead
  let lastError = '';
  let lastRendered = '';
  let saveTimer = null;
  let overlay, origEl, trEl, resizeObs;

  chrome.storage.sync.get(DUALSUB_DEFAULTS, (s) => {
    settings = s;
    lastRendered = '';
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const prev = { ...settings };
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
    if (prev.targetLang !== settings.targetLang || (!prev.enabled && settings.enabled)) {
      restartTranslation();
    }
    updateFontSize();
    lastRendered = '';
    emit();
  });

  document.addEventListener('seeked', () => pump(), true); // media events don't bubble; capture works

  const currentTimeMs = () => (site.video()?.currentTime || 0) * 1000;

  // Reloading/updating the extension orphans this copy of the script: its
  // chrome.* calls throw "Extension context invalidated". Detect that and remove
  // our UI; background.js injects the new copy into open tabs.
  let dead = false;
  function alive() {
    if (dead) return false;
    if (chrome.runtime?.id) return true;
    dead = true;
    overlay?.remove();
    resizeObs?.disconnect();
    document.documentElement.classList.remove('dualsub-active');
    emit(); // lookup.js / transcript.js clean up their UI
    return false;
  }

  // Tiny API for lookup.js / transcript.js, which load after this file.
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => {
    try { fn(); } catch (err) { console.warn('[DualSub] listener', err); }
  });
  self.DualSub = {
    site,
    get track() { return track; },
    get settings() { return settings; },
    get active() { return document.documentElement.classList.contains('dualsub-active'); },
    needsTranslation: () => needsTranslation(),
    currentTimeMs,
    // Where floating UI must live to be visible and clickable: the fullscreen
    // element, or the modal <dialog> TOU.TV plays in (the top layer covers and
    // inerts everything else, whatever its z-index).
    uiHost() {
      return document.fullscreenElement || site.player()?.closest('dialog[open]') || document.body;
    },
    seek(ms) {
      const video = site.video();
      if (video) video.currentTime = ms / 1000;
    },
    requestTranslation(texts) {
      forced.push(...texts);
      pump();
    },
    subscribe(fn) { listeners.add(fn); },
    get dead() { return dead; },
    cueId: (c) => cueId(c),
    translationFor: (cue) => (track ? translationFor(cue) : undefined),
    isHuman: (cue) => humanOf(cue) != null,
    translateLocal: (texts, srcLang) => translateLocal(texts, srcLang),
  };

  // ---------- tracks ----------

  const cueId = (c) => `${Math.round(c.start)}|${c.text}`;

  function setTrack({ key, videoId, srcLang, cues, source = null }) {
    gen++;
    inflight = 0;
    lastError = '';
    lastRendered = '';
    forced = [];
    // dict: Google translations (cached). draft: on-device translations shown
    // until Google's arrive, so a line never waits on the network.
    track = {
      key, videoId, srcLang, cues, ids: new Set(cues.map(cueId)),
      dict: new Map(), draft: new Map(), pending: new Set(),
      source, // YouTube: { list, info, original } to look up translation tracks again
    };
    console.info(`[DualSub] track ${key}: ${cues.length} cues`);
    loadCacheThenPump();
    emit();
  }

  function clearTrack() {
    track = null;
    gen++;
    inflight = 0;
    forced = [];
    lastRendered = '';
    emit();
  }

  // TextTrack sources grow as the video buffers, so their merged cue list is
  // rebuilt and swapped in; translations are keyed by text and survive.
  function replaceCues(cues) {
    track.cues = cues;
    track.ids = new Set(cues.map(cueId));
    lastRendered = '';
    pump();
    emit();
  }

  function restartTranslation() {
    if (!track) return;
    gen++;
    inflight = 0;
    lastError = '';
    forced = [];
    track.dict = new Map();
    track.draft = new Map();
    track.pending = new Set();
    loadCacheThenPump();
    emit();
    // A new target language may have its own human translation track.
    const t = track;
    if (t.source) {
      attachHuman(t.cues, t.source).then(() => {
        if (t !== track) return;
        lastRendered = '';
        emit();
      });
    }
  }

  // --- YouTube: caption files the player downloads ---
  //
  // We only *watch* the page's resource timeline for the player's /api/timedtext
  // request, then fetch the same URL ourselves (it carries tokens we couldn't
  // forge). Patching the page's fetch/XHR instead broke YouTube's watch-progress
  // saving, so nothing of YouTube's is touched.

  let autoCcVideo = null;
  const seenCaptionUrls = new Set();

  function initYouTube() {
    // buffered: also report requests made before we started (late injection).
    new PerformanceObserver((list) => {
      if (!alive()) return;
      for (const entry of list.getEntries()) {
        if (entry.name.includes('/api/timedtext')) onCaptionRequest(entry.name);
      }
    }).observe({ type: 'resource', buffered: true });

    document.addEventListener('yt-navigate-finish', () => {
      const vid = youtube.videoId();
      if (track && track.videoId !== vid) clearTrack();
      if (vid && settings.enabled) autoEnableCc(vid);
    });
  }

  function captionTrackInfo(rawUrl) {
    let url;
    try { url = new URL(rawUrl, location.href); } catch { return null; }
    const p = url.searchParams;
    const current = youtube.videoId();
    const videoId = p.get('v') || current;
    if (!videoId || videoId !== current) return null; // preload for another video
    const kind = p.get('kind') || '';
    return {
      url: url.href,
      videoId,
      kind,
      srcLang: p.get('tlang') || p.get('lang') || '',
      key: [videoId, p.get('lang'), kind, p.get('tlang') || ''].join('|'),
    };
  }

  // YouTube keeps the last caption language the user picked (e.g. French) and
  // shows it, or an auto-translation into it, on every video. We want the
  // language actually spoken: the auto-generated (ASR) track's language, else
  // the default caption for the audio track.
  const trackLists = new Map(); // videoId -> Promise<{ videoId, tracks, defaultTrack }>

  async function videoTracks(videoId) {
    if (!trackLists.has(videoId)) {
      trackLists.set(videoId, chrome.runtime.sendMessage({ type: 'ytTracks' }).catch(() => null));
    }
    const list = await trackLists.get(videoId);
    if (list?.videoId === videoId) return list;
    trackLists.delete(videoId); // asked too early (previous video's data): retry next time
    return null;
  }

  function originalTrack(list) {
    if (!list?.tracks.length) return null;
    // Human captions the uploader set as the default for this audio track win:
    // ASR can mislabel the language or only cover part of a mixed-language
    // video (e.g. ARTE: French narration, English interviews, ASR tagged "en").
    // This default follows the audio, not the viewer's caption preference.
    const def = list.defaultTrack;
    if (def && !def.kind) return def;
    // Otherwise go by the default audio's own ASR track. Videos with dubbed
    // audio list one ASR track per audio language, and the dub's ASR can come
    // back empty: the first ASR in the list is not necessarily the right one.
    const asr = def?.kind === 'asr' ? def : list.tracks.find((t) => t.kind === 'asr');
    const spoken = asr?.code || def?.code;
    if (!spoken) return null;
    const base = (code) => code.toLowerCase().split('-')[0];
    const manual = list.tracks.filter((t) => !t.kind);
    // Prefer human captions in the spoken language over ASR.
    return manual.find((t) => t.code === spoken) || manual.find((t) => base(t.code) === base(spoken)) || asr || null;
  }

  // The caption URL's signature doesn't cover lang/kind/tlang, so the player's
  // own URL can be pointed at another track.
  function retarget(info, t) {
    const u = new URL(info.url);
    u.searchParams.set('lang', t.code);
    if (t.kind) u.searchParams.set('kind', t.kind);
    else u.searchParams.delete('kind');
    // The player's URL may carry another track's name (e.g. name=CC1).
    if (t.name) u.searchParams.set('name', t.name);
    else u.searchParams.delete('name');
    u.searchParams.delete('tlang');
    u.searchParams.set('fmt', 'json3');
    const key = [info.videoId, t.code, t.kind, t.name || '', ''].join('|');
    return { ...info, url: u.href, kind: t.kind, srcLang: t.code, key };
  }

  async function loadCues(info) {
    const res = await fetch(info.url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cues = DualSubCaptions.parseCaptions(await res.text(), info.kind === 'asr', info.srcLang);
    for (const c of cues) {
      c.lang = info.srcLang;
      c.srcStart = c.start; // the track's own timeline, kept if alignToAsr shifts the cue
      c.srcEnd = c.end;
    }
    return cues;
  }

  // A human translation into the viewer's target language (e.g. TED's zh-Hans)
  // beats machine translation: attach it to the source cues line by line.
  function humanTranslationTrack(list, original) {
    const want = dualsubNormLang(settings.targetLang);
    return list?.tracks.find((t) => !t.kind && dualsubNormLang(t.code) === want
      && !(original && t.code === original.code && t.name === original.name)) || null;
  }

  async function attachHuman(cues, source) {
    const t = humanTranslationTrack(source.list, source.original);
    for (const c of cues) delete c.human;
    if (!t) return 0;
    try {
      const target = await loadCues(retarget(source.info, t));
      const n = DualSubCaptions.attachTranslations(cues, target, settings.targetLang);
      console.info(`[DualSub] human ${t.code} translation for ${n}/${cues.length} lines`);
      return n;
    } catch (err) {
      console.warn('[DualSub] failed to load the translation track', err);
      return 0;
    }
  }

  // With human captions chosen, the ASR track still helps: in the same language
  // its timing (which follows the audio) corrects lagging live-TV captions; in
  // another language it fills the parts the human captions leave out.
  function companionAsr(list, original) {
    if (!original || original.kind) return null;
    return list?.tracks.find((t) => t.kind === 'asr') || null;
  }

  async function onCaptionRequest(rawUrl) {
    const playerInfo = captionTrackInfo(rawUrl);
    let info = playerInfo;
    if (!info || seenCaptionUrls.has(info.url)) return;
    seenCaptionUrls.add(info.url);
    const list = await videoTracks(info.videoId);
    const original = originalTrack(list);
    if (original) info = retarget(info, original);
    let asr = companionAsr(list, original);
    let extra = asr ? retarget(info, asr) : null;
    let key = extra ? `${info.key}+${extra.key}` : info.key;
    if (track?.key === key) return;
    let cues;
    try {
      let [main, asrCues] = await Promise.all([loadCues(info), extra ? loadCues(extra).catch(() => []) : []]);
      // Our pick came back empty: fall back to what the player itself loaded,
      // which at least matches the audio that's playing.
      if (!main.length && playerInfo.url !== info.url) {
        console.info('[DualSub] chosen track is empty, using the player\'s own track');
        info = playerInfo;
        key = info.key;
        asr = null;
        asrCues = [];
        if (track?.key === key) return;
        main = await loadCues(info);
      }
      // Before any time shift: copies made by alignToAsr/fillGaps keep .human.
      await attachHuman(main, { list, info, original });
      if (!asrCues.length) cues = main;
      else if (dualsubNormLang(asr.code) === dualsubNormLang(original.code)) cues = DualSubCaptions.alignToAsr(main, asrCues);
      else cues = DualSubCaptions.fillGaps(main, asrCues);
    } catch (err) {
      console.warn('[DualSub] failed to load captions', err);
      seenCaptionUrls.delete(info.url);
      return;
    }
    if (!alive() || youtube.videoId() !== info.videoId || track?.key === key) return;
    if (cues.length) setTrack({ key, videoId: info.videoId, srcLang: info.srcLang, cues, source: { list, info, original } });
  }

  // Injected into an already-open page (after an update). The buffered resource
  // timeline usually still has the caption request; if not (or CC is off), make
  // the player fetch captions by toggling CC.
  function lateStartYouTube() {
    const vid = youtube.videoId();
    if (!vid || !settings.enabled) return;
    setTimeout(() => {
      const btn = q('#movie_player .ytp-subtitles-button');
      if (track || !btn || btn.offsetParent === null) return;
      if (btn.getAttribute('aria-pressed') === 'true') {
        btn.click();
        setTimeout(() => btn.click(), 300);
      } else {
        autoEnableCc(vid);
      }
    }, 1500);
  }

  // The player only downloads captions when CC is on, so turn it on once per video.
  function autoEnableCc(vid) {
    if (autoCcVideo === vid) return;
    autoCcVideo = vid;
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > 20 || youtube.videoId() !== vid || track?.videoId === vid) return clearInterval(timer);
      const btn = q('#movie_player .ytp-subtitles-button');
      if (!btn || btn.offsetParent === null) return; // not rendered yet, or video has no captions
      if (btn.getAttribute('aria-pressed') === 'false') btn.click();
      clearInterval(timer);
    }, 500);
  }

  // --- TextTrack sources (TOU.TV) ---

  let ttSource = '';
  let rawSig = '';

  function initTextTracks() {
    const timer = setInterval(() => (alive() ? syncTextTrack() : clearInterval(timer)), 1000);
  }

  const cueText = (c) =>
    (c.getCueAsHTML ? c.getCueAsHTML().textContent : c.text || '').replace(/\s+/g, ' ').trim();

  function syncTextTrack() {
    const video = site.video();
    if (!video) {
      if (track) clearTrack();
      return;
    }
    const tt = [...video.textTracks].find(
      (t) => (t.kind === 'captions' || t.kind === 'subtitles') && t.mode !== 'disabled' && t.cues,
    );
    if (!tt) return;

    const source = `${video.currentSrc}|${tt.language}|${tt.label}`;
    if (!track || source !== ttSource) {
      ttSource = source;
      rawSig = '';
      const key = `${location.hostname}${location.pathname}|${tt.language}`;
      setTrack({ key, videoId: site.videoId(), srcLang: tt.language, cues: [] });
    }
    const last = tt.cues[tt.cues.length - 1];
    const sig = `${tt.cues.length}|${last?.startTime}`;
    if (!tt.cues.length || sig === rawSig) return;
    rawSig = sig;
    const raw = [...tt.cues]
      .map((c) => ({ start: c.startTime * 1000, end: c.endTime * 1000, text: cueText(c) }))
      .filter((c) => c.text)
      .sort((a, b) => a.start - b.start);
    const cues = DualSubCaptions.mergeRollUp(raw);
    // The newest sentence may still be growing: don't spend a request on it yet.
    if (cues.length) cues[cues.length - 1].partial = true;
    replaceCues(cues);
  }

  // ---------- translation ----------

  const humanOf = (cue) => (cue?.human?.lang === settings.targetLang ? cue.human.text : null);
  // Human translation track first, then Google, then the on-device draft.
  const translationFor = (cue) => humanOf(cue) ?? track?.dict.get(cue.text) ?? track?.draft.get(cue.text);

  const needsTranslation = () =>
    settings.enabled && track && dualsubNormLang(track.srcLang) !== dualsubNormLang(settings.targetLang);

  // Cached as { source line: translation } so it survives cues being added or reordered.
  const cacheKey = (t) => `ds2:${t.key}:${settings.targetLang}`;

  async function loadCacheThenPump() {
    const t = track;
    const g = gen;
    if (!needsTranslation()) return;
    const key = cacheKey(t);
    const cached = (await chrome.storage.local.get(key))[key];
    if (g !== gen) return;
    if (cached) for (const [src, tr] of Object.entries(cached)) t.dict.set(src, tr);
    lastRendered = '';
    pump();
    emit();
  }

  // Binary search: index of the last cue starting at or before ms, or -1.
  function cueIndexAt(t, ms) {
    let lo = 0, hi = t.cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t.cues[mid].start <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // Up to BATCH untranslated lines: explicit requests first, then lines between
  // the playhead and LOOKAHEAD_MS ahead. Stopping there keeps request volume low
  // instead of translating everything.
  function nextBatch(t) {
    const texts = [];
    const wanted = (s) => !t.dict.has(s) && !t.pending.has(s) && !texts.includes(s);
    while (forced.length && texts.length < BATCH) {
      const s = forced.shift();
      if (wanted(s)) texts.push(s);
    }
    if (texts.length) return texts;
    const now = currentTimeMs();
    for (let i = Math.max(0, cueIndexAt(t, now)); i < t.cues.length && texts.length < BATCH; i++) {
      const c = t.cues[i];
      if (c.start > now + LOOKAHEAD_MS) break;
      if (c.partial && (c.start > now || local.translators.size)) continue;
      if (humanOf(c)) continue; // already has a human translation
      if (wanted(c.text)) texts.push(c.text);
    }
    return texts;
  }

  function pump() {
    const t = track;
    pumpLocal();
    if (!needsTranslation() || inflight > 0) return;
    const resumeAt = Math.max(retryAt, googlePausedUntil);
    if (Date.now() < resumeAt) {
      clearTimeout(pumpTimer);
      pumpTimer = setTimeout(pump, resumeAt - Date.now());
      return;
    }
    const wait = lastRequestAt + MIN_INTERVAL - Date.now();
    if (wait > 0) {
      clearTimeout(pumpTimer);
      pumpTimer = setTimeout(pump, wait);
      return;
    }
    const texts = nextBatch(t);
    if (!texts.length) return;
    texts.forEach((s) => t.pending.add(s));
    inflight++;
    translateBatch(t, texts);
  }

  // The quality lane: Google. Its results replace on-device drafts.
  async function translateBatch(t, texts) {
    const g = gen;
    lastRequestAt = Date.now();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'translate', lines: texts, targetLang: settings.targetLang });
    } catch (err) {
      res = { error: String(err?.message || err) };
    }
    if (g !== gen) return; // track or settings changed meanwhile
    inflight--;
    texts.forEach((s) => t.pending.delete(s));
    lastRendered = '';

    if (!res || res.error) {
      failures++;
      if (res?.rateLimited) googlePausedUntil = Date.now() + backoff(failures);
      lastError = errorText(res);
      console.warn('[DualSub]', res?.error || 'unknown error');
      retryAt = Date.now() + backoff(failures);
      forced.unshift(...texts); // retry the same lines once the backoff expires
      emit();
      pump();
      return;
    }
    failures = 0;
    lastError = '';
    texts.forEach((s, i) => {
      t.dict.set(s, res.translations[i]);
      t.draft.delete(s);
    });
    scheduleSave(t);
    pump();
    emit();
  }

  // The fast lane: Chrome's on-device translator drafts the lines around the
  // playhead right away, current line first.
  async function pumpLocal() {
    const t = track;
    if (localBusy || dead || !needsTranslation()) return;
    const now = currentTimeMs();
    const texts = [];
    let batchLang = t.srcLang;
    for (let i = Math.max(0, cueIndexAt(t, now)); i < t.cues.length && texts.length < LOCAL_BATCH; i++) {
      const c = t.cues[i];
      if (c.start > now + LOCAL_AHEAD_MS) break;
      // A still-growing sentence is drafted anyway if it's already on screen:
      // TOU.TV buffers only seconds ahead, so it's often the current line.
      if (c.partial && c.start > now) continue;
      // One on-device model per source language: batch lines of one language.
      const lang = c.lang || t.srcLang;
      if (texts.length && lang !== batchLang) continue;
      if (humanOf(c)) continue;
      if (!t.dict.has(c.text) && !t.draft.has(c.text) && !texts.includes(c.text)) {
        batchLang = lang;
        texts.push(c.text);
      }
    }
    if (!texts.length) return;
    localBusy = true;
    const g = gen;
    const out = await translateLocal(texts, batchLang);
    localBusy = false;
    if (g !== gen || !out) return;
    texts.forEach((s, i) => {
      if (out[i] && !t.dict.has(s)) t.draft.set(s, out[i]);
    });
    lastRendered = '';
    emit();
    pumpLocal();
  }

  const backoff = (n) => Math.min(MAX_BACKOFF, 5000 * 2 ** Math.max(0, n - 1));

  // Engine switching is silent: while throttled we just show "…" and retry.
  // The one thing only the user can do is the click Chrome requires before it
  // downloads the on-device model.
  function errorText(res) {
    if (res?.rateLimited) return local.needsGesture ? '点一下页面，启用本地翻译' : '';
    return res?.error || '翻译失败';
  }

  // ---------- on-device translator (Chrome Translator API) ----------

  const local = { translators: new Map(), needsGesture: false, armed: false, unavailable: new Set() };

  const localLang = (lang) => {
    const l = dualsubNormLang(lang);
    return l === 'zh-hans' ? 'zh' : l === 'zh-hant' ? 'zh-Hant' : l;
  };

  async function localTranslator(srcLang = track?.srcLang) {
    if (!('Translator' in self) || !track) return null;
    const sourceLanguage = localLang(srcLang);
    const targetLanguage = localLang(settings.targetLang);
    const pair = `${sourceLanguage}>${targetLanguage}`;
    if (local.translators.has(pair)) return local.translators.get(pair);
    // Waiting for the click that lets Chrome download the model, or no model
    // for this language pair: don't keep asking.
    if (local.needsGesture || local.unavailable.has(pair)) return null;
    try {
      if ((await Translator.availability({ sourceLanguage, targetLanguage })) === 'unavailable') {
        local.unavailable.add(pair);
        return null;
      }
      const translator = await Translator.create({ sourceLanguage, targetLanguage });
      local.translators.set(pair, translator);
      return translator;
    } catch (err) {
      // The first use downloads a model, which Chrome only allows after a user
      // gesture: retry on the next click or key press.
      if (err?.name === 'NotAllowedError') {
        local.needsGesture = true;
        armGesture();
      } else {
        console.warn('[DualSub] local translator', err);
      }
      return null;
    }
  }

  function armGesture() {
    if (local.armed) return;
    local.armed = true;
    const retry = () => {
      local.armed = false;
      local.needsGesture = false;
      document.removeEventListener('pointerdown', retry, true);
      document.removeEventListener('keydown', retry, true);
      localTranslator().then((tr) => {
        if (!tr) return;
        lastError = '';
        pumpLocal();
      });
    };
    document.addEventListener('pointerdown', retry, true);
    document.addEventListener('keydown', retry, true);
  }

  async function translateLocal(texts, srcLang) {
    const tr = await localTranslator(srcLang);
    if (!tr) return null;
    try {
      return await Promise.all(texts.map((s) => tr.translate(s)));
    } catch (err) {
      console.warn('[DualSub] local translate', err);
      return null;
    }
  }

  function scheduleSave(t) {
    const key = cacheKey(t);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ [key]: Object.fromEntries(t.dict) }), 1500);
  }

  // ---------- rendering ----------

  function ensureOverlay(player) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'dualsub-overlay';
      // Keep Chrome's page translation from rewriting the original line.
      overlay.setAttribute('translate', 'no');
      overlay.classList.add('notranslate');
      origEl = document.createElement('div');
      origEl.className = 'ds-line ds-orig';
      trEl = document.createElement('div');
      trEl.className = 'ds-line ds-tr';
      overlay.append(origEl, trEl);
      resizeObs = new ResizeObserver(updateFontSize);
    }
    if (overlay.parentElement !== player) {
      if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
      player.appendChild(overlay);
      resizeObs.disconnect();
      resizeObs.observe(player);
      updateFontSize();
    }
  }

  function updateFontSize() {
    const player = overlay?.parentElement;
    if (!player) return;
    const px = Math.max(14, player.clientHeight * 0.042) * (settings.fontScale || 1);
    overlay.style.setProperty('--ds-size', `${px.toFixed(1)}px`);
  }

  const CJK = /[぀-ヿ㐀-鿿가-힯]/;

  // Manual captions have no word timings: spread the cue's duration over its
  // words by character count so the highlight still sweeps along the line.
  function cueWords(cue) {
    if (cue.words) return cue.words;
    const spaced = !CJK.test(cue.text) || cue.text.includes(' ');
    const tokens = spaced ? cue.text.split(' ') : Array.from(cue.text);
    const total = tokens.reduce((n, w) => n + w.length, 0) || 1;
    const span = Math.max(300, (cue.end - cue.start) * 0.9);
    let acc = 0;
    cue.sep = spaced ? ' ' : '';
    cue.words = tokens.map((w) => {
      const t = cue.start + (acc / total) * span;
      acc += w.length;
      return { t, w };
    });
    return cue.words;
  }

  let wordEls = [];
  let spoken = -1;
  let renderedCue = ''; // cue id: TextTrack cues are rebuilt as objects every sync

  function renderOriginal(cue) {
    renderedCue = cueId(cue);
    origEl.dataset.lang = cue.lang || track.srcLang;
    wordEls = [];
    spoken = -1;
    origEl.replaceChildren();
    cueWords(cue).forEach((w, j) => {
      if (j && cue.sep) origEl.append(cue.sep);
      const span = document.createElement('span');
      span.className = 'ds-word';
      span.textContent = w.w;
      origEl.append(span);
      wordEls.push(span);
    });
  }

  function updateSpoken(cue, ms) {
    let n = 0;
    while (n < cue.words.length && cue.words[n].t <= ms) n++;
    if (n === spoken) return;
    spoken = n;
    wordEls.forEach((el, j) => el.classList.toggle('ds-spoken', j < n));
  }

  // DOM checks that don't need to run every frame.
  let chromeCheckAt = 0, ccOn = true, lift = false;
  function checkPlayerChrome(player) {
    const now = performance.now();
    if (now - chromeCheckAt < 300) return;
    chromeCheckAt = now;
    ccOn = site.ccOn();
    lift = site.controlsShown(player);
  }

  function render() {
    const player = site.player();
    if (player) checkPlayerChrome(player);
    const active = settings.enabled && track && player && track.videoId === site.videoId() && ccOn;
    document.documentElement.classList.toggle('dualsub-active', !!active);
    if (!active) {
      if (overlay) overlay.hidden = true;
      lastRendered = '';
      return;
    }
    ensureOverlay(player);
    // lookup.js holds the layout while a word tooltip is open, so the word
    // doesn't slide away when pausing brings up the control bar.
    if (!self.DualSub.holdLayout) overlay.classList.toggle('ds-lift', lift);

    const ms = currentTimeMs();
    const i = cueIndexAt(track, ms);
    const cue = i >= 0 && ms <= track.cues[i].end + 200 ? track.cues[i] : null;
    const translate = needsTranslation();
    const done = cue && translationFor(cue);
    const tr = cue && translate ? done ?? (lastError ? `⚠ ${lastError}` : '…') : '';
    const showOrig = cue && (settings.showOriginal || !translate);

    const key = `${cue ? cueId(cue) : ''}|${tr}|${showOrig}`;
    if (key !== lastRendered) {
      lastRendered = key;
      overlay.hidden = !cue;
      origEl.hidden = !showOrig;
      if (!showOrig) renderedCue = '';
      else if (renderedCue !== cueId(cue)) renderOriginal(cue);
      trEl.textContent = tr;
      trEl.hidden = !tr;
      trEl.classList.toggle('ds-pending', !!cue && done == null);
    }
    if (showOrig) updateSpoken(cue, ms);
  }

  let lastPump = 0;
  function tick(now) {
    if (!alive()) return; // stops the loop
    try { render(); } catch (err) { console.warn('[DualSub] render', err); }
    // The lookahead window moves with playback, so top it up periodically.
    if (now - lastPump > 2000) { lastPump = now; pump(); }
    requestAnimationFrame(tick);
  }

  site.init();
  requestAnimationFrame(tick);
  if (site === youtube && document.readyState !== 'loading') lateStartYouTube();
})();
