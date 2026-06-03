---
'@dudousxd/nestjs-telescope-sqs': minor
'@dudousxd/nestjs-telescope': minor
---

Make the SQS queue `dlqUrl` **optional**, reflecting real AWS where many queues
have no dead-letter queue. The primary value — live queue **depth**
(`waiting`/`active`/`delayed`, the latter now read from
`ApproximateNumberOfMessagesDelayed`) — is always reported from the main queue,
with or without a DLQ. DLQ inspection (`listJobs('failed')`) and `redrive` are now
a bonus, available only for queues configured with a `dlqUrl`:

- Without a `dlqUrl`: `failed` is `0`, `listJobs('failed')` returns an empty page,
  and `redrive` throws `Queue "<name>" has no DLQ configured; redrive unavailable`.
- Each queue's `QueueSummary` now advertises an optional `actions` capability hint
  (`['redrive']` when a DLQ is configured, otherwise `[]`) so the UI can show the
  Redrive button only for queues that support it. Adds the optional
  `actions?: QueueActionName[]` field to `QueueSummary` in core.
