import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import pdfjsLib from 'pdfjs-dist';
import { createCanvas, DOMMatrix } from 'canvas';

const { getDocument } = pdfjsLib;

// Polyfill DOMMatrix globally for pdfjs-dist
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = DOMMatrix;
}
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─────────────────────────────────────────────
// ENV VARIABLES
// Required in your .env file:
//   OPENAI_API_KEY=sk-...
//   TELEGRAM_BOT_TOKEN=...
//   MAPBOX_TOKEN=pk.eyJ1...
// ─────────────────────────────────────────────
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAPBOX_TOKEN       = process.env.MAPBOX_TOKEN;

if (!OPENAI_API_KEY)     throw new Error('Missing OPENAI_API_KEY in .env');
if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
if (!MAPBOX_TOKEN)       throw new Error('Missing MAPBOX_TOKEN in .env');

// ─────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const bot    = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ─────────────────────────────────────────────
// EXPRESS — health check endpoints
// ─────────────────────────────────────────────
const app = express();
app.get('/',       (req, res) => res.status(200).send('🤖 Dispatch Bot is running!'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// Graceful shutdown
process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// ─────────────────────────────────────────────
// PER-USER PROCESSING LOCK
// Prevents the same user from sending multiple
// files at once and spiking OpenAI costs.
// ─────────────────────────────────────────────
const processingUsers  = new Set();
const recentlyFinished = new Set(); // brief cooldown after mileage sent
const pendingLocations = new Map(); // stores location reply that arrived while still processing

// ─────────────────────────────────────────────
// DISK-BACKED CONVERSATION STATE
//
// Saves to states.json so restarts/deploys don't
// wipe a pending location request mid-conversation.
//
// Each entry:
// {
//   state:        'waiting_for_location',
//   pickups:      ['2 Slater Dr, Elizabethport, NJ 07206', ...],
//   deliveries:   ['2801 Alex Lee Blvd, Florence, SC 29506', ...],
//   rateConMiles: 387,       ← from rate con, used as fallback
//   expiresAt:    1234567890  ← unix ms, 10 min from creation
// }
// ─────────────────────────────────────────────
const STATES_FILE = path.join(__dirname, 'states.json');

function loadStates() {
  try {
    if (fs.existsSync(STATES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATES_FILE, 'utf8'));
      const now = Date.now();
      const valid = {};
      for (const [id, s] of Object.entries(raw)) {
        if (s.expiresAt > now) valid[id] = s;
      }
      return valid;
    }
  } catch (e) { console.error('[STATES] Load error:', e.message); }
  return {};
}

function saveStatesToDisk(states) {
  try {
    fs.writeFileSync(STATES_FILE, JSON.stringify(states, null, 2));
  } catch (e) { console.error('[STATES] Save error:', e.message); }
}

function getState(chatId) {
  const states = loadStates();
  const s = states[String(chatId)];
  if (!s) return null;
  if (s.expiresAt < Date.now()) { deleteState(chatId); return null; }
  return s;
}

function setState(chatId, data) {
  const states = loadStates();
  states[String(chatId)] = { ...data, expiresAt: Date.now() + 10 * 60 * 1000 };
  saveStatesToDisk(states);
  console.log(`[STATE SET] chatId=${chatId} | state=${data.state} | pickups=${data.pickups ? data.pickups.length : 0}`);
}

function deleteState(chatId) {
  const states = loadStates();
  delete states[String(chatId)];
  saveStatesToDisk(states);
  console.log(`[STATE DEL] chatId=${chatId}`);
}

function activeStateCount() {
  return Object.keys(loadStates()).length;
}

// ─────────────────────────────────────────────
// USAGE TRACKER
// Saved to usage.json — survives restarts.
// Tracks total, daily, and per-user counts.
// ─────────────────────────────────────────────
const USAGE_FILE = path.join(__dirname, 'usage.json');

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE))
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch (e) { console.error('[USAGE] Load error:', e.message); }
  return { totalProcessed: 0, today: 0, lastDate: '', users: {} };
}

function trackUsage(chatId, firstName) {
  const usage = loadUsage();
  const today = new Date().toISOString().split('T')[0];
  if (usage.lastDate !== today) { usage.today = 0; usage.lastDate = today; }
  usage.totalProcessed++;
  usage.today++;
  const key = String(chatId);
  if (!usage.users[key]) usage.users[key] = { name: firstName, count: 0, lastUsed: '' };
  usage.users[key].count++;
  usage.users[key].name     = firstName;
  usage.users[key].lastUsed = new Date().toISOString();
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2)); } catch (e) {}
  console.log(`[USAGE] Total:${usage.totalProcessed} Today:${usage.today} ${firstName}:${usage.users[key].count}`);
}

// ─────────────────────────────────────────────
// MAPBOX — GEOCODE ADDRESS
// Converts a plain text address into [lng, lat]
// coordinates using Mapbox Geocoding API.
// Returns [lng, lat] or null on failure.
// ─────────────────────────────────────────────
async function geocodeAddress(address) {
  try {
    const encoded = encodeURIComponent(address);
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${MAPBOX_TOKEN}&limit=1&country=US`;

    const https = await import('https');
    const body = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const json = JSON.parse(body);

    if (!json.features || json.features.length === 0) {
      console.error(`[MAPBOX] Geocode failed for: "${address}"`);
      return null;
    }

    const [lng, lat] = json.features[0].geometry.coordinates;
    const placeName  = json.features[0].place_name;
    console.log(`[GEOCODE] "${address}" → ${lat},${lng} (${placeName})`);
    return [lng, lat];

  } catch (error) {
    console.error('[MAPBOX] Geocode error:', error.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// MAPBOX — GET DRIVING MILES
// Uses Mapbox Directions API to calculate real
// road miles between two addresses.
//
// Flow: address string → geocode → coordinates
//       → directions API → miles
//
// Returns miles as a number, or null on failure.
// ─────────────────────────────────────────────
async function getDrivingMiles(originAddress, destAddress) {
  try {
    console.log(`[MILES] Calculating: "${originAddress}" → "${destAddress}"`);

    // Step 1: Geocode both addresses to coordinates
    const [originCoords, destCoords] = await Promise.all([
      geocodeAddress(originAddress),
      geocodeAddress(destAddress)
    ]);

    if (!originCoords) {
      console.error(`[MILES] Could not geocode origin: "${originAddress}"`);
      return null;
    }
    if (!destCoords) {
      console.error(`[MILES] Could not geocode destination: "${destAddress}"`);
      return null;
    }

    // Step 2: Call Mapbox Directions API
    const coords = `${originCoords[0]},${originCoords[1]};${destCoords[0]},${destCoords[1]}`;
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?access_token=${MAPBOX_TOKEN}&geometries=geojson`;

    const https = await import('https');
    const body = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const json = JSON.parse(body);

    if (!json.routes || json.routes.length === 0) {
      console.error('[MAPBOX] No route found:', JSON.stringify(json));
      return null;
    }

    // Mapbox returns distance in meters — convert to miles
    const meters = json.routes[0].distance;
    const miles  = Math.round(meters / 1609.34);

    console.log(`[MILES] Result: ${miles} miles`);
    return miles;

  } catch (error) {
    console.error('[MAPBOX] Directions error:', error.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// EXTRACT ADDRESSES FROM RAW TEXT
// Asks GPT to pull pickup and delivery addresses
// from the raw rate con text as clean JSON.
// This runs in parallel with the dispatch format.
// ─────────────────────────────────────────────
// extractAddressesFromText is now a simple adapter — 
// it extracts address arrays from the already-parsed dispatchData
// so we don't need a second GPT call
function extractAddressesFromDispatchData(dispatchData) {
  if (!dispatchData) return null;
  try {
    // Combine street + cityStateZip for Mapbox geocoding (needs full address string)
    const pickups    = (dispatchData.pickups    || [])
      .map(p => [p.street, p.cityStateZip].filter(Boolean).join(', '))
      .filter(Boolean);
    const deliveries = (dispatchData.deliveries || [])
      .map(d => [d.street, d.cityStateZip].filter(Boolean).join(', '))
      .filter(Boolean);
    return {
      pickups,
      deliveries,
      rateConMiles: dispatchData.rateConMiles ?? null
    };
  } catch (e) {
    console.error('[ADDRESSES] Adapter error:', e.message);
    return null;
  }
}


// ─────────────────────────────────────────────
// CALCULATE AND SEND MILEAGE
// Called when user replies with their truck location.
// Calculates:
//   💨 Deadhead: truck location  → first pickup
//   📦 Loaded:   first pickup    → last delivery
//   📊 Total:    deadhead + loaded
// ─────────────────────────────────────────────
async function calculateAndSendMileage(chatId, truckLocation, state) {
  try {
    // Guard: if dispatchData is missing (stale state from a crashed run), bail out
    if (!state.dispatchData || !state.pickups || !state.deliveries) {
      await bot.sendMessage(chatId, '⚠️ Something went wrong with this load — please resend the rate confirmation.');
      deleteState(chatId);
      return;
    }

    await bot.sendMessage(chatId, '🗺️ Calculating mileage... Please wait ⏳');

    const firstPickup  = state.pickups[0];
    const lastDelivery = state.deliveries[state.deliveries.length - 1];

    console.log(`[MILEAGE] Truck: "${truckLocation}" → PU: "${firstPickup}" → DEL: "${lastDelivery}"`);

    // Calculate deadhead + loaded in parallel
    const [deadheadMiles, loadedMiles] = await Promise.all([
      getDrivingMiles(truckLocation, firstPickup),
      getDrivingMiles(firstPickup, lastDelivery)
    ]);

    console.log(`[MILEAGE] Deadhead: ${deadheadMiles} | Loaded: ${loadedMiles}`);

    // Build and send the ONE combined final message
    const finalMsg = buildFinalMessage(state.dispatchData, deadheadMiles, loadedMiles);
    await bot.sendMessage(chatId, finalMsg, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('[MILEAGE] Error:', error.message);
    await bot.sendMessage(chatId, '⚠️ Something went wrong calculating mileage. Please try again.');
  } finally {
    deleteState(chatId);
    // 3-second cooldown so any immediate follow-up text isn't misread
    recentlyFinished.add(chatId);
    setTimeout(() => recentlyFinished.delete(chatId), 3000);
  }
}
// ─────────────────────────────────────────────
// GPT-4o VISION
// Sends image directly to GPT-4o — no Tesseract.
// Much faster and handles blurry/phone photos.
// ─────────────────────────────────────────────
async function extractTextFromImageWithVision(imagePath) {
  try {
    console.log(`[VISION] Processing: ${imagePath}`);
    const imageBuffer = fs.readFileSync(imagePath);
    const base64      = imageBuffer.toString('base64');
    const mimeType    = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' }
          },
          {
            type: 'text',
            text: 'Extract ALL text from this rate confirmation document exactly as it appears. Preserve every number, address, date, time, and reference number accurately. Return only the raw extracted text.'
          }
        ]
      }],
      max_tokens: 2000
    });

    const text = response.choices[0].message.content.trim();
    console.log(`[VISION] Done. Length: ${text.length}`);
    return text;

  } catch (error) {
    console.error('[VISION] Error:', error.message);
    return '';
  }
}

// ─────────────────────────────────────────────
// PDF EXTRACTION
// Sends the PDF directly to GPT-4o as base64.
// GPT-4o natively reads PDFs — no page rendering,
// no pdfjs, no DOMMatrix errors.
// Falls back to pdf-parse for text-based PDFs
// to save cost when possible.
// ─────────────────────────────────────────────
async function extractTextFromPDF(pdfPath) {
  try {
    // First try direct text extraction (fast, free, works on text-based PDFs)
    console.log('[PDF] Attempting direct text extraction...');
    const data = await pdfParse(fs.readFileSync(pdfPath));
    const text = data.text.trim();

    if (text.length >= 1000) {
      console.log(`[PDF] Direct extraction successful. Length: ${text.length}`);
      return text;
    }

    // Not enough text — send the whole PDF to GPT-4o Vision as base64
    console.log(`[PDF] Text too short (${text.length} chars) — sending PDF directly to GPT-4o...`);
    return await extractPDFWithGPT(pdfPath);

  } catch (error) {
    console.error('[PDF] Parse error:', error.message);
    return await extractPDFWithGPT(pdfPath);
  }
}

// Render each PDF page to PNG image, send each to GPT-4o Vision.
// Pages processed sequentially to avoid race conditions.
async function extractPDFWithGPT(pdfPath) {
  try {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const pdf  = await getDocument({ data, useSystemFonts: true }).promise;

    console.log(`[PDF GPT] ${pdf.numPages} pages — rendering to images...`);

    const pageTexts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const tmpPath = path.join(__dirname, 'temp', `pg_${i}_${Date.now()}.png`);
      try {
        const page     = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas   = createCanvas(viewport.width, viewport.height);

        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        fs.writeFileSync(tmpPath, canvas.toBuffer('image/png'));

        const text = await extractTextFromImageWithVision(tmpPath);
        console.log(`[PDF GPT] Page ${i} done. Length: ${text.length}`);
        pageTexts.push(`\n--- Page ${i} ---\n${text}`);
      } catch (err) {
        console.error(`[PDF GPT] Page ${i} error:`, err.message);
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    }

    const result = pageTexts.join('\n');
    console.log(`[PDF GPT] All pages done. Total: ${result.length} chars`);
    return result;

  } catch (error) {
    console.error('[PDF GPT] Fatal error:', error.message);
    return '';
  }
}

// ─────────────────────────────────────────────
// DISPATCH INFO EXTRACTION
// Formats the raw text into the dispatch message
// ─────────────────────────────────────────────
async function extractDispatchInfoWithAI(text) {
  console.log('[AI] Extracting dispatch info...');

  const prompt = `You are an expert logistics dispatcher bot.

Read the rate confirmation text below and extract ALL stops.
There may be MULTIPLE pickups and MULTIPLE deliveries — do NOT skip or merge any.

Extract:
- Load # (may be labeled as Trip#, Load#, Order#, Pro# — NOT the Rate Confirmation ID or audit trail ID)
- REF # (reference number from broker)
- Need Trailer line if present (e.g. "Need Trailer / One way")
- Load type if present (e.g. "Live/Live", "Drop/Live")
- ALL Pickup stops: date, time, shipper name, full address, PU# only if labeled
- ALL Delivery stops: date, time, receiver name, full address, DEL# only if labeled
- Rate
- Miles (from rate con)

Return ONLY this JSON (no markdown, no backticks, no explanation):
{
  "loadNumber": "60113353338",
  "refNumber": "ABC123",
  "trailerNote": "Need Trailer / One way",
  "loadType": "Live/Live",
  "pickups": [
    { "datetime": "ASAP till 4PM", "name": "MPR LOGISTICS DBA HSS LOGISTICS", "street": "4111 Ellison St NE", "cityStateZip": "Albuquerque, NM 87109" }
  ],
  "deliveries": [
    { "datetime": "02/27/26 08:00 AM", "name": "Actionpaq", "street": "2120 Town West Dr", "cityStateZip": "Rogers, AR 72756" }
  ],
  "rate": "2500",
  "rateConMiles": 771
}

RULES:
- Do NOT extract puNumber or delNumber — these are not needed
- trailerNote / loadType: only fill if present, otherwise empty string
- rateConMiles: number only, null if not found
- street: ONLY the street number + street name (e.g. "3808 North Sullivan Road") — NO city, state, or zip
- cityStateZip: ONLY city, state, zip and country if present (e.g. "Spokane Valley, WA US 99216")
- IGNORE broker/carrier office addresses, Remit To, Bill To, Pay To, Factor To addresses
- Only include addresses that have a scheduled pickup or delivery date/time

RATE CONFIRMATION TEXT:
${text}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You extract logistics data and return only valid JSON.' },
      { role: 'user',   content: prompt }
    ],
    temperature: 0,
    max_tokens: 1000
  });

  const raw     = response.choices[0].message.content.trim();
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  console.log('[AI] Raw response:', cleaned.substring(0, 300));

  const data = JSON.parse(cleaned);
  console.log('[AI] Parsed successfully.');
  return data;
}

// ─────────────────────────────────────────────
// BUILD FINAL COMBINED MESSAGE
// Takes structured dispatch data + mileage numbers
// and returns the single formatted message to send.
// ─────────────────────────────────────────────
function buildFinalMessage(data, deadheadMiles, loadedMiles) {
  const DIV = `============================`;
  let msg = '';

  // ── Header ──
  msg += `*✅✅✅NEXT LOAD✅✅✅*
`;
  if (data.trailerNote) msg += `*${data.trailerNote}*
`;
  if (data.loadType)    msg += `*${data.loadType}*
`;
  if (data.loadNumber)  msg += `*Load# ${data.loadNumber}*
`;
  if (data.refNumber)   msg += `*REF# ${data.refNumber}*
`;
  else                  msg += `*PU#: N/A*
`;
  msg += `${DIV}
`;

  // ── Pickups ──
  data.pickups.forEach((pu, i) => {
    const label = data.pickups.length > 1 ? `PU ${i + 1}:` : `PU:`;
    msg += `*${label} ${pu.datetime}*
`;
    msg += `${pu.name}
`;
    msg += `${pu.street}
`;
    msg += `${pu.cityStateZip}
`;
    msg += `${DIV}
`;
  });

  // ── Deliveries ──
  data.deliveries.forEach((del, i) => {
    const label = data.deliveries.length > 1 ? `DEL ${i + 1}:` : `DEL:`;
    msg += `*${label} ${del.datetime}*
`;
    msg += `${del.name}
`;
    msg += `${del.street}
`;
    msg += `${del.cityStateZip}
`;
    msg += `
`;
  });

  // ── Mileage — own section with dividers ──
  const effectiveLoaded = loadedMiles ?? data.rateConMiles ?? null;
  const total = (deadheadMiles !== null && effectiveLoaded !== null)
    ? deadheadMiles + effectiveLoaded
    : null;

  if (deadheadMiles !== null || effectiveLoaded !== null || total !== null) {
    msg += `${DIV}
`;
    if (deadheadMiles !== null)   msg += `Deadhead: ${deadheadMiles} miles
`;
    if (effectiveLoaded !== null) msg += `Loaded: ${effectiveLoaded} miles
`;
    if (total !== null)           msg += `Total: ${total} miles
`;
    msg += `${DIV}
`;
  }

  // ── Footer ──
  msg += `Please ensure that the Trailer photos, Bill of Lading (BOL), seal information, and all other relevant documents are sent to dispatch and confirmed prior to departure from the facility.
`;
  msg += `Failure to confirm these documents before departure may result in additional charges.
`;
  msg += `Late arrivals and departures, non-compliance with dispatch instructions, and refusal of a load after booking may also incur charges.
`;
  msg += `Please ensure that your tracking system is consistently activated. Any charges incurred from the broker due to the app not being used will be the responsibility of the driver.`;

  return msg;
}





// ─────────────────────────────────────────────
// FILE DOWNLOAD HELPER
// ─────────────────────────────────────────────
async function downloadTelegramFile(fileId, destPath) {
  const file    = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const https   = await import('https');
  const stream  = fs.createWriteStream(destPath);

  await new Promise((resolve, reject) => {
    https.get(fileUrl, (res) => {
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); resolve(); });
    }).on('error', reject);
  });

  console.log(`[DOWNLOAD] Saved to ${destPath}`);
}

// ─────────────────────────────────────────────
// CORE FILE PROCESSOR
// Handles both PDF and photo uploads.
// Flow:
//   1. Extract raw text (Vision or pdf-parse)
//   2. Run dispatch format + address extraction in parallel
//   3. Send dispatch message
//   4. Save state + ask for truck location
// ─────────────────────────────────────────────
async function processFile(chatId, firstName, filePath, extractFn, failMessage) {
  if (processingUsers.has(chatId)) {
    await bot.sendMessage(chatId, '⏳ Already processing a file — please wait before sending another.');
    return;
  }

  processingUsers.add(chatId);

  try {
    // Step 1: Set a placeholder state IMMEDIATELY so if the user replies
    // before GPT finishes, the message handler knows to wait — not reject
    setState(chatId, { state: 'processing' });

    // Step 2: Ask for truck location right away
    await bot.sendMessage(
      chatId,
      `📍 *Where is your truck right now?*

Reply with city + state or full address.
_Example: Dallas, TX_

Type /cancel to skip.`,
      { parse_mode: 'Markdown' }
    );

    // Step 3: Extract raw text
    const rawText = await extractFn(filePath);

    if (!rawText || rawText.length < 50) {
      await bot.sendMessage(chatId, failMessage);
      deleteState(chatId);
      return;
    }

    // Step 4: Extract dispatch data via GPT
    console.log('[PROCESS] Extracting dispatch data...');
    const dispatchData = await extractDispatchInfoWithAI(rawText);
    const addresses    = extractAddressesFromDispatchData(dispatchData);

    console.log('[DISPATCH DATA]', JSON.stringify(dispatchData).substring(0, 200));
    console.log('[ADDRESSES]', JSON.stringify(addresses));

    const hasAddresses = addresses && addresses.pickups?.length > 0 && addresses.deliveries?.length > 0;

    if (hasAddresses) {
      // Step 5: Update state with full data — now ready to handle location reply
      setState(chatId, {
        state:        'waiting_for_location',
        pickups:      addresses.pickups,
        deliveries:   addresses.deliveries,
        rateConMiles: dispatchData.rateConMiles ?? null,
        dispatchData: dispatchData
      });
      console.log('[PROCESS] State updated to waiting_for_location');

      // If the user already replied with their location while we were processing,
      // use it now — no need to wait for them to reply again
      if (pendingLocations.has(chatId)) {
        const savedLocation = pendingLocations.get(chatId);
        pendingLocations.delete(chatId);
        console.log(`[PROCESS] Using saved location: "${savedLocation}"`);
        const readyState = getState(chatId);
        await calculateAndSendMileage(chatId, savedLocation, readyState);
      }
    } else {
      // No addresses — send dispatch message without mileage and clear state
      console.log('[PROCESS] No addresses extracted — sending dispatch without mileage');
      deleteState(chatId);
      const fallbackMsg = buildFinalMessage(dispatchData, null, null);
      await bot.sendMessage(chatId, fallbackMsg, { parse_mode: 'Markdown' });
    }

    trackUsage(chatId, firstName);

  } catch (error) {
    console.error('[PROCESS] Error:', error.message);
    await bot.sendMessage(chatId, `⚠️ Error: ${error.message}`);
  } finally {
    processingUsers.delete(chatId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}
// ─────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const { chat: { id: chatId }, from: { first_name } } = msg;
  await bot.sendMessage(chatId, `👋 Hey ${first_name}!

I'm your *Dispatch Assistant Bot* 🚛

Send me a *Rate Confirmation PDF* or *photo* and I'll extract:
• Load# and REF#
• All pickup and delivery stops
• Rate and miles

Then I'll ask for your *truck's location* and calculate:
💨 Deadhead miles
📦 Loaded miles
📊 Total miles

📎 Just send the file to get started!
Type /help for more info.`, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────
// /help
// ─────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `📋 *Dispatch Bot — Help*

*How to use:*
1️⃣ Send a Rate Confirmation as a PDF or photo
2️⃣ Bot extracts all dispatch info automatically
3️⃣ Reply with your truck's location
4️⃣ Bot calculates deadhead, loaded, and total miles

*Mileage (powered by Mapbox):*
💨 Deadhead — truck location → first pickup
📦 Loaded — first pickup → last delivery
📊 Total — deadhead + loaded

*Supported file types:*
📄 PDF (digital or scanned)
📷 Photo / image (JPG, PNG)

*Tips:*
• Photos should be clear and well-lit
• For truck location be specific: "Dallas, TX"

*Commands:*
/start — Welcome
/help — This page
/status — Bot health and usage stats
/cancel — Cancel pending location request`,
  { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────
// /cancel
// ─────────────────────────────────────────────
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  if (getState(chatId)) {
    deleteState(chatId);
    await bot.sendMessage(chatId, '✅ Cancelled. Send a new rate confirmation whenever you\'re ready.');
  } else {
    await bot.sendMessage(chatId, '✅ Nothing pending. Send a rate confirmation to get started!');
  }
});

// ─────────────────────────────────────────────
// /status
// ─────────────────────────────────────────────
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;

  const sec  = Math.floor(process.uptime());
  const days = Math.floor(sec / 86400);
  const hrs  = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const uptime = `${days > 0 ? days + 'd ' : ''}${hrs > 0 ? hrs + 'h ' : ''}${mins}m`;

  const usage = loadUsage();
  const today = new Date().toISOString().split('T')[0];
  const todayCount = usage.lastDate === today ? usage.today : 0;

  const topUsers = Object.values(usage.users)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((u, i) => `  ${i + 1}. ${u.name} — ${u.count} files`)
    .join('\n') || '  No data yet';

  await bot.sendMessage(chatId, `✅ *Bot is running*

🕐 *Uptime:* ${uptime}
⚙️ *Node:* ${process.version}
💾 *Memory:* ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB
📍 *Pending location requests:* ${activeStateCount()}
🗺️ *Mileage:* Mapbox

📊 *Usage:*
• Today: ${todayCount} files
• All time: ${usage.totalProcessed} files
• Users: ${Object.keys(usage.users).length}

🏆 *Top Users:*
${topUsers}`,
  { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────
// MESSAGE HANDLER — truck location replies
// ─────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Only handle plain text
  if (!msg.text) return;
  const text = msg.text.trim();

  // Commands have their own dedicated handlers
  if (text.startsWith('/')) return;

  console.log(`[MSG] chatId=${chatId} text="${text}"`);

  // If mileage was just sent, ignore follow-up texts (3s cooldown)
  if (recentlyFinished.has(chatId)) {
    console.log(`[MSG] Ignored — cooldown for ${chatId}`);
    return;
  }

  // If still processing the file, save the location reply for later
  // instead of dropping it or showing "please send rate con"
  if (processingUsers.has(chatId)) {
    console.log(`[MSG] File still processing — saving location for later: "${text}"`);
    pendingLocations.set(chatId, text);
    await bot.sendMessage(chatId, '👍 Got it! Calculating your mileage once we finish reading the rate con...');
    return;
  }

  const state = getState(chatId);
  console.log(`[STATE] ${state ? state.state : 'none'}`);

  if (state && state.state === 'waiting_for_location') {
    await calculateAndSendMileage(chatId, text, state);
    return;
  }

  // Genuine random text with no context
  await bot.sendMessage(chatId,
    '📎 Please send a Rate Confirmation PDF or photo to get started.\n\nType /help for instructions.'
  );
});

// ─────────────────────────────────────────────
// TELEGRAM: PDF HANDLER
// ─────────────────────────────────────────────
bot.on('document', async (msg) => {
  const chatId    = msg.chat.id;
  const firstName = msg.from.first_name;
  const doc       = msg.document;

  if (!doc.mime_type?.includes('pdf')) return;

  if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
    await bot.sendMessage(chatId, '⚠️ File too large. Please send a PDF under 20MB.');
    return;
  }

  const filePath = path.join(__dirname, 'temp', `doc_${doc.file_id}.pdf`);

  await bot.sendMessage(chatId, '📄 PDF received. Extracting info... Please wait ⏳');
  await downloadTelegramFile(doc.file_id, filePath);
  await processFile(chatId, firstName, filePath, extractTextFromPDF,
    '⚠️ Could not extract text. Please make sure the PDF is readable.');
});

// ─────────────────────────────────────────────
// TELEGRAM: PHOTO HANDLER
// ─────────────────────────────────────────────
bot.on('photo', async (msg) => {
  const chatId    = msg.chat.id;
  const firstName = msg.from.first_name;
  const photo     = msg.photo[msg.photo.length - 1];
  const filePath  = path.join(__dirname, 'temp', `photo_${photo.file_id}.jpg`);

  await bot.sendMessage(chatId, '📷 Image received. Analyzing with AI Vision... Please wait ⏳');
  await downloadTelegramFile(photo.file_id, filePath);
  await processFile(chatId, firstName, filePath, extractTextFromImageWithVision,
    '⚠️ Could not read image. Please make sure it is clear and well-lit.');
});

// ─────────────────────────────────────────────
// ENSURE TEMP DIR EXISTS
// ─────────────────────────────────────────────
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server started on port ${PORT}`);
  console.log('🤖 Dispatch Bot running');
  console.log('🗺️  Mileage: Mapbox Directions API');
  console.log('👁️  OCR: GPT-4o Vision');

  // Clean up any stale 'processing' states from previous crashes/restarts.
  // These can never complete since the process died mid-extraction.
  // Only keep 'waiting_for_location' states which are still actionable.
  try {
    const states = loadStates();
    let cleaned = 0;
    for (const [id, s] of Object.entries(states)) {
      if (s.state !== 'waiting_for_location') {
        delete states[id];
        cleaned++;
      }
    }
    if (cleaned > 0) {
      saveStatesToDisk(states);
      console.log(`🧹 Cleared ${cleaned} stale processing state(s)`);
    }
  } catch (e) { console.error('Startup cleanup error:', e.message); }

  console.log(`📍 Active states on startup: ${activeStateCount()}`);
});