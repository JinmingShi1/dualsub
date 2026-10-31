// Shared constants. Loaded by the content script, popup and background worker.

self.DUALSUB_DEFAULTS = {
  enabled: true,
  targetLang: 'zh-Hans',
  showOriginal: true,
  fontScale: 1,
};

// label: shown in the popup; google: Google Translate code when it differs from ours.
self.DUALSUB_LANGS = {
  'zh-Hans': { label: '简体中文', google: 'zh-CN' },
  'zh-Hant': { label: '繁體中文', google: 'zh-TW' },
  en: { label: 'English' },
  ja: { label: '日本語' },
  ko: { label: '한국어' },
  es: { label: 'Español' },
  fr: { label: 'Français' },
  de: { label: 'Deutsch' },
};

// Collapse locale variants so "zh-CN" and "zh-Hans" compare equal.
self.dualsubNormLang = (lang) => {
  const l = (lang || '').toLowerCase();
  if (l.startsWith('zh')) return /hant|tw|hk|mo/.test(l) ? 'zh-hant' : 'zh-hans';
  return l.split('-')[0];
};
