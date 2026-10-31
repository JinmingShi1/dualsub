// Transcript side panel: every cue with its timestamp. Click a line to seek,
// translate lines on demand, hover words for lookup (handled by lookup.js).
(() => {
  const USER_SCROLL_GRACE = 4000; // don't auto-scroll right after the user scrolls
  const CJK = /[぀-ヿ㐀-鿿가-힯]/;

  let tab, panel, list, statusEl, allBtn;
  let open = false;
  let rows = []; // [{ id, cue, el, trEl, state }] in cue order
  let builtFor = null; // track object the rows belong to
  let builtCues = null; // cue array they were reconciled against
  let activeRow = null;
  let userScrollAt = 0;

  const core = () => self.DualSub;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function build() {
    tab = el('button', null, '文稿');
    tab.id = 'dualsub-tab';
    tab.title = '打开文稿';
    tab.onclick = () => setOpen(true);

    panel = el('aside');
    panel.id = 'dualsub-panel';
    panel.hidden = true;
    for (const node of [tab, panel]) {
      node.setAttribute('translate', 'no');
      node.classList.add('notranslate');
    }

    const head = el('div', 'ds-panel-head');
    head.append(el('span', 'ds-panel-title', '文稿'));
    statusEl = el('span', 'ds-panel-status');
    allBtn = el('button', 'ds-panel-btn', '全部翻译');
    allBtn.onclick = translateAll;
    const close = el('button', 'ds-panel-close', '×');
    close.title = '关闭';
    close.onclick = () => setOpen(false);
    head.append(statusEl, allBtn, close);

    list = el('div', 'ds-panel-list');
    const markUserScroll = () => { userScrollAt = Date.now(); };
    list.addEventListener('wheel', markUserScroll, { passive: true });
    list.addEventListener('touchmove', markUserScroll, { passive: true });
    list.addEventListener('mousedown', markUserScroll);
    list.addEventListener('click', onListClick);

    panel.append(head, list);
  }

  function mount() {
    const host = core().uiHost();
    if (!host) return; // document_start: <body> doesn't exist yet
    for (const node of [tab, panel]) if (node.parentElement !== host) host.appendChild(node);
  }

  // The panel takes a column on the right and the page/player shrinks to make
  // room (rules in content.css keyed off html.ds-room), so it never covers video.
  const panelWidth = () => Math.min(400, Math.max(300, Math.round(window.innerWidth * 0.3)));

  function makeRoom(on) {
    const root = document.documentElement;
    root.style.setProperty('--ds-panel-w', `${panelWidth()}px`);
    root.classList.toggle('ds-room', on);
    // Players size themselves on window resize.
    window.dispatchEvent(new Event('resize'));
  }

  function setOpen(value) {
    open = value;
    panel.hidden = !open;
    tab.hidden = open || !core().active;
    makeRoom(open);
    if (open) {
      userScrollAt = 0;
      activeRow?.el.classList.remove('ds-row-active');
      activeRow = null; // re-center on the current line when reopening
      refresh();
      followPlayhead();
    }
  }

  function onListClick(e) {
    const rowEl = e.target.closest('.ds-row');
    if (!rowEl) return;
    const row = rows[+rowEl.dataset.i];
    if (!row) return;
    if (e.target.closest('.ds-row-trbtn')) {
      core().requestTranslation([row.cue.text]);
      setRowTranslation(row);
      return;
    }
    core().seek(row.cue.start);
    userScrollAt = 0;
  }

  function wordSpans(text) {
    const spaced = !CJK.test(text) || text.includes(' ');
    const tokens = spaced ? text.split(' ') : Array.from(text);
    const out = [];
    tokens.forEach((w, j) => {
      if (j && spaced) out.push(document.createTextNode(' '));
      out.push(el('span', 'ds-word', w));
    });
    return out;
  }

  function makeRow(cue, id) {
    const rowEl = el('div', 'ds-row');
    const body = el('div', 'ds-row-body');
    const orig = el('div', 'ds-row-orig');
    if (cue.lang) orig.dataset.lang = cue.lang;
    orig.append(...wordSpans(cue.text));
    const trEl = el('div', 'ds-row-tr');
    body.append(orig, trEl);
    rowEl.append(el('span', 'ds-row-time', fmtTime(cue.start)), body);
    return { id, cue, el: rowEl, trEl, state: '' };
  }

  // Keyed update: reuse rows whose cue is unchanged, insert new ones in place and
  // drop vanished ones. Rebuilding the whole list every second (TOU.TV adds cues
  // as it buffers) reset the scroll and made the panel jitter.
  function reconcile(track) {
    const { cueId } = core();
    const old = builtFor === track ? new Map(rows.map((r) => [r.id, r])) : new Map();
    if (builtFor !== track) {
      list.replaceChildren();
      activeRow = null;
    }
    const next = track.cues.map((cue) => {
      const id = cueId(cue);
      const row = old.get(id);
      if (!row) return makeRow(cue, id);
      old.delete(id);
      row.cue = cue;
      return row;
    });
    for (const gone of old.values()) {
      gone.el.remove();
      if (gone === activeRow) activeRow = null;
    }
    list.querySelector('.ds-panel-empty')?.remove();
    next.forEach((row, i) => {
      row.el.dataset.i = i;
      const at = list.children[i];
      if (at !== row.el) list.insertBefore(row.el, at || null);
    });
    rows = next;
    builtFor = track;
    builtCues = track.cues;
    if (!rows.length) list.append(el('div', 'ds-panel-empty', '字幕加载中…'));
  }

  function setRowTranslation(row) {
    const { track } = core();
    const tr = core().translationFor(row.cue);
    const state = tr != null ? `t:${tr}`
      : row.cue.partial ? 'partial'
      : track?.pending.has(row.cue.text) ? 'pending' : 'none';
    if (state === row.state) return;
    row.state = state;
    if (state === 'partial') {
      row.trEl.replaceChildren();
    } else if (tr != null) {
      row.trEl.replaceChildren(document.createTextNode(tr));
    } else if (state === 'pending') {
      row.trEl.replaceChildren(el('span', 'ds-row-muted', '翻译中…'));
    } else {
      row.trEl.replaceChildren(el('button', 'ds-row-trbtn', '翻译'));
    }
  }

  function refresh() {
    const { track, active } = core();
    tab.hidden = open || !active;
    if (!open) return;
    if (!track || !active) {
      if (!active) {
        setOpen(false);
        return;
      }
      builtFor = null;
      builtCues = null;
      activeRow = null;
      rows = [];
      list.replaceChildren(el('div', 'ds-panel-empty', '这个视频还没有字幕'));
      statusEl.textContent = '';
      allBtn.hidden = true;
      return;
    }
    if (track !== builtFor || track.cues !== builtCues) reconcile(track);
    const translate = core().needsTranslation();
    allBtn.hidden = !translate;
    let done = 0; // has any translation (an on-device draft counts)
    let final = 0; // has Google's translation
    for (const row of rows) {
      if (translate) setRowTranslation(row);
      else if (row.state !== 'off') {
        row.state = 'off';
        row.trEl.replaceChildren();
      }
      if (core().translationFor(row.cue) != null) done++;
      if (core().isHuman(row.cue) || track.dict.has(row.cue.text)) final++;
    }
    const total = rows.filter((r) => !r.cue.partial).length;
    statusEl.textContent = translate && total ? `已译 ${Math.min(done, total)}/${total}` : '';
    // Still useful while drafts remain: it asks Google for the better version.
    allBtn.disabled = final >= total;
  }

  function translateAll() {
    const { track } = core();
    if (!track) return;
    const texts = [...new Set(track.cues.filter((c) => !c.partial && !core().isHuman(c)).map((c) => c.text))]
      .filter((s) => !track.dict.has(s));
    core().requestTranslation(texts);
    refresh();
  }

  // Highlight the line under the playhead and glide it to a third of the way
  // down; only when the active line changes, so the list never fights itself.
  function followPlayhead() {
    if (!open || !rows.length) return;
    const ms = core().currentTimeMs();
    let lo = 0, hi = rows.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].cue.start <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const row = rows[idx] || null;
    if (row === activeRow) return;
    activeRow?.el.classList.remove('ds-row-active');
    activeRow = row;
    if (!row) return;
    row.el.classList.add('ds-row-active');
    if (Date.now() - userScrollAt > USER_SCROLL_GRACE) {
      list.scrollTo({ top: row.el.offsetTop - list.clientHeight / 3, behavior: 'smooth' });
    }
  }

  let timer = null;

  // The extension was reloaded: remove this copy's UI and give the room back.
  function teardown() {
    clearInterval(timer);
    tab.remove();
    panel.remove();
    if (open) {
      open = false;
      document.documentElement.classList.remove('ds-room');
      window.dispatchEvent(new Event('resize'));
    }
  }

  function start() {
    if (!self.DualSub) return;
    build();
    core().subscribe(() => {
      if (core().dead) return teardown();
      mount();
      refresh();
    });
    document.addEventListener('fullscreenchange', mount);
    window.addEventListener('resize', (e) => {
      // Ignore the synthetic event makeRoom() fires itself.
      if (open && e.isTrusted) document.documentElement.style.setProperty('--ds-panel-w', `${panelWidth()}px`);
    });
    timer = setInterval(() => {
      mount();
      refresh();
      followPlayhead();
    }, 300);
  }

  start();
})();
