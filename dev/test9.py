import servshim, math, struct, wave, os, shutil, json
from playwright.sync_api import sync_playwright
shutil.rmtree('/tmp/aud', ignore_errors=True); os.makedirs('/tmp/aud')
def mk(p,f,secs=1.0):
    sr=22050;n=int(secs*sr)
    with wave.open(p,'w') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h',int(9000*math.sin(2*math.pi*f*i/sr))) for i in range(n)))
mk('/tmp/aud/One.wav',220); mk('/tmp/aud/Two.wav',330); mk('/tmp/aud/Three.wav',440)

# Shared mock-Drive store, persisted between "devices" (browser contexts) as JSON on disk.
STORE='/tmp/mockdrive.json'
if os.path.exists(STORE): os.remove(STORE)

def device(ctx_store_init=None):
    """returns (browser factory helpers)"""
    pass

results=[]
def check(name,cond,extra=''):
    results.append(cond)
    print(('PASS ' if cond else 'FAIL ')+name+((' | '+str(extra)) if (extra!='' and not cond) else ''))

with sync_playwright() as p:
    browser=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])

    def new_device(label):
        ctx=browser.new_context(viewport={'width':412,'height':892})
        pg=ctx.new_page()
        pg.on('pageerror', lambda e: print(f"[{label}] PAGEERROR:", e))
        # inject shared mock store BEFORE app scripts run
        store = json.load(open(STORE)) if os.path.exists(STORE) else {"files":{}}
        pg.add_init_script(f"window.__mockDriveStore = {json.dumps(store)};")
        pg.goto('http://localhost:8901/index.html'); pg.wait_for_timeout(700)
        return ctx,pg

    def save_store(pg):
        store=pg.evaluate("window.__mockDriveStore")
        json.dump(store, open(STORE,'w'))

    def sync(pg):
        pg.evaluate("runSync(true)")
        pg.wait_for_function("SYNC.running===false && (SYNC.status==='ok'||SYNC.status==='error')", timeout=15000)
        pg.wait_for_timeout(200)
        return pg.evaluate("SYNC.status")

    def import_dir(pg):
        if not pg.eval_on_selector('#drawer','e=>e.classList.contains("show")'):
            pg.click('#hamburgerBtn'); pg.wait_for_timeout(200)
        pg.click('#settingsBtn'); pg.wait_for_timeout(200)
        pg.click('#_setImport'); pg.wait_for_timeout(200)
        with pg.expect_file_chooser() as fc: pg.click('#_impDir')
        fc.value.set_files('/tmp/aud'); pg.wait_for_timeout(1000)
        # close settings + drawer
        for _ in range(2):
            if pg.eval_on_selector('#modalScrim','e=>e.classList.contains("show")'): pg.eval_on_selector('#_cancel','e=>e.click()'); pg.wait_for_timeout(150)
        if pg.eval_on_selector('#drawer','e=>e.classList.contains("show")'): pg.eval_on_selector('#scrim','e=>e.click()'); pg.wait_for_timeout(200)

    # ================= DEVICE A: import + first sync (upload) =================
    ctxA,A=new_device('A')
    check('mock adapter active', A.evaluate("syncSignedIn()")==True)
    import_dir(A)
    check('A has 3 snippets', A.evaluate("state.snippets.length")==3)
    st=sync(A)
    check('A first sync ok', st=='ok', A.evaluate("SYNC.detail"))
    man=A.evaluate("window.__mockDriveStore.files['manifest.json']? JSON.parse(window.__mockDriveStore.files['manifest.json'].data):null")
    check('manifest uploaded with 3 snippets', man and len(man['snippets'])==3, man and len(man['snippets']))
    audios=A.evaluate("Object.keys(window.__mockDriveStore.files).filter(k=>k.startsWith('au_'))")
    check('3 audio blobs uploaded', len(audios)==3, audios)
    save_store(A)

    # ================= DEVICE B: fresh, pulls everything =================
    ctxB,B=new_device('B')
    check('B starts empty', B.evaluate("state.snippets.length")==0)
    st=sync(B)
    check('B pull sync ok', st=='ok', B.evaluate("SYNC.detail"))
    check('B now has 3 snippets', B.evaluate("state.snippets.length")==3)
    check('B audio blobs present & playable', B.evaluate("state.snippets.every(s=>s.audioFile&&s.audioFile.size>1000)"))
    names=set(B.evaluate("state.snippets.map(s=>s.name)"))
    check('B names match', names=={'One','Two','Three'}, names)
    save_store(B)

    # ================= CONFLICT: both edit same snippet, B later wins =================
    # A renames "One" -> "One-A" at t0; B renames -> "One-B" slightly later
    A.evaluate("""(async()=>{ const s=state.snippets.find(x=>x.name==='One'); s.name='One-A'; await DB.put('snippets',s); })()""")
    A.wait_for_timeout(50)
    sync(A); save_store(A)
    B.wait_for_timeout(60)
    # reload B's store view to include A's change, then B makes a NEWER edit
    B.evaluate("s=>{window.__mockDriveStore=s}", json.load(open(STORE)))
    B.evaluate("""(async()=>{ const s=state.snippets.find(x=>x.id && (x.name==='One'||x.name==='One-A')); s.name='One-B'; await DB.put('snippets',s); })()""")
    st=sync(B); save_store(B)
    check('B newer edit wins on B', B.evaluate("state.snippets.some(s=>s.name==='One-B')") and not B.evaluate("state.snippets.some(s=>s.name==='One-A')"))
    # A syncs and should adopt B's newer value
    A.evaluate("s=>{window.__mockDriveStore=s}", json.load(open(STORE)))
    sync(A); save_store(A)
    check('A adopts newest (One-B)', A.evaluate("state.snippets.some(s=>s.name==='One-B')") and not A.evaluate("state.snippets.some(s=>s.name==='One-A')"), A.evaluate("state.snippets.map(s=>s.name)"))

    # ================= DELETION propagates via tombstone =================
    A.evaluate("""(async()=>{ const s=state.snippets.find(x=>x.name==='Two'); await deleteSnippet(s.id); })()""")
    A.wait_for_timeout(100)
    st=sync(A); save_store(A)
    check('A deleted Two locally', not A.evaluate("state.snippets.some(s=>s.name==='Two')"))
    man=A.evaluate("JSON.parse(window.__mockDriveStore.files['manifest.json'].data)")
    check('manifest carries tombstone', any(t for t in man['tombstones']) and len(man['snippets'])==2, len(man['tombstones']))
    check('deleted audio blob pruned from drive', A.evaluate("Object.keys(window.__mockDriveStore.files).filter(k=>k.startsWith('au_')).length")==2)
    # B still has Two; after sync it should vanish
    B.evaluate("s=>{window.__mockDriveStore=s}", json.load(open(STORE)))
    check('B still has Two pre-sync', B.evaluate("state.snippets.some(s=>s.name==='Two')"))
    st=sync(B); save_store(B)
    check('deletion propagated to B', not B.evaluate("state.snippets.some(s=>s.name==='Two')"), B.evaluate("state.snippets.map(s=>s.name)"))
    check('B down to 2 snippets', B.evaluate("state.snippets.length")==2)

    # ================= NEW snippet on B flows to A =================
    B.evaluate("""(async()=>{ const s={id:uid(),name:'Four',tags:['new'],markers:[],notes:'',ratings:[],recordings:[],pitch:0,gain:0,audioRev:0,audioType:'audio/wav',audioFile:new Blob([new Uint8Array(2048)],{type:'audio/wav'})}; await DB.put('snippets',s); const lib=getLibrary(); lib.snippetIds.push(s.id); await DB.put('setlists',lib); await reloadData(); })()""")
    B.wait_for_timeout(100)
    st=sync(B); save_store(B)
    A.evaluate("s=>{window.__mockDriveStore=s}", json.load(open(STORE)))
    st=sync(A); save_store(A)
    check('new snippet Four reached A', A.evaluate("state.snippets.some(s=>s.name==='Four')"))
    check('Four audio downloaded on A', A.evaluate("(state.snippets.find(s=>s.name==='Four')||{}).audioFile?true:false"))

    # ================= SETLIST sync + order + print cfg =================
    A.evaluate("""(async()=>{ const ids=state.snippets.slice(0,2).map(s=>s.id); const sl={id:uid(),name:'GigX',snippetIds:ids,order:0,print:{heading:false,numbers:true,mode:'auto',tags:{},gaps:[],breaks:[]}}; state.setlists.push(sl); await DB.put('setlists',sl); })()""")
    A.wait_for_timeout(80)
    sync(A); save_store(A)
    B.evaluate("s=>{window.__mockDriveStore=s}", json.load(open(STORE)))
    sync(B); save_store(B)
    check('setlist GigX synced to B', B.evaluate("state.setlists.some(s=>s.name==='GigX')"))
    check('setlist print cfg preserved', B.evaluate("(state.setlists.find(s=>s.name==='GigX')||{}).print? state.setlists.find(s=>s.name==='GigX').print.heading===false : false"))

    # ================= AUDIO REPLACE bumps rev, re-uploads =================
    A.evaluate("""(async()=>{ const s=state.snippets.find(x=>x.name==='Four'); s.audioRev=(s.audioRev||0)+1; s.audioFile=new Blob([new Uint8Array(4096)],{type:'audio/wav'}); delete s.loudness; await DB.put('snippets',s); })()""")
    A.wait_for_timeout(80)
    sync(A); save_store(A)
    check('new audio rev uploaded', A.evaluate("Object.keys(window.__mockDriveStore.files).some(k=>k==='au_'+state.snippets.find(s=>s.name==='Four').id+'_r1')"))
    B.evaluate("s=>{window.__mockDriveStore=s}", json.load(open(STORE)))
    sync(B); save_store(B)
    check('B pulled new audio rev', B.evaluate("(state.snippets.find(s=>s.name==='Four')||{}).audioRev")==1)
    check('B new blob size 4096', B.evaluate("(state.snippets.find(s=>s.name==='Four')||{}).audioFile.size")==4096)
    check('old audio rev pruned from drive', A.evaluate("!Object.keys(window.__mockDriveStore.files).includes('au_'+state.snippets.find(s=>s.name==='Four').id+'_r0')"))

    # ================= IDEMPOTENT: immediate re-sync is a no-op =================
    files_before=A.evaluate("Object.keys(window.__mockDriveStore.files).sort()")
    man_before=A.evaluate("window.__mockDriveStore.files['manifest.json'].data")
    st=sync(A)
    files_after=A.evaluate("Object.keys(window.__mockDriveStore.files).sort()")
    check('re-sync no file churn', files_before==files_after, f"{len(files_before)} vs {len(files_after)}")

    # ================= CONVERGENCE: A and B identical =================
    save_store(A); B.evaluate("s=>{window.__mockDriveStore=s}", json.load(open(STORE))); sync(B); save_store(B)
    A.evaluate("s=>{window.__mockDriveStore=s}", json.load(open(STORE))); sync(A)
    a_names=sorted(A.evaluate("state.snippets.map(s=>s.name)"))
    b_names=sorted(B.evaluate("state.snippets.map(s=>s.name)"))
    check('devices converge (snippets)', a_names==b_names, f"A={a_names} B={b_names}")
    a_sets=sorted(A.evaluate("state.setlists.filter(s=>s.id!=='library').map(s=>s.name)"))
    b_sets=sorted(B.evaluate("state.setlists.filter(s=>s.id!=='library').map(s=>s.name)"))
    check('devices converge (setlists)', a_sets==b_sets, f"A={a_sets} B={b_sets}")

    # ================= 401 handling: expired token drops creds =================
    C_ctx,C=new_device('C')
    C.evaluate("window.__mockDriveStore.failAuthOnce=true; localStorage.setItem('sr_gd_token', JSON.stringify({t:'x',exp:Date.now()+3600000}))")
    # with mock present, runSync uses mock; failAuthOnce throws 401 in init
    C.evaluate("runSync(true)")
    C.wait_for_function("SYNC.status==='error'||SYNC.status==='ok'", timeout=8000)
    C.wait_for_timeout(200)
    check('401 sets error status', C.evaluate("SYNC.status")=='error', C.evaluate("SYNC.status+' / '+SYNC.detail"))
    check('401 cleared stored token', C.evaluate("!localStorage.getItem('sr_gd_token')"))

    print("\n=== %d/%d PASS ===" % (sum(results), len(results)))
    browser.close()
