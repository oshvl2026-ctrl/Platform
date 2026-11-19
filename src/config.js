const path = require('path');
const fs = require('fs');

// Load a local .env file if present (for running on your own computer).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(dataDir, { recursive: true });

// Session secret: use the env var, otherwise generate one and keep it in the data folder.
let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  const f = path.join(dataDir, '.session-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, require('crypto').randomBytes(32).toString('hex'));
  sessionSecret = fs.readFileSync(f, 'utf8').trim();
}

module.exports = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  siteName: env.SITE_NAME || 'CourseHub',
  brandColor: env.BRAND_COLOR || '#0E6B5C',
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  sessionSecret,
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 1024),
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    currency: (env.STRIPE_CURRENCY || 'usd').toLowerCase(),
  },
  paymob: {
    baseUrl: (env.PAYMOB_BASE_URL || 'https://accept.paymob.com').replace(/\/$/, ''),
    secretKey: env.PAYMOB_SECRET_KEY || '',
    publicKey: env.PAYMOB_PUBLIC_KEY || '',
    hmacSecret: env.PAYMOB_HMAC_SECRET || '',
    integrationIds: (env.PAYMOB_INTEGRATION_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number),
    currency: (env.PAYMOB_CURRENCY || 'EGP').toUpperCase(),
  },
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  },
};
