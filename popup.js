const $ = (id) => document.getElementById(id);

async function init() {
  const s = await chrome.storage.sync.get(DUALSUB_DEFAULTS);

  for (const [code, { label }] of Object.entries(DUALSUB_LANGS)) {
    $('targetLang').append(new Option(label, code, false, code === s.targetLang));
  }
  $('enabled').checked = s.enabled;
  $('showOriginal').checked = s.showOriginal;
  $('fontScale').value = s.fontScale;

  $('enabled').onchange = (e) => chrome.storage.sync.set({ enabled: e.target.checked });
  $('showOriginal').onchange = (e) => chrome.storage.sync.set({ showOriginal: e.target.checked });
  $('fontScale').oninput = (e) => chrome.storage.sync.set({ fontScale: +e.target.value });
  $('targetLang').onchange = (e) => chrome.storage.sync.set({ targetLang: e.target.value });
}

init();
