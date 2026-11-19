const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const config = require('./src/config');
const db = require('./src/db');
const h = require('./src/helpers');
const files = require('./src/files');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Payment webhooks first: they need their own body parsing and no login or form token.
app.use('/webhooks', require('./src/routes/webhooks'));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/legacy/build'), { maxAge: '30d' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieSession({
  name: 'lms', keys: [config.sessionSecret], maxAge: 30 * 24 * 3600 * 1000,
  sameSite: 'lax', httpOnly: true, secure: config.baseUrl.startsWith('https://'),
}));
app.use(h.loadUser);
app.use((req, res, next) => (req.is('multipart/form-data') ? next() : h.csrfCheck(req, res, next)));

app.locals.site = { name: config.siteName, brand: config.brandColor, baseUrl: config.baseUrl };
app.locals.money = h.money;
const { marked } = require('marked');
app.locals.md = (t) => marked.parse(String(t || ''));
app.locals.fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// Public course cover images.
app.get('/img/:name', (req, res) => {
  const ok = db.prepare('SELECT 1 FROM courses WHERE image_path = ?').get(req.params.name);
  if (!ok) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(files.abs(req.params.name));
});

app.get('/healthz', (req, res) => res.send('ok'));
app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/store').router);
app.use('/', require('./src/routes/learn'));
app.use('/admin', require('./src/routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: "We couldn't find that page." }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again. If it keeps happening, contact support.' });
});

// Create the admin account from ADMIN_EMAIL / ADMIN_PASSWORD on first start.
if (config.adminEmail) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(config.adminEmail);
  if (u && u.role !== 'admin') db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(u.id);
  if (!u && config.adminPassword) {
    db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')`)
      .run(config.adminEmail, 'Admin', bcrypt.hashSync(config.adminPassword, 10));
    console.log(`Admin account created for ${config.adminEmail}`);
  }
}

if (require.main === module) {
  app.listen(config.port, () => console.log(`${config.siteName} running at ${config.baseUrl} (port ${config.port})`));
}
module.exports = app;
