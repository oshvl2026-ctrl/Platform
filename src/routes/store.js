const express = require('express');
const db = require('../db');
const config = require('../config');
const h = require('../helpers');
const stripe = require('../payments/stripe');
const paymob = require('../payments/paymob');
const { fulfillOrder, markFailed } = require('../payments/fulfill');

const router = express.Router();

// ---------- catalog ----------
router.get('/', (req, res) => {
  const courses = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) lesson_count
    FROM courses c WHERE published = 1 ORDER BY created_at DESC`).all();
  const bundles = db.prepare('SELECT * FROM bundles WHERE published = 1 ORDER BY id DESC').all()
    .map(b => h.getItem('bundle', b.id));
  res.render('home', { title: config.siteName, courses, bundles });
});

router.get('/courses/:slug', (req, res) => {
  const course = h.getItem('course', req.params.slug);
  if (!course || (!course.published && !(req.user && req.user.role === 'admin'))) return res.status(404).render('error', { title: 'Not found', message: 'That course could not be found.' });
  const sections = h.curriculum(course.id);
  const enrolled = req.user && h.isEnrolled(req.user.id, course.id);
  const progress = enrolled ? h.courseProgress(req.user.id, course.id) : null;
  const lessonCount = sections.reduce((n, s) => n + s.lessons.length, 0);
  res.render('course', { title: course.title, course, sections, enrolled, progress, lessonCount });
});

router.get('/bundles/:slug', (req, res) => {
  const bundle = h.getItem('bundle', req.params.slug);
  if (!bundle || (!bundle.published && !(req.user && req.user.role === 'admin'))) return res.status(404).render('error', { title: 'Not found', message: 'That bundle could not be found.' });
  const owned = req.user ? bundle.courses.every(c => h.isEnrolled(req.user.id, c.id)) : false;
  const separate = bundle.courses.reduce((a, c) => ({ USD: a.USD + c.price_usd_cents, EGP: a.EGP + c.price_egp_cents }), { USD: 0, EGP: 0 });
  res.render('bundle', { title: bundle.title, bundle, owned, separate });
});

router.get('/verify{/:code}', (req, res) => {
  const code = String(req.params.code || req.query.code || '').trim().toUpperCase();
  const cert = code ? db.prepare(`SELECT ce.*, u.name student, c.title course FROM certificates ce
    JOIN users u ON u.id = ce.user_id JOIN courses c ON c.id = ce.course_id WHERE ce.code = ?`).get(code) : null;
  res.render('verify', { title: 'Verify certificate', code, cert });
});

// ---------- checkout ----------
function loadCheckout(req) {
  const type = req.params.type === 'bundle' ? 'bundle' : 'course';
  const item = h.getItem(type, req.params.slug);
  if (!item || !item.published) return { error: 'not_found' };
  const codeInput = (req.body && req.body.coupon) || req.query.coupon || '';
  const { coupon, error: couponError } = h.findCoupon(codeInput, item);
  const prices = h.priceFor(item, coupon);
  return { type, item, coupon, couponError, couponCode: codeInput, prices };
}

// Only "course" and "bundle" are checkout types; anything else falls through to the routes below.
const itemType = (req, res, next) => (['course', 'bundle'].includes(req.params.type) ? next() : next('route'));

router.get('/checkout/:type/:slug', itemType, h.requireLogin, (req, res) => {
  const c = loadCheckout(req);
  if (c.error) return res.status(404).render('error', { title: 'Not found', message: 'That item is not available.' });
  const ids = h.itemCourseIds(c.item);
  if (ids.length && ids.every(id => h.isEnrolled(req.user.id, id))) {
    h.flash(req, 'success', 'You already have access.');
    return res.redirect(c.type === 'course' ? `/learn/${c.item.slug}` : '/my-courses');
  }
  res.render('checkout', {
    title: 'Checkout', ...c,
    stripeOn: stripe.enabled() && c.item.price_usd_cents > 0,
    paymobOn: paymob.enabled() && c.item.price_egp_cents > 0,
    stripeCurrency: config.stripe.currency.toUpperCase(), paymobCurrency: config.paymob.currency,
  });
});

router.post('/checkout/:type/:slug', itemType, h.requireLogin, async (req, res, next) => {
  try {
    const c = loadCheckout(req);
    if (c.error) return res.status(404).render('error', { title: 'Not found', message: 'That item is not available.' });
    const back = `/checkout/${c.type}/${c.item.slug}${c.couponCode ? '?coupon=' + encodeURIComponent(c.couponCode) : ''}`;
    if (c.couponError) { h.flash(req, 'error', c.couponError); return res.redirect(`/checkout/${c.type}/${c.item.slug}`); }
    const provider = req.body.provider;

    const createOrder = (prov, currency, amount) => {
      const r = db.prepare(`INSERT INTO orders (user_id, item_type, item_id, item_title, provider, currency, amount_cents, coupon_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, c.type, c.item.id, c.item.title, prov, currency, amount, c.coupon ? c.coupon.id : null);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(r.lastInsertRowid);
    };

    // Free (price 0 or 100% coupon): enroll right away.
    if (provider === 'free' && c.prices.USD.final === 0 && c.prices.EGP.final === 0) {
      const order = createOrder('free', 'USD', 0);
      fulfillOrder(order.id, 'free');
      h.flash(req, 'success', `You're enrolled in ${c.item.title}.`);
      return res.redirect(c.type === 'course' ? `/learn/${c.item.slug}` : '/my-courses');
    }

    if (provider === 'stripe' && stripe.enabled()) {
      const amount = c.prices.USD.final;
      if (amount < 50) { h.flash(req, 'error', 'Card payments need a total of at least 0.50.'); return res.redirect(back); }
      const order = createOrder('stripe', config.stripe.currency.toUpperCase(), amount);
      const session = await stripe.createCheckout({ order, user: req.user, title: c.item.title });
      db.prepare('UPDATE orders SET provider_ref = ? WHERE id = ?').run(session.id, order.id);
      return res.redirect(303, session.url);
    }

    if (provider === 'paymob' && paymob.enabled()) {
      const phone = String(req.body.phone || '').replace(/[^\d+]/g, '');
      if (phone.length < 8) { h.flash(req, 'error', 'Please enter your mobile number for local payment.'); return res.redirect(back); }
      const amount = c.prices.EGP.final;
      if (amount < 100) { h.flash(req, 'error', 'Local payments need a total of at least 1.00.'); return res.redirect(back); }
      const order = createOrder('paymob', config.paymob.currency, amount);
      const reference = `order-${order.id}-${Date.now()}`;
      db.prepare('UPDATE orders SET provider_ref = ? WHERE id = ?').run(reference, order.id);
      const { url } = await paymob.createCheckout({ order, user: req.user, title: c.item.title, phone, reference });
      return res.redirect(303, url);
    }

    h.flash(req, 'error', 'Please choose a payment method.');
    res.redirect(back);
  } catch (e) {
    console.error(e);
    h.flash(req, 'error', 'We could not start the payment. Please try again in a moment.');
    res.redirect(`/checkout/${req.params.type}/${req.params.slug}`);
  }
});

function orderFromRef(ref) {
  const m = String(ref || '').match(/^order-(\d+)-/);
  return m ? db.prepare('SELECT * FROM orders WHERE id = ? AND provider_ref = ?').get(Number(m[1]), ref) : null;
}

function successRedirect(res, order) { res.redirect(`/checkout/thanks?order=${order.id}`); }

// Stripe sends the buyer back here. The webhook is the main confirmation; this also checks directly in case the webhook is slow.
router.get('/checkout/stripe/return', h.requireLogin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(req.query.order), req.user.id);
  if (!order) return res.redirect('/my-courses');
  try {
    if (order.status !== 'paid' && stripe.enabled() && req.query.session_id === order.provider_ref) {
      const s = await stripe.retrieveSession(order.provider_ref);
      if (s.payment_status === 'paid' && String(s.metadata.order_id) === String(order.id)) fulfillOrder(order.id, s.id);
    }
  } catch (e) { console.error('Stripe lookup failed:', e.message); }
  successRedirect(res, order);
});

// Paymob sends the buyer back here with signed query parameters.
router.get('/checkout/paymob/return', (req, res) => {
  const q = req.query;
  if (!paymob.enabled() || !paymob.verifyRedirect(q)) return res.status(400).render('error', { title: 'Payment check failed', message: 'We could not verify this payment response. If you were charged, contact us and we will sort it out.' });
  const order = orderFromRef(q.merchant_order_id);
  if (!order) return res.redirect('/my-courses');
  if (q.success === 'true' && q.pending !== 'true') fulfillOrder(order.id, order.provider_ref);
  else if (q.pending !== 'true') markFailed(order.id);
  successRedirect(res, order);
});

router.get('/checkout/thanks', h.requireLogin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(req.query.order), req.user.id);
  if (!order) return res.redirect('/my-courses');
  const course = order.item_type === 'course' ? db.prepare('SELECT * FROM courses WHERE id = ?').get(order.item_id) : null;
  res.render('thanks', { title: order.status === 'paid' ? 'Payment received' : 'Payment status', order, course });
});

router.get('/checkout/cancelled', h.requireLogin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(req.query.order), req.user.id);
  if (order) markFailed(order.id);
  h.flash(req, 'error', 'Payment was cancelled. You have not been charged.');
  res.redirect('/');
});

router.get('/orders', h.requireLogin, (req, res) => {
  const orders = db.prepare(`SELECT * FROM orders WHERE user_id = ? AND status != 'pending' ORDER BY id DESC`).all(req.user.id);
  res.render('orders', { title: 'My purchases', orders });
});

module.exports = { router, orderFromRef };
