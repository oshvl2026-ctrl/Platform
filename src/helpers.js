const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const CURRENCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', EGP: 'EGP ', SAR: 'SAR ', AED: 'AED ' };

function money(cents, currency) {
  const cur = String(currency || 'USD').toUpperCase();
  const v = (Number(cents || 0) / 100).toFixed(2).replace(/\.00$/, '');
  const sym = CURRENCY_SYMBOL[cur];
  return sym ? `${sym}${v}` : `${v} ${cur}`;
}

function toCents(v) {
  const n = parseFloat(String(v || '0').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

function uniqueSlug(table, title, excludeId) {
  const base = slugify(title);
  let slug = base, i = 2;
  while (db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`).get(slug, excludeId || 0)) slug = `${base}-${i++}`;
  return slug;
}

function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }

// ---------- auth ----------
function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.uid) {
    req.user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(req.session.uid) || null;
  }
  if (!req.session.csrf) req.session.csrf = randomToken(16);
  res.locals.user = req.user;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  next();
}
function flash(req, type, msg) { req.session.flash = { type, msg }; }

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'This area is for administrators only.' });
  next();
}

// Checks the CSRF token on every form POST. Multipart forms are checked after the upload is parsed.
function csrfCheck(req, res, next) {
  if (req.method !== 'POST') return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!token || token !== req.session.csrf) {
    return res.status(403).render('error', { title: 'Form expired', message: 'Your form expired. Go back, refresh the page and try again.' });
  }
  next();
}

// ---------- courses & access ----------
function isEnrolled(userId, courseId) {
  if (!userId) return false;
  return !!db.prepare('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?').get(userId, courseId);
}
function canAccessCourse(user, courseId) {
  return !!user && (user.role === 'admin' || isEnrolled(user.id, courseId));
}
function enroll(userId, courseId, source = 'purchase') {
  db.prepare('INSERT OR IGNORE INTO enrollments (user_id, course_id, source) VALUES (?, ?, ?)').run(userId, courseId, source);
}

function curriculum(courseId) {
  const sections = db.prepare('SELECT * FROM sections WHERE course_id = ? ORDER BY position, id').all(courseId);
  const lessons = db.prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY position, id').all(courseId);
  for (const s of sections) s.lessons = lessons.filter(l => l.section_id === s.id);
  return sections;
}
function orderedLessons(courseId) {
  return curriculum(courseId).flatMap(s => s.lessons);
}

function courseProgress(userId, courseId) {
  const total = db.prepare('SELECT COUNT(*) c FROM lessons WHERE course_id = ?').get(courseId).c;
  const done = userId ? db.prepare(`SELECT COUNT(*) c FROM progress p JOIN lessons l ON l.id = p.lesson_id
    WHERE p.user_id = ? AND l.course_id = ?`).get(userId, courseId).c : 0;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}
function completedSet(userId, courseId) {
  const rows = db.prepare(`SELECT p.lesson_id FROM progress p JOIN lessons l ON l.id = p.lesson_id
    WHERE p.user_id = ? AND l.course_id = ?`).all(userId, courseId);
  return new Set(rows.map(r => r.lesson_id));
}

function markComplete(userId, lesson) {
  db.prepare('INSERT OR IGNORE INTO progress (user_id, lesson_id) VALUES (?, ?)').run(userId, lesson.id);
  return maybeIssueCertificate(userId, lesson.course_id);
}

function maybeIssueCertificate(userId, courseId) {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!course || !course.cert_enabled) return null;
  const p = courseProgress(userId, courseId);
  if (!p.total || p.done < p.total) return null;
  const existing = db.prepare('SELECT * FROM certificates WHERE user_id = ? AND course_id = ?').get(userId, courseId);
  if (existing) return existing;
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  db.prepare('INSERT INTO certificates (code, user_id, course_id) VALUES (?, ?, ?)').run(code, userId, courseId);
  return db.prepare('SELECT * FROM certificates WHERE code = ?').get(code);
}

// ---------- items (course or bundle) & pricing ----------
function getItem(type, slugOrId) {
  const table = type === 'bundle' ? 'bundles' : 'courses';
  const col = typeof slugOrId === 'number' ? 'id' : 'slug';
  const item = db.prepare(`SELECT * FROM ${table} WHERE ${col} = ?`).get(slugOrId);
  if (!item) return null;
  item.item_type = type === 'bundle' ? 'bundle' : 'course';
  if (item.item_type === 'bundle') {
    item.courses = db.prepare(`SELECT c.* FROM courses c JOIN bundle_courses bc ON bc.course_id = c.id
      WHERE bc.bundle_id = ? ORDER BY c.title`).all(item.id);
  }
  return item;
}
function itemCourseIds(item) {
  return item.item_type === 'bundle' ? item.courses.map(c => c.id) : [item.id];
}

function findCoupon(code, item) {
  if (!code) return { coupon: null };
  const c = db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE').get(String(code).trim());
  if (!c || !c.active) return { error: 'That coupon code is not valid.' };
  if (c.expires_at && new Date(c.expires_at + 'T23:59:59') < new Date()) return { error: 'That coupon has expired.' };
  if (c.max_uses && c.uses >= c.max_uses) return { error: 'That coupon has been fully used.' };
  if (c.item_type && (c.item_type !== item.item_type || c.item_id !== item.id)) return { error: 'That coupon does not apply to this item.' };
  return { coupon: c };
}

// Returns prices in both currencies after the coupon.
function priceFor(item, coupon) {
  const out = {};
  for (const [cur, field, cfield] of [['USD', 'price_usd_cents', 'amount_usd_cents'], ['EGP', 'price_egp_cents', 'amount_egp_cents']]) {
    const base = item[field] || 0;
    let final = base;
    if (coupon) {
      if (coupon.kind === 'percent') final = Math.round(base * (100 - (coupon.percent_off || 0)) / 100);
      else final = base - (coupon[cfield] || 0);
    }
    out[cur] = { base, final: Math.max(0, final) };
  }
  return out;
}

// ---------- email (optional) ----------
let transporter = null;
function mailer() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = require('nodemailer').createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}
async function sendMail(to, subject, text) {
  const t = mailer();
  if (!t) { console.log(`[email not configured] To: ${to} | ${subject}\n${text}`); return false; }
  try { await t.sendMail({ from: config.smtp.from, to, subject, text }); return true; }
  catch (e) { console.error('Email failed:', e.message); return false; }
}

// Turns YouTube / Vimeo / Loom / Bunny / Wistia links into embeddable URLs.
function embedUrl(url) {
  if (!url) return null;
  let m;
  if ((m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/))) return `https://www.youtube-nocookie.com/embed/${m[1]}?rel=0&modestbranding=1`;
  if ((m = url.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/(\w+))?/))) return `https://player.vimeo.com/video/${m[1]}${m[2] ? '?h=' + m[2] : ''}`;
  if ((m = url.match(/loom\.com\/(?:share|embed)\/(\w+)/))) return `https://www.loom.com/embed/${m[1]}`;
  if (/iframe\.mediadelivery\.net|player\.mediadelivery\.net|fast\.wistia\.net|\/embed\//.test(url)) return url;
  return null;
}

module.exports = {
  money, toCents, slugify, uniqueSlug, randomToken, loadUser, flash, requireLogin, requireAdmin, csrfCheck,
  isEnrolled, canAccessCourse, enroll, curriculum, orderedLessons, courseProgress, completedSet, markComplete,
  maybeIssueCertificate, getItem, itemCourseIds, findCoupon, priceFor, sendMail, embedUrl,
};
