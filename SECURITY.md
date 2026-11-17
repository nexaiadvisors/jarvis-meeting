# Security

## Report a vulnerability

Please do not open a public issue. Use GitHub's private reporting: the **Security** tab of this repository, then **Report a vulnerability**. You should get a reply within a week.

## How the service protects data

- **Server-side privacy filter.** Documents are filtered in the `/api/voice/*` routes before any model sees them. Personal terms, pay data and denied key patterns always win over an allow rule. See `src/agent/work-scope.ts` and `PERSONAL_DENY_TERMS` in `.env.example`.
- **Owner-only scope.** Calendar, email and wider notes are readable only when the owner is the only person in the call.
- **Untrusted names.** Participant display names are sanitised before they reach a prompt.
- **Signed sessions.** The agent page gets a short-lived session token per meeting. The webhook checks a shared secret.
- **Local by default.** Transcripts are written to `.data/` on your own disk. Screen frames are not stored.
- **No sending without a spoken yes.** The one outbound message tool needs a read-back and the owner's own spoken confirmation, checked on the server.

## Your part

Keep `.env.local` out of git, keep your knowledge connector bound to `127.0.0.1`, and rotate `WEBHOOK_SECRET` if the public URL leaks.
