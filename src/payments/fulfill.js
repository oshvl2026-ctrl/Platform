const db = require('../db');
const config = require('../config');
const h = require('../helpers');

// Marks an order paid and enrolls the buyer. Safe to call more than once for the same order.
function fulfillOrder(orderId, providerRef) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  if (order.status === 'paid') return order;
  const item = h.getItem(order.item_type, order.item_id);
  const tx = db.transaction(() => {
    const r = db.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now'), provider_ref = COALESCE(?, provider_ref)
      WHERE id = ? AND status != 'paid'`).run(providerRef || null, order.id);
    if (!r.changes) return false;
    if (item) for (const cid of h.itemCourseIds(item)) h.enroll(order.user_id, cid, order.provider === 'free' ? 'coupon' : 'purchase');
    if (order.coupon_id) db.prepare('UPDATE coupons SET uses = uses + 1 WHERE id = ?').run(order.coupon_id);
    return true;
  });
  const changed = tx();
  if (changed) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
    if (user) {
      h.sendMail(user.email, `You're enrolled: ${order.item_title}`,
        `Hi ${user.name},\n\nThanks for your purchase of "${order.item_title}" (${h.money(order.amount_cents, order.currency)}).\n\n` +
        `Start learning here: ${config.baseUrl}/my-courses\n\n${config.siteName}`);
    }
  }
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
}

function markFailed(orderId, providerRef) {
  db.prepare(`UPDATE orders SET status = 'failed', provider_ref = COALESCE(?, provider_ref) WHERE id = ? AND status = 'pending'`)
    .run(providerRef || null, orderId);
}

module.exports = { fulfillOrder, markFailed };
