---
'@dudousxd/nestjs-telescope-ui': minor
---

Add a gated "Redrive DLQ" action to the queue management UI. On the failed tab /
queue header, `RedriveDlqButton` is shown only when the driver advertises
`'redrive'` (`capabilities.actionsByDriver[driver]`) and `mutationsEnabled` is
true — so it surfaces for SQS-style DLQ drivers and stays hidden for BullMQ. It
confirms before firing (it moves messages back to the source queue) via the
existing `useQueueAction()` with `action: 'redrive'`, and a 403 surfaces inline as
"Not authorized".
