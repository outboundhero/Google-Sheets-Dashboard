# CLAUDE.md

This file briefs future Claude sessions on this codebase. It covers what isn't obvious from a quick file scan — conventions, gotchas, and where things live.

## What this app is

A Next.js 16 / React 19 / TypeScript dashboard called **LeadSync** for an agency (Outboundhero) that runs cold-email campaigns for cleaning/janitorial clients. It pulls leads from multiple Google Sheets, surfaces analytics, manages cold-email infrastructure (domains, inboxes, warmup, campaigns) on top of the Outboundhero/EmailBison API, discovers + registers `.info` domains via Porkbun + OpenAI, and provisions DFY inbox orders through three external providers (ScaledMail / MilkBox / Inboxing).

## Stack

- Next.js 16 App Router, React 19, TypeScript, Tailwind 4
- shadcn-style primitives in `src/components/ui/`, Lucide icons
- Supabase (auth + Postgres) — `getSupabaseAdmin()` from `src/lib/supabase.ts` is the service-role client used in API routes
- Upstash/Vercel Redis with a local JSON fallback for ephemeral data
- SWR for client-side data fetching; SWR keys are URLs (`/api/...`)
- googleapis (service-account JWT) for Sheets reads + writes

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
      campaigns/page.tsx                → /campaigns
      domains/page.tsx                  → /domains   (admin-only domain buyer)
      deliverability/inbox-orders/page.tsx → /deliverability/inbox-orders (DFY inbox order management)
      settings/page.tsx                 → /settings
    login/page.tsx                      → /login
    api/                  see "API routes" section below
  components/
    ui/                   shadcn primitives
    dashboard/, deliverability/, campaigns/, clients/, leads-table/, layout/, shared/
  lib/
    supabase.ts           browser/server/middleware/admin clients
    leads-store.ts        Redis/JSON store for synced leads + sync metadata
    sheets-config.ts      Redis/JSON store for tracked-sheets config
    google-sheets.ts      Sheets API client; getSheetsClient() is exported
    google-sheets-secondary-domain.ts   appends to a specific sheet's "Secondary Domain" column (used by domain buyer)
    sync-leads.ts         chunked sync orchestration
    analytics.ts          computeAnalytics() — dashboard math
    constants.ts          column maps, status colors, status enum
    date-utils.ts         PST helpers (UTC-8, no DST)
    supabase-sheets-sync.ts   syncs tracked_sheets config Redis → Supabase
    dismissed-leads.ts    "Lead not Received" dismiss state in Supabase
    porkbun.ts            Porkbun v3 client (checkDomain, createDomain, setAutoRenew)
    openai-domains.ts     gpt-4o-mini domain-name generator
    scaledmail.ts         ScaledMail provider client (createOrder, getOrderStatus, swap, delete) — 25 mailboxes/order
    milkbox.ts            MilkBox provider client — 50 mailboxes/order
    inboxing.ts           Inboxing provider client — 49 mailboxes/order
    inbox-order-aliases.ts  alias generator for inbox orders
    auth-context.tsx      React context exposing useAuth()
    hooks/                SWR hooks (use-leads, use-analytics, use-sheets, use-domains, use-not-delivered-today, ...)
  types/
    lead.ts               Lead, LeadStatus, DashboardLead
    sheet.ts              TrackedSheet
    analytics.ts          DashboardAnalytics
    inbox-order.ts        InboxOrder, InboxOrderProvider, InboxOrderStatus, MAILBOX_COUNT_BY_PROVIDER
  middleware.ts           role-based gate on every request
```

Repo-root SQL files (`supabase-*.sql`) are migrations/utilities — sometimes needed, sometimes already applied. Don't blindly run them. The user prefers to run SQL manually in Supabase.

## API routes (grouped)

- **Leads/data**: `GET /api/data/all`, `GET /api/sheets`, `GET /api/sheets/[id]`, `POST /api/sync`, `GET /api/cron/sync`, `GET /api/analytics`, `GET /api/leads/not-delivered-today`, `POST /api/leads/not-delivered-today` (dismiss)
- **Sheets config**: `POST /api/sheets`, `DELETE /api/sheets/[id]`
- **Client tracker**: `GET /api/client-tracker`, `GET /api/client-tags`
- **Deliverability**: `GET /api/deliverability/domains`, `GET /api/deliverability/tags`, `GET /api/deliverability/sync`, `POST /api/deliverability/sync` (+`PUT` rebuild), `POST /api/deliverability/bulk-tags`, `bulk-delete`, `bulk-limits`, `send-to-sheet`, `attach-domains-to-campaign`, `remove-from-campaigns`, `import-domain`, `inboxes/[id]/warmup`
- **Campaigns**: `GET/POST /api/campaigns`, `GET/POST /api/campaigns/[id]`, `GET /api/campaigns/[id]/status`, `GET /api/campaigns/failed`
- **Domain buyer**: `POST /api/domains/generate` (OpenAI), `POST /api/domains/check` (Porkbun, persists to `porkbun_domains`), `GET /api/domains/list`, `POST /api/domains/register-one` (Porkbun create + auto-renew off), `POST /api/domains/append-to-sheet`, `POST /api/domains/delete`
- **Inbox orders (DFY provisioning)**: `GET /api/inbox-orders` (list), `POST /api/inbox-orders` (create — dispatches to ScaledMail/MilkBox/Inboxing), `GET/PATCH/DELETE /api/inbox-orders/[id]`, `POST /api/inbox-orders/[id]/refresh` (re-poll provider), `POST /api/inbox-orders/[id]/flag`, `POST /api/inbox-orders/[id]/swap`, `POST /api/inbox-orders/[id]/redirect`
- **Cron jobs** (configured in `vercel.json`): `/api/cron/sync` (every 2d at 00:00 UTC, lead sync), `/api/cron/deliverability` (every 2d at 12:00 UTC, inbox/domain sync), `/api/cron/redirect-check` (every 2d at 06:00 UTC, refreshes `deliverability_domains.redirect_url`), `/api/cron/inbox-orders-poll` (every 6h, polls pending/swapping/deleting orders, batch of 100, ~50s budget), `/api/cron/campaigns` (daily at 17:00 UTC ≈ 10 AM Pacific, paginates Outboundhero campaigns and upserts into Supabase `campaigns` table)
- **External (token-auth)**: `GET /api/external/tracked-sheets` — exempt from session middleware; uses `Authorization: Bearer ${EXTERNAL_API_TOKEN}` (fallback `outboundhero2024`)
- **Misc**: `POST /api/cache` (clear), `/api/auth/...`

## Auth & roles

- Roles live in `user.app_metadata.role` (admin | viewer). Middleware at `src/middleware.ts` enforces:
  - Admins bypass everything.
  - Viewers can access `/clients` and `/deliverability` pages, plus a whitelist of GET-only API routes (`VIEWER_API_GETS`).
  - All other paths redirect / return 403.
  - `/api/cron/*` and `/api/external/*` skip auth entirely (cron uses Vercel headers; external uses Bearer token).
- In React, gate UI on `const { role } = useAuth(); const isAdmin = role === "admin"` — don't hide just by hoping the API will 403.

## Data flow — important conceptual model

**There is no single source of truth.** Different domains live in different stores:

| Concern | Primary store | Notes |
|---|---|---|
| Tracked sheets config | Redis (`sheets-config`) — JSON fallback | Mirrored to Supabase `tracked_sheets` for the external API |
| Lead rows | Redis (`leads-store:sheet:{id}`) — JSON fallback | Pulled from Google Sheets via chunked sync. `replyContent` and `ourLastReply` are blanked before storage (see `trimLeadForStorage`). |
| Sync metadata | Redis (`leads-store:meta`) | Drives the dashboard "syncing… X/Y sheets" indicator |
| Cold-email inboxes/domains | Supabase `deliverability_inboxes`, `deliverability_domains` | Synced from Outboundhero API via `/api/deliverability/sync` (POST chunks, PUT rebuilds domain stats via `rebuild_domain_stats` RPC) |
| Campaigns | Supabase `campaigns` | Daily cron `/api/cron/campaigns` at 17:00 UTC paginates Outboundhero and upserts. `client_tag` is derived from the substring before `":"` in the campaign name. Users can also trigger a manual sync from the campaigns page. No live-API fallback by design. |
| Porkbun discoveries | Supabase `porkbun_domains` | One row per domain ever checked, regardless of availability — dedupes future checks |
| Dismissed "not delivered today" leads | Supabase `lead_not_received_dismissed` | PK `(sheet_id, lead_email)`; once dismissed, permanent |
| Inbox orders (DFY) | Supabase `inbox_orders` | One row per provider order. `provider` enum: `scaledmail`/`milkbox`/`inboxing`. `status` enum: `pending`/`active`/`failed`/`swapping`/`swapped`/`deleting`/`deleted`. `parent_order_id` self-FK links swap replacements. Polled by `/api/cron/inbox-orders-poll`. |

## Conventions and gotchas

- **Status string casing matters**: the canonical value is `"Lead not Received"` — lowercase 'n' in "not". Users often type "Lead Not Received". When filtering by status, do `.trim().toLowerCase() === "lead not received"` to be safe.
- **`currentCategory` may be empty for entire clients** (e.g. BHS). `src/lib/analytics.ts` uses `makeDeliverablePredicate(leads)` — if a client has any leads tagged with a meeting category, that's the deliverable; otherwise it falls back to `status === "Quality Lead"`. Honour this when adding new "deliverable" metrics.
- **`replyTime` vs `timeWeGotReply`**: Both can be present, empty, or one of each. Existing code uses the pattern `parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime)` ([analytics.ts:50](src/lib/analytics.ts#L50)). The "today" check in `/api/leads/not-delivered-today` checks **either** field.
- **PST is hardcoded to UTC-8, no DST.** All time-window logic uses `pstDateString()` / `isPstToday()` / `isPstTodayOrYesterday()` from `src/lib/date-utils.ts`. Don't reach for `Intl.DateTimeFormat` unless you intend to migrate everything.
- **The `[sheetId]` route param is actually a clientTag**: `src/app/(dashboard)/clients/[sheetId]/page.tsx` decodes `params.sheetId` and uses it as a client tag. Don't rename — many places assume this.
- **Google Sheets dates**: Sheets returns several formats including `"3/9/2026 2:30 PM"` (12-hour AM/PM). Node's `new Date()` won't parse the AM/PM form — `parseDate()` in `analytics.ts` and `normalizeGoogleDate()` in `google-sheets.ts` handle this.
- **Google Sheets write quota**: 300 reads/min per project. The chunked sync uses 10 sheets/chunk with 2.5s pacing. When adding new write paths, prefer a single `values.update` over many small ones; on "exceeds grid limits" errors, extend the tab via `appendDimension` and retry (see `appendDomainsToSheet` for the pattern).
- **Porkbun rate limit is 1 check / 10 seconds** by default. The domain buyer page paces this client-side with `setInterval(10_500ms)` — each `/api/domains/check` does exactly one Porkbun call. Don't try to fan out checks server-side; the rate limit is per-account.
- **Porkbun `createDomain` v3 spec**: body needs `apikey`, `secretapikey`, `cost` (integer **pennies**, not dollars), and `agreeToTerms: "yes"`. There is no `years` field — defaults to 1 year. `updateAutoRenew` body uses `status: "on" | "off"`, not `autoRenew`.
- **External API (`/api/external/*`) auth**: Bearer token in env var `EXTERNAL_API_TOKEN`, with a string fallback to `"outboundhero2024"`. Middleware exempts this path so external services don't need Supabase sessions.
- **Long-running jobs are frontend-driven** (with one exception): For most features, there are no background workers — the frontend calls a small API endpoint repeatedly while it tracks progress in component state. See `startBackgroundTagCampaign` in `src/app/(dashboard)/deliverability/page.tsx` for the canonical pattern (parallel sub-jobs with per-step status, rendered as a progress card). **Exception**: inbox orders are polled server-side by `/api/cron/inbox-orders-poll` (Vercel cron, every 6h) because order completion is asynchronous on the provider side and may take hours-to-days.
- **Inbox order providers have different mailbox-per-order counts**: ScaledMail = 25, MilkBox = 50, Inboxing = 49. Hardcoded in `MAILBOX_COUNT_BY_PROVIDER` ([types/inbox-order.ts:57](src/types/inbox-order.ts#L57)). Used to compute price/capacity in the UI — don't fetch this from the providers, they don't expose it.
- **Inbox order status mapping**: each provider returns its own raw status strings, which the provider client normalizes into the shared `InboxOrderStatus` enum. `provider_status_raw` and `setup_stage` preserve the original for debugging. When adding a new provider, follow the `ProviderStatusResult` shape (`status` + `rawStatus` + `setupStage` + `failureReason` + `completed`).
- **Inbox order poll budget**: the cron route caps work at ~50s (within Vercel's 60s `maxDuration`) and batches 100 rows ordered by `last_checked_at NULLS FIRST`. If you add a slower provider call, keep the per-iteration time-check intact.
- **`deliverability_domains.redirect_url`** is refreshed by `/api/cron/redirect-check` every 2 days. Inbox-order flow may also set it directly (e.g. on order creation). Don't write to this column from feature code without understanding which path is authoritative for that domain.
- **SWR pattern**: hooks live in `src/lib/hooks/`. Default config is `revalidateOnFocus: false`, `dedupingInterval: 10000`, `keepPreviousData: true`. When a job mutates server state, follow up with `mutate()` to refresh.
- **`leadsoverflow` is not throwaway**: the leads-store explicitly **trims** `replyContent` and `ourLastReply` to keep storage small (`trimLeadForStorage` in `leads-store.ts`). If you need those for analysis, you have to re-pull from Sheets.
- **`getSheetsClient()` is exported**: it's the only authenticated entry point to Sheets. Reuse it; don't re-init `google.auth.JWT` elsewhere.

## External APIs

- **Google Sheets** — `googleapis` SDK, service-account JWT auth (`GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`), scope `https://www.googleapis.com/auth/spreadsheets`.
- **Outboundhero / EmailBison** — `https://app.outboundhero.co/api`, `Authorization: Bearer ${OUTBOUNDHERO_API_KEY}`.
- **Porkbun** — `https://api.porkbun.com/api/json/v3`, body auth with `apikey` + `secretapikey`.
- **OpenAI** — `https://api.openai.com/v1/chat/completions`, model `gpt-4o-mini`, `response_format: { type: "json_object" }`. Raw fetch (no `openai` SDK).
- **ScaledMail** — DFY inbox provider, 25 mailboxes/order. Auth via `SCALEDMAIL_API_KEY` + `SCALEDMAIL_ORGANIZATION_ID`. Also needs `SCALEDMAIL_PORKBUN_USERNAME` / `SCALEDMAIL_PORKBUN_PASSWORD` (Porkbun account credentials forwarded to ScaledMail for domain transfers/setup) and `SCALEDMAIL_OUTLOOK_*` config.
- **MilkBox** — DFY inbox provider, 50 mailboxes/order. Auth via `MILKBOX_API_KEY`. Needs `MILKBOX_DOMAIN_PROVIDER_ID` and `MILKBOX_SEQUENCER_ID`.
- **Inboxing** — DFY inbox provider, 49 mailboxes/order. Auth via `INBOXING_API_KEY`, base `INBOXING_BASE_URL`. Needs `INBOXING_CLOUDFLARE_CREDENTIAL_ID` and `INBOXING_REGISTRAR_CREDENTIAL_ID` for DNS + registrar wiring.
- **Supabase** — service-role admin client for server, anon + cookie-aware client for browser.

## Env vars

Required:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` (with `\n` escapes, decoded in code)
- `OUTBOUNDHERO_API_KEY`

Optional (feature-specific):
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `_TOKEN`) — without these, the app falls back to local JSON files (dev only)
- `PORKBUN_API_KEY` + `PORKBUN_SECRET_API_KEY` — domain buyer
- `OPENAI_API_KEY` — domain buyer
- `EXTERNAL_API_TOKEN` — overrides the public-API fallback token
- `INBOX_ORDER_DEFAULT_REDIRECT_URL` — fallback redirect when an inbox order is created without an explicit redirect URL (defaults to `https://findlocalcommercialcleaning.com`)
- ScaledMail: `SCALEDMAIL_API_KEY`, `SCALEDMAIL_ORGANIZATION_ID`, `SCALEDMAIL_PORKBUN_USERNAME`, `SCALEDMAIL_PORKBUN_PASSWORD`, `SCALEDMAIL_OUTLOOK_*`
- MilkBox: `MILKBOX_API_KEY`, `MILKBOX_DOMAIN_PROVIDER_ID`, `MILKBOX_SEQUENCER_ID`
- Inboxing: `INBOXING_API_KEY`, `INBOXING_BASE_URL`, `INBOXING_CLOUDFLARE_CREDENTIAL_ID`, `INBOXING_REGISTRAR_CREDENTIAL_ID`

## Working in this repo

- Commit messages are short imperative-mood titles, occasionally with a body. Recent examples: `Speed up Send to Sheet: instant load + searchable list`, `Fall back to Quality Lead status when client doesn't fill currentCategory`.
- The user commits and pushes frequently — push to `main` is the norm unless they ask for a PR.
- Always run `npx tsc --noEmit` before pushing.
- The user does not want CLAUDE.md to advertise itself — keep docs out of code unless asked.
- The user often runs SQL manually in Supabase. When new tables are needed, paste the SQL in chat — don't try to apply via MCP unless asked.
- The user has rejected the Supabase MCP tool in the past ("why the fuck do you need to access the mcp?"). Stick to the SQL-via-chat workflow.

## Quick verification

```bash
# Type-check
npx tsc --noEmit

# Lint a subset of files
npx eslint <paths>

# Dev server
npm run dev
```

There is no test suite. Verification is mostly: type-check + lint + manual click-through, plus the occasional debug API route added temporarily for diagnosis (and deleted afterwards).
