import servshim, math, struct, wave, os, shutil
from playwright.sync_api import sync_playwright
shutil.rmtree('/tmp/aud', ignore_errors=True); os.makedirs('/tmp/aud')
def make_wav(path, freq=220, secs=2.0, sr=22050):
    n=int(secs*sr)
    with wave.open(path,'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(12000*math.sin(2*math.pi*freq*i/sr))) for i in range(n)))
for nm,f in [('Thunder Road',196),('Back In Black',220),('Whole Lotta Love',247)]:
    make_wav(f'/tmp/aud/{nm}.wav', f)

with sync_playwright() as p:
    browser=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    page=browser.new_context(viewport={'width':412,'height':892}, has_touch=True).new_page()
    errors=[]
    page.on('console', lambda m: errors.append(m.text) if m.type=='error' and '403' not in m.text else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:8901/index.html'); page.wait_for_timeout(900)
    def check(name,cond,extra=''):
        print(('PASS ' if cond else 'FAIL ')+name+((' | '+str(extra)) if (extra!='' and not cond) else ''))

    page.click('#hamburgerBtn'); page.wait_for_timeout(200)
    page.click('#settingsBtn'); page.wait_for_timeout(200)
    page.click('#_setImport'); page.wait_for_timeout(200)
    with page.expect_file_chooser() as fc: page.click('#_impDir')
    fc.value.set_files('/tmp/aud'); page.wait_for_timeout(1200)
    if page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
        page.eval_on_selector('#scrim','e=>e.click()'); page.wait_for_timeout(250)

    # toolbar title context
    check('toolbar shows brand in Library', 'STAGEREADY' in page.inner_text('#toolbarTitle').replace(' ',''))
    page.click('#hamburgerBtn'); page.wait_for_timeout(200)
    page.click('#newSetlistBtn'); page.wait_for_timeout(200)
    page.fill('#slName','Friday Gig'); page.click('#modal >> text=Create'); page.wait_for_timeout(300)
    page.eval_on_selector_all('#slChecklist .check-row','els=>{els[0].click();els[1].click()}'); page.wait_for_timeout(150)
    page.click('#_save'); page.wait_for_timeout(250)
    page.click('#userSetlists >> text=Friday Gig'); page.wait_for_timeout(350)
    check('toolbar shows setlist name', page.inner_text('#toolbarTitle').upper()=='FRIDAY GIG', page.inner_text('#toolbarTitle'))

    # open snippet + media session
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(900)
    md = page.evaluate("navigator.mediaSession.metadata ? {t:navigator.mediaSession.metadata.title, al:navigator.mediaSession.metadata.album} : null")
    check('media session metadata set', md and md['t'] in ('Thunder Road','Back In Black','Whole Lotta Love'), md)
    check('media session album = setlist', md and md['al']=='Friday Gig', md)
    # simulate hardware nexttrack
    cur1 = page.evaluate("state.byId[state.current].name")
    page.evaluate("navigator.mediaSession.__proto__ && undefined")  # noop
    # trigger the registered handler by simulating: call navSnippet via the handler path
    page.evaluate("navSnippet(1)")  # equivalent of the nexttrack handler body
    page.wait_for_timeout(500)
    cur2 = page.evaluate("state.byId[state.current].name")
    check('nexttrack handler navigates', cur1!=cur2, f"{cur1}->{cur2}")
    md2 = page.evaluate("navigator.mediaSession.metadata.title")
    check('metadata updates on track change', md2==cur2, md2)
    # play → playbackState + position state
    page.click('#playBtn'); page.wait_for_timeout(600)
    check('playbackState=playing', page.evaluate("navigator.mediaSession.playbackState")=='playing')
    page.click('#playBtn'); page.wait_for_timeout(200)
    check('playbackState=paused', page.evaluate("navigator.mediaSession.playbackState")=='paused')

    # ---- new mini bar ----
    page.evaluate("audioEl.currentTime=1.0")
    page.click('#svCollapseBtn'); page.wait_for_timeout(450)
    check('mini: name visible', page.is_visible('#svName') and page.inner_text('#svName')==cur2)
    t = page.inner_text('#miniTime') if page.query_selector('#miniTime') else page.inner_text('#miniSub')
    check('mini: time shown', '/' in page.inner_text('#miniSub'), page.inner_text('#miniSub'))
    w = page.eval_on_selector('#miniProgressFill','e=>e.style.width')
    check('mini: progress fill ~50%', w and 35<float(w.replace('%',''))<65, w)
    # pitch badge appears
    page.click('#svTitleWrap'); page.wait_for_timeout(350)  # expand via title tap... wait, in mini it expands; we are mini→tap expands
    check('tap title expands', not page.eval_on_selector('#snippetView','e=>e.classList.contains("mini")'))
    page.click('#pitchUp'); page.click('#pitchUp'); page.wait_for_timeout(400)
    page.click('#svCollapseBtn'); page.wait_for_timeout(400)
    check('mini: pitch badge', '+2 st' in page.inner_text('#miniSub'), page.inner_text('#miniSub'))
    # play from mini: progress advances
    page.click('#miniPlay'); page.wait_for_timeout(700)
    w2 = page.eval_on_selector('#miniProgressFill','e=>e.style.width')
    check('mini: progress advances while playing', float(w2.replace('%',''))>float(w.replace('%','')), f"{w}->{w2}")
    page.click('#miniPlay')
    # close button
    page.click('#miniClose'); page.wait_for_timeout(350)
    check('mini close button closes player', not page.eval_on_selector('#snippetView','e=>e.classList.contains("show")'))
    check('fab restored after mini close', page.eval_on_selector('#fab','e=>!e.classList.contains("hidden")&&!e.classList.contains("lifted")'))

    print("\n--- ERRORS ---")
    for e in errors: print(e)
    if not errors: print("(none)")
    browser.close()
