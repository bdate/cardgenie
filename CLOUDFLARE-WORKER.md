# Cloudflare Worker API

This project can run the private Card Genie API on Cloudflare Workers. The frontend can stay on GitHub Pages, while the OpenAI key stays private as a Worker secret.

## One-time setup

Log in to Cloudflare from the project root:

```bash
npx wrangler login
```

Add the OpenAI key as a Worker secret:

```bash
npx wrangler secret put OPENAI_API_KEY
```

When prompted, paste the OpenAI key. Do not commit the key to the repo.

For delivery, add provider secrets when you are ready to send real cards:

```bash
npx wrangler secret put SENDGRID_API_KEY
npx wrangler secret put EMAIL_FROM
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_API_KEY_SID
npx wrangler secret put TWILIO_API_KEY_SECRET
npx wrangler secret put TWILIO_FROM_NUMBER
```

Email delivery uses Twilio SendGrid when `SENDGRID_API_KEY` is configured. Postmark can still be used as an optional fallback with `POSTMARK_SERVER_TOKEN`.

Set `PUBLIC_APP_URL` to the production frontend URL so email and text links point at the app:

```toml
[vars]
PUBLIC_APP_URL = "https://www.card-genie.com"
```

Shared cards use an in-memory fallback during local testing. For production, bind a Workers KV namespace named `CARD_STORE` so delivered card links survive Worker restarts.

## Deploy the Worker

```bash
npm run deploy:worker
```

Wrangler will print the deployed Worker URL, usually like:

```text
https://cardgenie-api.<your-cloudflare-subdomain>.workers.dev
```

Verify the API:

```bash
curl https://cardgenie-api.<your-cloudflare-subdomain>.workers.dev/api/health
```

Expected response:

```json
{"ok":true}
```

## Connect GitHub Pages to the Worker

Set the GitHub repository variable `VITE_API_BASE_URL` to the Worker URL:

```bash
gh variable set VITE_API_BASE_URL --repo bdate/cardgenie --body "https://cardgenie-api.<your-cloudflare-subdomain>.workers.dev"
```

Then rerun the GitHub Pages workflow so the frontend rebuilds with the Worker URL.

## Local development

The existing Express server is still the recommended local API:

```bash
npm run dev
```

The Worker can also be tested locally:

```bash
npm run dev:worker
```
