import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { raisState } from './raisState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function readJson(fileName, fallback) {
  try {
    const filePath = path.resolve(__dirname, '..', fileName);
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`[DASHBOARD] Could not read ${fileName}: ${error.message}`);
    return fallback;
  }
}

function isConfigured(name) {
  return Boolean(String(process.env[name] || '').trim());
}

function isEnabled(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function secureEqual(first, second) {
  const left = Buffer.from(String(first || ''));
  const right = Buffer.from(String(second || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getClientKey(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
}

function requireDashboardAuth(req, res, next) {
  const expected = process.env.BOT_DASHBOARD_PASSWORD
    || process.env.RAIS_DASHBOARD_PASSWORD;

  if (!expected) {
    res.status(503).json({ error: 'Dashboard password is not configured.' });
    return;
  }

  const clientKey = getClientKey(req);
  const now = Date.now();
  const attempt = loginAttempts.get(clientKey);

  if (attempt && attempt.blockedUntil > now) {
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return;
  }

  const provided = req.headers['x-dashboard-token'] || req.query.token;
  if (secureEqual(provided, expected)) {
    loginAttempts.delete(clientKey);
    next();
    return;
  }

  const nextCount = attempt && now - attempt.startedAt < LOGIN_WINDOW_MS
    ? attempt.count + 1
    : 1;
  loginAttempts.set(clientKey, {
    count: nextCount,
    startedAt: nextCount === 1 ? now : attempt.startedAt,
    blockedUntil: nextCount >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_WINDOW_MS : 0,
  });
  res.status(401).json({ error: 'Unauthorized' });
}

function getDispatcherSnapshot() {
  const usage = readJson('usage.json', {
    totalProcessed: 0,
    today: 0,
    lastDate: '',
    users: {},
  });
  const states = readJson('states.json', {});
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const activeStates = Object.values(states).filter((state) => state.expiresAt > now);
  const topUsers = Object.values(usage.users || {})
    .sort((first, second) => (second.count || 0) - (first.count || 0))
    .slice(0, 8)
    .map((user) => ({
      name: user.name || 'Unknown',
      count: user.count || 0,
      lastUsed: user.lastUsed || null,
    }));

  return {
    processedToday: usage.lastDate === today ? usage.today || 0 : 0,
    processedTotal: usage.totalProcessed || 0,
    userCount: Object.keys(usage.users || {}).length,
    pendingLocations: activeStates.filter(
      (state) => state.state === 'waiting_for_location',
    ).length,
    activeStates: activeStates.length,
    topUsers,
  };
}

function getConfiguration() {
  return [
    { section: 'Dispatcher', key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', required: true },
    { section: 'Dispatcher', key: 'OPENAI_API_KEY', label: 'OpenAI API key', required: true },
    { section: 'Dispatcher', key: 'MAPBOX_TOKEN', label: 'Mapbox token', required: true },
    { section: 'Triumph', key: 'TRIUMPH_CLIENT_ID', label: 'Triumph client ID', required: true },
    { section: 'Triumph', key: 'TRIUMPH_REFRESH_TOKEN', label: 'Triumph refresh token', required: true },
    { section: 'Triumph', key: 'TRIUMPH_TOKEN', label: 'Triumph access token', required: false },
    { section: 'Rais', key: 'RAIS_ENABLED', label: 'Rais enabled', required: true, configured: isEnabled('RAIS_ENABLED') },
    { section: 'Rais', key: 'RAIS_ALLOWED_CHAT_IDS', label: 'Allowed Rais chats', required: true },
    { section: 'Rais', key: 'RAIS_ALLOWED_USERNAMES', label: 'Allowed Rais users', required: false },
    { section: 'Gmail', key: 'GMAIL_CLIENT_ID', label: 'Gmail client ID', required: true },
    { section: 'Gmail', key: 'GMAIL_CLIENT_SECRET', label: 'Gmail client secret', required: true },
    { section: 'Gmail', key: 'GMAIL_REDIRECT_URI', label: 'Gmail redirect URI', required: true },
    { section: 'Gmail', key: 'GMAIL_REFRESH_TOKEN', label: 'Gmail refresh token', required: true },
    { section: 'Gmail', key: 'DEFAULT_EMAIL_TO', label: 'Fallback email recipient', required: false },
    { section: 'Dashboard', key: 'BOT_DASHBOARD_PASSWORD', label: 'Dashboard password', required: true, configured: isConfigured('BOT_DASHBOARD_PASSWORD') || isConfigured('RAIS_DASHBOARD_PASSWORD') },
  ].map((item) => ({
    ...item,
    configured: item.configured ?? isConfigured(item.key),
  }));
}

function getOverview() {
  const configuration = getConfiguration();
  const configured = (section, key) => configuration.some(
    (item) => item.section === section && item.key === key && item.configured,
  );
  const requiredReady = (section) => configuration
    .filter((item) => item.section === section && item.required)
    .every((item) => item.configured);
  const raisEnabled = isEnabled('RAIS_ENABLED');

  return {
    generatedAt: new Date().toISOString(),
    system: {
      online: true,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    services: [
      {
        name: 'Dispatcher',
        description: 'Rate confirmation extraction and mileage',
        status: requiredReady('Dispatcher') ? 'healthy' : 'needs_setup',
      },
      {
        name: 'Triumph MC',
        description: 'MC search and credit checks',
        status: requiredReady('Triumph') ? 'healthy' : 'needs_setup',
      },
      {
        name: 'Rais Gmail',
        description: 'BOL, POD, traffic and status emails',
        status: !raisEnabled
          ? 'disabled'
          : requiredReady('Rais') && requiredReady('Gmail')
            ? 'healthy'
            : 'needs_setup',
      },
      {
        name: 'Dashboard',
        description: 'Protected operations overview',
        status: configured('Dashboard', 'BOT_DASHBOARD_PASSWORD')
          ? 'healthy'
          : 'needs_setup',
      },
    ],
    dispatcher: getDispatcherSnapshot(),
    rais: {
      enabled: raisEnabled,
      sentToday: raisState.sentToday,
      filesToday: raisState.filesToday,
      errorsToday: raisState.errorsToday,
      startedAt: raisState.startedAt,
    },
    configuration,
  };
}

function setSecurityHeaders(req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
}

export function registerBotDashboard(app) {
  const publicDirectory = path.resolve(__dirname, '..', 'public', 'dashboard');

  app.use('/dashboard', setSecurityHeaders);
  app.use('/dashboard', express.static(publicDirectory, { index: 'index.html' }));
  app.get('/rais-dashboard', (req, res) => res.redirect('/dashboard/'));
  app.get('/rais-dashboard/', (req, res) => res.redirect('/dashboard/'));

  app.use('/api/dashboard', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/dashboard/overview', requireDashboardAuth, (req, res) => {
    res.json(getOverview());
  });

  app.get('/api/dashboard/activity', requireDashboardAuth, (req, res) => {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 50;
    res.json({ activity: raisState.activityLog.slice(0, limit) });
  });

  app.get('/api/dashboard/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });
}
