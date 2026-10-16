import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { getAgents } from '../Avoonta/Avoonta.node';
import {
	avoontaApiRequest,
	FINISHED_STATUSES,
	LIST_KEYS,
	throwIfApiError,
	toOrderItem,
} from '../Avoonta/GenericFunctions';

// How many order ids are remembered to fire each finished call once.
const SEEN_LIMIT = 1000;

export class AvoontaTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Avoonta Trigger',
		name: 'avoontaTrigger',
		icon: { light: 'file:../../icons/avoonta.svg', dark: 'file:../../icons/avoonta.dark.svg' },
		group: ['trigger'],
		version: [1],
		description: 'Starts the workflow when an AI agent finishes calling a lead',
		subtitle: 'Call finished',
		defaults: {
			name: 'Avoonta Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'avoontaApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Call Finished',
						value: 'callFinished',
						description: 'An AI agent finished calling a lead (a final outcome)',
					},
				],
				default: 'callFinished',
			},
			{
				displayName: 'Agent Name or ID',
				name: 'agentId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getAgents' },
				default: '',
				description:
					'Only calls by this agent. Leave empty for every agent. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Outcome',
				name: 'status',
				type: 'options',
				options: [
					{ name: 'Any Finished Call', value: '' },
					{ name: 'Booked an Appointment', value: 'BOOKED' },
					{ name: 'Failed (No Conversation)', value: 'FAILED' },
					{ name: 'No Answer, Text Sent', value: 'VOICEMAIL_SMS_SENT' },
					{ name: 'Not Qualified', value: 'DISQUALIFIED' },
					{ name: 'Qualified (No Booking)', value: 'QUALIFIED' },
				],
				default: '',
				description: 'Only calls with this outcome',
			},
		],
	};

	methods = {
		loadOptions: { getAgents },
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const agentId = String(this.getNodeParameter('agentId', '') ?? '').trim();
		const status = String(this.getNodeParameter('status', '') ?? '').trim();
		const statuses = status ? [status] : FINISHED_STATUSES;

		const manual = this.getMode() === 'manual';
		const staticData = this.getWorkflowStaticData('node') as { seenIds?: string[] };
		const firstRun = !Array.isArray(staticData.seenIds);

		const qs: IDataObject = {
			status: statuses.join(','),
			// The first run only remembers what already exists, so it reads more.
			limit: firstRun && !manual ? 100 : 50,
		};
		if (agentId) qs.agent_id = agentId;

		const body = throwIfApiError.call(
			this,
			await avoontaApiRequest.call(this, 'GET', '/v1/orders', { qs }),
		);
		// The API is asked for finished orders only; this keeps it so even if a
		// status filter were ignored, because each order fires once.
		const orders = ((body[LIST_KEYS.orders] as IDataObject[] | undefined) ?? []).filter((o) =>
			statuses.includes(String(o.status)),
		);

		// "Fetch Test Event": the newest finished call, and nothing is remembered.
		if (manual) {
			return orders.length ? [this.helpers.returnJsonArray([toOrderItem(orders[0])])] : null;
		}

		const seen = new Set(staticData.seenIds ?? []);
		const ids = orders.map((o) => String(o.order_id));
		staticData.seenIds = [...new Set([...ids, ...(staticData.seenIds ?? [])])].slice(0, SEEN_LIMIT);

		// The first run after activation fires nothing: calls that finished before
		// the workflow was turned on are not new.
		if (firstRun) return null;

		const fresh = orders.filter((o) => !seen.has(String(o.order_id)));
		if (!fresh.length) return null;
		// The API lists newest first; fire oldest first.
		return [this.helpers.returnJsonArray(fresh.reverse().map(toOrderItem))];
	}
}
