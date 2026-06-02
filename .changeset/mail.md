---
'@dudousxd/nestjs-telescope-mail': minor
---

Add the mail watcher (`@dudousxd/nestjs-telescope-mail`). `MailWatcher` wraps a
nodemailer transporter's `sendMail` (structural transport type — no hard
nodemailer dependency) to capture sent mail (mailer, from, to, subject, body
preview, sent/failed), correlated to the active request/job batch via the
caller's async context. Recording is non-throwing and host errors are always
re-thrown.
