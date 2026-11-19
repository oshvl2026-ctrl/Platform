const express = require('express');
const db = require('../db');
const stripe = require('../payments/stripe');
const paymob = require('../payments/paymob');
const { fulfillOrder, markFailed } = require('../payments/fulfill');

const router = express.Router();

// Stripe needs the raw body to check the signature.
router.post('/stripe', express.raw({ type: '*/*' }), (req, res) => {
  if (!stripe.enabled()) return res.status(400).send('Stripe not configured');
  let event;
  try { event = stripe.constructEvent(req.body, req.get('stripe-signature')); }
  catch (e) { console.error('Stripe webhook signature failed:', e.message); return res.status(400).send('Bad signature'); }

  const s = event.data.object;
  const orderId = Number((s.metadata && s.metadata.order_id) || s.client_reference_id);
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (s.payment_status === 'paid' && orderId) fulfillOrder(orderId, s.id);
  } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    if (orderId) markFailed(orderId, s.id);
  }
  res.json({ received: true });
});

// Paymob "transaction processed" callback.
router.post('/paymob', express.json({ limit: '1mb' }), (req, res) => {
  if (!paymob.enabled()) return res.status(400).send('Paymob not configured');
  const obj = req.body && req.body.obj;
  if (!obj || req.body.type !== 'TRANSACTION') return res.status(200).send('ignored');
  if (!paymob.verifyProcessed(obj, req.query.hmac)) { console.error('Paymob HMAC failed'); return res.status(401).send('Bad HMAC'); }

  const ref = obj.order && obj.order.merchant_order_id;
  const m = String(ref || '').match(/^order-(\d+)-/);
  const order = m ? db.prepare('SELECT * FROM orders WHERE id = ? AND provider_ref = ?').get(Number(m[1]), ref) : null;
  if (!order) return res.status(200).send('unknown order');
  if (Number(obj.amount_cents) !== order.amount_cents) { console.error('Paymob amount mismatch for order', order.id); return res.status(200).send('amount mismatch'); }

  if (obj.success === true && obj.pending === false && !obj.is_voided && !obj.is_refunded) fulfillOrder(order.id, ref);
  else if (obj.pending === false && obj.success === false) markFailed(order.id);
  res.status(200).send('ok');
});

module.exports = router;
