# DualSub

A Chrome extension that shows bilingual subtitles on YouTube and ICI TOU.TV, translated with
Google Translate's free web endpoint (no API key).

## How it works

```
content.js                 finds the site's captions, schedules batches around the playhead,
                           renders the overlay (lookup.js / transcript.js add hover + panel)
      │ chrome.runtime.sendMessage
background.js (worker)     Google Translate, one request per batch (lines joined by \n)
```

- **Site adapters** (`content.js`): each site says where the player/video are,
  whether CC is on, and where cues come from.
  - **YouTube**: the `/api/timedtext` URL carries tokens we can't forge. A
    `PerformanceObserver` watches the page's resource timeline for the player's
    request and we fetch the same URL. (An earlier version patched the page's
    fetch/XHR, which broke YouTube's watch-progress saving.)
    YouTube shows the viewer's last-picked caption language (or an
    auto-translation into it) on every video, so we read the track list from
    the player response (one read-only MAIN-world call) and retarget the URL's
    `lang`/`kind`/`name`/`tlang` to the video's own track: the human captions
    the uploader set as default for the audio track if any (ASR can mislabel
    mixed-language videos), else captions in the language of the default
    audio's ASR track (dubbed videos list one ASR per audio language, and the
    dub's may be empty). If the chosen track comes back empty we fall back to
    the track the player itself loaded.
    With human captions chosen, the ASR track is fetched too:
    - same language: `alignToAsr` pairs distinctive words and shifts the human
      cues to the ASR timing (live-TV captions trail the speech by ~5–8s);
    - other language: `fillGaps` adds ASR lines where the human captions are
      silent (e.g. ARTE: French narration subtitled, English interviews not).
      Each cue keeps its own `lang` for on-device translation and lookup.
    If the video also has human captions in the target language (e.g. TED's
    zh-CN), `attachTranslations` pairs them with the source lines by time
    (each translated line goes to the source line containing its midpoint,
    on the caption file's own timeline) and they take priority over machine
    translation; those lines never hit Google or the on-device model.
  - **ICI TOU.TV**: captions are CEA-608 embedded in the video stream (no
    subtitle file in the DASH manifest). Radio-Canada's player decodes them into
    a hidden `video.textTracks` entry; we poll it as it buffers. The captions
    are roll-up (each cue repeats the previous tail), so `mergeRollUp` keeps
    only the new words and regroups them into sentences.
- **Auto-generated (ASR) captions** usually arrive word by word with offsets,
  but some tracks give a whole line per event with no offsets; those lines are
  split into words spread over the line's duration. `captions.js` then regroups
  words into sentences: end at . ? !, past 18 words a comma will do, 30 is the
  hard cap, and a cue stays up until its source line ends.
- **Translation, two lanes**:
  - *Fast lane*: Chrome's on-device Translator API drafts the lines from the
    playhead to 60s ahead, current line first, so text appears with the cue.
    The line on screen is drafted even if it's still growing (TOU.TV buffers
    only seconds ahead, so the newest sentence is often the current one).
  - *Quality lane*: Google, batches of 20 lines from the playhead up to 3
    minutes ahead (re-prioritised on seek). Its results replace the drafts and
    are the only ones cached.
  The first on-device use needs one click on the page (Chrome downloads the
  language model then).
- **Word highlight**: ASR tracks carry per-word timings; for manual captions the
  cue duration is spread over the words by character count.
- **Word lookup** (`lookup.js`): hover any word in the overlay or transcript.
  Translation from the engine chain; part of speech and definitions from
  Wiktionary's REST API (translated into the target language), so the card is
  the same even when Google's dictionary endpoint is throttled. Hovering the
  overlay pauses the video; leaving resumes.
- **Transcript** (`transcript.js`): side panel with every line and timestamp;
  click to seek, translate a line or the whole video, follows the playhead.
  Opening it shrinks the page (YouTube) or player dialog (TOU.TV) instead of
  covering the video.
- **Rate limits, silent failover**: Google's keyless endpoints throttle bursts
  (429 / captcha redirect). `background.js` tries `translate_a/single`, then
  `translate_a/t` (throttled separately, one `q` per line), pausing a throttled
  endpoint with exponential backoff. While all are throttled the Google lane
  pauses and on-device drafts carry the display. Requests are spaced ≥1.5s
  apart.
- **Updates without reloading pages**: on install/update `background.js` injects
  the current scripts into open YouTube / TOU.TV tabs (the buffered resource
  timeline usually still has YouTube's caption request); the orphaned copy notices `chrome.runtime.id` is gone and
  removes its UI instead of showing "Extension context invalidated".
- **Cache**: finished translations are stored as `{source line: translation}` per
  video/track/language in `chrome.storage.local`, so rewatching is instant.

## Setup

1. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** →
   select this folder
2. Open a YouTube video (CC is switched on automatically, `C` toggles it) or
   an ICI TOU.TV episode with the player's subtitle button on.

The source language is picked automatically (the language spoken in the
video), whatever caption language YouTube's player is set to.

## Development

```bash
node --test test/*.test.mjs              # parser + prompt unit tests
node scripts/smoke-translate.mjs         # one real batch through Google Translate
```

After editing, click reload on the extension card; open tabs pick up the new
version without a page refresh.

## Roadmap

- [x] YouTube: capture captions, bilingual overlay, translation, cache
- [x] ICI TOU.TV via the player's TextTrack
- [ ] Netflix (manifest `timedtexttracks`, TTML/WebVTT)
- [x] Use an existing human target-language track (YouTube)
- [x] Chrome built-in Translator API: instant drafts, Google upgrades them
- [x] Hover word lookup, transcript side panel
- [ ] Sentence loop, saved words
