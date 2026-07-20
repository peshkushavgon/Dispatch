import {
  findExactMC,
  getCreditCheck,
  searchMC,
  TriumphApiError,
} from './triumphApi.js';
import { lookupBrokerContact } from './brokerContact.js';

const MAX_LOAD_AMOUNT = 25_000_000;
const FURTHER_INFORMATION_REASON = 'FurtherInformationIsNeeded';
const USAGE = 'Usage: /mc <MC number> [load amount]\nExample: /mc 161412 2500';

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== null && number > 0) return number;
  }
  return null;
}

function money(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatAddress(address) {
  if (!address) return null;
  if (typeof address === 'string') return address.trim() || null;

  const street = [address.address1, address.address2].filter(Boolean).join(' ');
  return [street, address.city, address.state, address.zip]
    .filter(Boolean)
    .join(', ') || null;
}

function getCreditLimit(result) {
  return firstNumber(
    result.initialLimit_Value,
    result.initialLimitValue,
    result.recourseCreditLimit,
    result.nonRecourseCreditLimit,
    result.creditLimit,
  );
}

function getDecision(result) {
  const status = String(result.creditStatus ?? '').toUpperCase();

  if (status === 'GREEN' || status === 'APPROVED') {
    return { icon: '✅', label: 'APPROVED' };
  }

  if (status === 'RED' || status === 'NOBUY' || status === 'DENIED') {
    return { icon: '❌', label: 'DENIED' };
  }

  if (status === 'YELLOW' || status === 'PENDING') {
    return { icon: '⏳', label: 'PENDING' };
  }

  return { icon: '⚠️', label: 'REVIEW NEEDED' };
}

function getAuthority(result) {
  const docket = String(result.docket ?? result.mcNumber ?? '').toUpperCase();
  const rawAuthority = docket.startsWith('FF')
    ? result.fMCSAContract ?? result.fmcsaContract
    : result.fMCSABroker ?? result.fmcsaBroker;
  const authority = String(rawAuthority ?? '').trim().toUpperCase();

  if (authority === 'A' || authority === 'ACTIVE') return 'ACTIVE';
  if (authority === 'N' || authority === 'I' || authority === 'INACTIVE') {
    return 'INACTIVE';
  }

  return null;
}

function displayMC(result, fallback) {
  const docket = String(result.docket ?? result.mcNumber ?? fallback ?? '');
  const digits = docket.replace(/\D/g, '');
  return digits || docket || String(fallback);
}

function addContactLines(lines, result) {
  const contact = result.brokerContact ?? {};
  lines.push(`Phone: ${contact.phone ?? 'Not found'}`);
  lines.push(`Email: ${contact.email ?? 'Not found'}`);
  lines.push(`Website: ${contact.website ?? 'Not found'}`);
  lines.push(`Domain: ${contact.domain ?? 'Not found'}`);
  if (contact.sourceUrl) lines.push(`Contact source: ${contact.sourceUrl}`);
}

export function parseMCArguments(rawArguments) {
  const parts = String(rawArguments ?? '').trim().split(/\s+/).filter(Boolean);

  if (parts.length < 1 || parts.length > 2) {
    return { error: USAGE };
  }

  const mcNumber = parts[0].replace(/^MC[-#:]?/i, '');
  if (!/^\d{1,9}$/.test(mcNumber)) {
    return { error: `Invalid MC number.\n${USAGE}` };
  }

  if (parts.length === 1) {
    return { mcNumber, loadAmount: null };
  }

  const rawAmount = parts[1].replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(rawAmount)) {
    return { error: `Invalid load amount.\n${USAGE}` };
  }

  const loadAmount = Number(rawAmount);
  if (loadAmount <= 0 || loadAmount > MAX_LOAD_AMOUNT) {
    return {
      error: `Load amount must be between $0.01 and ${money(MAX_LOAD_AMOUNT)}.`,
    };
  }

  return { mcNumber, loadAmount };
}

export function parseDirectMCText(text) {
  const normalized = String(text ?? '').trim();

  if (/^\d{5,9}$/.test(normalized)) return normalized;

  const prefixed = normalized.match(/^MC[-#:\s]*(\d{1,9})$/i);
  return prefixed?.[1] ?? null;
}

export function formatCreditCheck(result, mcNumber, loadAmount = null) {
  const decision = getDecision(result);
  const authority = getAuthority(result);
  const creditLimit = getCreditLimit(result);
  const openAR = asNumber(result.openAR ?? result.openAr);
  const availableCredit = creditLimit !== null
    ? creditLimit - (openAR ?? 0)
    : null;
  const averageDaysToPay = asNumber(result.averageDaysToPay);
  const name = result.legalName ?? result.name ?? 'Unknown customer';
  const dba = result.dbaName ?? result.dBAName;
  const address = formatAddress(result.address);

  const lines = [
    `${decision.icon} Triumph Credit Check`,
    `Customer: ${name}`,
    `MC: ${displayMC(result, mcNumber)}`,
  ];

  if (dba) lines.push(`DBA: ${dba}`);
  if (address) lines.push(`Address: ${address}`);
  addContactLines(lines, result);
  if (authority) lines.push(`Authority: ${authority}`);
  lines.push(`Status: ${decision.label}`);
  if (authority === 'INACTIVE') lines.push('Reason: Inactive FMCSA authority');
  if (loadAmount !== null) lines.push(`Load amount: ${money(loadAmount)}`);
  if (creditLimit !== null) lines.push(`Credit limit: ${money(creditLimit)}`);
  if (openAR !== null) lines.push(`Open AR: ${money(openAR)}`);
  if (availableCredit !== null) lines.push(`Available credit: ${money(availableCredit)}`);
  if (averageDaysToPay !== null) lines.push(`Average days to pay: ${averageDaysToPay}`);

  return lines.join('\n');
}

function formatAmountRequired(result, mcNumber) {
  const name = result.legalName ?? result.name ?? 'Unknown customer';
  const dba = result.dbaName ?? result.dBAName;
  const address = formatAddress(result.address);
  const lines = [
    '💵 Triumph needs the load amount',
    `Customer: ${name}`,
    `MC: ${displayMC(result, mcNumber)}`,
  ];

  if (dba) lines.push(`DBA: ${dba}`);
  if (address) lines.push(`Address: ${address}`);
  addContactLines(lines, result);
  lines.push('', `Run: /mc ${mcNumber} <amount>`, `Example: /mc ${mcNumber} 2500`);
  return lines.join('\n');
}

export function formatMCError(error) {
  if (error instanceof TriumphApiError) {
    if (error.code === 'AUTH') {
      return '🔐 Triumph refresh session expired. Sign in once and replace TRIUMPH_REFRESH_TOKEN.';
    }
    if (error.code === 'AUTH_SETUP') {
      return '⚙️ Triumph automatic renewal is not fully configured. Check the Triumph token-storage environment settings.';
    }
    if (error.code === 'AUTH_STORAGE') {
      return '🔐 Triumph could not safely store the renewed session. Please try again shortly.';
    }
    if (error.code === 'CONFIG') {
      return '⚙️ Triumph is not configured. Check the Triumph environment settings.';
    }
    if (error.code === 'RATE_LIMIT') {
      return '⏳ Triumph is temporarily limiting requests. Please try again shortly.';
    }
    if (error.code === 'NETWORK') {
      return '🌐 Could not connect to Triumph. Please try again.';
    }
  }

  return '❌ Triumph could not complete this MC check. Please try again.';
}

export async function handleMC(bot, chatId, rawArguments) {
  const parsed = parseMCArguments(rawArguments);
  if (parsed.error) {
    await bot.sendMessage(chatId, parsed.error);
    return;
  }

  const { mcNumber, loadAmount } = parsed;
  const amountText = loadAmount === null ? '' : ` for ${money(loadAmount)}`;
  await bot.sendMessage(chatId, `🔍 Checking MC ${mcNumber}${amountText}...`);

  try {
    const searchPayload = await searchMC(mcNumber);
    const match = findExactMC(searchPayload, mcNumber);

    if (!match) {
      await bot.sendMessage(chatId, `❌ MC ${mcNumber} was not found in Triumph.`);
      return;
    }

    const riskEntityId = match.id ?? match.riskEntityId ?? match.debtorId;
    if (riskEntityId === null || riskEntityId === undefined) {
      throw new TriumphApiError(
        'Triumph returned an MC match without a risk entity ID.',
        'API',
      );
    }

    const creditResult = await getCreditCheck(riskEntityId, loadAmount);
    const result = { ...match, ...creditResult };
    result.brokerContact = await lookupBrokerContact(result, mcNumber);

    if (creditResult?.reason === FURTHER_INFORMATION_REASON && loadAmount === null) {
      await bot.sendMessage(chatId, formatAmountRequired(result, mcNumber));
      return;
    }

    await bot.sendMessage(
      chatId,
      formatCreditCheck(result, mcNumber, loadAmount),
    );
  } catch (error) {
    console.error(`[MC] ${error.code ?? 'UNEXPECTED'}: ${error.message}`);
    await bot.sendMessage(chatId, formatMCError(error));
  }
}
