// Live smoke test of the built n8n node against the real API, with a TEST key
// (av_test_ only: nobody is dialed, nothing is charged; a test order is a
// simulated call).
//
//     npm run build
//     AVOONTA_API_KEY=av_test_... node live-test.mjs          (bash)
//     $env:AVOONTA_API_KEY='av_test_...'; node live-test.mjs  (PowerShell)
//
// Optional: AVOONTA_API_BASE (default https://api.avoonta.com).
//
// It runs the node's own code (dist/) with a small stand-in for n8n's request
// helper that adds the Bearer header the way the "Avoonta API" credential does.
// The key is read from the environment only, and never printed or saved.
// The lead is a fictional 555 number.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Avoonta } = require('./dist/nodes/Avoonta/Avoonta.node.js');
const { AvoontaTrigger } = require('./dist/nodes/AvoontaTrigger/AvoontaTrigger.node.js');

const KEY = String(process.env.AVOONTA_API_KEY ?? '').trim();
const BASE = String(process.env.AVOONTA_API_BASE ?? 'https://api.avoonta.com').replace(/\/+$/, '');
if (!KEY) throw new Error('Set AVOONTA_API_KEY to an av_test_ key.');
if (!KEY.startsWith('av_test_'))
	throw new Error('AVOONTA_API_KEY is not a test key (av_test_); refusing.');
const scrub = (s) => String(s).split(KEY).join('***');

/** What n8n's httpRequestWithAuthentication does, for this node's requests. */
async function httpRequestWithAuthentication(credentialName, req) {
	if (credentialName !== 'avoontaApi') throw new Error(`unexpected credential ${credentialName}`);
	const url = new URL(req.url);
	for (const [k, v] of Object.entries(req.qs ?? {})) url.searchParams.set(k, String(v));
	const headers = { ...(req.headers ?? {}), Authorization: `Bearer ${KEY}` };
	if (req.body) headers['Content-Type'] = 'application/json';
	const r = await fetch(url, {
		method: req.method,
		headers,
		body: req.body ? JSON.stringify(req.body) : undefined,
	});
	const text = await r.text();
	let body = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* not JSON */
	}
	sent.push({
		method: req.method,
		url: url.toString(),
		headers: req.headers,
		body: req.body,
		status: r.status,
	});
	return { statusCode: r.status, headers: Object.fromEntries(r.headers), body };
}
let sent = [];

function context(params, { mode = 'trigger', staticData = {} } = {}) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, a, b) => {
			const fallback = typeof a === 'number' ? b : a;
			return Object.prototype.hasOwnProperty.call(params, name) ? params[name] : fallback;
		},
		getNode: () => ({
			id: 'live',
			name: 'Avoonta',
			type: 'n8n-nodes-avoonta.avoonta',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		getCredentials: async () => ({ apiKey: KEY, baseUrl: BASE }),
		getWorkflow: () => ({ id: 'live_test', active: false }),
		getMode: () => mode,
		getWorkflowStaticData: () => staticData,
		continueOnFail: () => false,
		helpers: { httpRequestWithAuthentication, returnJsonArray: (l) => l.map((json) => ({ json })) },
	};
}

const node = new Avoonta();
const trigger = new AvoontaTrigger();
const exec = async (params) => {
	sent = [];
	try {
		const [out] = await node.execute.call(context(params));
		return { items: out.map((o) => o.json), error: null, sent };
	} catch (e) {
		return { items: null, error: e, sent };
	}
};

let passed = 0,
	failed = 0;
const check = (name, cond, detail = '') => {
	if (cond) passed++;
	else failed++;
	console.log(
		`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `  ${scrub(detail).slice(0, 400)}`}`,
	);
};

try {
	// The credential test request: GET /v1/me
	sent = [];
	const me = await httpRequestWithAuthentication('avoontaApi', {
		method: 'GET',
		url: `${BASE}/v1/me`,
	});
	check(
		'credential test GET /v1/me is 200 and test mode',
		me.statusCode === 200 && me.body?.key?.mode === 'test',
		JSON.stringify(me.body),
	);

	const bad = await fetch(`${BASE}/v1/me`, {
		headers: { Authorization: 'Bearer av_test_not_a_real_key' },
	});
	check('a wrong key is 401', bad.status === 401, String(bad.status));

	const agents = await exec({ resource: 'agent', operation: 'getAll' });
	check(
		'Agent > Get Many lists agents',
		Array.isArray(agents.items) &&
			agents.items.length > 0 &&
			/^agt_/.test(agents.items[0].id ?? ''),
		agents.error?.message ?? JSON.stringify(agents.items),
	);
	const agentId = agents.items?.[0]?.id;

	sent = [];
	const options = await node.methods.loadOptions.getAgents.call(context({}));
	check(
		'Agent dropdown has the same agents',
		options.length === agents.items?.length && options[0]?.value === agentId,
		JSON.stringify(options),
	);

	const wallet = await exec({ resource: 'wallet', operation: 'getBalance' });
	check(
		'Wallet > Get Balance (mode test)',
		wallet.items?.[0]?.mode === 'test' &&
			Number.isInteger(wallet.items?.[0]?.wallet?.balance_cents),
		wallet.error?.message ?? JSON.stringify(wallet.items),
	);

	const lead = {
		resource: 'call',
		operation: 'create',
		agentId,
		phone: '(415) 555-0100',
		consentConfirmed: true,
		consentSource: 'n8n node live test (test key)',
		additionalFields: {
			firstName: 'N8n',
			lastName: 'Test',
			externalReferenceId: `n8n_live_${Date.now()}`,
			notes: 'Live smoke test of the n8n node.',
		},
		cadence: {},
	};

	const refused = await exec({ ...lead, consentConfirmed: false });
	check(
		'Call a lead without consent is refused',
		/agreed to be called and texted by an AI assistant/.test(refused.error?.message ?? ''),
		refused.error?.message,
	);
	check('the refusal sends nothing', refused.sent.length === 0, JSON.stringify(refused.sent));

	const first = await exec(lead);
	const o = first.items?.[0];
	check(
		'Call a lead returns success, test:true, an ord_ id',
		o?.success === true && o?.test === true && /^ord_/.test(o?.order_id ?? ''),
		first.error?.message ?? JSON.stringify(o),
	);
	check(
		'phone (415) 555-0100 sent as +14155550100',
		first.sent[0]?.body?.lead?.phone === '+14155550100',
		JSON.stringify(first.sent[0]?.body),
	);
	check(
		'notes sent as lead.custom_context',
		first.sent[0]?.body?.lead?.custom_context === 'Live smoke test of the n8n node.',
		JSON.stringify(first.sent[0]?.body),
	);
	const idem = first.sent[0]?.headers?.['Idempotency-Key'];
	check('Idempotency-Key is n8n_ + 48 hex', /^n8n_[0-9a-f]{48}$/.test(idem ?? ''), String(idem));

	const again = await exec(lead);
	check(
		'the same input again returns the same order',
		again.items?.[0]?.order_id === o?.order_id &&
			again.sent[0]?.headers?.['Idempotency-Key'] === idem,
		again.error?.message ?? JSON.stringify(again.items),
	);

	const got = await exec({ resource: 'call', operation: 'get', orderId: o?.order_id });
	check(
		'Call > Get returns the order',
		got.items?.[0]?.order_id === o?.order_id && got.items?.[0]?.id === o?.order_id,
		got.error?.message ?? JSON.stringify(got.items).slice(0, 300),
	);

	const missing = await exec({
		resource: 'call',
		operation: 'get',
		orderId: 'ord_00000000000000000000000000000000',
	});
	check(
		'Call > Get of an unknown id returns no item',
		Array.isArray(missing.items) && missing.items.length === 0,
		missing.error?.message ?? JSON.stringify(missing.items),
	);

	sent = [];
	const manual = await trigger.poll.call(context({}, { mode: 'manual' }));
	const ev = manual?.[0]?.[0]?.json;
	check(
		'Trigger (manual) gives a finished call, or none yet',
		manual === null ||
			(ev?.id &&
				['BOOKED', 'QUALIFIED', 'DISQUALIFIED', 'VOICEMAIL_SMS_SENT', 'FAILED'].includes(
					ev.status,
				)),
		JSON.stringify(ev).slice(0, 300),
	);
	check(
		'Trigger leaves out an unset agent filter',
		!/agent_id=/.test(sent[0]?.url ?? ''),
		String(sent[0]?.url),
	);

	const staticData = {};
	const firstPoll = await trigger.poll.call(context({}, { staticData }));
	check(
		'Trigger first run fires nothing and remembers ids',
		firstPoll === null && Array.isArray(staticData.seenIds),
		JSON.stringify(staticData).slice(0, 200),
	);
} catch (e) {
	failed++;
	console.log(`  FAIL ${scrub(e?.stack ?? e)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
