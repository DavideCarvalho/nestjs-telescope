---
'@dudousxd/nestjs-telescope': patch
---

Scan the analytics window in large pages (5000, was 500). The metrics window
scan is the only caller; small pages turned one scan into many sequential
round-trips, which dominated latency against a remote SQL store. A big page
collapses a typical window into one or two queries — the real win for remote
RDS, complementing the content projection.
