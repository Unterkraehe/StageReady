STAGE READY — install / hosting notes
=====================================

This folder is a complete installable PWA. Keep all files together:

  index.html                 the app (open this)
  manifest.webmanifest       PWA metadata
  sw.js                      service worker (offline support)
  icon-192.png / icon-512.png / icon-maskable-512.png / apple-touch-icon.png

USE IT NOW
  Open index.html in Chrome or Firefox. Everything works (snippets,
  setlists, looping, speed, pitch, tuner, metronome, import/export, print).

INSTALL IT AS AN APP / OFFLINE USE
  PWA install + offline require the folder to be served over http(s)
  (service workers don't run from a file:// path). Any static host works:

    • Quick local test:  cd into this folder, then
          python3 -m http.server 8080
      and visit http://localhost:8080/
    • Or drop the folder on any static host (Netlify, GitHub Pages, your
      own server, etc.) and open it over https.

  Once loaded over http(s), your browser will offer "Install app"
  (an Install button also appears in the side drawer). After first load
  the app is cached and works offline.
