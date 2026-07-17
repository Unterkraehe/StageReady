# Enabling Google Drive Sync

Stage Ready can sync each user's library across their devices through **their own
Google Drive**. You (the app owner) do a one-time ~10-minute setup to get a Google
OAuth Client ID; after that, every user just taps **Connect Google Drive** in
Settings and signs in with their own Google account. You never host or see anyone's
data — each library lives in that user's Drive, in a folder called `StageReady`,
using the `drive.file` scope (the app can only touch files it created).

## One-time setup

1. Go to **https://console.cloud.google.com/** and create a project (any name).
2. **APIs & Services → Library →** search **Google Drive API →** click **Enable**.
3. **APIs & Services → OAuth consent screen:**
   - User type: **External**, then **Create**.
   - Fill the app name, your email for the support/developer fields, **Save and
     continue**.
   - **Scopes:** you don't need to add any here (the app requests `drive.file` at
     runtime). Continue.
   - **Test users:** while your consent screen is in "Testing" mode, add the Google
     accounts that are allowed to connect (yourself and anyone testing). To open it
     to any Google user, later click **Publish app** — for the single `drive.file`
     scope, Google generally does **not** require a formal verification review.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Web application**.
   - **Authorized JavaScript origins:** add your site origin, e.g.
     `https://yourname.github.io`
   - **Authorized redirect URIs:** add the **full app URL**, e.g.
     `https://yourname.github.io/your-repo/`  (include the trailing slash and the
     repo path if your Pages site is served from a subfolder).
   - Create, then copy the **Client ID** (looks like
     `1234567890-abc....apps.googleusercontent.com`).
5. Open **`js/09-sync.js`** and paste it into the line near the top:
   ```js
   const GDRIVE_CLIENT_ID = '1234567890-abc....apps.googleusercontent.com';
   ```
6. Deploy. In the app: **menu → Settings → Sync — Google Drive → Connect**.

### Local testing note
OAuth origins must match exactly. If you test on `http://localhost:8901`, add that
as both an authorized origin and redirect URI too (Google allows `http://localhost`
for development). For `file://` it won't work — serve over http.

## What syncs, and how

- **Metadata** (snippet names, tags, notes, markers, ratings, pitch/volume, setlist
  contents & order, print settings) syncs constantly and cheaply via a single
  `manifest.json`.
- **Audio files and recordings** upload once and are referenced by ID; they only
  transfer again if you replace a file. A second device downloads them on the next
  sync so it's fully offline-ready.
- **Merging is additive: sync only ever adds or updates — it never deletes.** Every
  edit stamps a timestamp and the newest version of a record wins. Nothing is ever
  removed from Drive or from another device by syncing, so Drive doubles as a
  complete archive of everything you've ever had.
- **Deleting is local.** Removing a snippet on one device removes it *there only*;
  it stays in Drive and on your other devices, and sync won't restore it to the
  device you removed it from. To remove something everywhere, delete it on each
  device (and delete the file in the Drive `StageReady` folder if you want the
  space back — old audio versions are kept there too).
- **Offline-first:** IndexedDB on the device is always the source of truth and the
  app is fully usable with no connection; sync is a background reconciliation that
  runs on launch, after edits (debounced), when you return to the tab, and on demand
  via **Sync now**.

## Background sync (installed PWA)

- **Android / Chrome:** yes. The sync engine also runs inside the service worker,
  so the browser can finish an interrupted sync (and pick up changes) while the app
  is closed, using the Background Sync API. If you also grant the periodic
  background sync permission, Chrome will additionally refresh roughly twice a day
  at its own discretion. Background sync events get a limited time budget, so the
  *first* upload of a large library is still best done with the app open.
- **iPhone / iPad:** not possible. Safari implements neither Background Sync nor
  Periodic Background Sync, in a home-screen PWA or otherwise. There, syncing runs
  whenever the app is open (on launch, after edits, and when you switch back to it).

## Reliability with big libraries

Uploading a few hundred snippets is a long job, so sync is built to resume rather
than restart:

- The Drive folder id is remembered, so a second `StageReady` folder (created by, say,
  two devices' first sync racing each other) can never make the app think its files
  are missing and upload them all again.
- Files already on Drive are never uploaded twice — verified in a 300-snippet test
  across app restarts.
- The manifest is checkpointed every 25 files, so an interrupted upload keeps its
  progress instead of being lost.
- Individual failures are retried and then skipped, so one bad file cannot abort the
  whole run; the next sync picks it up.
- If the one-hour Google token is about to expire mid-upload, sync stops cleanly and
  asks you to reconnect instead of failing every remaining file.

## Cost & privacy

Zero cost and zero infrastructure for you: there is no server and no database. Each
user's audio counts against their own Google Drive quota (free accounts include
15 GB). Because the app uses `drive.file`, it cannot see any of the user's other
Drive files — only the `StageReady` folder it made.

## Adding other providers later

The engine talks to a small storage interface (`init / readJSON / writeJSON /
uploadBlob / downloadBlob / deleteBlob / list`). Google Drive is the first adapter.
A **WebDAV/Nextcloud** adapter is the natural next one (users enter a server URL and
an app password), and Dropbox would be straightforward as well. That work lives
entirely inside `js/09-sync.js`.
