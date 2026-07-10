---
"@dudousxd/nestjs-telescope-cache": minor
---

Add `bentoCacheSource(emitter)`, a ready-made `CustomCacheSource` for
[BentoCache](https://bentocache.dev). BentoCache exposes no post-construction
event API — consumers construct their own Node `EventEmitter`, pass it to
`new BentoCache({ emitter })`, and hand-map bento's events onto
`CacheEventInput`. That mapping was previously ~45 lines every consumer had to
copy-paste; `bentoCacheSource` packages it:

```ts
import { EventEmitter } from 'node:events';
import { BentoCache } from 'bentocache';
import { CacheWatcher, bentoCacheSource } from '@dudousxd/nestjs-telescope-cache';

const bentoEmitter = new EventEmitter();
const bento = new BentoCache({ ..., emitter: bentoEmitter });

new CacheWatcher(bentoCacheSource(bentoEmitter));
```

Maps `cache:hit`/`cache:miss`/`cache:written`/`cache:deleted`/`cache:cleared` to
`get`/`get`/`set`/`delete`/`clear`, with `layer`→`tier` and `graced`→`stale`; a
`cache:cleared` event (which has no single key of its own) records as
`key: '*'`. The accepted emitter type is a minimal structural shape
(`{ on(event, listener) }`), so this package has no dependency — not even
dev — on `bentocache`; a malformed/partial event payload is mapped
defensively and never throws.
