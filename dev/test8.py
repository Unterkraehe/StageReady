import servshim, math, struct, wave, os, shutil
from playwright.sync_api import sync_playwright
shutil.rmtree('/tmp/aud', ignore_errors=True); os.makedirs('/tmp/aud')
sr=22050; n=int(8.0*sr)
with wave.open('/tmp/aud/Loop Song.wav','w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(b''.join(struct.pack('<h', int(11000*math.sin(2*math.pi*220*i/sr))) for i in range(n)))

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
    fc.value.set_files('/tmp/aud'); page.wait_for_timeout(1000)
    if page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
        page.eval_on_selector('#scrim','e=>e.click()'); page.wait_for_timeout(250)
    page.click('#snippetList .snip-row'); page.wait_for_timeout(1000)

    # ---- 1. Set In only: no phantom out, not armed, preview handle ----
    page.evaluate("audioEl.currentTime=1.0")
    page.click('#setInBtn'); page.wait_for_timeout(150)
    st = page.evaluate("({i:player.loopIn, o:player.loopOut, on:player.loopOn})")
    check('Set In sets ONLY in', abs(st['i']-1.0)<0.05 and st['o'] is None, st)
    check('not armed with single point', st['on']==False)
    check('in-handle preview shown', page.eval_on_selector('#loopHandleIn','e=>e.style.display')=='block' and page.eval_on_selector('#loopHandleOut','e=>e.style.display')=='none')
    check('ramp row hidden (no region)', page.eval_on_selector('#loopRampRow','e=>getComputedStyle(e).display')=='none')

    # ---- 1b. Set In button reflects state ----
    check('Set In button shows time + set class', page.eval_on_selector('#setInBtn','e=>e.classList.contains("set")&&e.textContent.startsWith("In 0:01")'), page.eval_on_selector('#setInBtn','e=>e.textContent'))
    check('Set Out button still unset', page.eval_on_selector('#setOutBtn','e=>!e.classList.contains("set")&&e.textContent==="Set Out"'))

    # ---- 2. paused seek far past old phantom (+5s) — no yank ----
    page.evaluate("audioEl.currentTime=7.0"); page.wait_for_timeout(300)
    check('paused seek beyond in+5 stays put', abs(page.evaluate("audioEl.currentTime")-7.0)<0.05, page.evaluate("audioEl.currentTime"))

    # ---- 3. Set Out completes region: auto-armed, ramp visible, styling ----
    page.evaluate("audioEl.currentTime=3.0")
    page.click('#setOutBtn'); page.wait_for_timeout(200)
    st = page.evaluate("({i:player.loopIn, o:player.loopOut, on:player.loopOn})")
    check('region 1.0→3.0 armed automatically', abs(st['i']-1.0)<0.05 and abs(st['o']-3.0)<0.05 and st['on'], st)
    check('ramp row visible with region', page.eval_on_selector('#loopRampRow','e=>getComputedStyle(e).display')=='flex')
    check('Set Out button shows time + set class', page.eval_on_selector('#setOutBtn','e=>e.classList.contains("set")&&e.textContent.startsWith("Out 0:03")'), page.eval_on_selector('#setOutBtn','e=>e.textContent'))
    check('region highlighted while loop ON', page.eval_on_selector('#loopRegion','e=>e.classList.contains("on")&&getComputedStyle(e).display==="block"'))
    btn = page.evaluate("""()=>{const b=document.querySelector('#loopToggleBtn');const cs=getComputedStyle(b);
      return {txt:b.textContent, ghost:b.classList.contains('ghost'), bgImg:cs.backgroundImage!=='none', bgCol:cs.backgroundColor};}""")
    check('Loop:On shows accent gradient (not white/transparent)', btn['txt']=='Loop: On' and not btn['ghost'] and btn['bgImg'], btn)
    # tap it twice (off/on) and re-check no white sticky state
    page.click('#loopToggleBtn'); page.wait_for_timeout(150)
    st_off = page.evaluate("""()=>({regionOn:document.querySelector('#loopRegion').classList.contains('on'),
      hIn:document.querySelector('#loopHandleIn').style.display, hOut:document.querySelector('#loopHandleOut').style.display,
      hInVisible:getComputedStyle(document.querySelector('#loopHandleIn')).display!=='none'})""")
    check('loop OFF: no region fill, handles remain', (not st_off['regionOn']) and st_off['hIn']=='block' and st_off['hOut']=='block' and st_off['hInVisible'], st_off)
    page.click('#loopToggleBtn'); page.wait_for_timeout(150)
    btn2 = page.evaluate("()=>{const cs=getComputedStyle(document.querySelector('#loopToggleBtn'));return {bgImg:cs.backgroundImage!=='none', bgCol:cs.backgroundColor};}")
    check('gradient survives tapping', btn2['bgImg'] and 'rgb(255, 255, 255)' not in btn2['bgCol'], btn2)

    # ---- 4. natural wrap while playing ----
    page.evaluate("audioEl.currentTime=2.6")
    page.click('#playBtn'); page.wait_for_timeout(1200)
    t = page.evaluate("audioEl.currentTime")
    check('playback wrapped back inside region', 0.9<=t<=3.1 and t<2.6+1.2, t)

    # ---- 5. playing seek beyond out: NO yank, plays on outside ----
    page.evaluate("audioEl.currentTime=5.0"); page.wait_for_timeout(700)
    t = page.evaluate("audioEl.currentTime")
    check('playing seek past out stays out', t>=5.0, t)
    # ---- 6. seek back inside → looping resumes ----
    page.evaluate("audioEl.currentTime=2.7"); page.wait_for_timeout(1000)
    t = page.evaluate("audioEl.currentTime")
    check('looping resumes after re-entering', 0.9<=t<=3.1, t)
    page.click('#playBtn')  # pause

    # ---- 7. reversed entry: Out first at 0.5, In later at 1.5 → swapped ----
    page.click('#clearLoopBtn'); page.wait_for_timeout(100)
    check('clear resets + hides ramp', page.evaluate("player.loopIn===null&&player.loopOut===null&&!player.loopOn") and page.eval_on_selector('#loopRampRow','e=>getComputedStyle(e).display')=='none')
    page.evaluate("audioEl.currentTime=1.5"); page.click('#setOutBtn'); page.wait_for_timeout(100)
    check('out-only preview handle', page.eval_on_selector('#loopHandleOut','e=>e.style.display')=='block' and page.eval_on_selector('#loopHandleIn','e=>e.style.display')=='none')
    page.evaluate("audioEl.currentTime=2.5"); page.click('#setInBtn'); page.wait_for_timeout(150)
    st = page.evaluate("({i:player.loopIn, o:player.loopOut, on:player.loopOn})")
    check('reversed points swapped & armed', abs(st['i']-1.5)<0.05 and abs(st['o']-2.5)<0.05 and st['on'], st)

    # ---- 8. same-spot guard ----
    page.click('#clearLoopBtn')
    page.evaluate("audioEl.currentTime=2.0"); page.click('#setInBtn')
    page.click('#setOutBtn'); page.wait_for_timeout(200)
    st = page.evaluate("({i:player.loopIn, o:player.loopOut, on:player.loopOn})")
    check('same-spot rejected with toast', st['o'] is None and not st['on'] and 'same' in page.inner_text('#toast').lower(), st)

    # ---- 9. toggle off keeps region; playback passes out; toggle on wraps again ----
    page.evaluate("audioEl.currentTime=3.0"); page.click('#setOutBtn'); page.wait_for_timeout(100)
    page.click('#loopToggleBtn'); page.wait_for_timeout(100)   # off
    page.evaluate("audioEl.currentTime=2.8")
    page.click('#playBtn'); page.wait_for_timeout(900)
    t = page.evaluate("audioEl.currentTime")
    check('loop off → plays past out', t>3.05, t)
    page.click('#loopToggleBtn'); page.wait_for_timeout(100)   # on (outside region)
    page.evaluate("audioEl.currentTime=2.8"); page.wait_for_timeout(900)
    t = page.evaluate("audioEl.currentTime")
    check('re-armed → wraps again', 1.9<=t<=3.1, t)
    page.click('#playBtn')

    # ---- 9b. Play from outside armed loop snaps to loop start ----
    page.evaluate("audioEl.currentTime=6.5"); page.wait_for_timeout(150)
    page.click('#playBtn'); page.wait_for_timeout(500)
    t = page.evaluate("audioEl.currentTime")
    check('play from outside snaps into loop', 1.9<=t<=3.1, t)
    page.click('#playBtn'); page.wait_for_timeout(150)

    # ---- 10. ramp integrates: only with region, increments on wraps ----
    r0 = page.eval_on_selector('#loopRampVal','e=>e.textContent')
    page.click('#loopRampUp'); page.wait_for_timeout(100)
    check('ramp adjustable', page.eval_on_selector('#loopRampVal','e=>e.textContent')=='+0.01x', r0)
    page.evaluate("audioEl.currentTime=2.7")
    page.click('#playBtn'); page.wait_for_timeout(1500)
    page.click('#playBtn')
    check('ramp raised speed on wrap', page.evaluate("audioEl.playbackRate")>1.0, page.evaluate("audioEl.playbackRate"))

    print("\n--- ERRORS ---")
    for e in errors: print(e)
    if not errors: print("(none)")
    browser.close()
