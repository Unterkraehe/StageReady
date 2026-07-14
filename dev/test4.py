import servshim, math, struct, wave, os, shutil, json, zipfile
from playwright.sync_api import sync_playwright
shutil.rmtree('/tmp/aud', ignore_errors=True); os.makedirs('/tmp/aud')
def make_wav(path, freq=220, secs=1.5, sr=22050):
    n=int(secs*sr)
    with wave.open(path,'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(12000*math.sin(2*math.pi*freq*i/sr))) for i in range(n)))
for nm,f in [('One',220),('Two',330),('Three',440),('Four',550)]:
    make_wav(f'/tmp/aud/{nm}.wav', f)

with sync_playwright() as p:
    browser=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    page=browser.new_context(viewport={'width':412,'height':892}, has_touch=True, permissions=['microphone']).new_page()
    errors=[]
    page.on('console', lambda m: errors.append(f"[console.error] {m.text}") if m.type=='error' and '403' not in m.text else None)
    page.on('pageerror', lambda e: errors.append(f"[pageerror] {e}"))
    page.goto('http://localhost:8901/index.html'); page.wait_for_timeout(900)
    def check(name,cond,extra=''):
        print(('PASS ' if cond else 'FAIL ')+name+((' | '+str(extra)) if (extra!='' and not cond) else ''))
    def close_drawer_if_open():
        if page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
            page.eval_on_selector('#scrim','e=>e.click()'); page.wait_for_timeout(250)

    # ---- init defaults ----
    check('speed label default', page.eval_on_selector('#speedVal','e=>e.textContent')=='1.00x')
    check('bpm label init', page.inner_text('#bpmVal')!='')
    check('subdiv buttons rendered at init', page.eval_on_selector_all('.subdiv-row button','e=>e.length')>=4)

    # ---- create snippet WITHOUT audio: validation ----
    page.click('#fab'); page.wait_for_timeout(200)
    page.fill('#snName','No Audio')
    page.click('#modal >> text=Create'); page.wait_for_timeout(300)
    still_open = page.eval_on_selector('#modalScrim','e=>e.classList.contains("show")')
    n0 = page.evaluate("state.snippets.length")
    check('create without audio blocked', still_open and n0==0, f"open={still_open} n={n0}")
    page.mouse.click(10,300); page.wait_for_timeout(250)  # dismiss

    # bulk import
    page.click('#hamburgerBtn'); page.wait_for_timeout(200)
    page.click('#settingsBtn'); page.wait_for_timeout(200)
    page.click('#_setImport'); page.wait_for_timeout(200)
    with page.expect_file_chooser() as fc: page.click('#_impDir')
    fc.value.set_files('/tmp/aud'); page.wait_for_timeout(1200)
    check('4 imported', page.evaluate("state.snippets.length")==4)
    close_drawer_if_open()

    # ---- replace audio ----
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(700)
    old_size = page.evaluate("state.byId[state.current].audioFile.size")
    make_wav('/tmp/aud/replacement.wav', 660, 0.8)
    page.click('#svMenuBtn'); page.wait_for_timeout(200)
    with page.expect_file_chooser() as fc: page.click('#_replace')
    fc.value.set_files('/tmp/aud/replacement.wav'); page.wait_for_timeout(900)
    new_size = page.evaluate("state.byId[state.current].audioFile.size")
    check('audio replaced (size changed)', new_size!=old_size and new_size>1000, f"{old_size}->{new_size}")
    check('duration reloaded', page.evaluate("audioEl.duration")<1.2)

    # ---- recording add + delete ----
    page.click('#recCard .card-head'); page.wait_for_timeout(150)
    page.click('#recBtn'); page.wait_for_timeout(1100)
    page.click('#recBtn'); page.wait_for_timeout(600)
    check('recording added', page.evaluate("state.byId[state.current].recordings.length")==1)
    page.click('#recList .media-row button')
    page.wait_for_timeout(250)
    # confirm dialog?
    if page.eval_on_selector('#modalScrim','e=>e.classList.contains("show")'):
        page.click('#_ok'); page.wait_for_timeout(300)
    check('recording deleted', page.evaluate("state.byId[state.current].recordings.length")==0)

    # ---- setlist-scoped navigation ----
    page.go_back(); page.wait_for_timeout(350)  # minimize
    page.click('#miniClose'); page.wait_for_timeout(250)  # close
    page.click('#hamburgerBtn'); page.wait_for_timeout(200)
    page.click('#newSetlistBtn'); page.wait_for_timeout(200)
    page.fill('#slName','Duo'); page.click('#modal >> text=Create'); page.wait_for_timeout(300)
    page.eval_on_selector_all('#slChecklist .check-row','els=>{els[1].click(); els[2].click()}')
    page.wait_for_timeout(150)
    page.click('#_save'); page.wait_for_timeout(300)
    page.click('#userSetlists >> text=Duo'); page.wait_for_timeout(350)
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(600)
    first = page.evaluate("state.byId[state.current].name")
    page.click('#nextBtn'); page.wait_for_timeout(500)
    second = page.evaluate("state.byId[state.current].name")
    check('nav scoped to setlist (moved to 2nd item)', second!=first, f"{first}->{second}")
    check('next disabled at end of setlist', page.eval_on_selector('#nextBtn','e=>e.disabled'))
    in_setlist = page.evaluate("state.navList.length")
    check('navList limited to setlist size', in_setlist==2, in_setlist)

    # ---- per-setlist export scoping ----
    page.go_back(); page.wait_for_timeout(300)
    page.click('#miniClose'); page.wait_for_timeout(250)
    page.click('#hamburgerBtn'); page.wait_for_timeout(200)
    page.eval_on_selector_all('#userSetlists .setlist-row .mini','els=>els[0].click()'); page.wait_for_timeout(300)
    with page.expect_download() as dl:
        page.click('#_exp')
    dl.value.save_as('/tmp/setlist.zip'); page.wait_for_timeout(400)
    z=zipfile.ZipFile('/tmp/setlist.zip'); mf=json.loads(z.read('manifest.json'))
    audio_files=[n for n in z.namelist() if n.startswith('audio/') and not n.endswith('/')]
    check('setlist export contains only its 2 snippets', len(mf['snippets'])==2 and len(audio_files)==2, f"{len(mf['snippets'])} snips {len(audio_files)} audio")
    check('setlist export has 1 setlist', len(mf['setlists'])==1 and mf['setlists'][0]['name']=='Duo')
    # modal still open after export -> close
    if page.eval_on_selector('#modalScrim','e=>e.classList.contains("show")'):
        page.click('#_save'); page.wait_for_timeout(250)
    close_drawer_if_open()

    # ---- rapid double back ----
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(600)
    page.click('#svMenuBtn'); page.wait_for_timeout(250)   # modal over snippet
    page.go_back(); page.go_back(); page.wait_for_timeout(700)
    alive = page.evaluate("typeof state!=='undefined'")
    check('rapid double-back keeps app alive', alive)
    if alive:
        check('rapid double-back: modal closed, snippet minimized', not page.eval_on_selector('#modalScrim','e=>e.classList.contains("show")') and page.eval_on_selector('#snippetView','e=>e.classList.contains("mini")'))
        page.click('#miniClose'); page.wait_for_timeout(250)

    # ---- reopen after all that: still functional ----
    page.click('#snippetList .snip-row >> nth=1'); page.wait_for_timeout(600)
    check('app still functional', page.eval_on_selector('#snippetView','e=>e.classList.contains("show")') and page.evaluate("!!state.current"))

    print("\n--- ERRORS ---")
    for e in errors: print(e)
    if not errors: print("(none)")
    browser.close()
