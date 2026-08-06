# Properly CRM — Review & Roadmap

_Snapshot review of the codebase: what works, what's risky, and what to add next. Ordered by priority. Severity in brackets._

## Overall state
The CRM is functionally solid — the features are built and tested. The important gaps are not features; they are **security/access control**, **save reliability**, and **code consolidation**. Address those and the foundation is durable.

---

## Priority 1 — Security & access control
These matter because the app holds client contact/financial data and has Gmail + Calendar access.

- **[High] Unauthenticated API endpoints.** `api/gmail-api.js`, `api/gcal.js`, and `api/claude.js` accept a request with only a `memberId` in the body (no auth) and then act with the service key. Someone with the URL could iterate member IDs to read an inbox, send mail, touch a calendar, or run up Gemini cost. CORS is `*`.
  - Fix: require a verified Supabase session on these endpoints (the pattern `run-drips.authorized()` already uses); stop trusting the client-supplied member id. Add basic rate limiting to `/api/claude` and narrow CORS.
- **[High] Verify RLS is actually enforced on every table.** With the anon key public and app-level auth described as "disabled for testing," row-level security is the *only* real access boundary. Confirm every table (contacts, transactions, notes, deadlines, followups, documents, gmail_tokens, cal_events, etc.) has correct RLS policies.
- **[High] Set `PORTAL_SECRET` and `CRON_SECRET` in Vercel.** `portal.js` falls back to a hardcoded HMAC secret if unset (forgeable magic-link tokens); `run-drips.authorized()` returns `true` if `CRON_SECRET` is unset (public send-email job). Fail closed instead of falling back.
- **[Med] OAuth `state` is unsigned.** `gmail-auth.js` carries only a base64 `memberId` with no CSRF protection — an attacker could bind their Google account to another member id. Sign/verify the state.

## Priority 2 — Save reliability (root of the bugs we chased)
- **[High] `dbSave` is fire-and-forget.** The app updates memory + localStorage and assumes Supabase accepted the write; on failure it only logs. This caused several "shows here but not there" gremlins. Make saves confirm success and surface failures to the user.
- **[High] `DB_COLS` "allow all" (`null`) for transactions/campaigns/enrollments/send_log.** Any new field is POSTed verbatim; if the column doesn't exist, PostgREST rejects the **whole** row — silently. Enumerate/validate columns, and confirm every field the app now writes has a column (`dismissedRisks`, `docChecklist`, lease `category`/`details`, `steps`).
- **[Med] Deletes are several un-awaited fetches, not atomic.** A partial failure orphans notes/followups/deadlines. `sweepStaleItems` is a band-aid. Move cascades to a Postgres `ON DELETE CASCADE` or a single RPC.
- **[Med] `gmail_tokens` refresh-token loss.** Google returns a refresh token only on first consent; reconnecting can store `''` and later refreshes fail. Preserve the existing refresh token on re-connect.

## Priority 3 — Consolidation (stops a whole class of drift bugs)
- **[Med] Three priority/briefing engines drift.** `app.js` (`computePriorities`), `cron-briefing.js` (`computeEmailPriorities`/`computeTxIntelEmail`), and `run-drips.js` (`buildBriefing`) implement overlapping logic separately. This is why "app shows X, email shows Y" kept recurring. Collapse toward one shared source of truth.
  - Note: the briefing email **does** fire (triggered via cron-jobs.org). The issue is duplication, not wiring.

## Priority 4 — Feature completions
- **[Med] Calendar is one-way.** Google events aren't merged into the CRM calendar view (there's a `gcal.js` `list` action, unused in the UI). Show Google events alongside CRM events.
- **[Med] Per-deadline "Send reminder now."** Manual one-off send from a specific deadline.
- **[Low] Archive/compact closed transactions.** Keep the active views clean.
- **[Low] Truncation guard on AI calls.** Check Gemini `finishReason`; a `MAX_TOKENS`/safety cutoff currently yields empty/partial output the parser can choke on.

## Priority 5 — Coordinator features (strategic, as you grow)
- **[Med] E-sign status tracking** (sent / viewed / signed) — TCs live in signatures.
- **[Med] Notify other parties** (lender, title, co-agent), not just client + team.
- **[Med] Commission/settlement (CDA) output** from the commission fields already captured.
- **[Low] Per-deal activity/audit timeline** (unify `tx_changes`, notes, emails, status changes).
- **[Low] SMS channel** — real-estate clients are often text-first; system is email-only today.

## Parked (discussed, intentionally deferred)
- Dedicated Google Workspace sending account (fixes self-send-to-Sent + deliverability).
- Investment/rental tracking (revisit after evaluating Gemini Spark).
- Proactive next-action coordinator (drafted next steps per priority).
- Full-text contract clause analysis (redFlags already cover ~80%).

---

## Suggested order to tackle
1. Confirm RLS on all tables + set `PORTAL_SECRET`/`CRON_SECRET` in Vercel (fast, high value).
2. Add session auth to `gmail-api` / `gcal` / `claude`.
3. Make `dbSave` confirm + surface failures; lock down `DB_COLS`.
4. Consolidate the three priority engines.
5. Merge Google events into the calendar view.
6. Pick coordinator features by what your volume needs.
