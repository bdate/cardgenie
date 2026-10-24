# Welcome experiment v1

New visitors to the root homepage are assigned randomly 50/50 to A (finished cards) or B (story to card). Assignment is first-touch, per browser, for 30 days. Paid traffic is identified by a Google click identifier or cpc/ppc/paidsearch UTM medium and reported separately from other traffic. No advertising budget or targeting changes are required.

Review both versions without enrolling or recording funnel events:

- https://www.card-genie.com/?welcome=a
- https://www.card-genie.com/?welcome=b

The Create button preserves click identifiers/UTMs and optional occasion/style parameters. Preview links continue with `landing_preview=1`; those visits are excluded from experiment purchases. `/?create=1` opens the existing creator directly. Account links, personal cards, GCU pages, checkout returns, hash links, and saved drafts bypass the welcome experience. Returning members and browsers that have started creating keep the creator as their homepage.

The existing admin Analytics screen includes a since-launch welcome funnel by version and source. Counts are distinct anonymous browser visitors per milestone. Revenue includes repeat live paid credit purchases; purchase rate is unique buyers / exposed visitors. The report is independent of the existing Analytics date filter. Early counts are directional, not statistical proof. Multiple devices and cleared browser storage count separately. Use the paid cohorts for advertising decisions.

Events are stored in a new, self-initializing `landing_events` table in the existing ACCOUNT_DB. Only experiment IDs, random visitor IDs, variant, source category, fixed milestone names and timestamps are collected. Purchases are recorded from verified live paid Stripe checkout sessions, deduplicated by checkout ID. Unpaid/test/GCU purchases and the test-login account are excluded. Form contents, names, phone numbers, images, URLs and click identifiers are not recorded in the experiment table. The Google Ads purchase conversion code is unchanged.

`welcome-api.yml` uses the existing Cloudflare deployment credential to deploy the API changes when the experiment module changes. The existing Pages workflow publishes the frontend. Both deployments must succeed for a measured experiment. If the API deployment fails, do not interpret an empty funnel as lack of engagement. Existing creation and payment operations continue independently of analytics failures.

Validation:

```sh
node --test tests/welcome.test.mjs
npm run build
npx wrangler deploy --dry-run
```

To disable the welcome experience, replace `const Experience = shouldShowWelcome()` in `src/main.tsx` with `const Experience = false` and redeploy the frontend; the existing creator remains the fallback. Keep the report available for reviewing collected data. Samples reuse existing fictional demonstration artwork and messages; no customer cards or source photos are exposed.
