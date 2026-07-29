---
'@dudousxd/nestjs-telescope-ui': patch
---

Clear the console launcher's pending state when the page is restored from the back/forward cache.

`useOpenTelescopeConsole` deliberately keeps `isPending` set after a successful mint so the button
does not flicker back to idle on a page that is navigating away. With bfcache the page does not die:
pressing Back restored the launcher with its React state intact, leaving a permanent "Opening…"
spinner on a button that could never be clicked again. The hook now listens for `pageshow` and
resets only when `event.persisted` is true, so a fresh load and a mint that is still genuinely in
flight both keep the original behaviour.
