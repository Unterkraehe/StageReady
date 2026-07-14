import servshim, math, struct, wave, os, shutil, json
from playwright.sync_api import sync_playwright
shutil.rmtree('/tmp/aud', ignore_errors=True); os.makedirs('/tmp/aud')
def make_wav(path, freq=220, secs=2.0, sr=22050):
    n=int(secs*sr)
    with wave.open(path,'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(12000*math.sin(2*math.pi*freq*i/sr))) for i in range(n)))
for nm,f in [('AAA',220),('BBB',330),('CCC',440)]:
    make_wav(f'/tmp/aud/{nm}.wav', f)

with sync_playwright() as p:
    browser=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    page=browser.new_context(viewport={'width':412,'height':892}, has_touch=True, permissions=['microphone']).new_page()
    errors=[]
    page.on('console', lambda m: errors.append(f"[console.error] {m.text}") if m.type=='error' else None)
    page.on('pageerror', lambda e: errors.append(f"[pageerror] {e}"))
    page.goto('http://localhost:8901/index.html'); page.wait_for_timeout(900)
    def check(name,cond,extra=''):
        print(('PASS ' if cond else 'FAIL ')+name+((' | '+str(extra)) if (extra!='' and not cond) else ''))

    # bulk add via folder import (fast)
    page.click('#hamburgerBtn'); page.wait_for_timeout(200)
    page.click('#settingsBtn'); page.wait_for_timeout(200)
    page.click('#_setImport'); page.wait_for_timeout(200)
    with page.expect_file_chooser() as fc: page.click('#_impDir')
    fc.value.set_files('/tmp/aud'); page.wait_for_timeout(1200)
    check('3 imported', page.evaluate("state.snippets.length")==3)
    if page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
        page.eval_on_selector('#scrim','e=>e.click()'); page.wait_for_timeout(250)

    # ---- drag reorder in library (custom sort) ----
    order0 = page.eval_on_selector_all('#snippetList .snip-name','e=>e.map(x=>x.textContent)')
    h = page.query_selector_all('#snippetList .snip-handle')
    check('drag handles visible (custom sort)', len(h)==3 and h[0].is_visible(), len(h))
    box = h[0].bounding_box()
    page.mouse.move(box['x']+box['width']/2, box['y']+box['height']/2)
    page.mouse.down()
    page.mouse.move(box['x']+box['width']/2, box['y']+box['height']/2+70, steps=8)
    page.mouse.move(box['x']+box['width']/2, box['y']+box['height']/2+140, steps=8)
    page.mouse.up(); page.wait_for_timeout(400)
    order1 = page.eval_on_selector_all('#snippetList .snip-name','e=>e.map(x=>x.textContent)')
    check('drag reorder changed order', order0!=order1, f"{order0}->{order1}")
    saved = page.evaluate("getLibrary().snippetIds.map(id=>state.byId[id].name)")
    check('reorder persisted to setlist', saved==order1, f"{saved} vs {order1}")
    page.reload(); page.wait_for_timeout(900)
    order2 = page.eval_on_selector_all('#snippetList .snip-name','e=>e.map(x=>x.textContent)')
    check('reorder survives reload', order2==order1, order2)

    # ---- shuffle ----
    page.click('#shuffleBtn'); page.wait_for_timeout(250)
    check('shuffle produced order', page.evaluate("Array.isArray(state.shuffleOrder)"))
    page.select_option('#sortSelect','alpha'); page.wait_for_timeout(200)
    check('shuffle cleared by sort change', page.evaluate("state.shuffleOrder===null"))
    page.select_option('#sortSelect','custom'); page.wait_for_timeout(200)

    # ---- open snippet: waveform seek by tap ----
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(900)
    check('waveform peaks computed', page.evaluate("!!player.peaks && player.peaks.length>100"))
    ws = page.query_selector('#waveStage').bounding_box()
    page.mouse.click(ws['x']+ws['width']*0.75, ws['y']+ws['height']*0.5)
    page.wait_for_timeout(250)
    frac = page.evaluate("audioEl.currentTime/audioEl.duration")
    check('tap waveform seeks ~75%', 0.65<frac<0.85, frac)

    # ---- loop handle drag ----
    page.evaluate("audioEl.currentTime=0.4"); page.click('#setInBtn')
    page.evaluate("audioEl.currentTime=1.6"); page.click('#setOutBtn'); page.wait_for_timeout(150)
    hin = page.query_selector('#loopHandleIn').bounding_box()
    page.mouse.move(hin['x']+hin['width']/2, hin['y']+hin['height']/2)
    page.mouse.down(); page.mouse.move(hin['x']+hin['width']/2+40, hin['y']+hin['height']/2, steps=6); page.mouse.up()
    page.wait_for_timeout(200)
    li2 = page.evaluate("player.loopIn")
    check('loop-in handle draggable', li2>0.45, li2)
    page.click('#clearLoopBtn')

    # ---- marker add / edit / delete ----
    page.evaluate("audioEl.currentTime=1.0")
    page.click('#addMarkerBtn'); page.wait_for_timeout(200)
    page.fill('#mkNote','chorus'); page.click('#modal >> text=Add'); page.wait_for_timeout(250)
    page.click('#markerList .mk-edit'); page.wait_for_timeout(250)
    page.fill('#mkNote','chorus v2'); page.click('#modal >> text=Save'); page.wait_for_timeout(250)
    check('marker edited', page.evaluate("state.byId[state.current].markers[0].note")=='chorus v2')
    page.click('#markerList .mk-edit'); page.wait_for_timeout(250)
    page.click('#modal >> text=Delete'); page.wait_for_timeout(300)
    check('marker deleted', page.evaluate("state.byId[state.current].markers.length")==0)
    check('marker list empty', page.eval_on_selector_all('#markerList .mk-row','e=>e.length')==0)

    # ---- edit snippet name & tags persists ----
    page.click('#svMenuBtn'); page.wait_for_timeout(200)
    page.click('#_edit'); page.wait_for_timeout(250)
    page.fill('#snName','Renamed Song')
    page.fill('#tagInput','live')
    page.click('#modal >> text=Save'); page.wait_for_timeout(300)
    check('rename applied in view', page.inner_text('#svName')=='Renamed Song', page.inner_text('#svName'))
    check('tag added via pending text', page.evaluate("state.byId[state.current].tags.includes('live')"))

    # ---- delete snippet removes from setlists ----
    sid = page.evaluate("state.current")
    page.evaluate("""(async()=>{ const sl={id:'tsl',name:'T',snippetIds:[state.current]}; state.setlists.push(sl); await DB.put('setlists',sl); renderDrawer(); })()""")
    page.wait_for_timeout(200)
    page.click('#svMenuBtn'); page.wait_for_timeout(200)
    page.click('#_del'); page.wait_for_timeout(250)
    page.click('#_ok'); page.wait_for_timeout(400)
    check('snippet deleted', page.evaluate(f"!state.byId['{sid}']"))
    check('deleted id purged from setlists', page.evaluate(f"state.setlists.every(sl=>!sl.snippetIds.includes('{sid}'))"))
    check('view closed after delete', not page.eval_on_selector('#snippetView','e=>e.classList.contains("show")'))
    check('library count 2', page.eval_on_selector_all('#snippetList .snip-row','e=>e.length')==2)

    # ---- delete setlist keeps snippets ----
    n_before = page.evaluate("state.snippets.length")
    page.click('#hamburgerBtn'); page.wait_for_timeout(250)
    page.eval_on_selector_all('#userSetlists .setlist-row .mini','els=>els[els.length-1].click()'); page.wait_for_timeout(300)
    page.click('#_del'); page.wait_for_timeout(250)
    page.click('#_ok'); page.wait_for_timeout(350)
    check('setlist deleted, snippets kept', page.evaluate("state.snippets.length")==n_before and page.evaluate("!state.setlists.some(s=>s.id==='tsl')"))

    # ---- sort by rating / last played don't crash with no data ----
    if page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
        page.eval_on_selector('#scrim','e=>e.click()'); page.wait_for_timeout(200)
    page.select_option('#sortSelect','rating'); page.wait_for_timeout(200)
    page.select_option('#sortSelect','played'); page.wait_for_timeout(200)
    check('rating/played sorts render', page.eval_on_selector_all('#snippetList .snip-row','e=>e.length')==2)
    hidden = page.eval_on_selector('#snippetList .snip-handle','e=>getComputedStyle(e).display')
    check('drag handles hidden in non-custom sort', hidden=='none', hidden)
    page.select_option('#sortSelect','custom'); page.wait_for_timeout(150)

    # ---- metronome deep test ----
    page.click('#metroBtn'); page.wait_for_timeout(250)
    page.eval_on_selector('#bpmSlider',"e=>{e.value='180';e.dispatchEvent(new Event('input'))}")
    check('bpm label updates', page.inner_text('#bpmVal')=='180')
    subs = page.eval_on_selector_all('.subdiv-row .btn, .subdiv-row button','e=>e.length')
    check('subdivision buttons present', subs>=4, subs)
    page.eval_on_selector_all('.subdiv-row button','e=>e[2].click()'); page.wait_for_timeout(100)
    page.click('#metroStartBtn'); page.wait_for_timeout(1200)
    lit = page.evaluate("[...document.querySelectorAll('.beat-dot')].some(d=>d.classList.contains('on'))")
    check('beat light animates', lit)
    # ramp: bpm should move from 100 toward 160
    page.click('#rampToggleRow'); page.wait_for_timeout(100)
    page.click('#metroStartBtn'); page.wait_for_timeout(150)  # stop
    page.click('#metroStartBtn'); page.wait_for_timeout(200)  # start with ramp
    b0 = page.evaluate("currentBpm()")
    page.wait_for_timeout(2000)
    b1 = page.evaluate("currentBpm()")
    check('ramp bpm increases over time', b1>b0+0.5, f"{b0}->{b1}")
    page.click('#metroStartBtn')
    # tap tempo
    for _ in range(4):
        page.click('#tapTempoBtn'); page.wait_for_timeout(500)
    bpm = page.evaluate("metro.bpm")
    check('tap tempo ~120', 105<=bpm<=135, bpm)
    check('tap disables ramp visually', not page.eval_on_selector('#rampToggleRow','e=>e.classList.contains("on")'))
    page.click('#metroBtn')  # close

    # ---- tuner refHz steppers ----
    page.click('#tunerBtn'); page.wait_for_timeout(200)
    page.click('#refUp'); page.click('#refUp')
    check('refHz stepper', page.input_value('#refHz')=='442')
    page.click('#refDown')
    check('refHz stepper down', page.input_value('#refHz')=='441')
    page.click('#tunerBtn')

    # ---- card collapse toggles ----
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(700)
    was = page.eval_on_selector('#notesCard','e=>e.classList.contains("collapsed")')
    page.click('#notesCard .card-head'); page.wait_for_timeout(150)
    check('notes card toggles', page.eval_on_selector('#notesCard','e=>e.classList.contains("collapsed")')!=was)

    # ---- mini bar controls ----
    page.click('#svCollapseBtn'); page.wait_for_timeout(350)
    page.click('#miniPlay'); page.wait_for_timeout(400)
    check('mini play works', not page.evaluate("audioEl.paused"))
    page.click('#miniPlay')
    nm_a = page.evaluate("state.byId[state.current].name")
    page.click('#miniNext'); page.wait_for_timeout(500)
    check('mini next navigates', page.evaluate("state.byId[state.current].name")!=nm_a)
    check('stays mini after nav', page.eval_on_selector('#snippetView','e=>e.classList.contains("mini")'))

    # ---- empty states ----
    page.click('#hamburgerBtn'); page.wait_for_timeout(200)
    page.click('#newSetlistBtn'); page.wait_for_timeout(200)
    page.fill('#slName','Empty'); page.click('#modal >> text=Create'); page.wait_for_timeout(300)
    page.click('#_prn'); page.wait_for_timeout(300)
    check('print empty setlist -> toast, no crash', 'empty' in page.inner_text('#toast').lower(), page.inner_text('#toast'))
    page.click('#modal >> text=Save'); page.wait_for_timeout(250)
    page.click('#userSetlists >> text=Empty'); page.wait_for_timeout(300)
    check('empty setlist view shows empty state', page.eval_on_selector_all('#snippetList .snip-row','e=>e.length')==0)
    check('no crash on empty view', page.is_visible('#libraryView'))

    # ---- scrim click closes modal ----
    page.click('#fab'); page.wait_for_timeout(200)
    page.mouse.click(10,300); page.wait_for_timeout(250)
    check('scrim click closes modal', not page.eval_on_selector('#modalScrim','e=>e.classList.contains("show")'))

    print("\n--- ERRORS ---")
    for e in errors: print(e)
    if not errors: print("(none)")
    browser.close()
