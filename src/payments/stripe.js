const config = require('../config');

let client = null;
function stripe() {
  if (!config.stripe.secretKey) return null;
  if (!client) client = require('stripe')(config.stripe.secretKey);
  return client;
}
function enabled() { return !!config.stripe.secretKey; }

async function createCheckout({ order, user, title }) {
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer_email: user.email,
    client_reference_id: String(order.id),
    metadata: { order_id: String(order.id) },
    line_items: [{
      quantity: 1,
      price_data: { currency: config.stripe.currency, unit_amount: order.amount_cents, product_data: { name: title } },
    }],
    success_url: `${config.baseUrl}/checkout/stripe/return?order=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/checkout/cancelled?order=${order.id}`,
  });
  return session;
}

function constructEvent(rawBody, signature) {
  return stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

async function retrieveSession(id) { return stripe().checkout.sessions.retrieve(id); }

module.exports = { enabled, createCheckout, constructEvent, retrieveSession };
