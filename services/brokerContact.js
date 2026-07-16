import axios from 'axios';
import OpenAI from 'openai';

const FMCSA_BASE_URL = 'https://mobile.fmcsa.dot.gov/qc/services';
const REQUEST_TIMEOUT_MS = 20_000;
const WEB_SEARCH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const contactCache = new Map();

const EMAIL_KEYS = new Set([
  'email',
  'emailaddress',
  'contactemail',
  'businessemail',
  'primaryemail',
]);
const PHONE_KEYS = new Set([
  'phone',
  'phonenumber',
  'telephone',
  'businessphone',
  'contactphone',
  'primaryphone',
]);
const WEBSITE_KEYS = new Set([
  'website',
  'websiteurl',
  'weburl',
  'companywebsite',
  'businesswebsite',
  'domain',
]);

function isEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function oneLine(value, maxLength = 300) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const cleaned = String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function findFirstByKeys(value, keys, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return null;
  seen.add(value);

  for (const [key, nestedValue] of Object.entries(value)) {
    if (keys.has(key.toLowerCase())) {
      const candidate = oneLine(nestedValue);
      if (candidate) return candidate;
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (!nestedValue || typeof nestedValue !== 'object') continue;
    const candidate = findFirstByKeys(nestedValue, keys, depth + 1, seen);
    if (candidate) return candidate;
  }

  return null;
}

function normalizeEmail(value) {
  const email = oneLine(value, 254)?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

function normalizePhone(value) {
  const phone = oneLine(value, 50);
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return phone;
}

function normalizeWebsite(value) {
  const website = oneLine(value, 300);
  if (!website) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return null;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return {
      website: `${url.protocol}//${url.hostname}`,
      domain: hostname,
    };
  } catch {
    return null;
  }
}

function addressText(result) {
  const address = result?.address;
  if (typeof address === 'string') return oneLine(address);
  if (!address || typeof address !== 'object') return null;

  return [
    address.address1,
    address.address2,
    address.city,
    address.state,
    address.zip,
  ].filter(Boolean).join(', ') || null;
}

function mergeContact(...contacts) {
  const merged = {};
  for (const contact of contacts) {
    if (!contact) continue;
    for (const key of ['phone', 'email', 'website', 'domain', 'sourceUrl']) {
      if (!merged[key] && contact[key]) merged[key] = contact[key];
    }
  }
  return merged;
}

export function extractContactDetails(result) {
  const website = normalizeWebsite(findFirstByKeys(result, WEBSITE_KEYS));
  return {
    phone: normalizePhone(findFirstByKeys(result, PHONE_KEYS)),
    email: normalizeEmail(findFirstByKeys(result, EMAIL_KEYS)),
    ...website,
  };
}

async function lookupFmcsaPhone(mcNumber) {
  const webKey = oneLine(process.env.FMCSA_WEB_KEY, 500);
  if (!webKey) return {};

  const digits = String(mcNumber ?? '').replace(/\D/g, '');
  if (!digits) return {};

  try {
    const response = await axios.get(
      `${FMCSA_BASE_URL}/carriers/docket-number/${encodeURIComponent(digits)}/`,
      {
        params: { webKey },
        timeout: REQUEST_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
      },
    );
    return {
      phone: normalizePhone(findFirstByKeys(response.data, PHONE_KEYS)),
    };
  } catch (error) {
    console.warn(`[MC CONTACT] FMCSA phone lookup skipped: ${error.message}`);
    return {};
  }
}

function collectCitationUrls(response) {
  const urls = new Set();

  for (const item of response?.output ?? []) {
    for (const source of item?.action?.sources ?? []) {
      const url = normalizeWebsite(source?.url)?.website;
      if (url) urls.add(url);
    }

    for (const content of item?.content ?? []) {
      for (const annotation of content?.annotations ?? []) {
        const url = normalizeWebsite(annotation?.url)?.website;
        if (url) urls.add(url);
      }
    }
  }

  return urls;
}

function sameWebsite(first, second) {
  const firstDomain = normalizeWebsite(first)?.domain;
  const secondDomain = normalizeWebsite(second)?.domain;
  return Boolean(firstDomain && secondDomain && firstDomain === secondDomain);
}

export function parseWebContact(outputText, citationUrls = []) {
  const text = oneLine(outputText, 5_000);
  if (!text) return {};

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (String(parsed.confidence ?? '').toLowerCase() !== 'high') return {};

    const source = normalizeWebsite(parsed.source_url ?? parsed.sourceUrl);
    if (!source) return {};

    const cited = [...citationUrls].some((url) => sameWebsite(url, source.website));
    if (!cited) return {};

    const website = normalizeWebsite(parsed.website ?? parsed.domain);
    const email = normalizeEmail(parsed.email);
    const emailDomain = email?.split('@')[1]?.replace(/^www\./, '') ?? null;

    return {
      phone: normalizePhone(parsed.phone),
      email,
      ...website,
      domain: website?.domain ?? emailDomain,
      sourceUrl: source.website,
    };
  } catch {
    return {};
  }
}

async function lookupWebContact(result, mcNumber) {
  if (!process.env.OPENAI_API_KEY) return {};
  if (!isEnabled(process.env.BROKER_CONTACT_WEB_SEARCH, true)) return {};

  const legalName = oneLine(result?.legalName ?? result?.name) ?? 'Unknown';
  const dbaName = oneLine(result?.dbaName ?? result?.dBAName);
  const address = addressText(result);
  const model = oneLine(process.env.BROKER_CONTACT_MODEL, 100) || 'gpt-5.4-mini';
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: WEB_SEARCH_TIMEOUT_MS,
    maxRetries: 1,
  });

  const identity = [
    `Legal name: ${legalName}`,
    dbaName ? `DBA: ${dbaName}` : null,
    `MC number: ${String(mcNumber).replace(/\D/g, '')}`,
    address ? `Registered address: ${address}` : null,
  ].filter(Boolean).join('\n');

  try {
    const response = await client.responses.create({
      model,
      tools: [{ type: 'web_search', search_context_size: 'low' }],
      include: ['web_search_call.action.sources'],
      max_output_tokens: 300,
      input: `Find the public business contact details for this U.S. freight brokerage:\n${identity}\n\nOnly use an official company website or a clearly matching government/business record. The source must match the legal name, DBA, MC number, or registered address; do not use a similarly named company. Never guess an email address or domain. If identity or a field cannot be verified, return null for that field. Return only JSON with exactly these keys: {"phone": string|null, "email": string|null, "website": string|null, "domain": string|null, "source_url": string|null, "confidence": "high"|"low"}. Use confidence "high" only when the source clearly belongs to this brokerage.`,
    });

    return parseWebContact(response.output_text, collectCitationUrls(response));
  } catch (error) {
    console.warn(`[MC CONTACT] Web contact lookup skipped: ${error.message}`);
    return {};
  }
}

function hasContact(contact) {
  return Boolean(contact.phone || contact.email || contact.website || contact.domain);
}

export async function lookupBrokerContact(result, mcNumber) {
  const cacheKey = String(mcNumber ?? '').replace(/\D/g, '');
  const cached = contactCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.contact;

  const direct = extractContactDetails(result);
  const fmcsa = direct.phone ? {} : await lookupFmcsaPhone(mcNumber);
  const needsWebSearch = !direct.email || !direct.website || (!direct.phone && !fmcsa.phone);
  const web = needsWebSearch ? await lookupWebContact(result, mcNumber) : {};
  const contact = mergeContact(direct, fmcsa, web);

  contactCache.set(cacheKey, {
    contact,
    expiresAt: Date.now() + (hasContact(contact) ? CACHE_TTL_MS : CACHE_TTL_MS / 4),
  });
  return contact;
}
