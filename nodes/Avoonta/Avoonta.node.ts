import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	avoontaApiRequest,
	buildOrderBody,
	CONSENT_REFUSAL,
	CONSENT_SOURCE_REQUIRED,
	dateText,
	idempotencyKey,
	isBlank,
	isTrue,
	LIST_KEYS,
	normalizePhone,
	throwIfApiError,
	toOrderItem,
	type CallLeadInput,
} from './GenericFunctions';

/** GET /v1/agents, for the Agent dropdowns of both nodes. */
export async function getAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const body = throwIfApiError.call(this, await avoontaApiRequest.call(this, 'GET', '/v1/agents'));
	const agents = (body[LIST_KEYS.agents] as IDataObject[] | undefined) ?? [];
	return agents.map((a) => ({
		name: a.label ? `${String(a.name)} (${String(a.label)})` : String(a.name),
		value: String(a.id),
	}));
}

export class Avoonta implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Avoonta',
		name: 'avoonta',
		icon: { light: 'file:../../icons/avoonta.svg', dark: 'file:../../icons/avoonta.dark.svg' },
		group: ['output'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Your AI voice agent calls a new lead in seconds',
		defaults: {
			name: 'Avoonta',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'avoontaApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Agent', value: 'agent' },
					{ name: 'Call', value: 'call' },
					{ name: 'Wallet', value: 'wallet' },
				],
				default: 'call',
			},

			// ---------------- Call ----------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['call'] } },
				options: [
					{
						name: 'Call a Lead',
						value: 'create',
						description: 'Your AI agent calls the lead in seconds',
						action: 'Call a lead now',
					},
					{
						name: 'Get',
						value: 'get',
						description:
							'Get a call by its order ID, with its status, outcome, recording and transcript',
						action: 'Get a call',
					},
				],
				default: 'create',
			},
			{
				displayName: 'Agent Name or ID',
				name: 'agentId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getAgents' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['call'], operation: ['create'] } },
				description:
					'The AI agent that makes the call. It must be switched on and published. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Phone',
				name: 'phone',
				type: 'string',
				required: true,
				default: '',
				placeholder: '+14155550199',
				displayOptions: { show: { resource: ['call'], operation: ['create'] } },
				description:
					"The lead's phone number. E.164 (+14155550199) or US format ((415) 555-0199 or 415-555-0199). US numbers only.",
			},
			{
				displayName: 'This Lead Agreed to Be Called and Texted by an AI Assistant',
				name: 'consentConfirmed',
				type: 'boolean',
				required: true,
				default: false,
				displayOptions: { show: { resource: ['call'], operation: ['create'] } },
				description:
					'Whether this lead agreed to be called and texted by an AI assistant. Required by law and by Avoonta. Turn on only when the lead gave consent, for example by ticking a consent box on your form. When off, nobody is called.',
			},
			{
				displayName: 'Consent Source',
				name: 'consentSource',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Website quote form, consent checkbox',
				displayOptions: { show: { resource: ['call'], operation: ['create'] } },
				description:
					'Where the lead agreed: the form URL, or a short description such as "Website quote form, consent checkbox"',
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['call'], operation: ['create'] } },
				options: [
					{
						displayName: 'Company',
						name: 'company',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Consented At',
						name: 'consentedAt',
						type: 'dateTime',
						default: '',
						description:
							'When the lead agreed, with a time zone. Map the form submission time. Leave empty to use the time of this step.',
					},
					{
						displayName: 'Email',
						name: 'email',
						type: 'string',
						placeholder: 'name@email.com',
						default: '',
					},
					{
						displayName: 'External Reference ID',
						name: 'externalReferenceId',
						type: 'string',
						default: '',
						description:
							'Your own ID for this lead (for example the CRM contact ID). Sent back with the call result. Also stops a re-run of this step from calling the same lead twice.',
					},
					{
						displayName: 'First Name',
						name: 'firstName',
						type: 'string',
						default: '',
						description: 'The agent greets the lead by this name',
					},
					{
						displayName: 'Last Name',
						name: 'lastName',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Notes for the Agent',
						name: 'notes',
						type: 'string',
						typeOptions: { rows: 4 },
						default: '',
						description:
							'What the lead asked for, in plain words. The agent reads it before the call. Up to 2,000 characters.',
					},
				],
			},
			{
				displayName: 'Follow-Up Plan',
				name: 'cadence',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['call'], operation: ['create'] } },
				description: "Options left out use the agent's follow-up plan",
				options: [
					{
						displayName: 'Max Attempts',
						name: 'maxAttempts',
						type: 'options',
						options: [
							{ name: '1', value: 1 },
							{ name: '2', value: 2 },
							{ name: '3', value: 3 },
						],
						default: 1,
						description: 'How many times to try if nobody answers (1 to 3)',
					},
					{
						displayName: 'Minutes Between Attempts',
						name: 'retryIntervalMinutes',
						type: 'number',
						typeOptions: { minValue: 5, maxValue: 10080 },
						default: 60,
						description: '5 to 10080 (7 days)',
					},
					{
						displayName: 'Text the Lead When Nobody Answers',
						name: 'sendSmsOnVoicemail',
						type: 'boolean',
						default: true,
						description: 'Whether to send one text with your booking link when nobody answers',
					},
				],
			},
			{
				displayName: 'Order ID',
				name: 'orderId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'ord_9b1e0c4d2a7f4e8b9c3d5a6f7e8d9c0b',
				displayOptions: { show: { resource: ['call'], operation: ['get'] } },
				description: 'The order ID from "Call a Lead". An unknown ID returns no item.',
			},

			// ---------------- Agent ----------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['agent'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List your AI agents that can take calls',
						action: 'Get many agents',
					},
				],
				default: 'getAll',
			},

			// ---------------- Wallet ----------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['wallet'] } },
				options: [
					{
						name: 'Get Balance',
						value: 'getBalance',
						description: 'Get the wallet balance in cents and dollars',
						action: 'Get the wallet balance',
					},
				],
				default: 'getBalance',
			},
		],
	};

	methods = {
		loadOptions: { getAgents },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const results: IDataObject[] = [];

				if (resource === 'call' && operation === 'create') {
					results.push(await callLead.call(this, i));
				} else if (resource === 'call' && operation === 'get') {
					const id = String(this.getNodeParameter('orderId', i, '')).trim();
					const response = await avoontaApiRequest.call(
						this,
						'GET',
						`/v1/orders/${encodeURIComponent(id)}`,
					);
					// Not found is an empty result, not an error (same as the Zapier search).
					if (response.statusCode !== 404) {
						results.push(toOrderItem(throwIfApiError.call(this, response, i)));
					}
				} else if (resource === 'agent' && operation === 'getAll') {
					const body = throwIfApiError.call(
						this,
						await avoontaApiRequest.call(this, 'GET', '/v1/agents'),
						i,
					);
					const agents = (body[LIST_KEYS.agents] as IDataObject[] | undefined) ?? [];
					for (const a of agents) {
						results.push({
							...a,
							display_name: a.label ? `${String(a.name)} (${String(a.label)})` : a.name,
						});
					}
				} else if (resource === 'wallet' && operation === 'getBalance') {
					results.push(
						throwIfApiError.call(this, await avoontaApiRequest.call(this, 'GET', '/v1/wallet'), i),
					);
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`Unknown operation "${operation}" for "${resource}".`,
						{ itemIndex: i },
					);
				}

				for (const json of results) out.push({ json, pairedItem: { item: i } });
			} catch (error) {
				// Network failures and the like arrive raw; give them the node and item.
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
				if (this.continueOnFail()) {
					out.push({ json: { error: nodeError.message }, pairedItem: { item: i } });
					continue;
				}
				throw nodeError;
			}
		}

		return [out];
	}
}

/** POST /v1/orders for one item. Consent is checked here, before any request. */
async function callLead(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	if (!isTrue(this.getNodeParameter('consentConfirmed', i, false))) {
		throw new NodeOperationError(this.getNode(), CONSENT_REFUSAL, { itemIndex: i });
	}
	const consentSource = this.getNodeParameter('consentSource', i, '') as string;
	if (isBlank(consentSource)) {
		throw new NodeOperationError(this.getNode(), CONSENT_SOURCE_REQUIRED, { itemIndex: i });
	}

	const extra = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
	const cadence = this.getNodeParameter('cadence', i, {}) as IDataObject;
	const input: CallLeadInput = {
		agentId: String(this.getNodeParameter('agentId', i, '')),
		phone: String(this.getNodeParameter('phone', i, '')),
		consentSource,
		firstName: extra.firstName as string | undefined,
		lastName: extra.lastName as string | undefined,
		email: extra.email as string | undefined,
		company: extra.company as string | undefined,
		notes: extra.notes as string | undefined,
		externalReferenceId: extra.externalReferenceId as string | undefined,
		consentedAt: dateText(extra.consentedAt),
		maxAttempts: cadence.maxAttempts as number | undefined,
		retryIntervalMinutes: cadence.retryIntervalMinutes as number | undefined,
		sendSmsOnVoicemail: cadence.sendSmsOnVoicemail as boolean | undefined,
	};

	const phone = normalizePhone(input.phone);
	const response = await avoontaApiRequest.call(this, 'POST', '/v1/orders', {
		headers: { 'Idempotency-Key': idempotencyKey(input, phone, this.getWorkflow().id) },
		body: buildOrderBody(input, phone),
	});
	return throwIfApiError.call(this, response, i);
}
