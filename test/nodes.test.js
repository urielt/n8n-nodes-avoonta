'use strict';

// No network: every request goes through a fake httpRequestWithAuthentication
// that records it and answers from a queue. Runs against the built dist/.
//
//     npm run build && npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const { Avoonta } = require('../dist/nodes/Avoonta/Avoonta.node.js');
const { AvoontaTrigger } = require('../dist/nodes/AvoontaTrigger/AvoontaTrigger.node.js');
const { AvoontaApi } = require('../dist/credentials/AvoontaApi.credentials.js');
const gf = require('../dist/nodes/Avoonta/GenericFunctions.js');
const pkg = require('../package.json');

const API = 'https://api.avoonta.com';
const AGENT = 'agt_4f2c9a1b7e3d4c5a8b6f0e1d2c3b4a59';
const ORDER = 'ord_9b1e0c4d2a7f4e8b9c3d5a6f7e8d9c0b';

const ok = (body, statusCode = 200, headers = {}) => ({ statusCode, headers, body });

const order = (over = {}) => ({
	id: ORDER,
	order_id: ORDER,
	external_reference_id: 'crm_contact_8821',
	status: 'BOOKED',
	transcript: [
		{ role: 'agent', text: 'Hi Dana.' },
		{ role: 'user', text: 'Hello.' },
	],
	test: true,
	updated_at: '2026-10-14T16:09:02.540+00:00',
	...over,
});

/** A fake n8n execute/poll/loadOptions context. */
function context({ params = {}, items = [{ json: {} }], responses = [], options = {} } = {}) {
	const calls = [];
	const staticData = options.staticData ?? {};
	const getParam = (name, a, b) => {
		// execute: (name, itemIndex, fallback); poll/loadOptions: (name, fallback)
		const fallback = typeof a === 'number' ? b : a;
		return Object.prototype.hasOwnProperty.call(params, name) ? params[name] : fallback;
	};
	return {
		calls,
		staticData,
		getInputData: () => items,
		getNodeParameter: getParam,
		getNode: () => ({
			id: 'n1',
			name: 'Avoonta',
			type: 'n8n-nodes-avoonta.avoonta',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		getCredentials: async (name) => {
			assert.equal(name, 'avoontaApi');
			return { apiKey: 'av_test_abcdefghijklmnop1234', baseUrl: options.baseUrl ?? API };
		},
		getWorkflow: () => ({ id: options.workflowId ?? 'wf_42', active: true }),
		getMode: () => options.mode ?? 'trigger',
		getWorkflowStaticData: () => staticData,
		continueOnFail: () => options.continueOnFail === true,
		helpers: {
			async httpRequestWithAuthentication(credentialName, request) {
				calls.push({ credentialName, request });
				if (!responses.length)
					throw new Error(`unexpected request ${request.method} ${request.url}`);
				return responses.shift();
			},
			returnJsonArray: (list) => list.map((json) => ({ json })),
		},
	};
}

const leadParams = (over = {}) => ({
	resource: 'call',
	operation: 'create',
	agentId: AGENT,
	phone: '(415) 555-0199',
	consentConfirmed: true,
	consentSource: 'https://acme.example/quote-form',
	additionalFields: {
		firstName: 'Dana',
		lastName: 'Reyes',
		email: 'dana@example.com',
		notes: 'Wants a roof quote after storm damage.',
		externalReferenceId: 'crm_contact_8821',
		consentedAt: '2026-10-14T09:00:00Z',
	},
	cadence: {},
	...over,
});

const run = (ctx) => new Avoonta().execute.call(ctx);

// ---------------------------------------------------------------- package

test('package.json is a valid n8n community node package', () => {
	assert.equal(pkg.name, 'n8n-nodes-avoonta');
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
	assert.deepEqual(pkg.files, ['dist', '!dist/tsconfig.tsbuildinfo']);
	assert.equal(pkg.peerDependencies['n8n-workflow'], '*');
	assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
	assert.deepEqual(pkg.n8n.credentials, ['dist/credentials/AvoontaApi.credentials.js']);
	assert.deepEqual(pkg.n8n.nodes, [
		'dist/nodes/Avoonta/Avoonta.node.js',
		'dist/nodes/AvoontaTrigger/AvoontaTrigger.node.js',
	]);
	for (const v of Object.values(pkg.devDependencies))
		assert.match(v, /^\d+\.\d+\.\d+$/, 'exact versions');
});

test('no telephony vendor name anywhere in the built code', () => {
	const vendor = new RegExp(['tel', 'nyx'].join(''), 'i');
	const fs = require('node:fs');
	const path = require('node:path');
	const walk = (d) =>
		fs
			.readdirSync(d, { withFileTypes: true })
			.flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
	for (const f of walk(path.join(__dirname, '..', 'dist'))) {
		assert.doesNotMatch(fs.readFileSync(f, 'utf8'), vendor, f);
	}
});

// ---------------------------------------------------------------- credentials

test('credential: one password API key, Bearer auth, tested with GET /v1/me', () => {
	const c = new AvoontaApi();
	assert.equal(c.name, 'avoontaApi');
	assert.equal(c.displayName, 'Avoonta API');
	const key = c.properties.find((p) => p.name === 'apiKey');
	assert.equal(key.typeOptions.password, true);
	assert.equal(key.required, true);
	const base = c.properties.find((p) => p.name === 'baseUrl');
	assert.equal(base.default, API);
	assert.match(
		c.authenticate.properties.headers.Authorization,
		/^=Bearer \{\{.*\$credentials\.apiKey.*\}\}$/,
	);
	assert.equal(c.test.request.url, '/v1/me');
	assert.match(c.test.request.baseURL, /\$credentials\.baseUrl/);
});

test('baseUrlOf: default host, trailing slash trimmed', () => {
	assert.equal(gf.baseUrlOf(''), API);
	assert.equal(gf.baseUrlOf(undefined), API);
	assert.equal(gf.baseUrlOf(' https://api.agency.example/ '), 'https://api.agency.example');
});

// ---------------------------------------------------------------- helpers

test('normalizePhone: US formats become E.164, others pass through', () => {
	assert.equal(gf.normalizePhone('(415) 555-0199'), '+14155550199');
	assert.equal(gf.normalizePhone('415.555.0199'), '+14155550199');
	assert.equal(gf.normalizePhone('1 415 555 0199'), '+14155550199');
	assert.equal(gf.normalizePhone('+1 (415) 555-0199'), '+14155550199');
	assert.equal(gf.normalizePhone(' 12345 '), '12345');
});

test('idempotencyKey: deterministic, scoped by reference, then consent time, then workflow+day', () => {
	const base = { agentId: AGENT };
	const day = new Date('2026-10-16T12:00:00Z');
	const a = gf.idempotencyKey({ ...base, externalReferenceId: 'r1' }, '+14155550199', 'wf', day);
	assert.match(a, /^n8n_[0-9a-f]{48}$/);
	assert.equal(
		a,
		gf.idempotencyKey({ ...base, externalReferenceId: ' r1 ' }, '+14155550199', 'other', day),
	);
	assert.notEqual(
		a,
		gf.idempotencyKey({ ...base, externalReferenceId: 'r2' }, '+14155550199', 'wf', day),
	);
	const c = gf.idempotencyKey(
		{ ...base, consentedAt: '2026-10-14T09:00:00Z' },
		'+14155550199',
		'wf',
		day,
	);
	assert.notEqual(a, c);
	const w1 = gf.idempotencyKey(base, '+14155550199', 'wf', day);
	assert.equal(w1, gf.idempotencyKey(base, '+14155550199', 'wf', new Date('2026-10-16T23:59:00Z')));
	assert.notEqual(
		w1,
		gf.idempotencyKey(base, '+14155550199', 'wf', new Date('2026-10-17T00:00:01Z')),
	);
	assert.notEqual(w1, gf.idempotencyKey(base, '+14155550199', 'wf2', day));
});

test('retryAfterSeconds: seconds or HTTP date', () => {
	assert.equal(gf.retryAfterSeconds({ 'retry-after': '7' }), 7);
	assert.equal(gf.retryAfterSeconds({}), undefined);
	const now = Date.parse('2026-10-16T12:00:00Z');
	assert.equal(gf.retryAfterSeconds({ 'retry-after': 'Fri, 16 Oct 2026 12:00:10 GMT' }, now), 10);
});

// ---------------------------------------------------------------- Call a lead

test('Call a lead: refuses before any request when consent is not confirmed', async () => {
	for (const consentConfirmed of [false, 'false', '', undefined]) {
		const ctx = context({ params: leadParams({ consentConfirmed }) });
		await assert.rejects(run(ctx), /agreed to be called and texted by an AI assistant/);
		assert.equal(ctx.calls.length, 0);
	}
});

test('Call a lead: refuses before any request when the consent source is empty', async () => {
	const ctx = context({ params: leadParams({ consentSource: '  ' }) });
	await assert.rejects(run(ctx), /Consent Source is required/);
	assert.equal(ctx.calls.length, 0);
});

test('Call a lead: continueOnFail turns a consent refusal into an error item', async () => {
	const ctx = context({
		params: leadParams({ consentConfirmed: false }),
		options: { continueOnFail: true },
	});
	const [out] = await run(ctx);
	assert.match(out[0].json.error, /agreed to be called/);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
	assert.equal(ctx.calls.length, 0);
});

test('Call a lead: POST /v1/orders with the body, consent and Idempotency-Key', async () => {
	const reply = {
		success: true,
		order_id: ORDER,
		status: 'QUEUED',
		estimated_dial_seconds: 15,
		wallet_balance_cents: 4850,
		test: true,
	};
	const ctx = context({ params: leadParams(), responses: [ok(reply, 202)] });
	const [out] = await run(ctx);
	assert.deepEqual(out, [{ json: reply, pairedItem: { item: 0 } }]);

	const { credentialName, request } = ctx.calls[0];
	assert.equal(credentialName, 'avoontaApi');
	assert.equal(request.method, 'POST');
	assert.equal(request.url, `${API}/v1/orders`);
	assert.equal(request.json, true);
	assert.equal(request.ignoreHttpStatusErrors, true);
	assert.deepEqual(request.body, {
		agent_id: AGENT,
		lead: {
			phone: '+14155550199',
			first_name: 'Dana',
			last_name: 'Reyes',
			email: 'dana@example.com',
			custom_context: 'Wants a roof quote after storm damage.',
		},
		consent: {
			opt_in_confirmed: true,
			consented_at: '2026-10-14T09:00:00Z',
			source: 'https://acme.example/quote-form',
		},
		external_reference_id: 'crm_contact_8821',
	});
	assert.equal(
		request.headers['Idempotency-Key'],
		gf.idempotencyKey(
			{ agentId: AGENT, externalReferenceId: 'crm_contact_8821' },
			'+14155550199',
			'wf_42',
		),
	);
	assert.equal(
		request.headers.Authorization,
		undefined,
		'auth comes from the credential, not the node',
	);
});

test('Call a lead: a re-run sends the same Idempotency-Key', async () => {
	const keys = [];
	for (let n = 0; n < 2; n++) {
		const ctx = context({
			params: leadParams(),
			responses: [ok({ success: true, order_id: ORDER })],
		});
		await run(ctx);
		keys.push(ctx.calls[0].request.headers['Idempotency-Key']);
	}
	assert.equal(keys[0], keys[1]);
});

test('Call a lead: consented_at defaults to now; cadence sent only when set (false kept)', async () => {
	const ctx = context({
		params: leadParams({
			additionalFields: {},
			cadence: { maxAttempts: 2, retryIntervalMinutes: 30, sendSmsOnVoicemail: false },
		}),
		responses: [ok({ success: true, order_id: ORDER })],
	});
	const before = Date.now();
	await run(ctx);
	const body = ctx.calls[0].request.body;
	assert.deepEqual(body.lead, { phone: '+14155550199' });
	assert.ok(Date.parse(body.consent.consented_at) >= before - 1000);
	assert.deepEqual(body.cadence, {
		max_attempts: 2,
		retry_interval_minutes: 30,
		send_sms_on_voicemail: false,
	});
	assert.equal(body.external_reference_id, undefined);
	assert.match(ctx.calls[0].request.headers['Idempotency-Key'], /^n8n_[0-9a-f]{48}$/);
});

test('Call a lead: a Luxon-like consentedAt is sent as ISO text', async () => {
	const ctx = context({
		params: leadParams({
			additionalFields: { consentedAt: { toISO: () => '2026-10-14T09:00:00.000-04:00' } },
		}),
		responses: [ok({ success: true, order_id: ORDER })],
	});
	await run(ctx);
	assert.equal(ctx.calls[0].request.body.consent.consented_at, '2026-10-14T09:00:00.000-04:00');
});

test('Call a lead: the agency base URL from the credential is used', async () => {
	const ctx = context({
		params: leadParams(),
		responses: [ok({ success: true, order_id: ORDER })],
		options: { baseUrl: 'https://api.agency.example/' },
	});
	await run(ctx);
	assert.equal(ctx.calls[0].request.url, 'https://api.agency.example/v1/orders');
});

// ---------------------------------------------------------------- errors

test('errors: {success:false, error, message} becomes a NodeApiError with the message', async () => {
	const ctx = context({
		params: leadParams(),
		responses: [
			ok(
				{ success: false, error: 'insufficient_funds', message: 'Your wallet is below $1.00.' },
				402,
			),
		],
	});
	await assert.rejects(run(ctx), (e) => {
		assert.equal(e.name, 'NodeApiError');
		assert.equal(e.message, 'Your wallet is below $1.00.');
		assert.equal(e.httpCode, '402');
		assert.match(e.description, /insufficient_funds/);
		return true;
	});
});

test('errors: success:false on a 200 is still an error', async () => {
	const ctx = context({
		params: { resource: 'wallet', operation: 'getBalance' },
		responses: [ok({ success: false, error: 'unavailable', message: 'Try later.' })],
	});
	await assert.rejects(run(ctx), /Try later\./);
});

test('errors: 401 says the API key was not accepted', async () => {
	const ctx = context({
		params: { resource: 'wallet', operation: 'getBalance' },
		responses: [ok({ success: false, error: 'unauthorized', message: 'Invalid API key.' }, 401)],
	});
	await assert.rejects(run(ctx), (e) => {
		assert.equal(e.message, 'Your Avoonta API key was not accepted. Invalid API key.');
		assert.equal(e.httpCode, '401');
		return true;
	});
});

test('errors: a 429 with a short Retry-After is waited out and retried once', async () => {
	const ctx = context({
		params: { resource: 'wallet', operation: 'getBalance' },
		responses: [
			ok({ success: false, error: 'rate_limited', message: 'Slow down.' }, 429, {
				'retry-after': '0',
			}),
			ok({ success: true, wallet: { balance_cents: 4850 } }),
		],
	});
	const [out] = await run(ctx);
	assert.equal(ctx.calls.length, 2);
	assert.equal(out[0].json.wallet.balance_cents, 4850);
});

test('errors: a 429 with a long Retry-After fails at once and says when to retry', async () => {
	const ctx = context({
		params: { resource: 'wallet', operation: 'getBalance' },
		responses: [
			ok({ success: false, error: 'rate_limited', message: 'Slow down.' }, 429, {
				'retry-after': '120',
			}),
		],
	});
	await assert.rejects(run(ctx), (e) => {
		assert.match(e.message, /Too many requests.*Slow down\./);
		assert.equal(e.description, 'Retry after 120 seconds.');
		assert.equal(e.httpCode, '429');
		return true;
	});
	assert.equal(ctx.calls.length, 1);
});

test('errors: a second 429 is not retried again', async () => {
	const ctx = context({
		params: { resource: 'wallet', operation: 'getBalance' },
		responses: [
			ok({ success: false, error: 'rate_limited', message: 'Slow down.' }, 429, {
				'retry-after': '0',
			}),
			ok({ success: false, error: 'rate_limited', message: 'Slow down.' }, 429, {
				'retry-after': '0',
			}),
		],
	});
	await assert.rejects(run(ctx), /Too many requests/);
	assert.equal(ctx.calls.length, 2);
});

// ---------------------------------------------------------------- Get, agents, wallet

test('Call > Get: GET /v1/orders/{id}, with a text transcript', async () => {
	const ctx = context({
		params: { resource: 'call', operation: 'get', orderId: ` ${ORDER} ` },
		responses: [ok(order())],
	});
	const [out] = await run(ctx);
	assert.equal(ctx.calls[0].request.method, 'GET');
	assert.equal(ctx.calls[0].request.url, `${API}/v1/orders/${ORDER}`);
	assert.equal(out[0].json.id, ORDER);
	assert.equal(out[0].json.transcript_text, 'Agent: Hi Dana.\nLead: Hello.');
});

test('Call > Get: an unknown id returns no item', async () => {
	const ctx = context({
		params: { resource: 'call', operation: 'get', orderId: 'ord_00000000000000000000000000000000' },
		responses: [ok({ success: false, error: 'not_found', message: 'No such order.' }, 404)],
	});
	const [out] = await run(ctx);
	assert.deepEqual(out, []);
});

test('Agent > Get Many: GET /v1/agents, one item per agent with a display name', async () => {
	const agents = [
		{ id: AGENT, name: 'Riley', label: 'Roofing quotes', published: true },
		{ id: 'agt_2', name: 'Sam', label: null, published: true },
	];
	const ctx = context({
		params: { resource: 'agent', operation: 'getAll' },
		responses: [ok({ success: true, agents })],
	});
	const [out] = await run(ctx);
	assert.equal(ctx.calls[0].request.url, `${API}/v1/agents`);
	assert.deepEqual(
		out.map((o) => o.json.display_name),
		['Riley (Roofing quotes)', 'Sam'],
	);
});

test('Agent dropdown (loadOptions): name and agt_ id', async () => {
	const ctx = context({
		responses: [
			ok({ success: true, agents: [{ id: AGENT, name: 'Riley', label: 'Roofing quotes' }] }),
		],
	});
	const options = await new Avoonta().methods.loadOptions.getAgents.call(ctx);
	assert.deepEqual(options, [{ name: 'Riley (Roofing quotes)', value: AGENT }]);
});

test('Wallet > Get Balance: GET /v1/wallet', async () => {
	const reply = {
		success: true,
		wallet: { balance_cents: 4850, balance: 48.5, currency: 'USD' },
		mode: 'test',
	};
	const ctx = context({
		params: { resource: 'wallet', operation: 'getBalance' },
		responses: [ok(reply)],
	});
	const [out] = await run(ctx);
	assert.equal(ctx.calls[0].request.url, `${API}/v1/wallet`);
	assert.deepEqual(out[0].json, reply);
});

test('several input items: one request each, paired items kept', async () => {
	const ctx = context({
		params: { resource: 'wallet', operation: 'getBalance' },
		items: [{ json: {} }, { json: {} }],
		responses: [ok({ success: true, wallet: {} }), ok({ success: true, wallet: {} })],
	});
	const [out] = await run(ctx);
	assert.deepEqual(
		out.map((o) => o.pairedItem),
		[{ item: 0 }, { item: 1 }],
	);
});

// ---------------------------------------------------------------- trigger

const poll = (ctx) => new AvoontaTrigger().poll.call(ctx);
const listReply = (orders) => ok({ success: true, orders });

test('trigger: is a polling trigger with no inputs', () => {
	const d = new AvoontaTrigger().description;
	assert.equal(d.polling, true);
	assert.deepEqual(d.inputs, []);
	assert.equal(d.name, 'avoontaTrigger');
});

test('trigger: asks for finished statuses; the first run remembers and fires nothing', async () => {
	const ctx = context({
		responses: [listReply([order({ order_id: 'ord_a' }), order({ order_id: 'ord_b' })])],
	});
	assert.equal(await poll(ctx), null);
	const { request } = ctx.calls[0];
	assert.equal(request.url, `${API}/v1/orders`);
	assert.deepEqual(request.qs, {
		status: 'BOOKED,QUALIFIED,DISQUALIFIED,VOICEMAIL_SMS_SENT,FAILED',
		limit: 100,
	});
	assert.deepEqual(ctx.staticData.seenIds, ['ord_a', 'ord_b']);
});

test('trigger: later runs fire each new finished call once, oldest first', async () => {
	const staticData = { seenIds: ['ord_a'] };
	const ctx = context({
		options: { staticData },
		responses: [
			listReply([
				order({ order_id: 'ord_c' }),
				order({ order_id: 'ord_b' }),
				order({ order_id: 'ord_a' }),
			]),
			listReply([
				order({ order_id: 'ord_c' }),
				order({ order_id: 'ord_b' }),
				order({ order_id: 'ord_a' }),
			]),
		],
	});
	const [items] = await poll(ctx);
	assert.deepEqual(
		items.map((i) => i.json.id),
		['ord_b', 'ord_c'],
	);
	assert.equal(items[0].json.transcript_text, 'Agent: Hi Dana.\nLead: Hello.');
	assert.equal(ctx.calls[0].request.qs.limit, 50);
	assert.equal(await poll(ctx), null, 'nothing new on the next poll');
});

test('trigger: agent and outcome filters; unfinished statuses are dropped', async () => {
	const ctx = context({
		params: { agentId: AGENT, status: 'QUALIFIED' },
		options: { staticData: { seenIds: [] } },
		responses: [
			listReply([
				order({ order_id: 'ord_q', status: 'QUALIFIED' }),
				order({ order_id: 'ord_x', status: 'CALLING' }),
			]),
		],
	});
	const [items] = await poll(ctx);
	assert.deepEqual(ctx.calls[0].request.qs, { status: 'QUALIFIED', limit: 50, agent_id: AGENT });
	assert.deepEqual(
		items.map((i) => i.json.id),
		['ord_q'],
	);
});

test('trigger: an unset agent filter is left out of the query', async () => {
	const ctx = context({
		params: { agentId: '' },
		options: { staticData: { seenIds: [] } },
		responses: [listReply([])],
	});
	await poll(ctx);
	assert.equal('agent_id' in ctx.calls[0].request.qs, false);
});

test('trigger: manual test returns the newest finished call and remembers nothing', async () => {
	const ctx = context({
		options: { mode: 'manual' },
		responses: [listReply([order({ order_id: 'ord_new' }), order({ order_id: 'ord_old' })])],
	});
	const [items] = await poll(ctx);
	assert.deepEqual(
		items.map((i) => i.json.id),
		['ord_new'],
	);
	assert.equal(ctx.staticData.seenIds, undefined);
});

test('trigger: the remembered ids are capped', async () => {
	const many = Array.from({ length: 1200 }, (_, n) => `ord_old_${n}`);
	const ctx = context({
		options: { staticData: { seenIds: many } },
		responses: [listReply([order({ order_id: 'ord_new' })])],
	});
	await poll(ctx);
	assert.equal(ctx.staticData.seenIds.length, 1000);
	assert.equal(ctx.staticData.seenIds[0], 'ord_new');
});

test('trigger: an API error is a NodeApiError', async () => {
	const ctx = context({
		responses: [ok({ success: false, error: 'unauthorized', message: 'Invalid API key.' }, 401)],
	});
	await assert.rejects(poll(ctx), /API key was not accepted/);
});
