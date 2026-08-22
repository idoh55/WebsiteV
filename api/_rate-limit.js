// Shared Firestore-backed rate limiter for serverless API endpoints.
// Server-only collection ("rateLimits"), never touched by client SDK code,
// so default-deny Firestore rules are fine for it — cheap way to stop a
// script from hammering an endpoint without adding a separate Redis/KV
// dependency.

const admin = require('./_firebase-admin');
const db = admin.firestore();

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

async function checkRateLimit(key, { windowMs = 60 * 60 * 1000, max = 5 } = {}) {
  const ref = db.collection('rateLimits').doc(key);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    if (!data || now - data.windowStart > windowMs) {
      tx.set(ref, { windowStart: now, count: 1 });
      return true;
    }
    if (data.count >= max) return false;
    tx.update(ref, { count: data.count + 1 });
    return true;
  });
}

module.exports = { getClientIp, checkRateLimit };
