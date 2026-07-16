import fs from 'fs';
import path from 'path';
import https from 'https';
import { google } from 'googleapis';
import {
  logRaisActivity,
  raisState,
  saveRaisState,
} from './raisState.js';

const STORE_TTL_MS = 2 * 60 * 60 * 1000;
const NEEDS_FILES = new Set(['bol', 'pod', 'traffic', 'lumper']);
const chatMessageStore = new Map();
const bulkUpdateChats = new Set();

let registered = false;
let botUsername = '';
let gmailClient = null;
let gmailConfigKey = '';

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

export function isRaisEnabled() {
  return envFlag('RAIS_ENABLED');
}

export function isRaisChatId(chatId) {
  if (!isRaisEnabled()) return false;
  const allowedChatIds = envList('RAIS_ALLOWED_CHAT_IDS');
  return allowedChatIds.length > 0 && allowedChatIds.includes(String(chatId));
}

// Dispatcher handlers call this first. A configured Rais chat is kept isolated
// so driver photos and documents are not mistaken for rate confirmations.
export function isRaisMessage(msg) {
  return isRaisChatId(msg?.chat?.id);
}

function isAllowedUser(msg) {
  const allowedUsernames = envList('RAIS_ALLOWED_USERNAMES')
    .map((username) => username.toLowerCase().replace(/^@/, ''));

  if (allowedUsernames.length === 0) return true;
  return allowedUsernames.includes(String(msg.from?.username || '').toLowerCase());
}

export function detectRaisCommand(text) {
  const normalized = String(text || '').toLowerCase();
  if (/onsite\s+at\s+pu/i.test(normalized)) return 'onsite_pu';
  if (/onsite\s+at\s+del/i.test(normalized)) return 'onsite_del';
  if (/\bupdate\b/i.test(normalized)) return 'update';
  if (/checking\s+bol/i.test(normalized)) return 'bol';
  if (/checking\s+pod/i.test(normalized)) return 'pod';
  if (/\btraffic\b|\bdelay\b|\bstuck\b|\baccident\b/i.test(normalized)) return 'traffic';
  if (/\blumper\b/i.test(normalized)) return 'lumper';
  if (/\btonu\b/i.test(normalized)) return 'tonu';
  if (/\blayover\b/i.test(normalized)) return 'layover';
  if (/picked\s+up|pick\s+up|p\/u|\bpu\b|loaded/i.test(normalized)) return 'bol';
  if (/delivered|delivery|dropped|\bdel\b|\bdrop\b/i.test(normalized)) return 'pod';
  return null;
}

export function extractRaisLoadNumber(text) {
  const cleaned = String(text || '')
    .replace(/@\w+/g, '')
    .replace(/^\/rais(?:@\w+)?\b/i, '')
    .replace(/#/g, ' ')
    .replace(/\b(load|onsite|at|pu|del|update|checking|bol|pod|traffic|delay|stuck|accident|picked|up|delivered|delivery|dropped|loaded|lumper|tonu|layover)\b/gi, '')
    .trim();

  const numericMatch = cleaned.match(/\b(\d{5,})\b/);
  if (numericMatch) return numericMatch[1];

  const alphaMatch = cleaned.match(/\b([A-Z]{1,4}\d+[-]?\d*)\b/i);
  return alphaMatch ? alphaMatch[1].toUpperCase() : null;
}

function extractFileIds(msg) {
  const ids = [];
  if (msg.photo) ids.push({ fileId: msg.photo.at(-1).file_id, type: 'photo' });
  if (msg.document) ids.push({ fileId: msg.document.file_id, type: 'document' });
  if (msg.video) ids.push({ fileId: msg.video.file_id, type: 'video' });
  return ids;
}

function storeMediaMessage(msg) {
  const fileIds = extractFileIds(msg);
  if (fileIds.length === 0) return;

  const chatId = String(msg.chat.id);
  const entries = chatMessageStore.get(chatId) || [];
  entries.push({
    messageId: msg.message_id,
    fileIds,
    date: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
  });

  const cutoff = Date.now() - STORE_TTL_MS;
  chatMessageStore.set(chatId, entries.filter((entry) => entry.date > cutoff));
}

function collectFilesInRange(chatId, startMessageId, endMessageId) {
  const entries = chatMessageStore.get(String(chatId)) || [];
  return entries
    .filter((entry) => entry.messageId >= startMessageId && entry.messageId <= endMessageId)
    .flatMap((entry) => entry.fileIds);
}

function parseLumperTimes(text) {
  const checkIn = String(text || '').match(/\bin\s+(\d{1,2}:\d{2})\b/i)?.[1] || null;
  const checkOut = String(text || '').match(/\bout\s+(\d{1,2}:\d{2})\b/i)?.[1] || null;
  return { checkIn, checkOut };
}

function getGmail() {
  const required = [
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REDIRECT_URI',
    'GMAIL_REFRESH_TOKEN',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Rais Gmail configuration is missing: ${missing.join(', ')}`);
  }

  const nextConfigKey = required.map((name) => process.env[name]).join('|');
  if (gmailClient && gmailConfigKey === nextConfigKey) return gmailClient;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
  gmailConfigKey = nextConfigKey;
  return gmailClient;
}

async function findLoadThread(loadNumber) {
  const gmail = getGmail();
  const loadLower = loadNumber.toLowerCase();

  let response = await gmail.users.messages.list({
    userId: 'me',
    q: `subject:"${loadNumber}"`,
    maxResults: 20,
  });
  let messages = response.data.messages || [];

  if (messages.length === 0) {
    response = await gmail.users.messages.list({
      userId: 'me',
      q: `"${loadNumber}"`,
      maxResults: 20,
    });
    messages = response.data.messages || [];
  }

  if (messages.length === 0) return null;

  const fetched = [];
  for (const message of messages) {
    try {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Message-ID', 'In-Reply-To'],
      });
      fetched.push(full.data);
    } catch (error) {
      console.error(`[RAIS] Could not inspect Gmail message: ${error.message}`);
    }
  }

  if (fetched.length === 0) return null;

  const validated = fetched.filter((message) => {
    const subject = message.payload.headers.find((header) => header.name === 'Subject')?.value || '';
    return subject.toLowerCase().includes(loadLower);
  });
  const candidates = validated.length > 0 ? validated : fetched;

  const threadMap = new Map();
  for (const message of candidates) {
    const entries = threadMap.get(message.threadId) || [];
    entries.push(message);
    threadMap.set(message.threadId, entries);
  }

  let bestMessages = [];
  let bestScore = -1;
  for (const entries of threadMap.values()) {
    const subjectMatches = entries.filter((message) => {
      const subject = message.payload.headers.find((header) => header.name === 'Subject')?.value || '';
      return subject.toLowerCase().includes(loadLower);
    }).length;
    const score = subjectMatches * 1000 + entries.length;
    if (score > bestScore) {
      bestScore = score;
      bestMessages = entries;
    }
  }

  let rootMessage = bestMessages.find(
    (message) => !message.payload.headers.find((header) => header.name === 'In-Reply-To'),
  );
  if (!rootMessage) {
    rootMessage = [...bestMessages].sort(
      (first, second) => Number(first.internalDate) - Number(second.internalDate),
    )[0];
  }

  return {
    threadId: rootMessage.threadId,
    messageId: rootMessage.id,
    headers: rootMessage.payload.headers,
  };
}

function buildEmailBody(command, loadNumber, fileCount, extraText) {
  const signature = '\n\nBest regards,\nRais Ralph';

  switch (command) {
    case 'onsite_pu':
      return `Team,\n\nWe are onsite at the shipper for Load #${loadNumber}.${signature}`;
    case 'onsite_del':
      return `Team,\n\nWe are onsite at the receiver for Load #${loadNumber}.${signature}`;
    case 'update':
      return `Team,\n\nUpdate for Load #${loadNumber}:\n\n${extraText}${signature}`;
    case 'bol':
      return `Hello,\n\nLoad #${loadNumber} has been picked up.\n\nBOL attached below (${fileCount} file${fileCount === 1 ? '' : 's'}).\n\nPlease confirm GTG.${signature}`;
    case 'pod':
      return `Hello,\n\nLoad #${loadNumber} has been delivered.\n\nPOD attached below (${fileCount} file${fileCount === 1 ? '' : 's'}).\n\nPlease confirm receipt.${signature}`;
    case 'traffic':
      return `Team,\n\nLoad #${loadNumber} is experiencing a traffic delay.\n\nPhotos/video attached (${fileCount} file${fileCount === 1 ? '' : 's'}).\n\nWe will keep you updated.${signature}`;
    case 'lumper': {
      const [checkIn, checkOut] = String(extraText || '').split('|');
      return `Hello,\n\nPlease find the lumper receipt attached for Load #${loadNumber}.\n\nCheck-in time:  ${checkIn || 'N/A'}\nCheck-out time: ${checkOut || 'N/A'}\n\nKindly process the lumper reimbursement at your earliest convenience.${signature}`;
    }
    case 'tonu': {
      const reasonLine = extraText ? `\n\nReason: ${extraText}` : '';
      return `Hello,\n\nWe are formally requesting TONU (Truck Order Not Used) for Load #${loadNumber}.\n\nThis load was cancelled by the broker after our driver was dispatched and en route.${reasonLine}\n\nPlease confirm TONU rate and process accordingly.${signature}`;
    }
    case 'layover':
      return `Hello,\n\nWe are requesting layover pay for Load #${loadNumber}.\n\nOur driver was detained beyond the allowed free time and is requesting layover compensation.\n\nPlease confirm layover rate and process accordingly.${signature}`;
    default:
      return `Update for Load #${loadNumber}.\n\n${extraText || ''}${signature}`;
  }
}

function getMimeType(filePath) {
  const mimeTypes = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.heic': 'image/heic',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function sendEmailReply(threadInfo, command, loadNumber, attachmentPaths, extraText) {
  const gmail = getGmail();
  const getHeader = (name) => threadInfo.headers.find((header) => header.name === name)?.value || '';
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const myEmail = profile.data.emailAddress.toLowerCase();
  const parseAddresses = (value) => String(value || '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);

  const allTo = [
    ...parseAddresses(getHeader('From')),
    ...parseAddresses(getHeader('To') || process.env.DEFAULT_EMAIL_TO),
  ].filter((address) => !address.toLowerCase().includes(myEmail));
  const allCc = parseAddresses(getHeader('Cc'))
    .filter((address) => !address.toLowerCase().includes(myEmail));

  const to = allTo.join(', ') || process.env.DEFAULT_EMAIL_TO;
  if (!to) throw new Error('No recipient was found for this Gmail thread.');

  const cc = allCc.join(', ');
  const subject = getHeader('Subject')
    ? `Re: ${getHeader('Subject')}`
    : `Re: Load #${loadNumber}`;
  const originalId = getHeader('Message-ID') || threadInfo.messageId;
  const boundary = `rais_${Date.now()}`;
  const body = buildEmailBody(command, loadNumber, attachmentPaths.length, extraText);

  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${subject}`,
    `In-Reply-To: ${originalId}`,
    `References: ${originalId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].filter((line) => line !== null);

  let raw = headers.join('\r\n');
  for (const attachmentPath of attachmentPaths) {
    const encoded = fs.readFileSync(attachmentPath).toString('base64');
    const filename = path.basename(attachmentPath);
    raw += `\r\n--${boundary}\r\nContent-Type: ${getMimeType(attachmentPath)}; name="${filename}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${filename}"\r\n\r\n${encoded}`;
  }
  raw += `\r\n--${boundary}--`;

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: Buffer.from(raw).toString('base64url'),
      threadId: threadInfo.threadId,
    },
  });
}

async function downloadTelegramFile(bot, fileId, index, command, loadNumber) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = await bot.getFileLink(fileId);
  const extension = path.extname(fileInfo.file_path) || '.jpg';
  const date = new Date().toISOString().slice(0, 10);
  const prefix = String(command || 'file').toUpperCase();
  const targetPath = path.join('/tmp', `${prefix}_${loadNumber}_${date}_${index + 1}${extension}`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(targetPath, { mode: 0o600 });
    https.get(fileUrl, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        output.close();
        reject(new Error(`Telegram file download returned ${response.statusCode}.`));
        return;
      }
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
    }).on('error', reject);
    output.on('error', reject);
  });

  return targetPath;
}

function cleanupFiles(paths) {
  for (const filePath of paths) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Temporary file already removed.
    }
  }
}

function stripInvocation(text) {
  let cleaned = String(text || '').replace(/^\/rais(?:@\w+)?\b/i, '');
  if (botUsername) {
    cleaned = cleaned.replace(new RegExp(`@${botUsername}\\b`, 'ig'), '');
  }
  return cleaned.trim();
}

function isRaisInvocation(text) {
  if (/^\/rais(?:@\w+)?\b/i.test(String(text || '').trim())) return true;
  return Boolean(botUsername) && new RegExp(`@${botUsername}\\b`, 'i').test(String(text || ''));
}

function getUpdateText(msg, commandText, loadNumber) {
  if (msg.reply_to_message) {
    return msg.reply_to_message.text || msg.reply_to_message.caption || '';
  }

  return commandText
    .replace(/\bupdate\b/gi, '')
    .replace(new RegExp(`\\b${loadNumber}\\b`, 'g'), '')
    .replace(/^load\s*#\s*\S*\s*$/gim, '')
    .replace(/^=+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendTextCommand(bot, msg, command, loadNumber, commandText) {
  const chatId = msg.chat.id;
  let extraText = '';

  if (command === 'update') {
    extraText = getUpdateText(msg, commandText, loadNumber);
    if (!extraText) {
      await bot.sendMessage(chatId, 'No text to forward.');
      return { sent: false, fileCount: 0 };
    }
  } else if (command === 'tonu') {
    extraText = commandText
      .replace(/\btonu\b/gi, '')
      .replace(new RegExp(`\\b${loadNumber}\\b`, 'g'), '')
      .replace(/#/g, '')
      .trim();
  }

  const threadInfo = await findLoadThread(loadNumber);
  if (!threadInfo) {
    await bot.sendMessage(chatId, 'Load not found. Check number.');
    raisState.errorsToday += 1;
    saveRaisState();
    return { sent: false, fileCount: 0 };
  }

  await sendEmailReply(threadInfo, command, loadNumber, [], extraText);
  raisState.sentToday += 1;
  saveRaisState();
  await bot.sendMessage(chatId, '✓');
  return { sent: true, fileCount: 0 };
}

async function sendFileCommand(bot, msg, command, loadNumber, commandText) {
  const chatId = msg.chat.id;
  let collectedFiles = [];

  if (msg.reply_to_message) {
    const repliedMessage = msg.reply_to_message;
    const repliedFiles = extractFileIds(repliedMessage);
    const entries = chatMessageStore.get(String(chatId)) || [];

    if (repliedFiles.length > 0 && !entries.some((entry) => entry.messageId === repliedMessage.message_id)) {
      entries.push({
        messageId: repliedMessage.message_id,
        fileIds: repliedFiles,
        date: (repliedMessage.date || Math.floor(Date.now() / 1000)) * 1000,
      });
      chatMessageStore.set(String(chatId), entries);
    }

    collectedFiles = collectFilesInRange(chatId, repliedMessage.message_id, msg.message_id);
    if (collectedFiles.length === 0) {
      await bot.sendMessage(chatId, 'No files found. Reply to first photo.');
      return { sent: false, fileCount: 0 };
    }
  } else {
    collectedFiles = extractFileIds(msg);
    if (collectedFiles.length === 0) {
      await bot.sendMessage(chatId, 'Reply to first photo then tag me.');
      return { sent: false, fileCount: 0 };
    }
  }

  let extraText = '';
  if (command === 'lumper') {
    const times = parseLumperTimes(commandText);
    if (!times.checkIn || !times.checkOut) {
      await bot.sendMessage(chatId, `Need in/out times. Example: lumper ${loadNumber} in 08:30 out 11:45`);
      return { sent: false, fileCount: 0 };
    }
    extraText = `${times.checkIn}|${times.checkOut}`;
  }

  const downloadedPaths = [];
  try {
    for (let index = 0; index < collectedFiles.length; index += 1) {
      try {
        downloadedPaths.push(await downloadTelegramFile(
          bot,
          collectedFiles[index].fileId,
          index,
          command,
          loadNumber,
        ));
      } catch (error) {
        console.error(`[RAIS] File ${index + 1} download failed: ${error.message}`);
      }
    }

    if (downloadedPaths.length === 0) {
      await bot.sendMessage(chatId, 'Download failed. Try again.');
      return { sent: false, fileCount: 0 };
    }

    const threadInfo = await findLoadThread(loadNumber);
    if (!threadInfo) {
      await bot.sendMessage(chatId, 'Load not found. Check number.');
      raisState.errorsToday += 1;
      saveRaisState();
      return { sent: false, fileCount: 0 };
    }

    await sendEmailReply(threadInfo, command, loadNumber, downloadedPaths, extraText);
    raisState.sentToday += 1;
    raisState.filesToday += downloadedPaths.length;
    saveRaisState();
    await bot.sendMessage(chatId, '✓');
    return { sent: true, fileCount: downloadedPaths.length };
  } finally {
    cleanupFiles(downloadedPaths);
  }
}

function recordActivity(msg, command, loadNumber, fileCount, outcome, error, startedAt) {
  logRaisActivity({
    id: Date.now(),
    loadNumber,
    eventType: command,
    outcome,
    groupName: msg.chat.title || 'Direct',
    taggerName: msg.from?.username || msg.from?.first_name || 'dispatcher',
    fileCount,
    error,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  });
}

async function handleBulkUpdate(bot, msg, text) {
  const loadNumber = extractRaisLoadNumber(text);
  if (!loadNumber) return;

  const extraText = getUpdateText(msg, text, loadNumber);
  if (!extraText) return;

  const startedAt = Date.now();
  try {
    const threadInfo = await findLoadThread(loadNumber);
    if (!threadInfo) {
      await bot.sendMessage(msg.chat.id, `Load #${loadNumber} not found.`);
      raisState.errorsToday += 1;
      saveRaisState();
      return;
    }

    await sendEmailReply(threadInfo, 'update', loadNumber, [], extraText);
    raisState.sentToday += 1;
    saveRaisState();
    await bot.sendMessage(msg.chat.id, '✓');
    recordActivity(msg, 'update', loadNumber, 0, 'sent', null, startedAt);
  } catch (error) {
    raisState.errorsToday += 1;
    saveRaisState();
    recordActivity(msg, 'update', loadNumber, 0, 'error', error.message, startedAt);
    console.error(`[RAIS] Bulk update failed: ${error.message}`);
    await bot.sendMessage(msg.chat.id, 'Failed. Check the Rais Gmail configuration and try again.');
  }
}

async function handleRaisMessage(bot, msg) {
  if (!isRaisEnabled()) return;

  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';
  const trimmed = text.trim();

  if (/^\/rais_chatid(?:@\w+)?$/i.test(trimmed)) {
    await bot.sendMessage(chatId, `Rais chat ID: ${chatId}`);
    return;
  }

  if (!isRaisChatId(chatId)) return;
  storeMediaMessage(msg);
  if (!isAllowedUser(msg)) return;

  if (/^\/(?:statusupdates|rais_updates)(?:@\w+)?\b/i.test(trimmed)) {
    bulkUpdateChats.add(String(chatId));
    await bot.sendMessage(chatId, '✓ Bulk update mode ON.\nSend updates now. Type /stopupdate when done.');
    return;
  }

  if (/^\/(?:stopupdate|rais_stopupdates)(?:@\w+)?\b/i.test(trimmed)) {
    bulkUpdateChats.delete(String(chatId));
    await bot.sendMessage(chatId, '✓ Bulk update mode OFF.');
    return;
  }

  if (bulkUpdateChats.has(String(chatId))) {
    await handleBulkUpdate(bot, msg, text);
    return;
  }

  if (!isRaisInvocation(text)) return;

  const commandText = stripInvocation(text);
  const loadNumber = extractRaisLoadNumber(commandText);
  if (!loadNumber) {
    await bot.sendMessage(chatId, 'Need a load number.');
    return;
  }

  let command = detectRaisCommand(commandText);
  if (!command && (msg.reply_to_message?.text || msg.reply_to_message?.caption)) {
    command = 'update';
  }
  if (!command && commandText.replace(loadNumber, '').replace(/#/g, '').trim()) {
    command = 'update';
  }

  if (!command) {
    await bot.sendMessage(
      chatId,
      'Rais commands:\nonsite at PU | onsite at DEL | UPDATE | checking BOL | checking POD | traffic | lumper | TONU | layover',
    );
    return;
  }

  const startedAt = Date.now();
  try {
    const result = NEEDS_FILES.has(command)
      ? await sendFileCommand(bot, msg, command, loadNumber, commandText)
      : await sendTextCommand(bot, msg, command, loadNumber, commandText);

    if (result.sent) {
      recordActivity(
        msg,
        command,
        loadNumber,
        result.fileCount,
        'sent',
        null,
        startedAt,
      );
    }
  } catch (error) {
    console.error(`[RAIS] ${command} failed: ${error.message}`);
    raisState.errorsToday += 1;
    saveRaisState();
    recordActivity(msg, command, loadNumber, 0, 'error', error.message, startedAt);
    await bot.sendMessage(chatId, 'Failed. Check the Rais Gmail configuration and try again.');
  }
}

export function registerRaisBot(bot) {
  if (registered) return;
  registered = true;

  botUsername = String(process.env.RAIS_BOT_USERNAME || process.env.BOT_USERNAME || '')
    .toLowerCase()
    .replace(/^@/, '');

  bot.getMe()
    .then((identity) => {
      botUsername = String(identity.username || botUsername).toLowerCase();
      console.log(`[RAIS] Commands use @${botUsername} or /rais.`);
    })
    .catch((error) => console.error(`[RAIS] Could not resolve bot username: ${error.message}`));

  bot.prependListener('message', (msg) => {
    handleRaisMessage(bot, msg).catch((error) => {
      console.error(`[RAIS] Unexpected handler error: ${error.message}`);
    });
  });

  if (isRaisEnabled() && envList('RAIS_ALLOWED_CHAT_IDS').length === 0) {
    console.warn('[RAIS] RAIS_ENABLED is on, but RAIS_ALLOWED_CHAT_IDS is empty. Use /rais_chatid, configure the chat ID, and restart.');
  }
}
