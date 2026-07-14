import servshim
import json, math, struct, wave, os
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8901"
errors = []
def make_wav(path, freq=220, secs=2.0, sr=22050):
    n = int(secs*sr)
    with wave.open(path, 'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(12000*math.sin(2*math.pi*freq*i/sr))) for i in range(n)))
import shutil; shutil.rmtree('/tmp/aud',ignore_errors=True); os.makedirs('/tmp/aud', exist_ok=True)
for nm,f,s in [('Song Alpha',220,2.0),('Song Beta',330,1.5),('Song Gamma',440,1.2)]:
    make_wav(f'/tmp/aud/{nm}.wav', f, s)

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    ctx = browser.new_context(viewport={'width':412,'height':892}, has_touch=True, permissions=['microphone'])
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(f"[console.{m.type}] {m.text}") if m.type=='error' else None)
    page.on('pageerror', lambda e: errors.append(f"[pageerror] {e}"))
    page.goto(BASE + "/index.html"); page.wait_for_timeout(1000)
    def check(name, cond, extra=''):
        print(('PASS ' if cond else 'FAIL ') + name + ((' | '+str(extra)) if (extra!='' and not cond) else ''))

    def add_snippet(path, tag=None):
        page.click('#fab'); page.wait_for_timeout(250)
        with page.expect_file_chooser() as fc: page.click('#pickAudio')
        fc.value.set_files(path); page.wait_for_timeout(150)
        if tag: page.fill('#tagInput', tag)
        page.click('#modal >> text=Create'); page.wait_for_timeout(700)
        page.click('#svMenuBtn'); page.wait_for_timeout(150)
        page.click('#modal >> text=Close'); page.wait_for_timeout(250)


    def open_drawer():
        if not page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
            page.click('#hamburgerBtn'); page.wait_for_timeout(250)
    add_snippet('/tmp/aud/Song Alpha.wav','rock')
    add_snippet('/tmp/aud/Song Beta.wav','jazz')
    add_snippet('/tmp/aud/Song Gamma.wav','rock')
    n = page.evaluate("state.snippets.length")
    check('3 snippets created', n==3, n)

    # ---- open first snippet, loop + notes + rating ----
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(700)
    page.evaluate("audioEl.currentTime=0.5")
    page.click('#setInBtn')
    page.evaluate("audioEl.currentTime=1.4")
    page.click('#setOutBtn'); page.wait_for_timeout(100)
    li,lo,lon = page.evaluate("[player.loopIn,player.loopOut,player.loopOn]")
    check('loop in/out set', abs(li-0.5)<0.05 and abs(lo-1.4)<0.05, f"{li},{lo}")
    print('  note: loopOn after set =', lon)
    check('loop auto-armed', lon==True, lon)
    page.click('#playBtn'); page.wait_for_timeout(1500)
    tw = page.evaluate("audioEl.currentTime")
    check('loop wraps inside region', 0.4<=tw<=1.5, tw)
    page.click('#playBtn')
    page.click('#clearLoopBtn')
    check('loop cleared', page.evaluate("player.loopIn===null&&player.loopOut===null"))

    # notes
    page.click('#editNotesBtn'); page.wait_for_timeout(150)
    page.fill('#notesArea', 'Check https://example.com riff')
    page.click('#saveNotes'); page.wait_for_timeout(200)
    check('notes saved + linkified', page.eval_on_selector_all('#notesBody a','a=>a.length')==1)

    # ratings (expand card first)
    page.click('#rateCard .card-head'); page.wait_for_timeout(150)
    page.evaluate("document.querySelectorAll('#starInput svg')[3].onclick()")
    page.fill('#rateNote','solid')
    page.click('#submitRateBtn'); page.wait_for_timeout(250)
    check('rating logged', page.evaluate("state.byId[state.current].ratings.length")==1)

    # recording (fake mic)
    page.click('#recCard .card-head'); page.wait_for_timeout(150)
    rec_btn = page.query_selector('#recBtn')
    if rec_btn:
        page.click('#recBtn'); page.wait_for_timeout(1200)
        page.click('#recBtn'); page.wait_for_timeout(600)
        nrec = page.evaluate("state.byId[state.current].recordings.length")
        check('recording captured', nrec==1, nrec)
    else:
        print('  (recBtn id differs, checking...)', page.eval_on_selector('#recCard','e=>e.innerHTML.slice(0,200)'))

    # nav prev/next
    page.click('#svMenuBtn'); page.wait_for_timeout(120); page.click('#modal >> text=Close'); page.wait_for_timeout(250)
    page.click('#snippetList .snip-row >> nth=1'); page.wait_for_timeout(500)
    name1 = page.evaluate("state.byId[state.current].name")
    page.click('#nextBtn'); page.wait_for_timeout(500)
    name2 = page.evaluate("state.byId[state.current].name")
    check('next navigates', name1!=name2, f"{name1}->{name2}")
    page.click('#prevBtn'); page.wait_for_timeout(500)
    check('prev navigates back', page.evaluate("state.byId[state.current].name")==name1)

    # ---- ANDROID BACK BUTTON (history) ----
    check('snippet open (pre-back)', page.eval_on_selector('#snippetView','e=>e.classList.contains("show")'))
    page.go_back(); page.wait_for_timeout(350)
    check('back minimizes snippet, app stays', page.eval_on_selector('#snippetView','e=>e.classList.contains("show")&&e.classList.contains("mini")') and page.is_visible('#libraryView'))
    check('mini is not a back layer', page.evaluate("_pushedDepth===0"))
    page.click('#miniClose'); page.wait_for_timeout(300)
    check('mini close dismisses player', not page.eval_on_selector('#snippetView','e=>e.classList.contains("show")'))
    # drawer + modal stack
    page.click('#hamburgerBtn'); page.wait_for_timeout(300)
    page.click('#settingsBtn'); page.wait_for_timeout(250)
    check('settings modal above drawer', page.is_visible('#modal'))
    page.go_back(); page.wait_for_timeout(300)
    check('back closes modal first', not page.eval_on_selector('#modalScrim','e=>e.classList.contains("show")') and page.eval_on_selector('#drawer','e=>e.classList.contains("show")'))
    page.go_back(); page.wait_for_timeout(300)
    check('back then closes drawer', not page.eval_on_selector('#drawer','e=>e.classList.contains("show")'))
    hist_ok = page.evaluate("_pushedDepth===0")
    check('back guard disarmed at root', hist_ok)

    # ---- SETLISTS ----
    page.click('#hamburgerBtn'); page.wait_for_timeout(250)
    page.click('#newSetlistBtn'); page.wait_for_timeout(250)
    page.fill('#slName', 'Gig Night')
    page.click('#modal >> text=Create'); page.wait_for_timeout(350)
    sl = page.evaluate("state.setlists.map(s=>s.name)")
    check('setlist created', 'Gig Night' in sl, sl)
    # edit modal auto-opened? find edit path: click edit icon
    if page.is_visible('#modal'):
        pass
    else:
        page.eval_on_selector_all('#userSetlists .setlist-row .mini', 'els=>els[0]&&els[0].click()')
        page.wait_for_timeout(300)
    check('edit setlist modal open', page.is_visible('#modal') and 'setlist' in page.inner_text('#modal').lower())
    # add snippets via checklist
    cnt = page.eval_on_selector_all('#slChecklist .check-row', 'els=>{els.forEach((e,i)=>{if(i<2)e.click()});return els.length}')
    page.wait_for_timeout(200)
    page.click('#modal >> text=Save'); page.wait_for_timeout(350)
    gig = page.evaluate("state.setlists.find(s=>s.name==='Gig Night').snippetIds.length")
    check('2 snippets added to setlist', gig==2, gig)

    # switch to setlist, verify filtering
    page.click('#userSetlists >> text=Gig Night'); page.wait_for_timeout(350)
    rows = page.eval_on_selector_all('#snippetList .snip-row','e=>e.length')
    check('setlist view shows 2', rows==2, rows)
    check('drawer closed after select', not page.eval_on_selector('#drawer','e=>e.classList.contains("show")'))

    # back to library
    page.click('#hamburgerBtn'); page.wait_for_timeout(250)
    page.click('#setlistList >> text=Library'); page.wait_for_timeout(350)
    check('library shows 3', page.eval_on_selector_all('#snippetList .snip-row','e=>e.length')==3)

    # ---- search & tag filter & sort ----
    page.fill('#searchInput','beta'); page.wait_for_timeout(250)
    check('search filters', page.eval_on_selector_all('#snippetList .snip-row','e=>e.length')==1)
    page.fill('#searchInput',''); page.wait_for_timeout(200)
    page.click('.tag-filter-bar >> text=rock'); page.wait_for_timeout(250)
    check('tag filter AND', page.eval_on_selector_all('#snippetList .snip-row','e=>e.length')==2)
    page.click('.tag-filter-bar >> text=rock'); page.wait_for_timeout(200)
    page.select_option('#sortSelect','alpha'); page.wait_for_timeout(250)
    first = page.eval_on_selector('#snippetList .snip-row .snip-name','e=>e.textContent')
    check('alpha sort', first=='Song Alpha', first)
    dir_btn = page.query_selector('#sortDirBtn')
    if dir_btn:
        page.click('#sortDirBtn'); page.wait_for_timeout(250)
        first2 = page.eval_on_selector('#snippetList .snip-row .snip-name','e=>e.textContent')
        check('sort invert', first2=='Song Gamma', first2)
        page.click('#sortDirBtn')
    page.select_option('#sortSelect','custom'); page.wait_for_timeout(200)

    # ---- TOOLS ----
    page.click('#metroBtn'); page.wait_for_timeout(250)
    check('metro panel opens', page.eval_on_selector('#metroPanel','e=>e.classList.contains("show")'))
    page.click('#rampToggleRow'); page.wait_for_timeout(100)
    check('ramp checkbox visually on', page.eval_on_selector('#rampToggleRow','e=>e.classList.contains("on")'))
    check('ramp checkmark visible', page.eval_on_selector('#rampToggleRow .check-box svg','e=>getComputedStyle(e).display')=='block')
    page.click('#metroStartBtn'); page.wait_for_timeout(900)
    beats = page.eval_on_selector_all('.beat-dot','e=>e.length')
    check('beat lights rendered', beats>=1, beats)
    page.click('#metroStartBtn')
    page.click('#tunerBtn'); page.wait_for_timeout(250)
    check('tuner swaps in, metro closed', page.eval_on_selector('#tunerPanel','e=>e.classList.contains("show")') and not page.eval_on_selector('#metroPanel','e=>e.classList.contains("show")'))
    page.click('#tunerStartBtn'); page.wait_for_timeout(1200)
    tuner_on = page.evaluate("tunerOn")
    check('tuner started with fake mic', tuner_on)
    page.click('#tunerStartBtn')
    page.go_back(); page.wait_for_timeout(300)
    check('back closes tool panel', not page.eval_on_selector('#tunerPanel','e=>e.classList.contains("show")'))

    # ---- THEME persist ----
    page.click('#themeBtn'); page.wait_for_timeout(300)
    check('light theme applied', page.evaluate("document.documentElement.getAttribute('data-theme')")=='light')
    page.reload(); page.wait_for_timeout(1000)
    check('theme persists after reload', page.evaluate("document.documentElement.getAttribute('data-theme')")=='light')
    check('data survives reload', page.evaluate("state.snippets.length")==3)
    page.click('#themeBtn'); page.wait_for_timeout(200)

    # ---- EXPORT / IMPORT round-trip ----
    page.click('#hamburgerBtn'); page.wait_for_timeout(250)
    page.click('#settingsBtn'); page.wait_for_timeout(250)
    with page.expect_download() as dl:
        page.click('#_setExport')
    path = dl.value.path()
    dl.value.save_as('/tmp/export.zip')
    page.wait_for_timeout(400)
    import zipfile
    z = zipfile.ZipFile('/tmp/export.zip')
    names = z.namelist()
    mf = json.loads(z.read('manifest.json'))
    audio_files=[n for n in names if n.startswith('audio/') and not n.endswith('/')]
    check('export zip has manifest + 3 audio', 'manifest.json' in names and len(audio_files)==3, names)
    check('manifest setlists include Gig Night', any(s['name']=='Gig Night' for s in mf['setlists']))
    check('progress overlay hidden after export', page.eval_on_selector('#progressOverlay','e=>e.classList.contains("hidden")'))

    # reset app (double confirm)
    open_drawer()
    page.click('#settingsBtn'); page.wait_for_timeout(250)
    page.click('#_setReset'); page.wait_for_timeout(250)
    page.click('#modal >> text=Continue'); page.wait_for_timeout(250)
    page.click('#modal >> text=Erase everything'); page.wait_for_timeout(800)
    check('reset wipes snippets', page.evaluate("state.snippets.length")==0)
    check('reset back to dark', page.evaluate("document.documentElement.getAttribute('data-theme')")=='dark')

    # import zip restore
    open_drawer()
    page.click('#settingsBtn'); page.wait_for_timeout(250)
    page.click('#_setImport'); page.wait_for_timeout(250)
    with page.expect_file_chooser() as fc:
        page.click('#_impZip')
    fc.value.set_files('/tmp/export.zip')
    page.wait_for_timeout(2500)
    check('import restores 3 snippets', page.evaluate("state.snippets.length")==3)
    check('import restores setlist', page.evaluate("state.setlists.some(s=>s.name==='Gig Night')"))
    check('imported snippet playable blob', page.evaluate("state.snippets.every(s=>s.audioFile && s.audioFile.size>1000)"))
    # imported ratings/notes intact
    check('import preserves notes', page.evaluate("state.snippets.some(s=>s.notes&&s.notes.includes('riff'))"))
    check('import preserves ratings', page.evaluate("state.snippets.some(s=>s.ratings.length>0)"))

    # dedup: import same folder twice
    open_drawer()
    page.click('#settingsBtn'); page.wait_for_timeout(200)
    page.click('#_setImport'); page.wait_for_timeout(200)
    with page.expect_file_chooser() as fc:
        page.click('#_impDir')
    fc.value.set_files('/tmp/aud')
    page.wait_for_timeout(1500)
    n_after = page.evaluate("state.snippets.length")
    check('folder import dedups vs existing', n_after==3, n_after)

    # ---- PRINT (iframe creation, no dialog in headless) ----
    page.evaluate("window.print=()=>{window._printCalled=true}")  # top-level shouldn't be used
    open_drawer()
    page.eval_on_selector_all('#userSetlists .setlist-row .mini','els=>els[0].click()'); page.wait_for_timeout(300)
    page.click('#_prn'); page.wait_for_timeout(300)
    page.eval_on_selector('#_pModes [data-mode="huge"]','e=>e.click()'); page.wait_for_timeout(150)
    page.click('#_pGo'); page.wait_for_timeout(800)
    frame_ok = page.evaluate("!!document.querySelector('iframe') && document.querySelector('iframe').contentDocument.body.textContent.includes('Gig Night')")
    check('print iframe built with content', frame_ok)
    numbered = page.evaluate("document.querySelector('iframe').contentDocument.querySelectorAll('.song').length")
    check('print has song rows', numbered==2, numbered)

    print("\n--- CONSOLE/PAGE ERRORS ---")
    for e in errors: print(e)
    if not errors: print('(none)')
    browser.close()
