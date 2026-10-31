// Hover a word (.ds-word, in the overlay or transcript) to see its meaning.
// Hovering a word in the overlay pauses the video; leaving resumes it.
(() => {
  const SHOW_DELAY = 150;
  const HIDE_DELAY = 200;
  const cache = new Map();

  let tip = null;
  let currentWord = null;
  let showTimer = null;
  let hideTimer = null;
  let pausedByUs = false;
  let requestId = 0;

  // Strip punctuation; for French/Italian also drop elisions (c'était -> était).
  function normalize(raw, lang) {
    let w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (/^(fr|it|ca)/i.test(lang || '')) w = w.replace(/^(?:[cdjlmnst]|qu|jusqu|lorsqu|puisqu)['’]/i, '');
    return w;
  }

  function ensureTip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'dualsub-tip';
      tip.setAttribute('translate', 'no');
      tip.classList.add('notranslate');
      tip.hidden = true;
      tip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      tip.addEventListener('mouseleave', scheduleHide);
    }
    const host = self.DualSub.uiHost();
    if (tip.parentElement !== host) host.appendChild(tip);
    return tip;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function speak(word, lang) {
    const u = new SpeechSynthesisUtterance(word);
    if (lang) u.lang = lang;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function fill(word, lang, data) {
    const head = el('div', 'ds-tip-head');
    head.append(el('span', 'ds-tip-word', word));
    const say = el('button', 'ds-tip-say', '🔊');
    say.title = '朗读';
    say.onclick = (e) => { e.stopPropagation(); speak(word, lang); };
    head.append(say);

    const body = [head];
    if (!data) body.push(el('div', 'ds-tip-muted', '查询中…'));
    else if (data.error) body.push(el('div', 'ds-tip-muted', `查询失败：${data.error}`));
    else {
      body.push(el('div', 'ds-tip-main', data.translation || '—'));
      for (const d of data.definitions) {
        const line = el('div', 'ds-tip-def');
        if (d.pos) line.append(el('span', 'ds-tip-pos', d.pos));
        line.append(document.createTextNode(d.gloss));
        if (d.original) line.title = d.original;
        body.push(line);
      }
      if (data.alternatives.length) body.push(el('div', 'ds-tip-alt', `也作：${data.alternatives.join('、')}`));
    }
    tip.replaceChildren(...body);
  }

  function place(wordEl) {
    const r = wordEl.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    const above = r.top - t.height - 10;
    const top = above >= 8 ? above : r.bottom + 10;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  async function show(wordEl) {
    if (self.DualSub.dead) return;
    const { track, settings } = self.DualSub;
    // Mixed-language videos: each line carries its own language.
    const lang = wordEl.closest('[data-lang]')?.dataset.lang || track?.srcLang || '';
    const word = normalize(wordEl.textContent, lang);
    if (!word) return;

    currentWord = wordEl;
    ensureTip();
    const key = `${lang}|${settings.targetLang}|${word.toLowerCase()}`;
    fill(word, lang, cache.get(key));
    tip.hidden = false;
    place(wordEl);

    if (wordEl.closest('#dualsub-overlay')) {
      self.DualSub.holdLayout = true;
      const video = self.DualSub.site.video();
      if (video && !video.paused) {
        video.pause();
        pausedByUs = true;
      }
    }

    if (cache.has(key)) return;
    const id = ++requestId;
    let data;
    try {
      data = await chrome.runtime.sendMessage({ type: 'lookup', word, srcLang: lang, targetLang: settings.targetLang });
    } catch (err) {
      data = { error: String(err?.message || err) };
    }
    if (data?.rateLimited) {
      const local = await self.DualSub.translateLocal([word], lang);
      if (local) data = { word, translation: local[0], alternatives: [], definitions: [], complete: false };
    }
    // Only cache full results; a degraded one should be retried later.
    if (!data?.error && data?.complete !== false) cache.set(key, data);
    if (id !== requestId || currentWord !== wordEl) return;
    fill(word, lang, data);
    place(wordEl);
  }

  function hide() {
    currentWord = null;
    requestId++;
    if (tip) tip.hidden = true;
    self.DualSub.holdLayout = false;
    if (pausedByUs) {
      pausedByUs = false;
      self.DualSub.site.video()?.play();
    }
  }

  function scheduleHide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY);
  }

  document.addEventListener('mouseover', (e) => {
    const word = e.target.closest?.('.ds-word');
    if (!word) return;
    clearTimeout(hideTimer);
    if (word === currentWord) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(word), currentWord ? 0 : SHOW_DELAY);
  }, true);

  document.addEventListener('mouseout', (e) => {
    const word = e.target.closest?.('.ds-word');
    if (!word) return;
    const to = e.relatedTarget;
    if (to && (to === word || tip?.contains(to))) return;
    scheduleHide();
  }, true);

  document.addEventListener('fullscreenchange', () => { if (tip) hide(); });

  self.DualSub?.subscribe(() => {
    if (!self.DualSub.dead) return;
    hide();
    tip?.remove();
    tip = null;
  });
})();
