import servshim, math, struct, wave, os, shutil
from playwright.sync_api import sync_playwright
shutil.rmtree('/tmp/aud', ignore_errors=True); os.makedirs('/tmp/aud')
def make_wav(path, secs=8.0):
    sr=22050; n=int(secs*sr)
    with wave.open(path,'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(12000*math.sin(2*math.pi*220*i/sr))) for i in range(n)))
make_wav('/tmp/aud/Long Song.wav')

SWIPE_JS = """(sel, x0,y0, x1,y1, steps) => new Promise(res=>{
  const el=document.querySelector(sel)||document.elementFromPoint(x0,y0);
  const target=document.elementFromPoint(x0,y0)||el;
  const mk=(type,x,y)=>{
    const touch=new Touch({identifier:1,target,clientX:x,clientY:y,pageX:x,pageY:y});
    return new TouchEvent(type,{touches:type==='touchend'?[]:[touch],targetTouches:type==='touchend'?[]:[touch],changedTouches:[touch],bubbles:true,cancelable:true});
  };
  target.dispatchEvent(mk('touchstart',x0,y0));
  let i=0;
  const step=()=>{
    i++;
    const x=x0+(x1-x0)*i/steps, y=y0+(y1-y0)*i/steps;
    target.dispatchEvent(mk('touchmove',x,y));
    if(i<steps) setTimeout(step,16);
    else { target.dispatchEvent(mk('touchend',x1,y1)); setTimeout(res,50); }
  };
  setTimeout(step,16);
})"""

with sync_playwright() as p:
    browser=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    page=browser.new_context(viewport={'width':412,'height':892}, has_touch=True).new_page()
    errors=[]
    page.on('console', lambda m: errors.append(m.text) if m.type=='error' and '403' not in m.text else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:8901/index.html'); page.wait_for_timeout(900)
    def check(name,cond,extra=''):
        print(('PASS ' if cond else 'FAIL ')+name+((' | '+str(extra)) if (extra!='' and not cond) else ''))
    def swipe(sel,x0,y0,x1,y1,steps=8):
        page.evaluate(SWIPE_JS, [sel,x0,y0,x1,y1,steps])
        page.wait_for_timeout(250)
    # ugly but needed: evaluate takes one arg
    def swipe(sel,x0,y0,x1,y1,steps=8):
        page.evaluate(f"({SWIPE_JS})({sel!r},{x0},{y0},{x1},{y1},{steps})")
        page.wait_for_timeout(250)

    # setup: import one snippet
    page.click('#hamburgerBtn'); page.wait_for_timeout(200)
    page.click('#settingsBtn'); page.wait_for_timeout(200)
    page.click('#_setImport'); page.wait_for_timeout(200)
    with page.expect_file_chooser() as fc: page.click('#_impDir')
    fc.value.set_files('/tmp/aud'); page.wait_for_timeout(1000)
    if page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
        page.eval_on_selector('#scrim','e=>e.click()'); page.wait_for_timeout(250)

    # ---- mini-play visuals ----
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(800)
    page.click('#svCollapseBtn'); page.wait_for_timeout(400)
    geom = page.evaluate("""()=>{
      const b=document.querySelector('#miniPlay').getBoundingClientRect();
      const s=document.querySelector('#miniPlay svg').getBoundingClientRect();
      return { dx:(s.left+s.width/2)-(b.left+b.width/2), dy:(s.top+s.height/2)-(b.top+b.height/2) };
    }""")
    check('mini-play icon centered', abs(geom['dx'])<2 and abs(geom['dy'])<2, geom)
    bg = page.eval_on_selector('#miniPlay','e=>getComputedStyle(e).backgroundImage')
    check('mini-play keeps gradient', 'gradient' in bg, bg[:60])

    # ---- back minimizes (full → mini), mini not a layer ----
    page.click('#svExpandBtn'); page.wait_for_timeout(350)
    check('expanded (full view)', not page.eval_on_selector('#snippetView','e=>e.classList.contains("mini")'))
    d1 = page.evaluate("_pushedDepth")
    page.go_back(); page.wait_for_timeout(400)
    check('back → minimized, not closed', page.eval_on_selector('#snippetView','e=>e.classList.contains("show")&&e.classList.contains("mini")'))
    check('depth 1→0 after minimize', d1==1 and page.evaluate("_pushedDepth")==0, f"{d1}->{page.evaluate('_pushedDepth')}")
    check('app alive with mini + at root', page.evaluate("typeof state!=='undefined'"))
    # collapse via button also releases entry
    page.click('#svExpandBtn'); page.wait_for_timeout(300)
    check('expand pushes layer', page.evaluate("_pushedDepth")==1)
    page.click('#svCollapseBtn'); page.wait_for_timeout(400)
    check('collapse button releases layer', page.evaluate("_pushedDepth")==0)

    # ---- swipe: pull down at top minimizes ----
    page.click('#svExpandBtn'); page.wait_for_timeout(350)
    swipe('#snippetView', 200, 500, 200, 680, 10)   # down 180px on card area
    check('pull-down at top minimizes', page.eval_on_selector('#snippetView','e=>e.classList.contains("mini")'))
    # scrolled: must NOT minimize (inject filler so the view really scrolls)
    page.click('#svExpandBtn'); page.wait_for_timeout(300)
    page.eval_on_selector('.sv-scroll','e=>{const f=document.createElement("div");f.id="_fill";f.style.height="1500px";e.appendChild(f);e.scrollTop=300;}')
    page.wait_for_timeout(100)
    st = page.eval_on_selector('.sv-scroll','e=>e.scrollTop')
    swipe('#snippetView', 200, 500, 200, 680, 10)
    check('pull-down while scrolled does nothing', st>0 and not page.eval_on_selector('#snippetView','e=>e.classList.contains("mini")'), f"scrollTop={st}")
    page.eval_on_selector('.sv-scroll','e=>{e.scrollTop=0; const f=document.querySelector("#_fill"); if(f)f.remove();}')
    page.wait_for_timeout(100)
    # small pull: no trigger
    swipe('#snippetView', 200, 500, 200, 550, 6)
    check('small pull does not minimize', not page.eval_on_selector('#snippetView','e=>e.classList.contains("mini")'))
    page.click('#svCollapseBtn'); page.wait_for_timeout(300)
    page.click('#miniClose'); page.wait_for_timeout(300)

    # ---- swipe: tool panels close upward ----
    page.click('#tunerBtn'); page.wait_for_timeout(350)
    swipe('#tunerPanel', 200, 300, 200, 180, 8)
    check('tuner swipe-up closes', not page.eval_on_selector('#tunerPanel','e=>e.classList.contains("show")'))
    page.click('#metroBtn'); page.wait_for_timeout(350)
    swipe('#metroPanel', 200, 300, 210, 190, 8)
    check('metro swipe-up closes', not page.eval_on_selector('#metroPanel','e=>e.classList.contains("show")'))
    page.click('#metroBtn'); page.wait_for_timeout(300)
    swipe('#metroPanel', 200, 250, 200, 340, 8)  # wrong direction (down)
    check('metro swipe-down ignored', page.eval_on_selector('#metroPanel','e=>e.classList.contains("show")'))
    page.click('#metroBtn'); page.wait_for_timeout(250)

    # ---- swipe: drawer closes leftward ----
    page.click('#hamburgerBtn'); page.wait_for_timeout(350)
    swipe('#drawer', 250, 400, 120, 405, 10)
    check('drawer swipe-left closes', not page.eval_on_selector('#drawer','e=>e.classList.contains("show")'))
    check('drawer transform reset', page.eval_on_selector('#drawer','e=>e.style.transform')=='')
    page.click('#hamburgerBtn'); page.wait_for_timeout(350)
    swipe('#drawer', 150, 400, 190, 400, 6)  # wrong direction (right)
    check('drawer swipe-right ignored', page.eval_on_selector('#drawer','e=>e.classList.contains("show")'))
    if page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
        page.eval_on_selector('#scrim','e=>e.click()'); page.wait_for_timeout(250)

    # ---- swipe: modal sheet drag-down on header ----
    page.click('#hamburgerBtn'); page.wait_for_timeout(250)
    page.click('#settingsBtn'); page.wait_for_timeout(350)
    hy = page.eval_on_selector('.modal-head','e=>{const r=e.getBoundingClientRect();return Math.round(r.top+r.height/2)}')
    swipe('#modalScrim', 200, hy, 200, hy+150, 10)
    check('settings swipe-down closes', not page.eval_on_selector('#modalScrim','e=>e.classList.contains("show")'))
    check('modal transform reset', page.eval_on_selector('#modal','e=>e.style.transform')=='')
    # drag on body content must NOT close (scroll areas)
    page.click('#settingsBtn'); page.wait_for_timeout(300)
    by = page.eval_on_selector('.modal-body','e=>{const r=e.getBoundingClientRect();return Math.round(r.top+r.height/2)}')
    swipe('#modalScrim', 200, by, 200, by+150, 8)
    check('drag on modal body ignored', page.eval_on_selector('#modalScrim','e=>e.classList.contains("show")'))
    page.click('#_cancel'); page.wait_for_timeout(200)
    if page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
        page.eval_on_selector('#scrim','e=>e.click()'); page.wait_for_timeout(250)

    # ---- history balance after all gestures ----
    check('history balanced after gesture storm', page.evaluate("_pushedDepth===0 && _layerDepth()===0"))

    print("\n--- ERRORS ---")
    for e in errors: print(e)
    if not errors: print("(none)")
    browser.close()
