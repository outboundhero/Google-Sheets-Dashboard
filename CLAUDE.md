# CLAUDE.md

This file briefs future Claude sessions on this codebase. It covers what isn't obvious from a quick file scan — conventions, gotchas, and where things live.

## What this app is

A Next.js 16 / React 19 / TypeScript dashboard called **LeadSync** for an agency (Outboundhero) that runs cold-email campaigns for cleaning/janitorial clients. It pulls leads from many Google Sheets, surfaces analytics, manages cold-email infrastructure across **four Bison/EmailBison instances** (domains, inboxes, warmup, campaigns), discovers + registers `.info` domains via Porkbun + OpenAI, and orders inboxes from external providers (ScaledMail / MilkBox / Inboxing).

## Stack

- Next.js 16 App Router, React 19, TypeScript, Tailwind 4
- shadcn-style primitives in `src/components/ui/`, Lucide icons
- Supabase (auth + Postgres) — `getSupabaseAdmin()` from `src/lib/supabase.ts` is the service-role client used in API routes
- Upstash/Vercel Redis with a local JSON fallback for ephemeral data (Redis is also where the deliverability sync's cursor + pass markers live)
- SWR for client-side data fetching; SWR keys are URLs (`/api/...`)
- googleapis (service-account JWT) for Sheets reads + writes

## Multi-instance Bison (load-bearing)

There are **4 Bison instances**, defined in [src/lib/bison-instances.ts](src/lib/bison-instances.ts). Each has its own URL and API key env var:

| Slug | Label | Group / Tier | Base URL | Env var |
|---|---|---|---|---|
| `outboundhero` | B2B #1 | 1 / b2b | `app.outboundhero.co/api` | `OUTBOUNDHERO_API_KEY` |
| `cleaningoutbound` | B2C #1 | 1 / b2c | `personal.cleaningoutbound.com/api` | `CLEANINGOUTBOUND_API_KEY` |
| `facilityreach` | B2B #2 | 2 / b2b | `app.facilityreach.com/api` | `FACILITYREACH_API_KEY` |
| `outboundclean` | B2C #2 | 2 / b2c | `personal.outboundclean.com/api` | `OUTBOUNDCLEAN_API_KEY` |

**Always call Bison through `bisonFetch(instance, path, init?)`** from [src/lib/bison.ts](src/lib/bison.ts) — it picks the right base URL + key. `resolveInstance(value)` and `resolveInstances(searchParams)` parse `?instance=` / `?instances=<csv>` query params from request URLs, defaulting to `outboundhero`.

UI scoping: the sidebar has an **Instance Switcher** ([src/components/layout/instance-switcher.tsx](src/components/layout/instance-switcher.tsx)) that drives `useInstance()` ([src/lib/instance-context.tsx](src/lib/instance-context.tsx)) — exposes `group` (1|2), `tier` ("all"|"b2b"|"b2c"), and the derived `instances`, `instancesKey`, `instancesQuery` for fetches. Persisted in localStorage. Most deliverability/campaigns reads pass `?${instancesQuery}` so the backend filters to the right slugs.

Supabase tables that hold Bison data are keyed by `(instance, …)`:
- `deliverability_inboxes` PK `(instance, id)`
- `deliverability_domains` PK `(instance, domain)`
- `campaigns` PK `(instance, id)`

**Upserts MUST include `onConflict: "instance,id"` (or `"instance,domain"`)** — never just `id` / `domain`. Same for `.eq("instance", ...)` filters on reads/updates/deletes.

⚠️ **The manual "Sync Inboxes" button on the deliverability page is a dropdown picker** ([deliverability/page.tsx](src/app/(dashboard)/deliverability/page.tsx) `handleSync(slugs)`): pick "All 4 instances" or a single instance. It crawls the chosen `slugs` in parallel (each `POST /api/deliverability/sync?instance=<slug>` + per-instance `prune`), then one `PUT /api/deliverability/sync` rebuilds domain stats for all instances. The per-instance sync route reads `?instance=` and falls back to `DEFAULT_INSTANCE`, so always pass the slug.

## Repo layout

```
src/
  app/
    (dashboard)/          authenticated pages
      page.tsx                          → /
      clients/page.tsx                  → /clients
      clients/[sheetId]/page.tsx        → /clients/:clientTag  (param is a URL-encoded clientTag, NOT sheetId — see below)
      leads/page.tsx                    → /leads
      deliverability/page.tsx           → /deliverability
      deliverability/inbox-orders/page.tsx → /deliverability/inbox-orders
      campaigns/page.tsx                → /campaigns
      domains/page.tsx                  → /domains   (admin-only domain buyer)
      performance/page.tsx              → /performance  (QL forecast, Turbo, auto-throttle — see "Performance tab")
      settings/page.tsx                 → /settings
    login/page.tsx                      → /login
    api/                  see "API routes"
  components/
    ui/                   shadcn primitives
    layout/sidebar.tsx + instance-switcher.tsx
    dashboard/, deliverability/, campaigns/, clients/, leads-table/, shared/
  lib/
    supabase.ts           browser/server/middleware/admin clients
    bison.ts              bisonFetch / bisonHeaders / resolve(Instance|s)
    bison-instances.ts    4-instance config + group/tier helpers
    instance-context.tsx  useInstance() React context
    leads-store.ts        Redis/JSON store for synced leads + sync metadata
    sheets-config.ts      Redis/JSON store for tracked-sheets config
    google-sheets.ts      Sheets API client; getSheetsClient() is exported
    google-sheets-secondary-domain.ts   appends to a specific sheet's "Secondary Domain" column (domain buyer)
    sync-leads.ts         chunked Google Sheets lead sync
    cron/sync-deliverability.ts shared per-instance Bison crawl + prune (used by 4 deliverability crons)
    cron/sync-campaigns.ts      shared per-instance campaign sync
    sending-mode/         Performance tab engine: QL forecast, statuses, Turbo + throttle windows (see "Performance tab")
    client-tag-allocations.ts   client tag → instance mapping cron + reads
    analytics.ts          computeAnalytics()
    constants.ts          column maps, status colors, status enum
    date-utils.ts         PST helpers (UTC-8, no DST)
    supabase-sheets-sync.ts   syncs tracked_sheets config Redis → Supabase
    dismissed-leads.ts    "Lead not Received" dismiss state in Supabase
    porkbun.ts            Porkbun v3 client (checkDomain, createDomain, setAutoRenew)
    openai-domains.ts     gpt-4o-mini domain-name generator (uses live example .info domains as few-shot prompt)
    redirect-resolver.ts  manual-redirect-walk resolver (Cloudflare-friendly, time-budgeted)
    milkbox.ts            MilkBox order client
    auth-context.tsx      React context exposing useAuth()
    hooks/                SWR hooks (use-leads, use-analytics, use-sheets, use-domains, use-not-delivered-today, use-inbox-orders, ...)
  types/
    lead.ts, sheet.ts, analytics.ts
  middleware.ts           role-based gate on every request
```

Repo-root SQL files (`supabase-*.sql`) are **stale** in places — they predate the multi-instance migration. `supabase-rebuild-domains.sql` for example shows the old single-instance RPC; the deployed `rebuild_domain_stats()` actually groups by `(instance, domain)`. **Don't blindly run repo SQL.** The user prefers running SQL manually in Supabase — paste the SQL in chat when a new table/RPC is needed.

## API routes (grouped)

- **Leads/data**: `GET /api/data/all`, `GET /api/sheets`, `GET /api/sheets/[id]`, `POST /api/sync`, `GET /api/cron/sync`, `GET /api/analytics`, `GET/POST /api/leads/not-delivered-today` (dismiss)
- **Sheets config**: `POST /api/sheets`, `DELETE /api/sheets/[id]`
- **Client tracker / allocations**: `GET /api/client-tracker`, `GET /api/client-tags`, `GET /api/client-tag-allocations`
- **Deliverability**: domains, tags, sync (POST chunks, PUT rebuild), bulk-tags / bulk-delete / bulk-limits, send-to-sheet, attach-domains-to-campaign, attach-campaigns, remove-from-campaigns, import-domain, sync-domains, inbox / inboxes warmup, check-redirects, **prune**, **data-audit**
- **Campaigns**: list/create/get/update/[id]/status, failed
- **Domain buyer**: `POST /api/domains/generate` (OpenAI), `POST /api/domains/check` (Porkbun → `porkbun_domains`), `GET /api/domains/list`, `POST /api/domains/register-one`, `POST /api/domains/append-to-sheet`, `POST /api/domains/delete`
- **Inbox orders**: `GET /api/inbox-orders`, `POST /api/inbox-orders/...` (per provider)
- **Performance**: `GET /api/performance`, `POST /api/performance/turbo` `{clientTag, action: preview|activate|cancel}`, `POST /api/performance/throttle` `{clientTag, action: pause|resume|release}`, `GET /api/performance/throttle-preview`, `POST /api/performance/auto-throttle` `{enabled}`, `GET /api/performance/windows?csv=1`
- **Reconnect log**: `GET /api/reconnect-log` (tag restore events surfaced in Settings)
- **Webhooks**: `POST /api/webhooks/bison-reconnect` (Bison → restores tags; URL itself is the secret)
- **External (token-auth)**: `GET/POST /api/external/tracked-sheets` — exempt from session middleware; uses `Authorization: Bearer ${EXTERNAL_API_TOKEN}` (fallback `outboundhero2024`)
- **Misc**: `POST /api/cache` (clear), `/api/auth/...`

### Cron schedule ([vercel.json](vercel.json))

| Path | Schedule | Notes |
|---|---|---|
| `/api/cron/sync` | `0 * * * *` | **Hourly** — Google Sheets lead chunks + tracked-sheets mirror |
| `/api/cron/sending-mode` | `10 * * * *` | Performance tab: re-evaluates every client, finishes/reverts Turbo + throttle windows; the throttle pass runs only on the 17:00 UTC run |
| `/api/cron/redirect-check` | `0 * * * *` | **Hourly** — oldest-checked first, cycles ~4k domains/day |
| `/api/cron/inbox-orders-poll` | `0 */6 * * *` | Polls provider status |
| `/api/cron/client-tag-allocations` | `0 8 * * *` | Mirrors client → instance mapping from sheet |
| `/api/cron/campaigns-{slug}` ×4 | daily, staggered 15m | One per instance |
| `/api/cron/deliverability-{slug}` ×4 | every 2 days, staggered 30m | Cursor-based per-instance inbox + domain crawl; prunes stale rows on each clean full pass |

This table lists the main jobs only — [vercel.json](vercel.json) has the full list (replacement, true-up, limit-policy, buy-alert, revive-completed, …).

## Auth & roles

- Roles in `user.app_metadata.role` (admin | viewer). Middleware at [src/middleware.ts](src/middleware.ts):
  - Admins bypass everything.
  - Viewers: `/clients` + `/deliverability` pages, plus a GET-only whitelist (`VIEWER_API_GETS`).
  - `/api/cron/*`, `/api/external/*`, and `/api/webhooks/*` skip session auth entirely.
- In React, gate UI on `const { role } = useAuth(); const isAdmin = role === "admin"`.

## Data flow

| Concern | Primary store | Notes |
|---|---|---|
| Tracked sheets config | Redis (`sheets-config`) — JSON fallback | Mirrored to Supabase `tracked_sheets` for the external API |
| Lead rows | Redis (`leads-store:sheet:{id}`) — JSON fallback | Chunked Google Sheets sync. `replyContent`/`ourLastReply` blanked before storage (`trimLeadForStorage`) |
| Sync metadata | Redis (`leads-store:meta`) | Drives the "syncing… X/Y sheets" indicator |
| Deliverability inboxes/domains | Supabase, **per-instance** | Crawled from each Bison; counts roll up via `rebuild_domain_stats()` RPC (already instance-aware) |
| Stale prune | Driven by `synced_at` + Redis pass markers | See "Pruning" below |
| Campaigns | Supabase `campaigns` per-instance | Daily cron per instance |
| Porkbun discoveries | Supabase `porkbun_domains` | One row per domain ever checked — dedupes future checks |
| Inbox orders | Supabase `inbox_orders` | Provider-agnostic order tracking, polled by cron |
| Tag restore log | Supabase `reconnect_tag_log` | Surfaced on /settings; populated by Bison reconnect webhook |
| Dismissed "not delivered today" | Supabase `lead_not_received_dismissed` | PK `(sheet_id, lead_email)`; permanent once dismissed |

## Pruning stale Bison data (important)

The cron crawls only added/updated rows — until recently it never deleted, so domains accumulated stale inboxes and counts inflated. The current scheme uses `synced_at` + a Redis-tracked "pass":

- Every sync upserts rows with `synced_at = now()`.
- [src/lib/cron/sync-deliverability.ts](src/lib/cron/sync-deliverability.ts) records a `passStartedAt` per instance in Redis when the cursor restarts at page 1, and a `clean` flag that flips false on any page-fetch or upsert error during the pass.
- When the cursor reaches `lastPage` cleanly, the cron deletes `deliverability_inboxes` where `instance = X AND synced_at < passStartedAt` — those rows weren't touched this pass → no longer in Bison.
- Safety cap: **bails if stale > 40%** of the instance's inboxes (guards against a partial/bad crawl).
- Rate-limited (429) passes never count as complete and never prune.

The manual **Sync Inboxes** button does the same end-to-end via `POST /api/deliverability/prune` (with a 45% cap), but only when run as a clean full crawl from page 1 (a resumed sync skips the prune). `GET /api/deliverability/data-audit` shows real (Bison) vs stored (Supabase) inbox counts per instance — quick sanity check for stale buildup.

## Performance tab — QL forecast, Turbo, auto-throttle (`/performance`)

Per-client view of how each client is doing against its QL guarantee this billing month, plus **Turbo** (manual: send more for 15 days) and **auto-throttle** (automatic: send less when a client is well ahead). Built from Nick's "Performance & Turbo Mode" spec (2026-09-23, v1 live Oct 9), then reworked to Nick + Spencer's **v2 list** (Slack, 2026-10-14, 14 points; answers 2026-10-16) — progress table below.

**Where things live**
- [src/lib/sending-mode/](src/lib/sending-mode/): `ql-pace.ts` (the forecast + status rules — start here), `status.ts` (`evaluateAllClients` → `client_sending_status`, `decideThrottles`, `runThrottlePass`), `windows.ts` (Turbo/throttle windows: snapshot every account's limits → apply → verify → revert), `config.ts` (tunables: `sending_mode_settings` row `id = 1`, code defaults when a column is missing), `capacity.ts`, `throttle-preview.ts`, `turbo-preview.ts`, `bison.ts`.
- Page [performance/page.tsx](src/app/(dashboard)/performance/page.tsx), hook `src/lib/hooks/use-performance.ts`, routes under `src/app/api/performance/`.
- Cron `/api/cron/sending-mode` (hourly at :10). `?dry=1` changes nothing; `?throttle=1` forces the throttle pass. The page reads the rows this cron writes, so new numbers appear up to an hour after a deploy.
- Tables: `sending_mode_settings`, `sending_windows`, `sending_window_accounts`, `client_sending_prefs`, `client_sending_status`. Everything in [supabase-sending-mode.sql](supabase-sending-mode.sql) **has been run in prod** (incl. the v2 columns and `last_status_at`).

**The numbers** ([ql-pace.ts](src/lib/sending-mode/ql-pace.ts))
- **MRL** = Meeting-Ready lead (lead sheet "Current Lead Category"). A client whose sheet never fills the category counts every lead. "Lead Not Received" still counts as delivered.
- **Reviewed** = Quality Lead / Not a Quality Lead / Duplicate (any "duplicat…"/"redundant" wording). **Pending** = blank or Undetermined. Lead Not Received is neither.
- **Actual rate** = QLs ÷ reviewed, over MRLs delivered in the last 30 days (dated by delivery date — the sheets don't record when a status was filled).
- **Blended rate** = (QLs + 4) ÷ (reviewed + 10). Drives the forecast and the throttle; the actual rate is shown beside it. Nick's draft said +8 (80%); the fleet's real rate is ~45%, and Nick answered "Yes" to starting at 4 of 10 (read from the reply, not restated — worth a one-line confirm). Tunable: `blend_prior_qls` / `blend_prior_leads`.
- **MRL pace** = MRLs a day over the last 14 days.
- **Forecast** = confirmed QLs + blended × pending MRLs this period + blended × MRL pace × days left.
- **Guarantee / operational target**: Tier 0.5 = 5 / 8, Tier 1 = 10 / 16, Tier 2 = 20 / 31 (`operationalTarget()`; tier from Client Tracker col K via `TARGETS` in `client-reports.ts`; PPQL/PPQM skipped). Billing period = monthly anniversary of the tracker Start Date (fallback Go Live).

**Statuses**, first match wins: `sync_error` (lead sheet not synced for 2+ days) → `overperforming` (throttle-ready, below) → `new_client` (days 1–19 from Start Date, first month only) → `no_mrls` / `new_period` (no MRLs this period; first 7 days = new_period) → `new_period` (first 7 days, < 3 MRLs) → `awaiting_reporting` (over half this period's MRLs still blank at the last Friday 5 PM PST cut-off, or 20+ MRLs never marked; shows how far marking has got) → `insufficient_data` (< 3 MRLs) → `critical` (forecast ≤ half the guarantee, or under it with ≤ 15 days left) → `at_risk` (under the guarantee) → `below_target` (under the target) → `on_track`. There is no per-month grace any more.

**Auto-throttle** — switch `sending_mode_settings.auto_throttle_enabled`, button on the page's Overperforming view (admins). **ON since 2026-10-12** (Nick). Off = releases still run, nobody new is throttled.
- Throttles a client when `overperforming`: forecast ≥ 150% of the guarantee (7.5 / 15 / 30), ≥ 10 reviewed MRLs in 30 days, ≥ 3 confirmed QLs this period, ≥ 7 days into the period, statuses being filled, and the forecast **still reaches the target once throttled** (re-checked with real send capacity from the inbox mirror, `capacity.ts`).
- Throttle = 3 sends/day (only ever lowers) + warm-up 8 (only ever raises). **Never pauses campaigns.**
- Released when the forecast drops under the target, a new billing period starts, the client is leaving / churned / paused / inactive, or auto-throttle is paused for that client.
- Revert puts back each account's recorded limits, verifies by re-reading Bison, retries up to 3× → `revert_failed` + pipeline alert. Throttles opened before 2026-10-21 never touched warm-up (`applied_limits.warmup` null) and only restore sending limits.
- The `limit-policy` cron skips clients with an open window so it doesn't undo them overnight.

**Turbo** — manual button with a preview first: 8 sends/day (only raises) + warm-up 5 (only lowers) for 15 days, then everything goes back automatically. A Turbo releases an open throttle first; the two never overlap.

**Gotchas**
- Slack for this feature is **muted** until `SENDING_MODE_SLACK_ENABLED=true`; window log rows and `pipeline_alerts` are always written.
- Pace (QLs by the Friday cut-off against a straight line) is still computed but only logged on windows — it no longer drives anything.
- Clients without a tier or a past Start Date/Go Live are left off the tab (point 7 below wants every client visible).
- Locally the Google Sheets key is stale, so `evaluateAllClients()` can't read the Client Tracker. To check rule changes on real data, run `evaluateQlPace()` over stored leads + the stored `client_sending_status` rows (read-only), or use `?dry=1` on prod.

**v2 progress** (Nick + Spencer, 2026-10-14). Points 1–11 are this tab. Point 12 (onboarding / task tracker — their #1 priority) and point 13 (project board — the separate "outreachify pms task bot" app) are **not in this repo**. Point 14 asks for an implementation breakdown.

| # | Ask | State |
|---|---|---|
| 1 | QL rate, blended rate, forecast, MRLs needed | ✅ live (f9c9c7f) |
| 2 | Guarantee vs operational target, Below Target | ✅ live (f9c9c7f) |
| 3 | Auto-throttle on the forecast: 150%, 3 sending + 8 warm-up, data minimums | ✅ live (0d75159) |
| 4 | MRL-based fallback throttle for clients not marking leads: upper MRL threshold × 1.4, rounded up to even, actual MRLs only; "reporting unreliable" rules; back to QL forecast once reliable | ⬜ next. Open: which "upper MRL threshold" — closest existing is the tier MRL targets 15 / 20 / 40 (`TARGETS`); Nick's 40 → 56 example matches Tier 2 |
| 5 | Turbo recommendations for clients forecast to miss the guarantee; continue across periods; usage tracking (extra MRLs, vs previous pace); low QL rate → Manual Review instead | ⬜ (manual Turbo itself is live) |
| 6 | New Client days 1–19 from Start Date; grace only in the first month | ✅ live (5430cd6) |
| 7 | Start Date, Go-Live, period start/end, days left for every client | ⬜ (period + days left already shown) |
| 8 | A reason instead of "No status data" | ✅ live (d3aa531) |
| 9 | Clickable summary cards, Action Required (assign / acknowledge / resolve / snooze, owner, days open), days since last MRL, shortfall, forecast confidence, search + filters, history + trends, sync health, notes, show the calculation everywhere | ⬜ biggest chunk |
| 10 | Alerts only on meaningful change, auto-resolve with history: Critical, throttle on, Turbo recommended / expiring, MRL or QL-rate drops, missed reporting, shortfall with 7 days left, sync errors, new client reaching day 20 | ⬜ |
| 11 | Overperforming rows show Throttle, not Turbo; keep the low-uncontacted-leads warning (in `turbo-preview.ts`); faster page load; auto-Turbo later | ⬜ |

Calls we made ourselves (Nick can change any): Lead Not Received counts as delivered but not in the rate; the throttle's "still reaches target" check uses the operational target; data minimums 10 / 3 / 7; New Billing Period = first 7 days; an overperforming new client shows Overperforming (so it can be throttled).

## Conventions and gotchas

- **Status string casing matters**: the canonical value is `"Lead not Received"` — lowercase 'n' in "not". Filter via `.trim().toLowerCase() === "lead not received"`.
- **`currentCategory` may be empty for entire clients** (e.g. BHS). `src/lib/analytics.ts` uses `makeDeliverablePredicate(leads)` — if any lead has a meeting category, that's the deliverable; otherwise it falls back to `status === "Quality Lead"`.
- **`replyTime` vs `timeWeGotReply`**: use the pattern `parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime)` ([analytics.ts:50](src/lib/analytics.ts#L50)). The "today" check in `/api/leads/not-delivered-today` checks **either** field.
- **PST is hardcoded to UTC-8, no DST.** Use `pstDateString()` / `isPstToday()` / `isPstTodayOrYesterday()` from `src/lib/date-utils.ts`.
- **The `[sheetId]` route param is actually a clientTag** ([clients/[sheetId]/page.tsx](src/app/(dashboard)/clients/[sheetId]/page.tsx)). Don't rename.
- **Google Sheets dates**: handle `"3/9/2026 2:30 PM"` (12-hour AM/PM) — Node's `new Date()` doesn't parse it; `parseDate()` and `normalizeGoogleDate()` do.
- **Google Sheets write quota**: 300 reads/min per project. Chunked sync = 10 sheets/chunk + 2.5s pacing. On "exceeds grid limits", extend rows via `appendDimension` and retry (see `appendDomainsToSheet`).
- **Porkbun rate limit**: 1 check / 10 seconds per account. Both discovery and registration are paced client-side at 10.5s intervals.
- **Porkbun `createDomain` v3 quirks**: body needs `apikey`, `secretapikey`, `cost` (integer **pennies**), `agreeToTerms: "yes"`. No `years` field (defaults to 1). `updateAutoRenew` body uses `status: "on" | "off"`.
- **Redirect resolver** ([src/lib/redirect-resolver.ts](src/lib/redirect-resolver.ts)): walks redirects **manually** (`redirect: "manual"`) reading `Location` off the first hop, with a browser User-Agent. This avoids losing the redirect when the destination (often Cloudflare) blocks bot traffic. Total per-domain budget is **10s** (across hops + both schemes).
- **Tag filter dropdown** on /deliverability pulls from each selected Bison instance's `/tags` directly (`loadTags`) — not from the Supabase RPC, which was flaky on large inbox sets.
- **Bulk tag add/remove is instance-aware + name-based** ([bulk-tags/route.ts](src/app/api/deliverability/bulk-tags/route.ts)). Bison tag **IDs are per-instance**, so the flow works by **tag NAME**, not ID. The `BulkTagDialog` unions tag names across the *selected* instances (`useInstance().instances`); the **Create** button just stages a name locally (no API call). On POST `{action, tagNames, domains}`, the route gathers the domains' inboxes across **all** instances, groups by instance, and per instance resolves each name → that instance's tag ID — **auto-creating the tag there if missing** (on `add`), reusing it if present (no duplicates). The old `{tagIds}` + `?instance=` path still works as a single-instance fallback. Before this fix the whole flow defaulted to `outboundhero`, so tagging any other instance created the tag in the wrong place / matched 0 inboxes.
- **Skipped inboxes in bulk tag ops**: the bulk-tags route returns `failedInboxes: [{email, domain, reason}]`. The progress card shows a "view" toggle that opens the list with a Copy emails button — those are almost always disconnected accounts.
- **The Clients page filters by the selected Bison group.** [clients/page.tsx](src/app/(dashboard)/clients/page.tsx) builds its list from `useSheets()` + `useAllLeads()` (neither is instance-scoped), then filters by `useInstance().group` against the client-tag → group map from `GET /api/client-tag-allocations` ([client-tag-allocations.ts](src/lib/client-tag-allocations.ts): sheet col A = Group 1, col C = Group 2 → Redis, UPPERCASE keys). **Tags NOT in the allocation sheet are unallocated and show in BOTH groups** (chosen so a client never disappears just for being missing from the sheet). Filtering is group-only — `tier` (b2b/b2c) does not narrow the Clients list, since the allocation map is group-level. The header count reflects the group-filtered list.
- **External API (`/api/external/*`)**: Bearer token in env var `EXTERNAL_API_TOKEN`, with a string fallback to `"outboundhero2024"`. Middleware exempts the path.
- **Long-running jobs are frontend-driven**: no background workers. Sync loops, registration loops, etc. work by the frontend calling small API endpoints repeatedly while tracking progress in component state. Canonical pattern: `startBackgroundTagCampaign` in [deliverability/page.tsx](src/app/(dashboard)/deliverability/page.tsx).
- **SWR pattern**: hooks live in `src/lib/hooks/`. Defaults: `revalidateOnFocus: false`, `dedupingInterval: 10000`, `keepPreviousData: true`. After server-state mutations call `mutate()` to refresh.
- **`getSheetsClient()` is exported** — the only authenticated entry point to Google Sheets. Reuse it; don't re-init `google.auth.JWT` elsewhere.
- **Bison reconnect webhook**: when a sender is reconnected in Bison, Bison hits `/api/webhooks/bison-reconnect`, we restore previously-applied tags and log the event to `reconnect_tag_log` (viewable on /settings).

## External APIs

- **Google Sheets** — `googleapis` SDK, service-account JWT (`GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`), scope `https://www.googleapis.com/auth/spreadsheets`.
- **Bison / EmailBison** — 4 instances, each with its own `Bearer ${env}`. Always via `bisonFetch(instance, …)`.
- **Porkbun** — `https://api.porkbun.com/api/json/v3`, body auth with `apikey` + `secretapikey`.
- **OpenAI** — `https://api.openai.com/v1/chat/completions`, model `gpt-4o-mini`, `response_format: { type: "json_object" }`. Raw fetch.
- **Inbox-order providers**: ScaledMail, MilkBox, Inboxing — each with its own creds (see env vars below).
- **Supabase** — service-role admin client for server, anon + cookie-aware for browser.

## Env vars

Required:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` (with `\n` escapes, decoded in code)
- One per Bison instance: `OUTBOUNDHERO_API_KEY`, `CLEANINGOUTBOUND_API_KEY`, `FACILITYREACH_API_KEY`, `OUTBOUNDCLEAN_API_KEY`

Optional (feature-specific):
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `_TOKEN`)
- `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` — domain buyer
- `OPENAI_API_KEY` — domain buyer
- `SCALEDMAIL_API_KEY`, `SCALEDMAIL_ORGANIZATION_ID`, `SCALEDMAIL_PORKBUN_USERNAME`, `SCALEDMAIL_PORKBUN_PASSWORD`, `SCALEDMAIL_OUTLOOK_*` — ScaledMail orders
- `MILKBOX_API_KEY`, `MILKBOX_DOMAIN_PROVIDER_ID`, `MILKBOX_SEQUENCER_ID` — MilkBox orders
- `INBOXING_API_KEY`, `INBOXING_BASE_URL`, `INBOXING_CLOUDFLARE_CREDENTIAL_ID`, `INBOXING_REGISTRAR_CREDENTIAL_ID` — Inboxing orders
- `INBOX_ORDER_DEFAULT_REDIRECT_URL` — used by inbox-order flow
- `CLIENT_TAG_ALLOCATION_SHEET_ID` — source-of-truth sheet for client→instance mapping
- `EXTERNAL_API_TOKEN` — overrides the public-API fallback token

## Working in this repo

- Commit messages are short imperative-mood titles, occasionally with a body. Recent: `Run redirect-check cron hourly instead of every 2 days`, `Prune stale inboxes at the end of a manual Sync Inboxes`.
- The user commits and pushes frequently — push to `main` is the norm unless they ask for a PR.
- Always run `npx tsc --noEmit` before pushing.
- Don't advertise CLAUDE.md in user-facing code.
- The user runs SQL manually in Supabase — paste the SQL in chat when a new table/RPC/column is needed. **Do NOT** call the Supabase MCP (they rejected that explicitly).
- `.env.local` may be stale vs Vercel. Don't assume local has working keys — for example, `OUTBOUNDHERO_API_KEY` locally is out of date (Vercel's works).

## Quick verification

```bash
npx tsc --noEmit          # type-check
npx eslint <paths>        # lint subset
npm run dev               # dev server

# real vs stored Bison counts per instance:
#   GET /api/deliverability/data-audit  (admin only)
```

No test suite. Verification = type-check + lint + manual click-through + the occasional debug API route (deleted afterwards).
