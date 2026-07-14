import servshim, math, struct, wave, os, shutil
from playwright.sync_api import sync_playwright
shutil.rmtree('/tmp/aud', ignore_errors=True); os.makedirs('/tmp/aud')
def make_wav(path, freq=220, secs=3.0, amp=12000):
    sr=22050; n=int(secs*sr)
    with wave.open(path,'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(amp*math.sin(2*math.pi*freq*i/sr))) for i in range(n)))
make_wav('/tmp/aud/Loud Song.wav', 220, 3.0, 24000)
make_wav('/tmp/aud/Quiet Song.wav', 330, 3.0, 3000)

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

    # tag the loud song for print tests
    page.evaluate("""(async()=>{ const s=state.snippets.find(x=>x.name==='Loud Song'); s.tags=['rock','opener']; s.notes='hit hard'; await DB.put('snippets',s); renderTagFilter(); renderLibrary(); })()""")
    page.wait_for_timeout(300)

    # ============ 1) MARKER TIME EDIT ============
    page.click('#snippetList >> text=Loud Song'); page.wait_for_timeout(900)
    page.evaluate("audioEl.currentTime=0.5")
    page.click('#addMarkerBtn'); page.wait_for_timeout(200)
    page.fill('#mkNote','v1'); page.click('#_ok'); page.wait_for_timeout(250)
    page.click('#markerList .mk-edit'); page.wait_for_timeout(250)
    check('time field editable', not page.eval_on_selector('#mkTime','e=>e.readOnly'))
    page.fill('#mkTime','0:02'); page.click('#_ok'); page.wait_for_timeout(300)
    mt = page.evaluate("state.byId[state.current].markers[0].time")
    check('marker time updated to 2s', abs(mt-2.0)<0.01, mt)
    page.click('#markerList .mk-edit'); page.wait_for_timeout(200)
    page.fill('#mkTime','abc'); page.click('#_ok'); page.wait_for_timeout(200)
    check('invalid time rejected (modal stays)', page.eval_on_selector('#modalScrim','e=>e.classList.contains("show")'))
    page.fill('#mkTime','1.25'); page.click('#_ok'); page.wait_for_timeout(250)
    check('plain seconds accepted', abs(page.evaluate("state.byId[state.current].markers[0].time")-1.25)<0.01)

    # ============ 3) LOUDNESS + VOLUME ============
    page.wait_for_timeout(400)
    loudL = page.evaluate("state.byId[state.current].loudness")
    check('loudness measured & stored', isinstance(loudL,(int,float)) and -40<loudL<0, loudL)
    check('audio graph built', page.evaluate("graph.built===true"))
    g_loud = page.evaluate("graph.gain.gain.value")
    page.click('#volUp'); page.click('#volUp'); page.wait_for_timeout(500)
    check('vol label +2 dB', page.eval_on_selector('#volVal','e=>e.textContent')=='+2 dB')
    check('vol persisted', page.evaluate("state.byId[state.current].gain")==2)
    g2 = page.evaluate("graph.gain.gain.value")
    check('gain node increased ~+2dB', g2>g_loud*1.18 and g2<g_loud*1.35, f"{g_loud}->{g2}")
    # open quiet song: auto-loudness should give it MORE gain than loud song (at trim 0)
    page.click('#volDown'); page.click('#volDown'); page.wait_for_timeout(400)
    g_loud0 = page.evaluate("graph.gain.gain.value")
    page.click('#nextBtn') if page.evaluate("state.navList.indexOf(state.current)")==0 else page.click('#prevBtn')
    page.wait_for_timeout(1200)
    check('now on quiet song', page.evaluate("state.byId[state.current].name")=='Quiet Song')
    g_quiet = page.evaluate("graph.gain.gain.value")
    check('quiet song boosted above loud song', g_quiet>g_loud0*1.5, f"loud={g_loud0:.3f} quiet={g_quiet:.3f}")
    # settings toggle off → gains equalize toward manual-only
    page.evaluate("state.autoLoud=false; applyVolume()"); page.wait_for_timeout(400)
    g_off = page.evaluate("graph.gain.gain.value")
    check('auto-loud off → unity-ish gain', 0.9<g_off<1.1, g_off)
    page.evaluate("state.autoLoud=true; applyVolume()")

    # ============ 4) LOOP RAMP ============
    page.evaluate("audioEl.currentTime=0.2"); page.click('#setInBtn')
    page.evaluate("audioEl.currentTime=1.0"); page.click('#setOutBtn'); page.wait_for_timeout(150)
    page.evaluate("audioEl.currentTime=0.3")               # start inside the region
    page.click('#loopRampUp'); page.click('#loopRampUp')   # +0.02x/loop
    check('ramp label', page.eval_on_selector('#loopRampVal','e=>e.textContent')=='+0.02x')
    page.click('#playBtn'); page.wait_for_timeout(2600)     # ~3 wraps at 0.8s loop
    page.click('#playBtn')
    sp = page.evaluate("audioEl.playbackRate")
    check('speed ramped up over loops', sp>=1.04, sp)
    check('speed label matches', page.eval_on_selector('#speedVal','e=>e.textContent')==f"{sp:.2f}x", page.eval_on_selector('#speedVal','e=>e.textContent'))
    page.click('#clearLoopBtn')

    # ============ 5) PITCH V2 ============
    page.click('#pitchUp'); page.click('#pitchUp'); page.wait_for_timeout(700)
    check('pitch worklet v2 active', page.evaluate("pitch.kind")=='worklet')
    page.click('#playBtn'); page.wait_for_timeout(600)
    t1=page.evaluate("audioEl.currentTime"); page.wait_for_timeout(400)
    check('plays with pitch v2', page.evaluate("audioEl.currentTime")>t1)
    page.click('#playBtn'); page.click('#pitchDown'); page.click('#pitchDown')
    page.go_back(); page.wait_for_timeout(300); page.click('#miniClose'); page.wait_for_timeout(300)

    # ============ 2) SETLIST DRAG REORDER ============
    def open_drawer():
        if not page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
            page.click('#hamburgerBtn'); page.wait_for_timeout(250)
    for nm in ('Alpha','Bravo','Charlie'):
        open_drawer()
        page.click('#newSetlistBtn'); page.wait_for_timeout(200)
        page.fill('#slName',nm); page.click('#modal >> text=Create'); page.wait_for_timeout(250)
        page.click('#_save'); page.wait_for_timeout(250)
    open_drawer()
    names0 = page.eval_on_selector_all('#userSetlists .setlist-row .nm','e=>e.map(x=>x.textContent)')
    h = page.query_selector('#userSetlists .setlist-row [data-slhandle]')
    box = h.bounding_box()
    page.mouse.move(box['x']+8, box['y']+8); page.mouse.down()
    page.mouse.move(box['x']+8, box['y']+60, steps=6)
    page.mouse.move(box['x']+8, box['y']+120, steps=6)
    page.mouse.up(); page.wait_for_timeout(400)
    names1 = page.eval_on_selector_all('#userSetlists .setlist-row .nm','e=>e.map(x=>x.textContent)')
    check('setlist drag changed order', names0!=names1, f"{names0}->{names1}")
    page.reload(); page.wait_for_timeout(1000)
    page.click('#hamburgerBtn'); page.wait_for_timeout(300)
    names2 = page.eval_on_selector_all('#userSetlists .setlist-row .nm','e=>e.map(x=>x.textContent)')
    check('setlist order survives reload', names2==names1, names2)

    # ============ 6) PRINT V2 ============
    # build a setlist with both songs
    open_drawer()
    page.click('#newSetlistBtn'); page.wait_for_timeout(200)
    page.fill('#slName','Show'); page.click('#modal >> text=Create'); page.wait_for_timeout(250)
    page.eval_on_selector_all('#slChecklist .check-row','els=>{els.forEach(e=>e.click())}'); page.wait_for_timeout(150)
    page.click('#_save'); page.wait_for_timeout(300)
    page.eval_on_selector_all('#userSetlists .setlist-row','els=>{const r=els.find(x=>x.textContent.includes("Show"));r.querySelector("[data-edit]").click()}')
    page.wait_for_timeout(300)
    page.click('#_prn'); page.wait_for_timeout(350)
    check('print dialog: tag rows present', page.eval_on_selector_all('.prt-tag','e=>e.length')==2)
    # heading off
    page.click('#_pHead'); page.wait_for_timeout(100)
    # disable tag 'opener'
    page.eval_on_selector_all('.prt-tag','els=>{const r=els.find(x=>x.dataset.tag==="opener");r.querySelector("[data-tagtoggle]").click()}')
    # set rock color
    page.eval_on_selector_all('.prt-tag','els=>{const r=els.find(x=>x.dataset.tag==="rock");const c=r.querySelector("[data-tagcolor]");c.value="#1f6fe8";c.dispatchEvent(new Event("input",{bubbles:true}))}')
    # add a gap note before song 2
    page.eval_on_selector('[data-addnote="1"]','e=>e.click()'); page.wait_for_timeout(200)
    page.eval_on_selector('.prt-gap [data-gaptext]','e=>{e.value="BREAK — 10 min";e.dispatchEvent(new Event("input",{bubbles:true}))}')
    page.eval_on_selector('.prt-gap [data-gapcolor]','e=>{e.value="#0f9d58";e.dispatchEvent(new Event("input",{bubbles:true}))}')
    # page break before song 2
    page.eval_on_selector('[data-break="1"]','e=>e.click()'); page.wait_for_timeout(150)
    check('break toggled on', page.eval_on_selector('[data-break="1"]','e=>e.classList.contains("on")'))
    # auto mode is default; print
    page.click('#_pGo'); page.wait_for_timeout(1200)
    r = page.evaluate("""()=>{
      const d=document.querySelector('iframe').contentDocument;
      const pages=[...d.querySelectorAll('.page')];
      return {
        pages: pages.length,
        heading: !!d.querySelector('.pr-head'),
        songs: d.querySelectorAll('.song').length,
        gapText: d.querySelector('.gap')? d.querySelector('.gap').textContent : null,
        gapColor: d.querySelector('.gap')? d.querySelector('.gap').style.getPropertyValue('--gc') : null,
        tags: [...d.querySelectorAll('.tag')].map(t=>t.textContent),
        tagColor: d.querySelector('.tag')? d.querySelector('.tag').style.getPropertyValue('--tc') : null,
        scales: pages.map(p=>parseFloat(p.style.getPropertyValue('--s'))),
        overflow: pages.some(p=>p.querySelector('.inner').scrollHeight > p.clientHeight+2)
      };
    }""")
    check('2 pages from break', r['pages']==2, r)
    check('heading omitted', not r['heading'])
    check('gap note printed on page 2', r['gapText']=='BREAK — 10 min')
    check('gap color applied', r['gapColor']=='#0f9d58', r['gapColor'])
    check('disabled tag filtered out', r['tags']==['rock'], r['tags'])
    check('tag color applied', r['tagColor']=='#1f6fe8', r['tagColor'])
    check('auto-fit scaled up (short pages)', all(s>1.2 for s in r['scales']), r['scales'])
    check('no page overflow', not r['overflow'])
    # config persisted?
    cfg = page.evaluate("getSetlist(state.setlists.find(s=>s.name==='Show').id).print")
    check('print config persisted', cfg and cfg['heading']==False and 1 in cfg['breaks'] and len(cfg['gaps'])==1)

    print("\n--- ERRORS ---")
    for e in errors: print(e)
    if not errors: print("(none)")
    browser.close()
