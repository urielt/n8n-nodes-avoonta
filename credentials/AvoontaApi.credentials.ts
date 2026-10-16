import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class AvoontaApi implements ICredentialType {
	name = 'avoontaApi';

	displayName = 'Avoonta API';

	icon: Icon = { light: 'file:../icons/avoonta.svg', dark: 'file:../icons/avoonta.dark.svg' };

	documentationUrl = 'https://avoonta.com/docs/authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Find your key in Avoonta > Connect & Billing > API keys. Keys starting av_test_ place test calls only.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.avoonta.com',
			description: 'The API address. Leave as is unless you were given a different one.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{String($credentials.apiKey).trim()}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{String($credentials.baseUrl || "https://api.avoonta.com").trim()}}',
			url: '/v1/me',
		},
	};
}
