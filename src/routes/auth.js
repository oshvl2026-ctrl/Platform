const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const h = require('../helpers');

const router = express.Router();

function safeNext(n) { return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/my-courses'; }

// Very small in-memory limiter for login attempts.
const attempts = new Map();
function tooMany(key) {
  const now = Date.now(), list = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, list);
  return list.length >= 10;
}
function noteAttempt(key) { attempts.set(key, [...(attempts.get(key) || []), Date.now()]); }

router.get('/signup', (req, res) => res.render('auth/signup', { title: 'Create account', next: req.query.next || '', values: {} }));
router.post('/signup', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const err = !name ? 'Please enter your name.'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Please enter a valid email.'
    : password.length < 8 ? 'Password must be at least 8 characters.'
    : db.prepare('SELECT 1 FROM users WHERE email = ?').get(email) ? 'An account with that email already exists. Try logging in.'
    : null;
  if (err) return res.status(400).render('auth/signup', { title: 'Create account', next: req.body.next || '', values: { name, email }, error: err });
  const role = (config.adminEmail && email === config.adminEmail) ? 'admin' : 'student';
  const r = db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(email, name, bcrypt.hashSync(password, 10), role);
  req.session.uid = r.lastInsertRowid;
  h.sendMail(email, `Welcome to ${config.siteName}`, `Hi ${name},\n\nYour account is ready. Browse courses at ${config.baseUrl}\n\n${config.siteName}`);
  res.redirect(safeNext(req.body.next));
});

router.get('/login', (req, res) => res.render('auth/login', { title: 'Log in', next: req.query.next || '', values: {} }));
router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = req.ip + '|' + email;
  if (tooMany(key)) return res.status(429).render('auth/login', { title: 'Log in', next: req.body.next || '', values: { email }, error: 'Too many attempts. Please wait 15 minutes and try again.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    noteAttempt(key);
    return res.status(400).render('auth/login', { title: 'Log in', next: req.body.next || '', values: { email }, error: 'Email or password is incorrect.' });
  }
  attempts.delete(key);
  req.session.uid = user.id;
  res.redirect(user.role === 'admin' && !req.body.next ? '/admin' : safeNext(req.body.next));
});

router.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });

router.get('/forgot', (req, res) => res.render('auth/forgot', { title: 'Reset password' }));
router.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    const token = h.randomToken();
    db.prepare(`INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))`).run(token, user.id);
    await h.sendMail(email, `Reset your ${config.siteName} password`,
      `Hi ${user.name},\n\nUse this link within one hour to choose a new password:\n${config.baseUrl}/reset/${token}\n\nIf you didn't ask for this, ignore this email.`);
  }
  res.render('auth/forgot', { title: 'Reset password', sent: true });
});

router.get('/reset/:token', (req, res) => {
  const r = db.prepare(`SELECT * FROM password_resets WHERE token = ? AND expires_at > datetime('now')`).get(req.params.token);
  if (!r) return res.render('error', { title: 'Link expired', message: 'This reset link is invalid or has expired. Request a new one.' });
  res.render('auth/reset', { title: 'Choose a new password', token: req.params.token });
});
router.post('/reset/:token', (req, res) => {
  const r = db.prepare(`SELECT * FROM password_resets WHERE token = ? AND expires_at > datetime('now')`).get(req.params.token);
  if (!r) return res.render('error', { title: 'Link expired', message: 'This reset link is invalid or has expired.' });
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.render('auth/reset', { title: 'Choose a new password', token: req.params.token, error: 'Password must be at least 8 characters.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), r.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(r.user_id);
  req.session.uid = r.user_id;
  h.flash(req, 'success', 'Your password has been updated.');
  res.redirect('/my-courses');
});

router.get('/account', h.requireLogin, (req, res) => res.render('auth/account', { title: 'My account' }));
router.post('/account', h.requireLogin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
  if (req.body.new_password) {
    if (!bcrypt.compareSync(String(req.body.current_password || ''), user.password_hash)) {
      h.flash(req, 'error', 'Your current password is incorrect.'); return res.redirect('/account');
    }
    if (String(req.body.new_password).length < 8) { h.flash(req, 'error', 'New password must be at least 8 characters.'); return res.redirect('/account'); }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(req.body.new_password), 10), user.id);
  }
  h.flash(req, 'success', 'Account updated.');
  res.redirect('/account');
});

module.exports = router;
