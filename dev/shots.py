import servshim, math, struct, wave, os, shutil, sys
from playwright.sync_api import sync_playwright
shutil.rmtree('/tmp/aud', ignore_errors=True); os.makedirs('/tmp/aud')
def make_wav(path, freq=220, secs=2.0, sr=22050):
    n=int(secs*sr)
    with wave.open(path,'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(11000*(math.sin(2*math.pi*freq*i/sr)+0.4*math.sin(2*math.pi*freq*2.03*i/sr)*math.sin(2*math.pi*1.7*i/sr)))) for i in range(n)))
for nm,f in [('Thunder Road',196),('Back In Black',220),('Whole Lotta Love',247)]:
    make_wav(f'/tmp/aud/{nm}.wav', f)

out = sys.argv[1] if len(sys.argv)>1 else '/tmp/shots'
shutil.rmtree(out, ignore_errors=True); os.makedirs(out)

with sync_playwright() as p:
    browser=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    page=browser.new_context(viewport={'width':412,'height':892}, has_touch=True, permissions=['microphone'], device_scale_factor=2).new_page()
    page.goto('http://localhost:8901/index.html'); page.wait_for_timeout(900)
    # import songs
    page.click('#hamburgerBtn'); page.wait_for_timeout(250)
    page.screenshot(path=f'{out}/02-drawer.png')
    page.click('#settingsBtn'); page.wait_for_timeout(250)
    page.screenshot(path=f'{out}/03-settings.png')
    page.click('#_setImport'); page.wait_for_timeout(200)
    with page.expect_file_chooser() as fc: page.click('#_impDir')
    fc.value.set_files('/tmp/aud'); page.wait_for_timeout(1200)
    if page.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
        page.eval_on_selector('#scrim','e=>e.click()'); page.wait_for_timeout(300)
    # add tags + rating to first
    page.evaluate("""(async()=>{ const s=state.snippets[0]; s.tags=['rock','set A']; s.ratings=[{id:'r1',score:4,note:'good',timestamp:Date.now()-86400000}]; s.lastPlayed=Date.now()-3600e3; await DB.put('snippets',s);
      const t=state.snippets[1]; t.tags=['blues']; await DB.put('snippets',t); renderTagFilter(); renderLibrary(); })()""")
    page.wait_for_timeout(400)
    page.screenshot(path=f'{out}/01-library.png')
    # snippet view
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(1000)
    page.evaluate("audioEl.currentTime=0.7")
    page.click('#addMarkerBtn'); page.wait_for_timeout(200)
    page.fill('#mkNote','Chorus'); page.click('#modal >> text=Add'); page.wait_for_timeout(250)
    page.evaluate("audioEl.currentTime=0.3"); page.click('#setInBtn')
    page.evaluate("audioEl.currentTime=1.5"); page.click('#setOutBtn'); page.wait_for_timeout(200)
    page.screenshot(path=f'{out}/04-snippet-top.png')
    page.eval_on_selector('#snippetView .sv-scroll, #snippetView','e=>e.scrollTo(0,9999)')
    page.wait_for_timeout(300)
    page.screenshot(path=f'{out}/05-snippet-bottom.png')
    # mini
    page.click('#svCollapseBtn'); page.wait_for_timeout(450)
    page.screenshot(path=f'{out}/06-mini.png')
    page.click('#svExpandBtn'); page.wait_for_timeout(400)
    # tools
    page.go_back(); page.wait_for_timeout(300)
    page.click('#tunerBtn'); page.wait_for_timeout(300)
    page.screenshot(path=f'{out}/07-tuner.png')
    page.click('#metroBtn'); page.wait_for_timeout(300)
    page.screenshot(path=f'{out}/08-metro.png')
    page.click('#metroBtn'); page.wait_for_timeout(200)
    # light theme library
    page.click('#themeBtn'); page.wait_for_timeout(400)
    page.screenshot(path=f'{out}/09-library-light.png')
    page.click('#snippetList .snip-row >> nth=0'); page.wait_for_timeout(900)
    page.screenshot(path=f'{out}/10-snippet-light.png')
    browser.close()
print("shots in", out)
