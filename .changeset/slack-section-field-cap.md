---
"@dudousxd/nestjs-telescope": patch
---

Fix exception Slack alerts being rejected as `invalid_blocks` when fully enriched. A server exception carrying instance + observed + error + route + user-agent + referer + duration + user + client IP + location + occurrences produces 11 context fields, but Slack caps a `section` block's `fields` at 10 and rejects the whole message. The context fields now spread across as many section blocks as needed instead of overflowing one.
