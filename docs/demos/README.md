# Demo scripts — setup and reference

Nine scripts, meant to be run in order or standalone — see each file for its
own audience/length:

1. [`01-office-command-center.md`](01-office-command-center.md) — dashboard walkthrough (~10-12 min)
2. [`02-crew-in-the-field.md`](02-crew-in-the-field.md) — WhatsApp walkthrough (~6-8 min)
3. [`03-end-to-end-story.md`](03-end-to-end-story.md) — combined close, both screens side by side (~5 min)
4. [`04-feature-equipment-fleet.md`](04-feature-equipment-fleet.md) — equipment/vehicle deep-dive (~5-6 min)
5. [`05-feature-payroll.md`](05-feature-payroll.md) — payroll reconciliation deep-dive (~4-5 min)
6. [`06-feature-procurement.md`](06-feature-procurement.md) — purchase orders/vendors (~5 min)
7. [`07-scenario-problem-solution.md`](07-scenario-problem-solution.md) — 5 pick-and-mix problem/solution scenarios
8. [`08-mobile-viewport-demo.md`](08-mobile-viewport-demo.md) — mobile UI reality check (~6-8 min)
9. [`09-full-technical-walkthrough.md`](09-full-technical-walkthrough.md) — **every page/widget in the frontend + the backend architecture behind each one, in full technical detail** (~35-50 min) — for engineering-minded audiences or onboarding, not a sales pitch

## Before presenting

**Dashboard login:** `redji@thesodboysltd.ca` — password on file with Redji. `nick@thesodboysltd.ca` also works if you want the "business owner" framing instead of "IT/admin."

**WhatsApp bot number:** +1 343 204 0439. The demo phone's number must be present in `channels.whatsapp.allowFrom` in `~/.openclaw/openclaw.json` on the OpenClaw box (`40.233.78.15`) — anyone not on that list gets no response at all, by design. Currently allowlisted: Redji (8193196405), Nick (6135813385), Vicki (6478021787). To demo from a different phone, add its number to the array and restart the gateway (`systemctl --user restart openclaw-gateway.service`).

**Demo data:** seeded once into the real production database (2026-08-30) — three job sites, three crew members (Jake Tremblay, Mia Chen, Tyler Brooks), equipment, consumables, vendors, purchase orders, timeclock history, and two live alerts. Every created row's id is recorded in `demo-data-manifest.json` at the repo root.

## Re-seeding or cleaning up

If the demo data gets deleted, edited beyond recognition during a live demo, or needs a refresh:

- **To remove it:** delete every id listed in `demo-data-manifest.json`, in this order (children before parents) — checkouts, alerts, purchase orders (and their items), vendors, consumables, assets, vehicles, sites, crew members (and their `keys`/`capability_grants`/`verifiable_credentials` rows, same pattern as the test suite's cleanup). Never touch Nick, Vicki, Redji, or the real HQ site — those are real, not seeded.
- **To re-seed:** the seed script isn't committed to the repo (it writes directly to production and was run as a one-off) — ask whoever ran it last, or write a fresh one following the same shape: `registerCrewMember`/`registerSite`/`registerVehicle`/`registerAsset`/`registerConsumable`/`registerVendor`/`createFreeformPurchaseOrder`/`raiseAlert`, plus hand-written `timeclock_entries` rows for backdated punches (the domain function only stamps "now").

## Known rough edges to route around live

- A brand-new asset defaults to `status='unconfirmed'`, not `available` — it can't be checked out until it goes through the real verification flow (or a direct DB nudge, which is what seeding did for the one demo checkout). Don't try to check out a *different* asset live unless you've verified it first.
- The mobile dashboard UI has real table-overflow issues on narrow screens (tracked in `docs/ARCHITECTURE.md`'s backlog) — present from a laptop/tablet-width screen, not a phone, for the dashboard half.
- WhatsApp replies are genuinely LLM-generated, not scripted — exact wording varies run to run. Don't read the example replies in the scripts aloud as if guaranteed; they describe the *shape* of the response.
