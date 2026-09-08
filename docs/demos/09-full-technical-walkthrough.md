# Full Technical Walkthrough: Dashboard Frontend + Backend

**Audience:** technical prospects, engineering-minded stakeholders, internal
onboarding for a new developer/hire
**Length:** 35–50 minutes (this is a deep-dive, not a sales pitch — trim by
skipping sections per audience)
**Setup:** logged in as admin on `dashboard.sodboysltd.org`; a second terminal
with SSH access to the production box is useful for the backend sections but
not required
**Tone shift from the other demo scripts**: this one names real technology —
tables, endpoints, files — because the audience wants the engineering, not
just the outcome.

---

## Part 1 — System overview (3–4 min)

**Say:** "This is a full-stack field-operations platform. Two independent
processes on the backend: a REST façade on port 8092 that the browser talks
to, and an MCP (Model Context Protocol) server on port 8090 that AI
agents — including the WhatsApp bot crew members text — talk to. Both sit in
front of the same domain logic, so a change made through the dashboard and a
change made by texting the bot land in the exact same database, instantly."

- **Stack**: Node/TypeScript backend, Postgres (pgvector-capable, though
  vector search isn't wired up yet), a forked React 18 + TypeScript + Vite
  frontend (originally an open-source construction-ERP product,
  OpenConstructionERP, cut down from ~200 routes to the 9 modules this
  business actually uses).
- **Identity model**: every actor — the node itself, the WhatsApp bot, every
  crew member — holds a real `did:web` cryptographic identity with
  JWT-based verifiable credentials, not a plain database role column. A
  crew member's phone number is a signed credential *bound to* that
  identity, not the identity itself.
- **The one pattern that shows up everywhere below**: **confirm-before-execute**.
  Anything a crew member submits about themselves (their own hours, a
  damage claim, an inventory adjustment) doesn't write directly — it lands
  in a `pending_confirmations` queue and a manager has to approve it before
  it becomes a real record. Watch for this pattern across Payroll, Site
  Inventory, and Equipment below.

---

## Part 2 — Dashboard (home page) (5–6 min)

Land on `/` (or `/dashboard`).

**Say:** "This is a purpose-built landing page, not a generic template —
the office's morning glance before the trucks leave."

### Widget: Site cards (top strip)
- One card per active job site: name, address, live "crew today" count
  (real-time — counts actual clocked-in crew, not a schedule), and an
  "open" badge when that site has an unresolved alert.
- **Backend**: `GET /api/v1/sites` → `listSitesWithActivityCounts()` in
  `src/domain/sites.ts`.

### Widget: Locations & weather
Split into two halves:
- **Left — a live map** (MapLibre GL, public OpenStreetMap tiles, no backend
  tile proxy): every site plotted, plus every vehicle/crew member's
  *latest known* location from `vehicle_telemetry`/`crew_telemetry`.
  **Say:** "There's no live GPS feed wired up yet — this is manually
  logged check-ins today. When a real telemetry source lands (vehicle
  OBD, WhatsApp location-share), it writes to the exact same two tables,
  so this map needs zero changes."
- **Right — Sites & weather panel**: up to 6 site cards in a 2-column grid,
  each showing a 7-day and ~1-month temperature/precipitation summary.
  **Backend**: `GET /api/v1/locations` combines vehicle + crew latest
  points; weather comes from Open-Meteo (free, no API key — see the
  sovereignty-tier note below).
  **Recently fixed**: this panel used to clip its two weather stats onto
  one unbroken row inside a ~150px card. Now stacks week/month onto
  separate lines — call this out as a real, recent UI fix if asked how
  actively this is maintained.

### Widget: System Status
- API server version, database connectivity (a live ping, not a static
  badge), configured AI providers (currently DeepSeek + OpenAI in the
  fallback chain), active UI languages.
- **Backend**: `GET /api/v1/system/status`.

### Widget: Inbox preview
- The 4 most recent unacknowledged alerts/notifications, with a link to
  the full Inbox. Each has an acknowledge checkmark.
  **Say, if asked**: "Acknowledging doesn't delete — this is closer to an
  audit log than an email inbox. There's a `DELETE` endpoint for API
  compatibility, but it's a documented no-op by design; nothing here is
  meant to be erasable once raised."
- **Backend**: `GET /api/v1/dashboard/inbox`, `POST /.../acknowledge`.

### Widget: Recent activity feed
- A live stream of real events — clock-ins, clock-outs, spend submissions —
  most recent first, "Show N more" pagination.
- **Backend**: `GET /api/v1/activity`.

### Module launch grid
- Nine cards, one per kept module (Equipment & Fleet, Resources & Crew,
  Field Time, Site Inventory, Procurement, Payroll, Teams and visibility,
  Map, Notifications) — each just a link, no live data on the card itself.

---

## Part 3 — Equipment & Fleet (4 min)

Navigate to `/equipment`.

**Say:** "Vehicles, not general equipment yet — the backing table is
`vehicles`, four real columns: plate, assigned driver, mileage, and latest
telemetry point."

- **Live stats**: fleet count, utilization derived from real trip data.
- **Utilization tab** is the one real analytics tab. Point out that other
  tabs the vendored frontend originally shipped — Health & Analytics,
  Maintenance, Damage, Fleet Optimization — were **physically removed**,
  not just hidden, because they called backend endpoints that were never
  built. **Say:** "That's a real engineering decision worth knowing about:
  a prior pass found these tabs silently rendering 'no data' instead of a
  visible error, because a failed query defaulted to an empty array. Rather
  than fake analytics or leave a misleading empty state, they were deleted
  outright."
- **Backend**: `src/facade/routes/equipment.ts` maps `vehicles.ts`'s
  4-column reality onto the frontend's much richer `Equipment` type — most
  fields (manufacturer, depreciation, ownership taxonomy) are fixed stubs,
  documented inline in the route file.
- No `DELETE` route — a vehicle with trip/telemetry history has real
  foreign-key risk and no "retired" status to fall back to, unlike assets.

---

## Part 4 — Resources & Crew (5 min)

Navigate to `/resources`.

**Say:** "This is deliberately the thinnest module in the whole system —
same crew directory, wearing two different UI costumes across two tabs."

### Resources tab
- The full crew list: phone number (used as the "code" column — this is
  the actual WhatsApp identity), name, type (always "Person" — the only
  real resource kind this domain has).
- **Backend**: `GET /api/v1/resources/resources/` → `listCrewMembers()`.
  Cost rate/currency are fixed stubs (`crew_members` has neither column).
  No create/update/delete here — crew provisioning is deliberately an
  ops/MCP-tool operation (`register_crew_member`), not a REST write.

### Requests / Assignments tabs
**Say, if you click into them:** "These are honest empty states now, not
broken ones. There's no 'resource request' or 'assignment board' concept
in this domain at all — the frontend's richer resourcing workflow assumed
one. A recent fix changed how that absence surfaces: it used to throw a
blocking 'Not found — Retry' error modal on page load; now it degrades to
an empty tab, matching how the adjacent Skills feature already behaved."
This is a good moment to talk about **engineering honesty as a feature**:
nothing in this system fakes data it doesn't have — it either builds the
real thing or shows a clean absence.

---

## Part 5 — Field Time (5 min)

Navigate to `/field-time`.

**Say:** "Timesheets, synthesized live from the same event stream Payroll
reconciles against — there's no separate 'timesheet' table."

- **Insights strip**: hours booked, daywork hours, hours not yet approved,
  lines booked — all real numbers, computed on request.
- **Three charts** (Hours by cost code, Labour against plant, Daywork hours
  by cost code) currently show "Not enough data." **Say:** "This isn't
  broken — it's the same honesty principle as Equipment's removed tabs.
  This domain doesn't track cost codes or plant-hours as a distinct
  dimension yet, so rather than draw a single fake bar or a misleading
  chart, the chart correctly refuses to render one it can't back with real
  categorized data."
- **Backend**: `src/facade/routes/fieldTime.ts` maps
  `timeclockSessions.ts`'s computed in/break/out state machine onto a
  synthesized `FieldTimesheet` — one per (crew member, calendar day), one
  `FieldTimesheetLine` per session that day. Status is a fixed `'draft'`
  stub; nothing here tracks a submit/approve/reverse lifecycle yet.

---

## Part 6 — Site Inventory (3–4 min)

Navigate to `/site-inventory`.

**Say:** "Consumables — fuel, seed, fertilizer, trimmer line — tracked as a
flat quantity-on-hand per item, adjusted through the same
confirm-before-execute pattern as everything a crew member self-reports."

- Item list with current stock, reorder threshold, a low-stock visual flag.
- **Backend**: maps `consumables.ts` onto a per-location stock-ledger UI
  the frontend originally supported — locations and a movement-history
  ledger are both honestly omitted, not faked with a synthetic default,
  since the real write path (`submit_consumable_adjustment`) is already
  two-party confirmed and this slice deliberately doesn't bypass that with
  a parallel direct-write endpoint.

---

## Part 7 — Procurement (4 min)

Navigate to `/procurement`.

**Say:** "Purchase orders, two creation paths, mapped to a real vocabulary
mismatch that's worth explaining if you're technical."

- Order list: vendor, items, amount, status (Draft → Issued → Completed →
  Cancelled).
- **The interesting engineering detail**: the frontend's "New PO" form
  takes ad-hoc line items directly with no prior order to compile from, but
  the backend's original creation path (`compilePurchaseOrder`) required a
  pre-existing order with real asset/consumable-linked items. Rather than
  force a mismatch, a second, honest creation path
  (`createFreeformPurchaseOrder`) was added for admin-direct orders not
  derived from a crew request — using nullable columns the schema already
  allowed.
- Status vocabulary is genuinely mapped, not aliased, between the two
  systems' different terms (`compiled→draft`, `sent_to_office→issued`,
  etc.) — call this out if the audience cares about integration quality:
  this is what a *careful* schema adaptation looks like versus a lossy one.

---

## Part 8 — Payroll (5 min)

Navigate to `/payroll`.

**Say:** "Reconciliation-only, by explicit design — this system never runs
payroll, it computes what's owed from real clock data."

- **Pay batches list**: currently one synthetic batch per calendar month
  (fixed id, recomputed live on every request, never persisted) — because
  this domain has no real batch concept.
- **Entries table**: worker, date, hours, rate, gross amount, deductions,
  net — one row per crew member with a configured pay rate.
- **Recently fixed, worth demoing live**: click **Export CSV** or **Export
  JSON**. **Say:** "Until this week these 404'd — the frontend called a
  real export endpoint that was never built on the backend. It needed no
  new domain concept, just formatting the same numbers already computed
  for the live view, so it shipped same-day as the bug report."
- Batch lifecycle buttons (Submit for approval, Finalize) are accepted but
  don't advance any real status — there's no persisted lifecycle to
  advance, and this is documented rather than faked.
- **Reconciliation is honestly always "matched"**: batch hours and live
  hours are the literal same query in this domain — there's no separate
  snapshot to drift from, so every row reporting `matched: true` is a real
  fact, not a hardcoded stub.

---

## Part 9 — Teams and visibility (2 min)

Navigate to `/teams`.

**Say:** "One synthetic team — 'All Crew' — containing every crew member.
The frontend's real multi-team, multi-role, restriction/access-matrix
system has no backing concept here yet; rather than build a fake
multi-team structure, this is one honest team standing in for one."

---

## Part 10 — Map (2 min)

Navigate to `/map`.

- Same MapLibre GL view as the dashboard widget, full-page, with a manual
  check-in form (log a crew member or vehicle's location by hand — the
  only way a point lands on the map today, since there's no live GPS
  feed yet).
- **Say:** "Purpose-built from scratch, not a resurrection of the vendored
  app's original 'Geo Hub' — that module assumed a whole 'Projects'
  concept and a backend tile-proxy this system doesn't have."

---

## Part 11 — Notification Webhooks (2 min)

Navigate to `/notification-webhooks` (or wherever it's mounted in nav).

- Register outbound webhook targets (URL + secret) that fire when
  specific alert types raise.
- **Backend**: full CRUD — `GET`/`POST`/`PATCH`/`DELETE` on
  `/api/v1/notifications/webhooks/`, the one module in this list with
  complete REST verbs.

---

## Part 12 — Settings (2 min)

Navigate to `/settings`.

- **LLM provider config**: view/edit the AI provider fallback chain
  (`GET`/`PATCH /api/v1/settings/llm`) — this is what the chat assistant
  (below) actually calls.
- **Change password**: self-service, re-verifies the current password
  server-side before accepting a new one (`crypto.scrypt`, no bcrypt
  dependency added).

---

## Part 13 — BI Dashboards / Field Reports / Vendors / Site Cost Summary (3 min, brief pass)

- **BI Dashboards** (`/bi-dashboards`): `GET /api/v1/bi/kpis` — a small set
  of real cross-cutting KPIs, not a full BI engine.
- **Field Reports**: crew-submitted field reports, read/list only from this
  UI.
- **Vendors**: the vendor directory Procurement's orders reference.
- **Site Cost Summary** (`/5d` internally, never labeled "5D Cost" in the
  UI — that term specifically implies cost-loaded-schedule/BIM integration
  this system doesn't have): real spend per site, combining PO cost and
  crew labour cost priced at each crew member's own rate. Budget/variance
  show as blank, never `$0`, when no budget has been set — an honest
  "unset" state, not a false zero.

---

## Part 14 — The chat assistant (2–3 min, if present in nav)

- A small floating chat button, read-only tool registry (`list_crew`,
  `list_equipment`, `list_active_alerts`, `get_crew_payroll_summary`).
- **Say, if asked about AI safety**: "No tool in its registry can mutate
  anything — every one is a read wrapper around existing domain functions.
  There's structurally no dangerous action an injected or malicious prompt
  could trigger through this surface, regardless of what it's told to do."

---

## Part 15 — Backend architecture, for a technical audience (5–8 min)

If the audience is engineering-literate, this is worth walking through
directly rather than summarizing:

- **Two independent processes, one domain layer**: the REST façade
  (`src/facade/`, port 8092) and the MCP server (`src/mcp/`, port 8090)
  both call into the exact same `src/domain/*.ts` functions — there is no
  duplicated business logic between "the dashboard's way of doing X" and
  "the WhatsApp bot's way of doing X."
- **Confirm-before-execute, generalized**: `src/domain/confirmations.ts`
  is an open registry (`registerConfirmationExecutor`), not a hardcoded
  list — every self-reported action (hours, damage claims, inventory
  adjustments, delivery receipts) goes through the same submit → review →
  approve/reject shape, and on approval, the system **re-checks state
  fresh** (e.g. geofence verification is recomputed against the site's
  *current* boundary, not what was true at submission time).
- **Two independent authorization axes**: which *agent* (bot, dashboard
  session) may call a given capability at all (an MCP tier, 0–4), and
  separately, which *human* role may actually approve something
  (`hasManagementCapability`) — a live cryptographic re-check every time,
  proven by a test that revokes a manager's grant mid-test and confirms
  the check flips to `false` immediately, not cached.
- **Sovereignty tiering**: every external network dependency — the AI
  provider chain, weather lookups, geocoding — has a real, dated, written
  decision in `policy/sovereignty_tiers.yaml`, never a silent default.
  Example: weather is accepted as external because a location/date query
  reveals nothing crew-identifying; geocoding is accepted because the
  coordinate (the actually sensitive part) is already stored regardless of
  whether it gets formatted into an address.
- **Production posture**: hosted on a deliberately small (1GB RAM) Oracle
  Cloud Always-Free VM behind Cloudflare with a real origin certificate
  (not Cloudflare's flexible/plaintext mode). **Say, if it comes up**: "The
  frontend build itself is memory-hungry enough to have taken this exact
  box down once — the fix was simple and is now a hard rule: the frontend
  never builds on the production box, only locally, then shipped over as a
  prebuilt bundle."

---

## Closing (1 min)

**Say:** "Every gap you saw today — the empty Field Time charts, the
stubbed batch lifecycle, the omitted movement ledger — was a deliberate,
documented choice, not an oversight. That's the actual claim being made:
not that everything is built, but that nothing here fakes what isn't."

---

### Notes for the presenter

- This script assumes real familiarity with the material — if a section's
  detail feels like too much for the room, cut to the **Say** lines only
  and skip the backend asides.
- Two live bug-fix stories are baked into Parts 2, 4, and 8 (weather-chip
  clipping, Resources error modal, Payroll export) — genuinely useful if
  the audience asks "how do bugs actually get found and fixed here."
- If asked "what's next": patrols/checkpoints and incident reporting are
  the next architectural extension being designed (for a sibling
  security-guard platform, IRONHORSE, reusing this exact backend pattern)
  — a good note that this architecture is proven to generalize beyond one
  business.
