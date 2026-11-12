---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
---

Global search across the Aviary consoles, and the switcher's probe marker. A console entry may now expose `search(context, q, limit)`. `GET <path>/api/consoles/search?q=` (behind the console's `authorize`) asks Telescope and every console the viewer may open, 300 ms and 5 same-origin hits each, and reports `partial: true` when one fails or times out. Telescope's own search (`telescopeConsoleSearch`) finds an entry by exact id and tags containing the text, inside the organizations the viewer's `authorize` grants. The command palette shows the hits next to its page shortcuts, and the brand menu gets **Search all consoles**. While the switcher runs other consoles' `authorize` or `search`, the request carries `aviaryProbe: true`. An auditing authorizer can skip those calls with `isConsoleProbe(context)`.
