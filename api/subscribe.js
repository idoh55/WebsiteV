// Adds an email to the Resend Audience used for the waitlist signup form.
// Requires: RESEND_API_KEY, RESEND_AUDIENCE_ID env vars — set in Vercel
// Project Settings > Environment Variables, never committed to the repo.
// Create the Audience once in the Resend dashboard and put its id in
// RESEND_AUDIENCE_ID.

const admin = require('./_firebase-admin');
const db = admin.firestore();

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 5; // per IP, per window

// Firestore-backed sliding-window-ish rate limit (server-only collection,
// never touched by client SDK code, so default-deny Firestore rules are
// fine for it) — cheap way to stop a script from hammering the endpoint
// without adding a separate Redis/KV dependency.
async function checkRateLimit(key) {
  const ref = db.collection('rateLimits').doc(key);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    if (!data || now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
      tx.set(ref, { windowStart: now, count: 1 });
      return true;
    }
    if (data.count >= RATE_LIMIT_MAX) return false;
    tx.update(ref, { count: data.count + 1 });
    return true;
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_AUDIENCE_ID) {
    console.error('Missing RESEND_API_KEY / RESEND_AUDIENCE_ID env vars');
    res.status(500).json({ error: 'Mailing list is not configured' });
    return;
  }

  // Honeypot — a hidden field real users never see or fill; bots that fill
  // every field in the form trip it. Respond as if it worked so the bot
  // doesn't learn anything and try a different approach.
  if (req.body?.company) {
    res.status(200).json({ ok: true });
    return;
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  try {
    const allowed = await checkRateLimit(`subscribe_${ip}`);
    if (!allowed) {
      res.status(429).json({ error: 'Too many requests — please try again later' });
      return;
    }
  } catch (e) {
    console.error('Rate limit check failed:', e.message);
    // Fail open on infra errors — a broken rate limiter shouldn't take down signups.
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  try {
    const r = await fetch(`https://api.resend.com/audiences/${process.env.RESEND_AUDIENCE_ID}/contacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, unsubscribed: false }),
    });
    if (!r.ok) {
      // Resend returns 409-ish behavior as an update for existing contacts on
      // some plans; only treat genuine failures as errors.
      const text = await r.text();
      console.error('Resend contact add failed:', r.status, text);
      res.status(502).json({ error: 'Failed to add to mailing list' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Subscribe error:', e.message);
    res.status(500).json({ error: 'Failed to add to mailing list' });
  }
};
