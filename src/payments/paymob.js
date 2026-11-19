const crypto = require('crypto');
const config = require('../config');

function enabled() {
  const p = config.paymob;
  return !!(p.secretKey && p.publicKey && p.hmacSecret && p.integrationIds.length);
}

// Creates a Paymob payment intention and returns the Unified Checkout URL to redirect the buyer to.
async function createCheckout({ order, user, title, phone, reference }) {
  const [first, ...rest] = (user.name || 'Student').trim().split(/\s+/);
  const body = {
    amount: order.amount_cents,
    currency: config.paymob.currency,
    payment_methods: config.paymob.integrationIds,
    items: [{ name: title.slice(0, 50), amount: order.amount_cents, description: title.slice(0, 255), quantity: 1 }],
    billing_data: {
      first_name: first || 'Student', last_name: rest.join(' ') || 'NA', email: user.email,
      phone_number: phone || 'NA', apartment: 'NA', floor: 'NA', street: 'NA', building: 'NA',
      city: 'NA', state: 'NA', country: 'NA', postal_code: 'NA',
    },
    customer: { first_name: first || 'Student', last_name: rest.join(' ') || 'NA', email: user.email },
    special_reference: reference,
    notification_url: `${config.baseUrl}/webhooks/paymob`,
    redirection_url: `${config.baseUrl}/checkout/paymob/return`,
  };
  const res = await fetch(`${config.paymob.baseUrl}/v1/intention/`, {
    method: 'POST',
    headers: { Authorization: `Token ${config.paymob.secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.client_secret) {
    throw new Error(`Paymob error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const url = `${config.paymob.baseUrl}/unifiedcheckout/?publicKey=${encodeURIComponent(config.paymob.publicKey)}&clientSecret=${encodeURIComponent(data.client_secret)}`;
  return { url, intentionId: data.id };
}

// Field order Paymob uses for transaction callback HMACs.
const HMAC_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id',
  'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id',
  'owner', 'pending', 'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
];

function get(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function str(v) { return v === undefined || v === null ? '' : String(v); }

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// For the server-to-server POST callback (JSON body with an "obj" transaction).
function verifyProcessed(obj, hmac) {
  const s = HMAC_FIELDS.map(f => str(get(obj, f))).join('');
  const calc = crypto.createHmac('sha512', config.paymob.hmacSecret).update(s).digest('hex');
  return safeEqual(calc, String(hmac || '').toLowerCase());
}

// For the browser redirect (flat query parameters; "order.id" arrives as "order").
function verifyRedirect(q) {
  const s = HMAC_FIELDS.map(f => str(f === 'order.id' ? q.order : q[f])).join('');
  const calc = crypto.createHmac('sha512', config.paymob.hmacSecret).update(s).digest('hex');
  return safeEqual(calc, String(q.hmac || '').toLowerCase());
}

module.exports = { enabled, createCheckout, verifyProcessed, verifyRedirect, HMAC_FIELDS };
