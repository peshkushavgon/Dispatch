import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import { createWorker } from 'tesseract.js';
import pdfjsLib from 'pdfjs-dist';
import { createCanvas } from 'canvas';

const { getDocument } = pdfjsLib;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// ─────────────────────────────────────────────
// FIX 4: Reuse a single Tesseract worker
// instead of creating/destroying it every call
// ─────────────────────────────────────────────
let tesseractWorker = null;
let workerReady = false;

async function getTesseractWorker() {
  if (!tesseractWorker || !workerReady) {
    console.log('🔧 Initializing Tesseract worker...');
    tesseractWorker = await createWorker('eng', 1, {
      // suppress verbose Tesseract logs
      logger: () => {}
    });
    workerReady = true;
    console.log('✅ Tesseract worker ready and will be reused.');
  }
  return tesseractWorker;
}

// Initialize the worker at startup so the FIRST request is fast too
getTesseractWorker().catch(console.error);

// ─────────────────────────────────────────────
// IMPROVEMENT: Graceful shutdown — terminate
// Tesseract worker cleanly on exit
// ─────────────────────────────────────────────
async function shutdown() {
  if (tesseractWorker && workerReady) {
    console.log('Terminating Tesseract worker...');
    await tesseractWorker.terminate();
    workerReady = false;
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Express app for health check
const app = express();

app.get('/', (req, res) => {
  res.status(200).send('🤖 Dispatch Bot is running!');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ─────────────────────────────────────────────
// START COMMAND
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
// FIX 4 APPLIED: OCR for images uses reused worker
// ─────────────────────────────────────────────
async function extractTextFromImage(imagePath) {
  try {
    console.log(`=== STARTING OCR (reused worker) ===`);
    console.log(`Image path: ${imagePath}`);

    const worker = await getTesseractWorker();

    // IMPROVEMENT: set PSM 6 (assume uniform block of text)
    // this speeds up recognition for document-style layouts
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
    });

    const { data: { text } } = await worker.recognize(imagePath);

    console.log(`OCR completed. Text length: ${text.length}`);
    console.log('First 200 characters:', text.substring(0, 200));
    console.log('====================================');

    return text.trim();
  } catch (error) {
    console.error('OCR Error:', error);
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
      console.log('⚠️ Minimal text (<100 chars). Using OCR...');
      return await extractTextFromPDFWithOCR(pdfPath);
    }

    console.log('✓ Text extraction successful');
    return text;
  } catch (error) {
    console.error('PDF Parse Error:', error);
    console.log('Falling back to OCR...');
    return await extractTextFromPDFWithOCR(pdfPath);
  }
}

// ─────────────────────────────────────────────
// IMPROVEMENT: PDF OCR now processes pages in
// PARALLEL instead of sequentially
// ─────────────────────────────────────────────
async function extractTextFromPDFWithOCR(pdfPath) {
  try {
    console.log('Converting PDF pages to images using PDF.js...');

    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const loadingTask = getDocument({
      data,
      useSystemFonts: true,
      standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/'
    });
    const pdf = await loadingTask.promise;

    console.log(`PDF has ${pdf.numPages} pages — processing in parallel`);

    // IMPROVEMENT: render all pages simultaneously
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

        console.log(`Processing page ${pageNum} with OCR...`);
        const pageText = await extractTextFromImage(tempImagePath);

        return `\n--- Page ${pageNum} ---\n${pageText}`;
      } catch (err) {
        console.error(`Error on page ${pageNum}:`, err);
        return `\n--- Page ${pageNum} --- [error]\n`;
      } finally {
        // Clean up temp image regardless of success/failure
        if (fs.existsSync(tempImagePath)) fs.unlinkSync(tempImagePath);
      }
    });

    const pages = await Promise.all(pagePromises);
    const fullText = pages.join('\n');

    console.log(`Total OCR text length: ${fullText.length}`);
    return fullText;
  } catch (error) {
    console.error('OCR PDF Error:', error);
    return '';
  }
}

// ─────────────────────────────────────────────
// OPENAI DISPATCH EXTRACTION
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
// IMPROVEMENT: Shared file download helper
// (removes duplicated code in photo + document)
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
// TELEGRAM: PDF HANDLER
// ─────────────────────────────────────────────
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const document = msg.document;

  if (!document.mime_type || !document.mime_type.includes('pdf')) return;

  const fileName = document.file_name || `temp_${document.file_id}.pdf`;
  const filePath = path.join(__dirname, 'temp', fileName);

  try {
    await bot.sendMessage(chatId, '📄 PDF received. Extracting info... Please wait ⏳');

    await downloadTelegramFile(document.file_id, filePath);

    const text = await extractTextFromPDF(filePath);

    if (!text || text.length < 50) {
      await bot.sendMessage(chatId, '⚠️ Could not extract text from PDF. Please ensure the file is readable.');
      return;
    }

    const result = await extractDispatchInfoWithAI(text);
    await bot.sendMessage(chatId, result);

  } catch (error) {
    console.error('Document Error:', error);
    await bot.sendMessage(chatId, `⚠️ Error: ${error.message}`);
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

// ─────────────────────────────────────────────
// TELEGRAM: PHOTO HANDLER
// ─────────────────────────────────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const photo = msg.photo[msg.photo.length - 1]; // highest resolution
  const filePath = path.join(__dirname, 'temp', `photo_${photo.file_id}.jpg`);

  try {
    await bot.sendMessage(chatId, '📷 Image received. Extracting text with OCR... Please wait ⏳');

    await downloadTelegramFile(photo.file_id, filePath);

    const text = await extractTextFromImage(filePath);

    if (!text || text.length < 50) {
      await bot.sendMessage(chatId, '⚠️ Could not extract text from image. Please ensure the image is clear and readable.');
      return;
    }

    const result = await extractDispatchInfoWithAI(text);
    await bot.sendMessage(chatId, result);

  } catch (error) {
    console.error('Photo Error:', error);
    await bot.sendMessage(chatId, `⚠️ Error processing image: ${error.message}`);
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

// ─────────────────────────────────────────────
// IMPROVEMENT: Ensure temp directory exists
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
  console.log('🤖 Bot is running... Send /start or a PDF in Telegram.');
});