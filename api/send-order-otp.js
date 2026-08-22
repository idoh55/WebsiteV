// Sends a 6-digit email verification code before an order request is
// accepted (see api/create-order.js). Requires: RESEND_API_KEY env var —
// set in Vercel Project Settings > Environment Variables, never committed.
//
// IMPORTANT: this sends to arbitrary customer addresses, not just your own
// inbox. Resend's shared sender (onboarding@resend.dev) can only deliver to
// the email your own Resend account is registered under — sending to real
// customers requires verifying your own sending domain in the Resend
// dashboard (Domains > Add Domain, then add the DNS records it gives you).
// Until that's done, codes will only actually arrive when testing with your
// own Resend account email.

const admin = require('./_firebase-admin');
const db = admin.firestore();
const { getClientIp, checkRateLimit } = require('./_rate-limit');

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.RESEND_API_KEY) {
    console.error('Missing RESEND_API_KEY env var');
    res.status(500).json({ error: 'Email verification is not configured' });
    return;
  }

  // Honeypot — mirrors the one on the order form itself; a bot filling
  // every field trips this before we ever generate/send a code.
  if (req.body?.company) {
    res.status(200).json({ ok: true });
    return;
  }

  const email = normalizeEmail(req.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  const ip = getClientIp(req);
  try {
    const ipAllowed = await checkRateLimit(`send-otp-ip_${ip}`, { windowMs: 60 * 60 * 1000, max: 5 });
    const emailAllowed = await checkRateLimit(`send-otp-email_${email}`, { windowMs: 60 * 60 * 1000, max: 3 });
    if (!ipAllowed || !emailAllowed) {
      res.status(429).json({ error: 'Too many requests — please try again later' });
      return;
    }
  } catch (e) {
    console.error('Rate limit check failed:', e.message);
    // Fail open on infra errors — a broken rate limiter shouldn't block real orders.
  }

  const code = generateCode();
  try {
    await db.collection('orderOtps').doc(email).set({
      code,
      expiresAt: Date.now() + CODE_TTL_MS,
      attempts: 0,
    });

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'I do Coffee <onboarding@resend.dev>',
        to: email,
        subject: `קוד האימות שלכם: ${code}`,
        html: `<div dir="rtl" style="font-family:sans-serif">
          <p>קוד האימות לשליחת בקשת ההזמנה שלכם ב-i do:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>
          <p style="color:#666;font-size:13px">הקוד בתוקף ל-10 דקות. אם לא ביקשתם קוד זה, אפשר להתעלם מהמייל.</p>
        </div>`,
      }),
    });
    if (!r.ok) {
      console.error('Resend OTP email failed:', r.status, await r.text());
      res.status(502).json({ error: 'Failed to send verification email' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('send-order-otp error:', e.message);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
};
