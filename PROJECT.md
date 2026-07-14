# Stage Ready — developer map

Mobile-first PWA for musicians: snippet library, setlists, practice player
(loop/markers/speed/pitch), tuner, metronome, import/export, printing.
No build step — plain files, deploy the whole folder to any static host
(GitHub Pages). All JS files are classic scripts sharing one global scope,
loaded in numeric order at the end of `index.html`.

## File map

| File | Contents (key globals) |
|---|---|
| `index.html` | Markup only: toolbar, drawer, library view, snippet view, tool panels, modal/toast/progress overlays, hidden file inputs. Loads css + vendor + js in order. |
| `css/app.css` | All styles. Sections: tokens (`:root`, themes via `html[data-theme]`), toolbar, drawer, library rows, snippet view + **mini bar**, transport/sliders, cards, tool panels, modal/toast/progress, FACELIFT LAYER (press feedback, focus rings) at end. |
| `vendor/jszip.min.js` | JSZip 3.10.1, vendored (offline). Don't edit. |
| `js/01-core.js` | `$`,`$$`,`uid`,`clamp`,`fmtTime`,`escapeHtml`; IndexedDB layer `DB` (stores: `snippets`,`setlists`,`meta`; db `stageReadyDB`); `state`, `LIBRARY_ID`, `reindex`, `getLibrary`, `getSetlist`; `toast`, `openModal`/`closeModal`/`confirmDialog` (`#_ok`/`#_cancel`); `applyTheme`; drawer open/close; **back-button guard**: `syncBackGuard` keeps one history entry per open layer (`_pushedDepth`, `_layerDepth`); popstate closes topmost layer; full snippet view is a layer, the mini bar is NOT (back minimizes via `setMini(true)`). |
| `js/02-library.js` | `visibleSnippets` (search/tags(AND)/sort/shuffle), `renderTagFilter`, `renderLibrary`, `updateToolbarTitle` (shows setlist name), `enableSort` (pointer drag-reorder persisting to setlist.snippetIds), filter control wiring. |
| `js/03-setlists.js` | `renderDrawer` (drag-reorder via `[data-slhandle]`, persists `setlist.order`), new/edit setlist modals (`#slName`, `#slChecklist`, `#_save`, `#_del`, `#_exp` export, `#_prn` print), `snippetEditorModal` (`#snName`, `#tagInput` w/ `commitTagInput`, `#pickAudio`), `addSnippet`/`deleteSnippet` (purges id from all setlists). |
| `js/04-player.js` | The audio engine. `audioEl` (native element, `preservesPitch`), `player` state, `newPlaybackCtx` (`latencyHint:'playback'` → Bluetooth-safe), `openSnippet(id,keepMini)`, waveform (`computePeaks`/`drawWaveform`), transport + `loop()` rAF, **Media Session** (`msMetadata`/`msPosition`, prev/next/seek handlers), `skip`, `navSnippet` (preserves mini), loop region (`setInBtn` auto-arms; `checkLoopWrap` runs from BOTH rAF and `timeupdate` so loops survive background throttling; `player.loopRamp` speeds up each wrap — source of truth is `audioEl.playbackRate`, never the step-snapped slider), markers (+ `renderMarkerList`, `editMarker` with editable time via `parseTimeStr`), **pitch shifter v2**: AudioWorklet `PITCH_WORKLET_SRC` — dual-tap delay line with WSOLA cross-correlation alignment at every grain reseat + Hann-COLA crossfade (flutter ≈ 0 across voice/bass; ~110ms inherent latency while active; bench with `dev/pitchbench.js`); SP fallback. **Audio graph** `graph`: src→gain→[pitch]→limiter→dest, built on open; `measureLoudness` (gated RMS, stored per snippet at first decode), `applyVolume` = auto-match to −16 dBFS (toggle `state.autoLoud`, meta 'autoloud') × per-snippet `snip.gain` dB trim (`setVol`, Vol row), `setPitch` persists per snippet; **mini bar**: `setMini` (syncs back guard), `updateMiniInfo` (progress strip `#miniProgressFill`, `#miniSub` time/speed/pitch/loop badges), `#miniClose`. |
| `js/05-details.js` | Notes (`linkify`, `#notesBody`, `#editNotesBtn`/`#saveNotes`), recordings (MediaRecorder, `#recBtn`, `#recList .media-row`), ratings (`renderStarInput`, `#submitRateBtn`, stamps lastPlayed), card collapse. |
| `js/06-tools.js` | `closeTools(keepGuard)`, panel toggles; **tuner**: `detectPitchYIN` (DC removal, rms gate 0.0022, sub-octave check for weak fundamentals, 38–1500 Hz, 4096 window), EMA smoothing + glide needle, `refHz`; **metronome**: lookahead scheduler, `currentBpm()` ramp, `renderSubdiv`, tap tempo, ramp checkbox = `.on` on `#rampToggleRow`. |
| `js/07-data.js` | Progress overlay (`showProgress`/`setProgress`/`hideProgress`), `exportBundle` (**STORE, never DEFLATE audio**, streamFiles, progress cb), `exportData`/`exportSetlist`, `importZip` (id remap, tombstone-free merge into library), `importDirectory` (dedup by `snipSig` name+size), **print v2**: per-setlist `sl.print` config (`getPrintCfg`) — heading/notes toggles, per-tag on/off + color, gap notes (`gaps:[{pos,text,color}]`), page `breaks:[pos]`, mode auto/normal/large/huge; `buildPrintHTML` renders `.page` divs with `--s` scale var; `printViaFrame(html,autoFit)` measures each page in an A4-sized hidden iframe and sets `--s` to fill the sheet (**isolated iframe — never window.print**), `openSettings`/`openImportChooser`, `resetAppFlow` (double confirm) / `resetApp`. |
| `js/08-app.js` | SW registration + install prompt (`#installBtn`); **swipe gestures** `onSwipe(el,{canStart,engage,onMove,onEnd})`: snippet pull-down-at-top→mini, tool panels swipe-up (strict vertical gate so slider drags never trigger), drawer swipe-left (finger-follow), modal header drag-down (finger-follow); `init()` (loads DB, theme, currentSetlist, initial renders). |
| `sw.js` | Precaches ALL files in CORE (**update list when adding files**), runtime cache-first otherwise. **Bump `VERSION` on every release** or installed clients keep the old app. |
| `dev/` | Test harness (not needed in production; harmless if deployed). |

## Invariants / gotchas
- JS load order matters (globals defined top-down). New code goes in the
  matching file; new files must be added to `index.html` AND `sw.js` CORE.
- Back guard: any new full-screen layer must (a) be counted in
  `_layerDepth()`, (b) call `syncBackGuard()` on open/close, (c) get a
  branch in the popstate handler in `01-core.js`.
- Audio blobs are stored inline in IndexedDB records; zip export uses STORE.
- `snipSig(name,size)` is the folder-import dedup key.
- Confirm dialogs: OK button is always `#_ok`.
- Modal element is static `#modal` inside `#modalScrim`; content re-rendered
  per open — attach delegated handlers to the scrim, not the content.

## Dev harness (`dev/`)
Real-Chromium E2E via Playwright. From the site root's parent:
```
python3 dev/test1.py   # suites 1..6; servshim serves the site on :8901
```
`dev/servshim.py` boots the HTTP server (edit its `os.chdir` path if the
site folder moves). `dev/shots.py <outdir>` captures UI screenshots.
Suites: 1 core flows · 2 setlists/import/export/reset/back · 3 drag/edit/
delete/metronome · 4 nav-scope/exports/rapid-back · 5 media-session/mini ·
6 swipes/back-minimize · 7 marker-time/setlist-order/loudness/loop-ramp/
pitch-v2/print-v2. ~210 checks total; keep them green.
`dev/pitchbench.js <path/04-player.js>` benchmarks pitch flutter/accuracy.

## Release checklist
1. Edit the relevant `js/*.js` / `css/app.css` / `index.html`.
2. Bump `VERSION` in `sw.js`.
3. Run suites (all green, no console errors).
4. Deploy the whole folder.
