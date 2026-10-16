import { createHash } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

// Same behaviour as the Zapier app (integrations/zapier): keep the two in step.

export const DEFAULT_BASE_URL = 'https://api.avoonta.com';

// The key that holds the list in each list response.
export const LIST_KEYS = {
	agents: 'agents',
	orders: 'orders',
} as const;

// Final order statuses (call_orders.status; docs "Order lifecycle").
// VOICEMAIL_SMS_SENT is final only when no attempts are left; otherwise the
// order moves straight on to RETRY_SCHEDULED, so a listed one is final.
export const FINISHED_STATUSES = [
	'BOOKED',
	'QUALIFIED',
	'DISQUALIFIED',
	'VOICEMAIL_SMS_SENT',
	'FAILED',
];

// A 429 whose Retry-After is this short is waited out and retried once.
const MAX_RETRY_WAIT_SECONDS = 30;

export const CONSENT_REFUSAL =
	'Avoonta only calls leads who agreed to be called and texted by an AI assistant. ' +
	'Turn on "This Lead Agreed to Be Called and Texted by an AI Assistant", and only for leads who did.';

export const CONSENT_SOURCE_REQUIRED =
	'Consent Source is required: the form URL or a description of where the lead agreed.';

type Context = IExecuteFunctions | IPollFunctions | ILoadOptionsFunctions;

export interface ApiResponse {
	statusCode: number;
	headers: IDataObject;
	body: unknown;
}

export const isBlank = (v: unknown): boolean =>
	v === undefined || v === null || String(v).trim() === '';

/** Booleans arrive as true/false, or from expressions as "true"/"yes". */
export const isTrue = (v: unknown): boolean =>
	v === true || (typeof v === 'string' && /^(true|yes)$/i.test(v.trim()));

/** The credential's base URL without a trailing slash; empty means the public host. */
export const baseUrlOf = (raw: unknown): string => {
	const s = String(raw ?? '')
		.trim()
		.replace(/\/+$/, '');
	return s || DEFAULT_BASE_URL;
};

/**
 * A phone number as the API wants it. "+" numbers keep their digits; a plain
 * US 10-digit number, or 11 digits starting with 1, becomes +1XXXXXXXXXX.
 * Anything else is passed on trimmed, and the API explains what is wrong.
 */
export const normalizePhone = (raw: unknown): string => {
	const s = String(raw ?? '').trim();
	const digits = s.replace(/[\s().-]/g, '');
	if (/^\+\d+$/.test(digits)) return digits;
	if (/^\d{10}$/.test(digits)) return `+1${digits}`;
	if (/^1\d{10}$/.test(digits)) return `+${digits}`;
	return s;
};

/** A date field as text: n8n may hand over a Luxon DateTime or a Date. */
export const dateText = (v: unknown): string | undefined => {
	if (isBlank(v)) return undefined;
	if (v instanceof Date) return v.toISOString();
	if (
		typeof v === 'object' &&
		v !== null &&
		typeof (v as { toISO?: unknown }).toISO === 'function'
	) {
		return String((v as { toISO: () => string }).toISO());
	}
	return String(v).trim();
};

export interface CallLeadInput {
	agentId: string;
	phone: string;
	consentSource: string;
	firstName?: string;
	lastName?: string;
	email?: string;
	company?: string;
	notes?: string;
	externalReferenceId?: string;
	consentedAt?: string;
	maxAttempts?: number | string;
	retryIntervalMinutes?: number | string;
	sendSmsOnVoicemail?: boolean | string;
}

/**
 * The Idempotency-Key for one "Call a lead" run. The same inputs always give
 * the same key, so a retried or re-run execution returns the first order
 * instead of calling the lead twice.
 *
 * Scope, most specific first: the External Reference ID, else the consent
 * time, else this workflow and today's UTC date (keys never expire on the
 * API, so without a date the same phone could never be called again from this
 * workflow).
 */
export const idempotencyKey = (
	input: Pick<CallLeadInput, 'agentId' | 'externalReferenceId' | 'consentedAt'>,
	phone: string,
	workflowId: string | undefined,
	now: Date = new Date(),
): string => {
	let scope: string;
	if (!isBlank(input.externalReferenceId)) {
		scope = `ref:${String(input.externalReferenceId).trim()}`;
	} else if (!isBlank(input.consentedAt)) {
		scope = `consent:${String(input.consentedAt).trim()}`;
	} else {
		scope = `wf:${workflowId || 'noworkflow'}:${now.toISOString().slice(0, 10)}`;
	}
	const hash = createHash('sha256')
		.update(JSON.stringify([String(input.agentId || '').trim(), phone, scope]))
		.digest('hex');
	return `n8n_${hash.slice(0, 48)}`;
};

/** The POST /v1/orders body. Empty optional fields are left out. */
export const buildOrderBody = (input: CallLeadInput, phone: string, now: Date = new Date()) => {
	const lead: IDataObject = { phone };
	const leadFields: IDataObject = {
		first_name: input.firstName,
		last_name: input.lastName,
		email: input.email,
		company: input.company,
		custom_context: input.notes,
	};
	for (const [k, v] of Object.entries(leadFields)) {
		if (!isBlank(v)) lead[k] = String(v).trim();
	}

	const body: IDataObject = {
		agent_id: String(input.agentId).trim(),
		lead,
		consent: {
			opt_in_confirmed: true,
			consented_at: isBlank(input.consentedAt)
				? now.toISOString()
				: String(input.consentedAt).trim(),
			source: String(input.consentSource).trim(),
		},
	};

	const cadence: IDataObject = {};
	if (!isBlank(input.maxAttempts)) cadence.max_attempts = parseInt(String(input.maxAttempts), 10);
	if (!isBlank(input.retryIntervalMinutes)) {
		cadence.retry_interval_minutes = parseInt(String(input.retryIntervalMinutes), 10);
	}
	if (!isBlank(input.sendSmsOnVoicemail)) {
		cadence.send_sms_on_voicemail = isTrue(input.sendSmsOnVoicemail);
	}
	if (Object.keys(cadence).length) body.cadence = cadence;

	if (!isBlank(input.externalReferenceId)) {
		body.external_reference_id = String(input.externalReferenceId).trim();
	}
	return body;
};

/** The transcript as plain lines, for steps that want one text field. */
export const transcriptText = (transcript: unknown): string =>
	Array.isArray(transcript)
		? transcript
				.map((t: IDataObject) => `${t.role === 'user' ? 'Lead' : 'Agent'}: ${String(t.text ?? '')}`)
				.join('\n')
		: '';

/** An API order as an n8n item: "id" for dedupe, plus a text transcript. */
export const toOrderItem = (order: IDataObject): IDataObject => ({
	...order,
	id: order.order_id ?? order.id,
	transcript_text: transcriptText(order.transcript),
});

/** Retry-After in seconds (a number of seconds or an HTTP date), if present. */
export const retryAfterSeconds = (headers: IDataObject | undefined, now = Date.now()) => {
	const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
	if (isBlank(raw)) return undefined;
	const s = String(raw).trim();
	if (/^\d+$/.test(s)) return parseInt(s, 10);
	const at = Date.parse(s);
	return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
};

const bodyOf = (raw: unknown): IDataObject | null => {
	if (raw && typeof raw === 'object') return raw as IDataObject;
	if (typeof raw === 'string' && raw.trim()) {
		try {
			return JSON.parse(raw) as IDataObject;
		} catch {
			return null;
		}
	}
	return null;
};

/**
 * One API request with the "Avoonta API" credential. The HTTP status is read
 * here, not thrown by n8n. A 429 with a short Retry-After is waited out once.
 */
export async function avoontaApiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	options: { body?: IDataObject; qs?: IDataObject; headers?: IDataObject } = {},
): Promise<ApiResponse> {
	const credentials = await this.getCredentials('avoontaApi');
	const request: IHttpRequestOptions = {
		method,
		url: `${baseUrlOf(credentials.baseUrl)}${path}`,
		headers: { Accept: 'application/json', ...(options.headers ?? {}) },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (options.qs) request.qs = options.qs;
	if (options.body) request.body = options.body;

	for (let attempt = 0; ; attempt++) {
		const response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'avoontaApi',
			request,
		)) as ApiResponse;
		if (response.statusCode === 429 && attempt === 0) {
			const wait = retryAfterSeconds(response.headers);
			if (wait !== undefined && wait <= MAX_RETRY_WAIT_SECONDS) {
				await sleep(wait * 1000);
				continue;
			}
		}
		return response;
	}
}

/**
 * The parsed body, or a NodeApiError for a failed request
 * ({success:false, error, message} or any HTTP 4xx/5xx).
 */
export function throwIfApiError(
	this: Context,
	response: ApiResponse,
	itemIndex?: number,
): IDataObject {
	const body = bodyOf(response.body);
	const status = response.statusCode;
	const failed = status >= 400 || (body !== null && body.success === false);
	if (!failed) return body ?? {};

	const apiMessage =
		(body && typeof body.message === 'string' && body.message) ||
		`Avoonta returned HTTP ${status}.`;
	const code = (body && typeof body.error === 'string' && body.error) || 'http_error';

	let message = apiMessage;
	let description = `Error code: ${code}`;
	if (status === 401) {
		message = `Your Avoonta API key was not accepted. ${apiMessage}`;
		description =
			'Check the API key in the Avoonta API credential, or create a new one in Avoonta > Connect & Billing > API keys.';
	} else if (status === 429) {
		const wait = retryAfterSeconds(response.headers);
		message = `Too many requests to Avoonta. ${apiMessage}`;
		description =
			wait !== undefined ? `Retry after ${wait} seconds.` : 'Wait a moment, then retry.';
	}

	throw new NodeApiError(this.getNode(), (body ?? { status }) as JsonObject, {
		message,
		description,
		httpCode: String(status),
		itemIndex,
	});
}
