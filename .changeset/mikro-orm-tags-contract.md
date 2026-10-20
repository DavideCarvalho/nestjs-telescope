---
'@dudousxd/nestjs-telescope-mikro-orm': patch
---

`MikroOrmStorageProvider.tags()` honours the `TagQuery`: counts come back most used first with ties by tag, `search` matches anywhere in the tag, and `limit`/`offset` page over that order. It returned counts in first-seen order and ignored `search`, which the dashboard's tag picker does not re-apply. Found by the new storage conformance suite.
