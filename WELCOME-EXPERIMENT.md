# Welcome experiment v2

v2 started Oct 27, 2026, when Version B changed from a story-to-card example to a real photo-to-card example (the Robin and Lesley congratulations card, shown with permission; headline "Turn your photos and memories into a one-of-a-kind greeting."). Version A (finished sample cards) is unchanged. v1 data stays in `landing_events` and appears as separate rows in the admin report.

Once the API readiness endpoint responds with `welcome-v2` and `enabled: true`, new visitors to the root homepage are assigned randomly 50/50 to A (finished cards) or B (photo to card). Until then, the existing creator remains the homepage. Preview links always work. Assignment is first-touch, per browser, for 30 days. Paid traffic is identified by a Google click identifier or cpc/ppc/paidsearch UTM medium and reported separately from other traffic. No advertising budget or targeting changes are required.

Review both versions without enrolling or recording funnel events:

- https://www.card-genie.com/?welcome=a
- https://www.card-genie.com/?welcome=b

The Create button preserves click identifiers/UTMs and optional occasion/style parameters. Preview links continue with `landing_preview=1`; those visits are excluded from experiment purchases. `/?create=1` opens the existing creator directly. Account links, personal cards, GCU pages, checkout returns, hash links, and saved drafts bypass the welcome experience. Returning members and browsers that have started creating keep the creator as their homepage.

The existing admin Analytics screen includes a since-launch welcome funnel by version and source. Counts are distinct anonymous browser visitors per milestone. Revenue includes repeat live paid credit purchases; purchase rate is unique buyers / exposed visitors. The report is independent of the existing Analytics date filter. Early counts are directional, not statistical proof. Multiple devices and cleared browser storage count separately. Use the paid cohorts for advertising decisions.

Milestones: view, sample opened, Create clicked, form started, card created or failed, account created (only when sign-in reports a brand-new account), card sent (only when at least one delivery succeeds; scheduled sends are not counted), checkout started, and verified purchase.

Google Ads secondary conversions (Count: One, no value) fire from `src/adsConversions.ts` for landing click (Create clicked on the welcome page), card created, account created and card sent, once per visitor or card in each browser. Credit purchase remains the only primary conversion. Google Ads cannot split these by welcome version; use the admin report for that.

Events are stored in a new, self-initializing `landing_events` table in the existing ACCOUNT_DB. Only experiment IDs, random visitor IDs, variant, source category, fixed milestone names and timestamps are collected. Purchases are recorded from verified live paid Stripe checkout sessions, deduplicated by checkout ID. Unpaid/test/GCU purchases and the test-login account are excluded. Form contents, names, phone numbers, images, URLs and click identifiers are not recorded in the experiment table. The Google Ads purchase conversion code is unchanged.

The existing Pages workflow publishes the frontend. The repository's Cloudflare automation token cannot update `cardgenie-api` (confirmed deployment error: no access to the specified service). The existing Cloudflare Git integration points at an older `bdate/cardgenie-api` repository, which is not the current production source. Do not rebuild that stale repository over the current API. The dashboard editor was inspected but no code change was accepted or deployed there.

Deploy the checked API from an authorized local checkout of **bdate/cardgenie** with `git pull --ff-only` followed by `npx wrangler deploy`. This preserves the existing secret values and bindings. The homepage experiment starts automatically after that deployment; no further frontend push is needed. An unavailable or mismatched readiness response falls back to the existing creator, so paid visitors are not enrolled in an unmeasured experiment. Existing creation and payment operations continue independently of analytics failures.

Validation:

```sh
node --test tests/welcome.test.mjs
npm run build
npx wrangler deploy --dry-run
```

To disable the welcome experience, return `enabled: false` from `/api/landing-experiment` and deploy the API. Alternatively, make `shouldShowWelcome()` return `false` and redeploy the frontend. Keep the report available for reviewing collected data. Samples reuse existing fictional demonstration artwork and messages; no customer cards or source photos are exposed.
