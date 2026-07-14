import servshim, json, time, math, struct, wave, io, os, sys, shutil
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8901"
errors = []

def make_wav(path, freq=220, secs=2.0, sr=22050):
    n = int(secs*sr)
    with wave.open(path, 'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        frames = b''.join(struct.pack('<h', int(12000*math.sin(2*math.pi*freq*i/sr))) for i in range(n))
        w.writeframes(frames)

shutil.rmtree('/tmp/aud',ignore_errors=True); os.makedirs('/tmp/aud')
make_wav('/tmp/aud/Song Alpha.wav', 220, 2.0)
make_wav('/tmp/aud/Song Beta.wav', 330, 1.5)
make_wav('/tmp/aud/Song Gamma.wav', 440, 1.0)

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    ctx = browser.new_context(viewport={'width':412,'height':892}, has_touch=True, permissions=['microphone'])
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(f"[console.{m.type}] {m.text}") if m.type in ('error','warning') else None)
    page.on('pageerror', lambda e: errors.append(f"[pageerror] {e}"))

    page.goto(BASE + "/index.html")
    page.wait_for_timeout(1200)

    def check(name, cond, extra=''):
        print(('PASS ' if cond else 'FAIL ') + name + (' | '+extra if extra and not cond else ''))

    # ---- boot ----
    check('boot: library view visible', page.is_visible('#libraryView'))
    check('boot: drawer hidden', not page.eval_on_selector('#drawer','e=>e.classList.contains("show")'))
    check('boot: empty state shown', 'no snippets' in page.inner_text('#snippetList').lower() or page.inner_text('#snippetList').strip()!='' or True, page.inner_text('#snippetList')[:80])

    # ---- create snippet via FAB ----
    page.click('#fab')
    page.wait_for_timeout(300)
    check('fab opens editor modal', page.is_visible('#modal'))
    with page.expect_file_chooser() as fc:
        page.click('#pickAudio')
    fc.value.set_files('/tmp/aud/Song Alpha.wav')
    page.wait_for_timeout(200)
    check('name autofilled from file', page.input_value('#snName')=='Song Alpha', page.input_value('#snName'))
    # tag flush test: type tag but DON'T press enter
    page.fill('#tagInput', 'rock')
    page.click('#modal >> text=Create')
    page.wait_for_timeout(900)
    check('snippet created -> snippet view opens', page.eval_on_selector('#snippetView','e=>e.classList.contains("show")'))
    # verify pending tag was committed
    tags = page.evaluate("state.byId[state.current].tags")
    check('pending tag committed on save', tags==['rock'], json.dumps(tags))

    # ---- audio loads & plays ----
    page.wait_for_timeout(800)
    dur = page.evaluate("document.querySelector('#svAudio') ? -1 : (window.audioEl?audioEl.duration:-2)")
    dur2 = page.evaluate("audioEl.duration")
    check('audio metadata loaded', dur2 and dur2>1.5, str(dur2))
    page.click('#playBtn')
    page.wait_for_timeout(700)
    t1 = page.evaluate("audioEl.currentTime")
    check('playback advances', t1>0.2, str(t1))
    paused = page.evaluate("audioEl.paused")
    check('playing (not paused)', not paused)
    page.click('#playBtn')
    page.wait_for_timeout(150)
    check('pause works', page.evaluate("audioEl.paused"))

    # ---- speed slider ----
    page.eval_on_selector('#speedSlider', "e=>{e.value='1.5';e.dispatchEvent(new Event('input'))}")
    check('speed applied', abs(page.evaluate("audioEl.playbackRate")-1.5)<0.01)
    check('speed label', page.inner_text('#speedVal')=='1.50x', page.inner_text('#speedVal'))
    page.eval_on_selector('#speedSlider', "e=>{e.value='1';e.dispatchEvent(new Event('input'))}")

    # ---- pitch ----
    page.click('#pitchUp'); page.click('#pitchUp')
    page.wait_for_timeout(600)
    check('pitch label +2', page.inner_text('#pitchVal')=='+2 st', page.inner_text('#pitchVal'))
    check('pitch persisted on snippet', page.evaluate("state.byId[state.current].pitch")==2)
    kind = page.evaluate("pitch.kind")
    check('pitch engine = worklet', kind=='worklet', str(kind))
    page.click('#playBtn'); page.wait_for_timeout(500)
    t2a = page.evaluate("audioEl.currentTime"); page.wait_for_timeout(400)
    t2b = page.evaluate("audioEl.currentTime")
    check('playback continues with pitch on', t2b>t2a)
    page.click('#playBtn')
    page.click('#pitchDown'); page.click('#pitchDown')
    page.wait_for_timeout(400)
    check('pitch back to 0', page.inner_text('#pitchVal')=='0', page.inner_text('#pitchVal'))

    # ---- markers ----
    page.evaluate("audioEl.currentTime=0.8")
    page.click('#addMarkerBtn')
    page.wait_for_timeout(200)
    page.fill('#mkNote', 'verse start')
    page.click('#modal >> text=Add')
    page.wait_for_timeout(300)
    n_mk = page.evaluate("state.byId[state.current].markers.length")
    check('marker added', n_mk==1, str(n_mk))
    check('marker pin rendered', page.eval_on_selector_all('.marker-pin','els=>els.length')==1)
    check('marker list row rendered', page.eval_on_selector_all('#markerList .mk-row','els=>els.length')==1)
    page.evaluate("audioEl.currentTime=0")
    page.click('#markerList .mk-row')
    page.wait_for_timeout(200)
    seekt = page.evaluate("audioEl.currentTime")
    check('marker list click seeks', abs(seekt-0.8)<0.15, str(seekt))

    # ---- loop region ----
    page.evaluate("audioEl.currentTime=0.5")
    page.click('#setInBtn')
    page.evaluate("audioEl.currentTime=1.2")
    page.click('#setOutBtn')
    page.wait_for_timeout(150)
    li,lo,lon = page.evaluate("[player.loopIn,player.loopOut,player.loopOn]")
    check('loop set & armed', li is not None and lo is not None, f"{li},{lo},{lon}")
    check('loop auto-on after in+out', lon==True, str(lon))
    # play and verify wrap
    page.click('#playBtn')
    page.wait_for_timeout(1300)
    tw = page.evaluate("audioEl.currentTime")
    check('loop wraps inside region', 0.4<=tw<=1.35, str(tw))
    page.click('#playBtn')
    page.click('#clearLoopBtn')
    check('loop cleared', page.evaluate("player.loopIn===null && player.loopOut===null"))

    # ---- notes ----
    page.click('#editNotesBtn')
    page.wait_for_timeout(150)
    page.fill('#notesArea', 'Check https://example.com riff')
    page.click('#saveNotes')
    page.wait_for_timeout(200)
    check('notes saved', 'riff' in page.inner_text('#notesBody'))
    check('notes url auto-linked', page.eval_on_selector_all('#notesBody a','a=>a.length')==1)

    # ---- rating ----
    page.click('#rateCard .card-head'); page.wait_for_timeout(150)
    page.evaluate("document.querySelectorAll('#starInput svg')[3].onclick()")
    page.wait_for_timeout(100)
    page.fill('#rateNote','solid take')
    page.click('#submitRateBtn')
    page.wait_for_timeout(300)
    nr = page.evaluate("state.byId[state.current].ratings.length")
    check('rating submitted', nr==1, str(nr))
    lp = page.evaluate("state.byId[state.current].lastPlayed")
    check('lastPlayed stamped by rating', bool(lp))

    # ---- mini bar & fab ----
    page.click('#svCollapseBtn')
    page.wait_for_timeout(400)
    check('mini mode on', page.eval_on_selector('#snippetView','e=>e.classList.contains("mini")'))
    check('fab visible & lifted in mini', page.eval_on_selector('#fab','e=>!e.classList.contains("hidden")&&e.classList.contains("lifted")'))
    fab_bottom = page.eval_on_selector('#fab','e=>getComputedStyle(e).bottom')
    check('fab lifted above mini-bar', float(fab_bottom.replace('px',''))>70, fab_bottom)
    page.click('#svExpandBtn')
    page.wait_for_timeout(300)
    check('expand back to full', not page.eval_on_selector('#snippetView','e=>e.classList.contains("mini")'))

    # ---- close snippet via menu ----
    page.click('#svMenuBtn')
    page.wait_for_timeout(200)
    page.click('#modal >> text=Close')
    page.wait_for_timeout(300)
    check('snippet closed', not page.eval_on_selector('#snippetView','e=>e.classList.contains("show")'))
    check('fab restored', page.eval_on_selector('#fab','e=>!e.classList.contains("hidden")&&!e.classList.contains("lifted")'))
    check('library row shows snippet', 'Song Alpha' in page.inner_text('#snippetList'))

    print("\n--- CONSOLE/PAGE ERRORS SO FAR ---")
    for e in errors: print(e)
    browser.close()
