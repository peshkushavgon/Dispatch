import fs from 'fs';
import path from 'path';

const DEFAULT_ISSUER = 'https://triumphext.okta.com/oauth2/default';
const DEFAULT_OAUTH_CLIENT_ID = '0oa4kpxnmr1jvq2ZT697';
const REFRESH_TIMEOUT_MS = 20_000;
const EXPIRY_SAFETY_SECONDS = 120;

let authStateLoaded = false;
let accessToken = null;
let refreshToken = null;
let refreshPromise = null;

export class TriumphAuthError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name = 'TriumphAuthError';
    this.code = code;
    this.status = status;
  }
}

function cleanToken(value) {
  return String(value ?? '').replace(/^Bearer\s+/i, '').trim() || null;
}

function getIssuer() {
  return (process.env.TRIUMPH_OKTA_ISSUER || DEFAULT_ISSUER).replace(/\/$/, '');
}

function getOAuthClientId() {
  return (process.env.TRIUMPH_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID).trim();
}

function getTokenStorePath() {
  return process.env.TRIUMPH_TOKEN_STORE_PATH
    ? path.resolve(process.env.TRIUMPH_TOKEN_STORE_PATH)
    : path.resolve(process.cwd(), '.triumph-tokens.json');
}

export function getJwtExpiration(token) {
  try {
    const parts = cleanToken(token)?.split('.') ?? [];
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

export function isAccessTokenFresh(token, nowSeconds = Date.now() / 1000) {
  const expiresAt = getJwtExpiration(token);
  return expiresAt !== null && expiresAt > nowSeconds + EXPIRY_SAFETY_SECONDS;
}

function readStoredTokens() {
  try {
    const storePath = getTokenStorePath();
    if (!fs.existsSync(storePath)) return null;

    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (
      stored.issuer !== getIssuer()
      || stored.oauthClientId !== getOAuthClientId()
    ) {
      return null;
    }

    return {
      accessToken: cleanToken(stored.accessToken),
      refreshToken: cleanToken(stored.refreshToken),
    };
  } catch (error) {
    console.error(`[TRIUMPH AUTH] Could not read token store: ${error.message}`);
    return null;
  }
}

function loadAuthState() {
  if (authStateLoaded) return;

  accessToken = cleanToken(process.env.TRIUMPH_TOKEN);
  refreshToken = cleanToken(process.env.TRIUMPH_REFRESH_TOKEN);

  const stored = readStoredTokens();
  if (stored?.refreshToken) refreshToken = stored.refreshToken;
  if (stored?.accessToken && isAccessTokenFresh(stored.accessToken)) {
    accessToken = stored.accessToken;
  }

  authStateLoaded = true;
}

function persistTokens() {
  const storePath = getTokenStorePath();
  const temporaryPath = `${storePath}.tmp`;
  const directory = path.dirname(storePath);

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify({
      issuer: getIssuer(),
      oauthClientId: getOAuthClientId(),
      accessToken,
      refreshToken,
      updatedAt: new Date().toISOString(),
    }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.renameSync(temporaryPath, storePath);
  fs.chmodSync(storePath, 0o600);
}

async function parseErrorResponse(response) {
  try {
    const payload = await response.json();
    return payload?.error ?? null;
  } catch {
    return null;
  }
}

async function requestNewTokens() {
  loadAuthState();

  if (!refreshToken) {
    if (accessToken) {
      throw new TriumphAuthError(
        'The access token expired and TRIUMPH_REFRESH_TOKEN is not configured.',
        'REFRESH_TOKEN_MISSING',
      );
    }

    throw new TriumphAuthError(
      'Neither TRIUMPH_TOKEN nor TRIUMPH_REFRESH_TOKEN is configured.',
      'AUTH_CONFIG',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: getOAuthClientId(),
      refresh_token: refreshToken,
    });

    const response = await fetch(`${getIssuer()}/v1/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const oauthError = await parseErrorResponse(response);
      if (oauthError === 'invalid_grant' || response.status === 401) {
        throw new TriumphAuthError(
          'The Triumph refresh session is no longer valid.',
          'REAUTH_REQUIRED',
          response.status,
        );
      }

      throw new TriumphAuthError(
        'Triumph rejected the token renewal request.',
        'AUTH_API',
        response.status,
      );
    }

    const payload = await response.json();
    const nextAccessToken = cleanToken(payload.access_token);
    if (!nextAccessToken) {
      throw new TriumphAuthError(
        'Triumph renewed the session without returning an access token.',
        'AUTH_API',
        response.status,
      );
    }

    accessToken = nextAccessToken;
    refreshToken = cleanToken(payload.refresh_token) || refreshToken;

    try {
      persistTokens();
    } catch (error) {
      console.error(`[TRIUMPH AUTH] Could not persist rotated tokens: ${error.message}`);
    }

    return accessToken;
  } catch (error) {
    if (error instanceof TriumphAuthError) throw error;

    throw new TriumphAuthError(
      'Could not connect to Triumph authentication.',
      'AUTH_NETWORK',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAccessToken({ forceRefresh = false } = {}) {
  loadAuthState();

  if (!forceRefresh && isAccessTokenFresh(accessToken)) {
    return accessToken;
  }

  if (!refreshPromise) {
    refreshPromise = requestNewTokens().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

export function invalidateAccessToken() {
  accessToken = null;
}
