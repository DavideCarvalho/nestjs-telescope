---
"@dudousxd/nestjs-telescope": minor
---

Add `isNew` to exception alert context + a New/Recurring header badge. Exception alerts now carry `isNew` (true on a family's first occurrence in the window, `occurrences === 1`), and the Slack card badges the header `🆕 New` vs `🔁 Recurring` so on-call can gauge urgency at a glance — a brand-new error vs one that keeps recurring.
