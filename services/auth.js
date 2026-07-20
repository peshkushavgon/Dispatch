import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DEFAULT_ISSUER = 'https://triumphext.okta.com/oauth2/default';
const DEFAULT_OAUTH_CLIENT_ID = '0oa4kpxnmr1jvq2ZT697';
const REFRESH_TIMEOUT_MS = 20_000;
const TOKEN_STORE_TIMEOUT_MS = 10_000;
const TOKEN_STORE_RETRIES = 3;
const REFRESH_LOCK_TTL_MS = 90_000;
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_POLL_MS = 400;
const EXPIRY_SAFETY_SECONDS = 120;

let authStateLoaded = false;
let authStatePromise = null;
let accessToken = null;
let refreshToken = null;
let configuredRefreshToken = null;
let refreshPromise = null;
let tokensNeedPersistence = false;

export class TriumphAuthError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name = 'TriumphAuthError';
    this.code = code;
    this.status = status;
  }
}

function cleanToken(value) {
  return String(value ?? '')
    .replace(/^Bearer\s+/i, '')
    .replace(/\s+/g, '') || null;
}

function tokenFingerprint(value) {
  const token = cleanToken(value);
  return token
    ? crypto.createHash('sha256').update(token).digest('base64url')
    : null;
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

function getRemoteStoreConfig() {
  const url = String(
    process.env.UPSTASH_REDIS_REST_URL
      || process.env.TRIUMPH_TOKEN_STORE_REST_URL
      || '',
  ).trim().replace(/\/$/, '');
  const token = String(
    process.env.UPSTASH_REDIS_REST_TOKEN
      || process.env.TRIUMPH_TOKEN_STORE_REST_TOKEN
      || '',
  ).replace(/\s+/g, '');
  const encryptionSecret = String(
    process.env.TRIUMPH_TOKEN_ENCRYPTION_KEY || '',
  ).trim();
  const configuredValues = [url, token, encryptionSecret].filter(Boolean).length;

  if (configuredValues === 0) return null;
  if (configuredValues !== 3) {
    throw new TriumphAuthError(
      'Triumph durable token storage is only partially configured.',
      'TOKEN_STORE_CONFIG',
    );
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') throw new Error('HTTPS is required.');
  } catch {
    throw new TriumphAuthError(
      'The Triumph durable token store URL is invalid.',
      'TOKEN_STORE_CONFIG',
    );
  }

  return {
    url,
    token,
    encryptionKey: crypto.createHash('sha256').update(encryptionSecret).digest(),
    key: `dispatch:triumph-oauth:${getOAuthClientId()}`,
  };
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

function readStoredTokensFromFile() {
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
      environmentRefreshTokenHash: String(
        stored.environmentRefreshTokenHash || '',
      ).trim() || null,
    };
  } catch (error) {
    console.error(`[TRIUMPH AUTH] Could not read token store: ${error.message}`);
    return null;
  }
}

function encryptStoredTokens(stored, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(stored), 'utf8'),
    cipher.final(),
  ]);

  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url'),
  });
}

function decryptStoredTokens(value, encryptionKey) {
  const encrypted = JSON.parse(value);
  if (encrypted.version !== 1 || !encrypted.iv || !encrypted.tag || !encrypted.data) {
    throw new Error('Unsupported token payload.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(encrypted.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

async function runRemoteStoreCommand(config, command) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_STORE_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || payload?.error) {
      throw new TriumphAuthError(
        'Triumph durable token storage rejected a request.',
        'TOKEN_STORE',
        response.status,
      );
    }

    return payload?.result ?? null;
  } catch (error) {
    if (error instanceof TriumphAuthError) throw error;
    throw new TriumphAuthError(
      'Could not connect to Triumph durable token storage.',
      'TOKEN_STORE',
    );
  } finally {
    clearTimeout(timeout);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireRefreshLock() {
  const config = getRemoteStoreConfig();
  if (!config) return null;

  const key = `${config.key}:refresh-lock`;
  const owner = crypto.randomUUID();
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    const result = await runRemoteStoreCommand(config, [
      'SET',
      key,
      owner,
      'NX',
      'PX',
      String(REFRESH_LOCK_TTL_MS),
    ]);

    if (result === 'OK') return { config, key, owner };
    await wait(REFRESH_LOCK_POLL_MS);
  }

  throw new TriumphAuthError(
    'Timed out waiting to safely renew the Triumph session.',
    'TOKEN_STORE',
  );
}

async function releaseRefreshLock(lock) {
  if (!lock) return;

  try {
    await runRemoteStoreCommand(lock.config, [
      'EVAL',
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      '1',
      lock.key,
      lock.owner,
    ]);
  } catch (error) {
    console.error(`[TRIUMPH AUTH] Could not release refresh lock: ${error.message}`);
  }
}

async function readStoredTokensFromRemote() {
  const config = getRemoteStoreConfig();
  if (!config) return null;

  const encrypted = await runRemoteStoreCommand(config, ['GET', config.key]);
  if (!encrypted) return null;

  try {
    const stored = decryptStoredTokens(encrypted, config.encryptionKey);
    if (
      stored.issuer !== getIssuer()
      || stored.oauthClientId !== getOAuthClientId()
    ) {
      throw new Error('Stored OAuth settings do not match.');
    }

    return {
      accessToken: cleanToken(stored.accessToken),
      refreshToken: cleanToken(stored.refreshToken),
      environmentRefreshTokenHash: String(
        stored.environmentRefreshTokenHash || '',
      ).trim() || null,
    };
  } catch {
    throw new TriumphAuthError(
      'Could not decrypt the stored Triumph session.',
      'TOKEN_STORE',
    );
  }
}

function configuredTokenReplacesStoredToken(stored) {
  const configuredHash = tokenFingerprint(configuredRefreshToken);
  return Boolean(
    configuredHash
      && stored?.environmentRefreshTokenHash
      && stored.environmentRefreshTokenHash !== configuredHash,
  );
}

function applyStoredAuthState(stored) {
  if (stored?.refreshToken) refreshToken = stored.refreshToken;
  if (stored?.accessToken) accessToken = stored.accessToken;
}

async function loadAuthState() {
  if (authStateLoaded) return;

  const configuredAccessToken = cleanToken(process.env.TRIUMPH_TOKEN);
  configuredRefreshToken = cleanToken(process.env.TRIUMPH_REFRESH_TOKEN);
  accessToken = configuredAccessToken;
  refreshToken = configuredRefreshToken;

  const fileStored = readStoredTokensFromFile();
  const fileWasReplaced = configuredTokenReplacesStoredToken(fileStored);
  if (!fileWasReplaced) applyStoredAuthState(fileStored);

  const remoteStored = await readStoredTokensFromRemote();
  if (remoteStored) {
    if (configuredTokenReplacesStoredToken(remoteStored)) {
      accessToken = configuredAccessToken;
      refreshToken = configuredRefreshToken;
      console.log('[TRIUMPH AUTH] Using a newly configured refresh session.');
    } else {
      applyStoredAuthState(remoteStored);
    }
  } else if (fileWasReplaced) {
    accessToken = configuredAccessToken;
    refreshToken = configuredRefreshToken;
  }

  authStateLoaded = true;
}

async function ensureAuthState() {
  if (!authStatePromise) {
    authStatePromise = loadAuthState().catch((error) => {
      authStatePromise = null;
      throw error;
    });
  }
  await authStatePromise;
}

function storedTokenPayload() {
  return {
    issuer: getIssuer(),
    oauthClientId: getOAuthClientId(),
    accessToken,
    refreshToken,
    environmentRefreshTokenHash: tokenFingerprint(configuredRefreshToken),
    updatedAt: new Date().toISOString(),
  };
}

function persistTokensToFile(stored) {
  const storePath = getTokenStorePath();
  const temporaryPath = `${storePath}.tmp`;
  const directory = path.dirname(storePath);

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(stored, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.renameSync(temporaryPath, storePath);
  fs.chmodSync(storePath, 0o600);
}

async function persistTokensToRemote(stored) {
  const config = getRemoteStoreConfig();
  if (!config) return;

  const encrypted = encryptStoredTokens(stored, config.encryptionKey);
  let lastError;

  for (let attempt = 1; attempt <= TOKEN_STORE_RETRIES; attempt += 1) {
    try {
      await runRemoteStoreCommand(config, ['SET', config.key, encrypted]);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function persistTokens() {
  const stored = storedTokenPayload();

  try {
    persistTokensToFile(stored);
  } catch (error) {
    console.error(`[TRIUMPH AUTH] Could not persist tokens locally: ${error.message}`);
  }

  await persistTokensToRemote(stored);
  tokensNeedPersistence = false;
}

async function parseErrorResponse(response) {
  try {
    const payload = await response.json();
    return payload?.error ?? null;
  } catch {
    return null;
  }
}

async function exchangeRefreshToken(candidate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: getOAuthClientId(),
      refresh_token: candidate,
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

    return {
      accessToken: nextAccessToken,
      refreshToken: cleanToken(payload.refresh_token) || candidate,
    };
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

async function requestNewTokens() {
  await ensureAuthState();

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

  const lock = await acquireRefreshLock();

  try {
    if (lock) {
      const latestStored = await readStoredTokensFromRemote();
      if (latestStored && !configuredTokenReplacesStoredToken(latestStored)) {
        applyStoredAuthState(latestStored);
        if (isAccessTokenFresh(accessToken)) return accessToken;
      }
    }

    const candidates = [...new Set([
      cleanToken(refreshToken),
      cleanToken(configuredRefreshToken),
    ].filter(Boolean))];
    let lastReauthError = null;

    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const renewed = await exchangeRefreshToken(candidates[index]);
        accessToken = renewed.accessToken;
        refreshToken = renewed.refreshToken;
        tokensNeedPersistence = true;

        try {
          await persistTokens();
        } catch (error) {
          console.error(`[TRIUMPH AUTH] Could not persist rotated tokens: ${error.message}`);
          throw error;
        }

        return accessToken;
      } catch (error) {
        if (
          error instanceof TriumphAuthError
          && error.code === 'REAUTH_REQUIRED'
          && index < candidates.length - 1
        ) {
          lastReauthError = error;
          console.warn('[TRIUMPH AUTH] Stored session was rejected; trying the newly configured session.');
          continue;
        }
        throw error;
      }
    }

    throw lastReauthError;
  } finally {
    await releaseRefreshLock(lock);
  }
}

export async function getAccessToken({ forceRefresh = false } = {}) {
  await ensureAuthState();

  if (tokensNeedPersistence) await persistTokens();

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
