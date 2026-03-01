import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import pdfjsLib from 'pdfjs-dist';
import { createCanvas } from 'canvas';

const { getDocument } = pdfjsLib;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Graceful shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Express app
const app = express();
app.get('/', (req, res) => res.status(200).send('🤖 Dispatch Bot is running!'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ─────────────────────────────────────────────
// NEW: PER-USER PROCESSING LOCK
// Prevents a user from flooding the bot with
// multiple files at once, spiking OpenAI costs
// and causing timeouts or race conditions.
// ─────────────────────────────────────────────
const processingUsers = new Set();

// ─────────────────────────────────────────────
// NEW: USAGE TRACKER
// Tracks how many files each user has processed
// and a daily total. Persisted to usage.json so
// it survives bot restarts.
// ─────────────────────────────────────────────
const USAGE_FILE = path.join(__dirname, 'usage.json');

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load usage file:', e);
  }
  return { totalProcessed: 0, today: 0, lastDate: '', users: {} };
}

function saveUsage(usage) {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
  } catch (e) {
    console.error('Failed to save usage file:', e);
  }
}

function trackUsage(chatId, firstName) {
  const usage = loadUsage();
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Reset daily counter if it's a new day
  if (usage.lastDate !== today) {
    usage.today = 0;
    usage.lastDate = today;
  }

  usage.totalProcessed += 1;
  usage.today += 1;

  // Per-user stats
  const userKey = String(chatId);
  if (!usage.users[userKey]) {
    usage.users[userKey] = { name: firstName, count: 0, lastUsed: '' };
  }
  usage.users[userKey].count += 1;
  usage.users[userKey].name = firstName; // update name in case it changed
  usage.users[userKey].lastUsed = new Date().toISOString();

  saveUsage(usage);
  console.log(`📊 Usage tracked — Total: ${usage.totalProcessed} | Today: ${usage.today} | User ${firstName}: ${usage.users[userKey].count}`);
}

// ─────────────────────────────────────────────
// /start COMMAND
// ─────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name;

  const welcomeMessage = `👋 Hey ${firstName}!

I'm your **Dispatch Assistant Bot** 🚛

Send me a **Rate Confirmation PDF** or an **image** of one, and I'll extract key info for you — Load#, REF#, PU/DEL, Rate, Miles, and Notes.

📎 Just upload your file and I'll handle the rest!

Need help? Type /help`;

  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────
// NEW: /help COMMAND
// ─────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;

  const helpMessage = `📋 *Dispatch Bot — Help*

*How to use:*
1️⃣ Send a Rate Confirmation as a *PDF* or *photo*
2️⃣ The bot will automatically extract all dispatch info
3️⃣ You'll get Load#, REF#, all PU and DEL stops, Rate, and Miles

*Supported formats:*
📄 PDF files (digital or scanned)
📷 Photos / images (JPG, PNG)

*Multiple stops supported:*
The bot handles rate cons with multiple pickups and multiple deliveries — it will list them all as PU 1, PU 2, DEL 1, DEL 2, etc.

*Tips for best results:*
• Make sure photos are clear and well-lit
• Avoid blurry or heavily angled shots
• Digital PDFs process fastest

*Commands:*
/start — Welcome message
/help — This help page
/status — Check if bot is running

❓ Issues? Contact your dispatcher admin.`;

  await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────
// NEW: /status COMMAND
// Check bot health + usage stats from Telegram
// without opening any dashboard
// ─────────────────────────────────────────────
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;

  const uptimeSeconds = Math.floor(process.uptime());
  const uptimeMinutes = Math.floor(uptimeSeconds / 60);
  const uptimeHours = Math.floor(uptimeMinutes / 60);
  const uptimeDays = Math.floor(uptimeHours / 24);

  // Format uptime nicely
  let uptimeStr = '';
  if (uptimeDays > 0) uptimeStr += `${uptimeDays}d `;
  if (uptimeHours % 24 > 0) uptimeStr += `${uptimeHours % 24}h `;
  uptimeStr += `${uptimeMinutes % 60}m`;

  // Load usage stats
  const usage = loadUsage();
  const today = new Date().toISOString().split('T')[0];
  const todayCount = usage.lastDate === today ? usage.today : 0;

  // Build top users list
  const topUsers = Object.values(usage.users)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((u, i) => `  ${i + 1}. ${u.name} — ${u.count} files`)
    .join('\n');

  const statusMessage = `✅ *Bot is running*

🕐 *Uptime:* ${uptimeStr}
⚙️ *Node version:* ${process.version}
💾 *Memory:* ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB

📊 *Usage Stats:*
• Today: ${todayCount} files processed
• All time: ${usage.totalProcessed} files processed
• Active users: ${Object.keys(usage.users).length}

🏆 *Top Users:*
${topUsers || '  No data yet'}`;

  await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────
// GPT-4o VISION — replaces Tesseract
// ─────────────────────────────────────────────
async function extractTextFromImageWithVision(imagePath) {
  try {
    console.log(`=== GPT-4o VISION ===`);
    console.log(`Image: ${imagePath}`);

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
                detail: 'high'
              }
            },
            {
              type: 'text',
              text: 'Extract ALL text from this rate confirmation document exactly as it appears. Preserve all numbers, addresses, dates, times, and reference numbers accurately. Return only the extracted text.'
            }
          ]
        }
      ],
      max_tokens: 2000
    });

    const text = response.choices[0].message.content.trim();
    console.log(`Vision complete. Text length: ${text.length}`);
    console.log('First 200 chars:', text.substring(0, 200));
    console.log('=====================');

    return text;
  } catch (error) {
    console.error('Vision OCR Error:', error);
    return '';
  }
}

// ─────────────────────────────────────────────
// PDF TEXT EXTRACTION
// ─────────────────────────────────────────────
async function extractTextFromPDF(pdfPath) {
  try {
    console.log('=== PDF TEXT EXTRACTION ===');
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);
    const text = data.text.trim();

    console.log(`Extracted text length: ${text.length}`);
    console.log('First 300 characters:', text.substring(0, 300));

    if (text.length < 100) {
      console.log('⚠️ Image-based PDF detected. Switching to GPT-4o Vision...');
      return await extractTextFromPDFWithVision(pdfPath);
    }

    console.log('✓ Direct text extraction successful');
    return text;
  } catch (error) {
    console.error('PDF Parse Error:', error);
    console.log('Falling back to GPT-4o Vision...');
    return await extractTextFromPDFWithVision(pdfPath);
  }
}

// ─────────────────────────────────────────────
// IMAGE-BASED PDF — render pages + Vision (parallel)
// ─────────────────────────────────────────────
async function extractTextFromPDFWithVision(pdfPath) {
  try {
    console.log('Rendering PDF pages for GPT-4o Vision...');

    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const pdf = await getDocument({
      data,
      useSystemFonts: true,
      standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/'
    }).promise;

    console.log(`PDF has ${pdf.numPages} pages — processing in parallel`);

    const pagePromises = Array.from({ length: pdf.numPages }, async (_, i) => {
      const pageNum = i + 1;
      const tempImagePath = path.join(__dirname, 'temp', `page_${pageNum}_${Date.now()}.png`);

      try {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');

        await page.render({ canvasContext: context, viewport }).promise;
        fs.writeFileSync(tempImagePath, canvas.toBuffer('image/png'));

        console.log(`Page ${pageNum} rendered — sending to Vision...`);
        const pageText = await extractTextFromImageWithVision(tempImagePath);

        return `\n--- Page ${pageNum} ---\n${pageText}`;
      } catch (err) {
        console.error(`Error on page ${pageNum}:`, err);
        return `\n--- Page ${pageNum} --- [error]\n`;
      } finally {
        if (fs.existsSync(tempImagePath)) fs.unlinkSync(tempImagePath);
      }
    });

    const pages = await Promise.all(pagePromises);
    const fullText = pages.join('\n');
    console.log(`Total Vision text length: ${fullText.length}`);
    return fullText;

  } catch (error) {
    console.error('PDF Vision Error:', error);
    return '';
  }
}

// ─────────────────────────────────────────────
// DISPATCH INFO EXTRACTION
// ─────────────────────────────────────────────
async function extractDispatchInfoWithAI(text) {
  console.log('=== SENDING TO AI ===');
  console.log('Text length:', text.length);
  console.log('First 500 chars:', text.substring(0, 500));
  console.log('=====================');

  const prompt = `You are an expert logistics dispatcher bot.

Read the rate confirmation text below and extract ALL stops — there may be MULTIPLE pickups and MULTIPLE deliveries. Do NOT skip or merge any stops.

Extract:
- Load #
- REF #
- ALL Pickup stops (PU): each with date, time, shipper name, address, and PU# only if explicitly labeled
- ALL Delivery stops (DEL): each with date, time, receiver name, address, and DEL# only if explicitly labeled
- Rate
- Miles
- Any other important details

Return the answer in this EXACT format. Repeat the PU block for every pickup, DEL block for every delivery:

Load# [number]

REF# [reference number]

⏳ PU 1: [date + time]
[PU# — ONLY if present in the document. If not found, skip this line completely. Do NOT write "Not found".]
[shipper name]
[address line 1]
[city, state zip]

⏳ PU 2: [date + time]   ← only include if there is a 2nd pickup, repeat for PU 3, PU 4 etc.
[PU# — only if present, otherwise skip this line]
[shipper name]
[address line 1]
[city, state zip]

⏳ DEL 1: [date + time]
[DEL# — ONLY if present in the document. If not found, skip this line completely. Do NOT write "Not found".]
[receiver name]
[address line 1]
[city, state zip]

⏳ DEL 2: [date + time]   ← only include if there is a 2nd delivery, repeat for DEL 3, DEL 4 etc.
[DEL# — only if present, otherwise skip this line]
[receiver name]
[address line 1]
[city, state zip]

_____

Rate: [amount] $
Mile: [miles] miles

⏰Late pick up = $250 fine❗️
⏰Late delivery = $250 fine❗️ important to keep the business
📝BOL/POD/Freight/Seal pictures MUST send otherwise $250 fine❗️
🚨 No update / $250 fine❗️

Your communication is really going smoothly❗️

RULES:
- NEVER merge multiple stops into one
- NEVER skip any pickup or delivery stop
- For PU# and DEL#: only include if explicitly present — otherwise skip that line, never write "Not found"
- Keep the format identical
- CRITICAL — IGNORE these addresses completely, do NOT treat them as pickup or delivery stops:
  * Carrier company office or home address
  * Broker or freight company office address
  * Any address labeled: "Carrier Address", "Broker Address", "Remit To", "Bill To", "Factor To", "Pay To", "Office", "Corporate", "Headquarters"
  * Only use addresses that have a scheduled pickup or delivery date/time attached to them

---
RATE CONFIRMATION TEXT:
${text}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are an expert logistics dispatcher assistant.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
  });

  const result = response.choices[0].message.content.trim();
  console.log('=== AI RESPONSE ===\n', result, '\n===================');
  return result;
}

// ─────────────────────────────────────────────
// SHARED FILE DOWNLOAD HELPER
// ─────────────────────────────────────────────
async function downloadTelegramFile(fileId, destPath) {
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  console.log(`Downloading: ${fileUrl}`);

  const https = await import('https');
  const fileStream = fs.createWriteStream(destPath);

  await new Promise((resolve, reject) => {
    https.get(fileUrl, (response) => {
      response.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
    }).on('error', reject);
  });

  console.log('Download complete.');
}

// ─────────────────────────────────────────────
// SHARED FILE PROCESSOR
// Used by both document and photo handlers.
// Handles the per-user lock, usage tracking,
// and the full extract → format → reply flow.
// ─────────────────────────────────────────────
async function processFile(chatId, firstName, filePath, extractFn, busyMessage, failMessage) {
  // ── Per-user lock ──
  if (processingUsers.has(chatId)) {
    await bot.sendMessage(chatId, '⏳ Still processing your previous file — please wait until it\'s done before sending another.');
    return;
  }

  processingUsers.add(chatId);

  try {
    const text = await extractFn(filePath);

    if (!text || text.length < 50) {
      await bot.sendMessage(chatId, failMessage);
      return;
    }

    const result = await extractDispatchInfoWithAI(text);
    await bot.sendMessage(chatId, result);

    // ── Track usage after successful processing ──
    trackUsage(chatId, firstName);

  } catch (error) {
    console.error('Processing Error:', error);
    await bot.sendMessage(chatId, `⚠️ Error: ${error.message}`);
  } finally {
    // Always release the lock, even on error
    processingUsers.delete(chatId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

// ─────────────────────────────────────────────
// TELEGRAM: PDF HANDLER
// ─────────────────────────────────────────────
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name;
  const document = msg.document;

  if (!document.mime_type || !document.mime_type.includes('pdf')) return;

  // File size check — Telegram limit is 20MB
  if (document.file_size && document.file_size > 20 * 1024 * 1024) {
    await bot.sendMessage(chatId, '⚠️ File too large. Please send a PDF under 20MB.');
    return;
  }

  // Use file_id as filename — avoids path traversal security risk
  const filePath = path.join(__dirname, 'temp', `doc_${document.file_id}.pdf`);

  await bot.sendMessage(chatId, '📄 PDF received. Extracting info... Please wait ⏳');
  await downloadTelegramFile(document.file_id, filePath);

  await processFile(
    chatId,
    firstName,
    filePath,
    extractTextFromPDF,
    '⏳ Processing...',
    '⚠️ Could not extract text from this PDF. Please make sure it is a readable file.'
  );
});

// ─────────────────────────────────────────────
// TELEGRAM: PHOTO HANDLER
// ─────────────────────────────────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name;
  const photo = msg.photo[msg.photo.length - 1]; // highest resolution
  const filePath = path.join(__dirname, 'temp', `photo_${photo.file_id}.jpg`);

  await bot.sendMessage(chatId, '📷 Image received. Analyzing with AI Vision... Please wait ⏳');
  await downloadTelegramFile(photo.file_id, filePath);

  await processFile(
    chatId,
    firstName,
    filePath,
    extractTextFromImageWithVision,
    '⏳ Processing...',
    '⚠️ Could not read the image. Please make sure it is clear and well-lit.'
  );
});

// ─────────────────────────────────────────────
// Ensure temp directory exists
// ─────────────────────────────────────────────
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server started on port ${PORT}`);
  console.log('🤖 Bot running with GPT-4o Vision ✅');
  console.log('📊 Usage tracking enabled — data saved to usage.json');
});