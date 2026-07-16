import axios from 'axios';
import {
  getAccessToken,
  invalidateAccessToken,
  TriumphAuthError,
} from './auth.js';

const BASE_URL = 'https://api-gateway.triumphbcap.com';
const DEFAULT_CLIENT_ID = '126906';
const REQUEST_TIMEOUT_MS = 20_000;

export class TriumphApiError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name = 'TriumphApiError';
    this.code = code;
    this.status = status;
  }
}

function getConfig() {
  const clientId = (process.env.TRIUMPH_CLIENT_ID || DEFAULT_CLIENT_ID).trim();

  if (!clientId) {
    throw new TriumphApiError(
      'TRIUMPH_CLIENT_ID is missing from the environment.',
      'CONFIG',
    );
  }

  return { clientId };
}

async function createClient(forceRefresh = false) {
  const { clientId } = getConfig();
  const token = await getAccessToken({ forceRefresh });

  return axios.create({
    baseURL: BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${token}`,
      clientId,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Origin: 'https://www.mytriumph.com',
      Referer: 'https://www.mytriumph.com/',
    },
  });
}

function normalizeApiError(error) {
  if (error instanceof TriumphApiError) return error;

  if (error instanceof TriumphAuthError) {
    if (error.code === 'AUTH_CONFIG' || error.code === 'REFRESH_TOKEN_MISSING') {
      return new TriumphApiError(error.message, 'AUTH_SETUP', error.status);
    }
    if (error.code === 'AUTH_NETWORK') {
      return new TriumphApiError(error.message, 'NETWORK', error.status);
    }
    return new TriumphApiError(error.message, 'AUTH', error.status);
  }

  const status = error.response?.status ?? null;

  if (status === 401 || status === 403) {
    return new TriumphApiError(
      'The Triumph session is expired or is not authorized for this account.',
      'AUTH',
      status,
    );
  }

  if (status === 429) {
    return new TriumphApiError(
      'Triumph is temporarily rate-limiting requests.',
      'RATE_LIMIT',
      status,
    );
  }

  if (axios.isAxiosError(error) && !error.response) {
    return new TriumphApiError(
      'Could not connect to Triumph.',
      'NETWORK',
    );
  }

  return new TriumphApiError(
    'Triumph could not complete the credit check.',
    'API',
    status,
  );
}

async function apiRequest(request) {
  try {
    const client = await createClient();

    try {
      return await request(client);
    } catch (error) {
      const status = error.response?.status;
      if (status !== 401 && status !== 403) throw error;

      invalidateAccessToken();
      const refreshedClient = await createClient(true);
      return await request(refreshedClient);
    }
  } catch (error) {
    throw normalizeApiError(error);
  }
}

export function normalizeMC(value) {
  const digits = String(value ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits || '0';
}

export function getSearchResults(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

export function findExactMC(payload, mcNumber) {
  const requestedMC = normalizeMC(mcNumber);
  return getSearchResults(payload).find((result) => {
    const docket = result?.docket ?? result?.mcNumber ?? result?.mc;
    return normalizeMC(docket) === requestedMC;
  }) ?? null;
}

export async function searchMC(mcNumber) {
  const response = await apiRequest((client) => client.post(
    '/credits/creditcheck/risk-entity/search',
    {
      searchTerm: String(mcNumber),
      pagination: {
        page: 1,
        size: 10,
        includeTotalCount: true,
      },
      searchableFields: ['MC', 'FF', 'legalName', 'dBAName', 'OtherName'],
    },
    {
      headers: {
        'api-version': '2.0',
      },
    },
  ));

  return response.data;
}

export async function getCreditCheck(riskEntityId, loadAmount = null) {
  const params = { riskEntityId: String(riskEntityId) };

  if (loadAmount !== null && loadAmount !== undefined) {
    params.newCreditLimit = String(loadAmount);
  }

  const response = await apiRequest((client) => client.get(
    '/credits/creditcheck',
    { params },
  ));

  return response.data;
}
