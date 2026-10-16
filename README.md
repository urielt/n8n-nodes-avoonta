# n8n-nodes-avoonta

The official [Avoonta](https://avoonta.com) community node for [n8n](https://n8n.io). Your AI voice agent calls a new lead in seconds, and every finished call comes back as a trigger.

## Install in n8n

Self-hosted n8n: **Settings > Community Nodes > Install**, enter `n8n-nodes-avoonta`, tick the risk notice and press **Install**. (n8n Cloud shows community nodes only after n8n verifies them.)

Then add a credential **Avoonta API** with an API key from **Avoonta > Connect & Billing > API keys**. Keys starting `av_test_` place test calls only: nobody is dialed and nothing is charged. Leave **Base URL** as `https://api.avoonta.com` unless you were given a different API address.

## What it does

| Node | Resource | Operation | API |
|---|---|---|---|
| Avoonta | Call | **Call a Lead**: your AI agent calls the lead in seconds | `POST /v1/orders` |
| Avoonta | Call | **Get**: a call by order ID, with status, outcome, recording and transcript (an unknown ID returns no item) | `GET /v1/orders/{id}` |
| Avoonta | Agent | **Get Many**: your agents that can take calls (also the Agent dropdowns) | `GET /v1/agents` |
| Avoonta | Wallet | **Get Balance**: the wallet balance in cents and dollars | `GET /v1/wallet` |
| Avoonta Trigger | | **Call Finished** (polling): an AI agent finished calling a lead. Optional Agent and Outcome filters. Each call fires once. | `GET /v1/orders?status=BOOKED,QUALIFIED,DISQUALIFIED,VOICEMAIL_SMS_SENT,FAILED` |

The credential is tested with `GET /v1/me` and sends `Authorization: Bearer <key>`.

## Rules this node keeps (same as the Zapier app in `integrations/zapier`)

- **Consent:** Call a Lead refuses before sending anything unless **This Lead Agreed to Be Called and Texted by an AI Assistant** is on and **Consent Source** is filled in (the form URL or a short description). **Consented At** is optional; map the form submission time, otherwise the time of the step is sent. Only turn consent on for leads who really agreed.
- **No double calls:** the `Idempotency-Key` is `n8n_` + 48 hex of a SHA-256 of agent, normalized phone and one scope: the External Reference ID if set, else Consented At, else the workflow ID plus today's UTC date. A re-run of the same item sends the same key, and the API returns the first order. Without an External Reference ID or Consented At, the same agent and phone is called at most once a day from one workflow.
- **Phones:** a US 10-digit number (or 11 digits starting with 1, with any spaces, dashes, dots or brackets) becomes `+1XXXXXXXXXX`. Anything else is sent as typed, and the API says what is wrong.
- **Notes for the Agent** map to `lead.custom_context` (up to 2,000 characters). Empty optional fields are left out. Follow-Up Plan options left out use the agent's own plan.
- **Errors:** `{success:false, error, message}` (or any HTTP 4xx/5xx) becomes a `NodeApiError` with the API's message; the error code is in the description. A 401 says the API key was not accepted. A 429 with `Retry-After` of 30 seconds or less is waited out and retried once; a longer one fails at once and says when to retry. With **Continue On Fail**, the error becomes an item.
- **Trigger:** the first poll after the workflow is activated only remembers existing finished calls (up to 100), so old calls do not fire. Later polls fire new ones, oldest first. Up to 1,000 order IDs are remembered. **Fetch Test Event** returns the newest finished call and remembers nothing.

## Develop

Node.js **22.12 or newer** (the `n8n-node` CLI needs it; 22.1 fails with `ERR_REQUIRE_ESM`).

```sh
cd integrations/n8n
npm ci
npm run lint     # n8n-node lint (n8n's community node rules)
npm run build    # n8n-node build -> dist/
npm test         # node:test against dist/, no network
npm run dev      # optional: starts a local n8n with this node at http://localhost:5678
```

`live-test.mjs` runs the built node against the real API with a **test** key from the environment (it refuses any key that is not `av_test_`). It places one simulated test call to a fictional 555 number; nobody is dialed and nothing is charged:

```sh
npm run build
AVOONTA_API_KEY=av_test_... node live-test.mjs
```

## Publish to npm (owner)

The package is not published by Claude. From a machine with Node 22.12+:

```sh
cd integrations/n8n
npm ci
npm run lint
npm run build
npm test
npm pack --dry-run          # check: only dist/, README.md, LICENSE, package.json
npm login                   # your npm account
npm publish --access public # prepublishOnly re-runs lint, build and test
```

PowerShell is the same commands, one per line (or joined with `;`).

To ship a new version later: change the code, bump `version` in `package.json` and add a line to `CHANGELOG.md`, then build, test and `npm publish --access public` again. Self-hosted n8n users update from **Settings > Community Nodes**.

### Optional: n8n verification (shows the node on n8n Cloud and in the nodes panel)

1. Since 1 May 2026, n8n only verifies community nodes that are published **from GitHub Actions with npm provenance**. So first put this folder in a public GitHub repository (or publish from this repo with a workflow whose working directory is `integrations/n8n`), and publish with `npm publish --provenance --access public` from that workflow (the n8n starter's `publish.yml`, using npm Trusted Publishing or an `NPM_TOKEN` secret). The `repository` field in `package.json` must then point at that GitHub repository.
2. Submit the package in the n8n Creator Portal (sign in with the community.n8n.io account) and follow n8n's review. n8n checks the same lint rules as `npm run lint`, no runtime dependencies, and the UX guidelines.

## Files

- `credentials/AvoontaApi.credentials.ts`: the "Avoonta API" credential (API key, Base URL, Bearer auth, test `GET /v1/me`).
- `nodes/Avoonta/Avoonta.node.ts`: the action node; `GenericFunctions.ts`: requests, errors, consent, idempotency, phone.
- `nodes/AvoontaTrigger/AvoontaTrigger.node.ts`: the polling trigger.
- `icons/`: the node and credential icons (light and dark).
- `test/nodes.test.js`: offline tests; `live-test.mjs`: live smoke test with a test key.

## License

MIT
