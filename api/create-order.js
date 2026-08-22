// Deploy as a serverless function (Vercel: /api). Server-side only.
// Requires: FIREBASE_SERVICE_ACCOUNT env var — set in Vercel Project
// Settings > Environment Variables, never committed to the repo.
// Optional: RESEND_API_KEY + ORDER_NOTIFY_EMAIL to email the owner when a
// new order request comes in.
//
// There is no payment step here — the site takes no card details and
// charges nothing. This just records the order request; the owner follows
// up with the customer directly (phone/WhatsApp/etc.) to arrange payment.
//
// Trusts only { id, qty } from the client — real name/price/stock always
// come from Firestore, so a tampered client request can't change what an
// order claims to cost.

const admin = require('./_firebase-admin');
const db = admin.firestore();
const { getClientIp, checkRateLimit } = require('./_rate-limit');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const MAX_OTP_ATTEMPTS = 5;

// Checks the code against what api/send-order-otp.js stored for this email,
// consuming it on success (single-use) so a leaked/guessed code can't be
// replayed for a second order. Wrong-code attempts are capped so someone
// can't just brute-force a 6-digit code against a live document.
async function verifyOrderOtp(email, code) {
  const ref = db.collection('orderOtps').doc(email);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: 'No verification code was sent to this email' };
  const data = snap.data();
  if (Date.now() > data.expiresAt) {
    await ref.delete();
    return { ok: false, reason: 'Verification code expired' };
  }
  if (data.attempts >= MAX_OTP_ATTEMPTS) {
    await ref.delete();
    return { ok: false, reason: 'Too many incorrect attempts — request a new code' };
  }
  if (data.code !== String(code || '').trim()) {
    await ref.update({ attempts: data.attempts + 1 });
    return { ok: false, reason: 'Incorrect verification code' };
  }
  await ref.delete();
  return { ok: true };
}

// Best-effort — a failed/unconfigured notification should never break the
// customer-facing order request itself.
async function sendOrderNotification(order) {
  if (!process.env.RESEND_API_KEY || !process.env.ORDER_NOTIFY_EMAIL) return;
  const itemsHtml = order.items.map(i => `${escapeHtml(i.name)} × ${i.qty} — ${i.price * i.qty} ₪`).join('<br>');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'I do Coffee <onboarding@resend.dev>',
        to: process.env.ORDER_NOTIFY_EMAIL,
        subject: `בקשת הזמנה חדשה — ${order.amount} ₪`,
        html: `<div dir="rtl" style="font-family:sans-serif">
          <h2>בקשת הזמנה חדשה!</h2>
          <p>אין תשלום מקושר — יש ליצור קשר עם הלקוח כדי לשלוח קישור לתשלום.</p>
          <p><strong>שם:</strong> ${escapeHtml(order.fullName || '—')}</p>
          <p><strong>טלפון:</strong> ${escapeHtml(order.phone || '—')}</p>
          <p><strong>אימייל:</strong> ${escapeHtml(order.email || '—')}</p>
          <p><strong>סה"כ:</strong> ${order.amount} ₪</p>
          <p><strong>פריטים:</strong><br>${itemsHtml}</p>
        </div>`,
      }),
    });
    if (!r.ok) console.error('Resend notification failed:', r.status, await r.text());
  } catch (e) {
    console.error('Failed to send order notification email:', e.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Honeypot — a hidden field real users never see or fill; bots that fill
  // every field in the form trip it. Respond as if it worked so the bot
  // doesn't learn anything and try a different approach.
  if (req.body?.company) {
    res.status(200).json({ ok: true });
    return;
  }

  const ip = getClientIp(req);
  try {
    const allowed = await checkRateLimit(`create-order_${ip}`, { windowMs: 60 * 60 * 1000, max: 2 });
    if (!allowed) {
      res.status(429).json({ error: 'Too many requests — please try again later' });
      return;
    }
  } catch (e) {
    console.error('Rate limit check failed:', e.message);
    // Fail open on infra errors — a broken rate limiter shouldn't block real orders.
  }

  try {
    const { items, fullName, phone, email, otpCode } = req.body || {};
    if (!items || !items.length) {
      res.status(400).json({ error: 'Cart is empty' });
      return;
    }
    if (!fullName || String(fullName).trim().split(' ').filter(Boolean).length < 2) {
      res.status(400).json({ error: 'Please provide a full name' });
      return;
    }
    const cleanPhone = String(phone || '').trim();
    if (!/^0\d{8,9}$/.test(cleanPhone)) {
      res.status(400).json({ error: 'Please provide a valid mobile phone number' });
      return;
    }
    const cleanEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      res.status(400).json({ error: 'Please provide a valid email address' });
      return;
    }

    // The client only reaches this point after the customer receives and
    // enters the emailed code (see api/send-order-otp.js) — verifying it
    // here is what makes the honeypot/rate-limit/ban checks hard to route
    // around with a bot.
    const otpResult = await verifyOrderOtp(cleanEmail, otpCode);
    if (!otpResult.ok) {
      res.status(401).json({ error: otpResult.reason });
      return;
    }

    const banSnap = await db.collection('bannedPhones').doc(cleanPhone).get();
    if (banSnap.exists) {
      res.status(403).json({ error: 'This phone number is blocked' });
      return;
    }

    // Look up real product data server-side.
    const resolvedItems = [];
    for (const reqItem of items) {
      const qty = Number(reqItem.qty) || 0;
      if (qty <= 0) continue;
      const snap = await db.collection('products').doc(String(reqItem.id)).get();
      if (!snap.exists) {
        res.status(400).json({ error: `Unknown product: ${reqItem.id}` });
        return;
      }
      const p = snap.data();
      if (p.active === false) {
        res.status(400).json({ error: `Product no longer available: ${p.name}` });
        return;
      }
      if (!p.comingSoon && (p.stock ?? 0) < qty) {
        res.status(400).json({ error: `Not enough stock for: ${p.name}` });
        return;
      }
      resolvedItems.push({ id: snap.id, name: p.name, price: p.price, qty });
    }
    if (resolvedItems.length === 0) {
      res.status(400).json({ error: 'Cart is empty' });
      return;
    }

    const amount = resolvedItems.reduce((s, i) => s + i.price * i.qty, 0);

    const order = {
      items: resolvedItems,
      amount,
      fullName: String(fullName).trim(),
      phone: String(phone).trim(),
      email: cleanEmail,
      status: 'pending',
      stockDecremented: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const orderRef = await db.collection('orders').add(order);

    await sendOrderNotification(order);

    res.status(200).json({ ok: true, orderId: orderRef.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
