// CardCom webhook — Task 3 of the CardCom spec. Unauthenticated endpoint (validation
// happens via the GetLpResult server-to-server call below, not via the webhook payload).
// Deploy at /api/cardcom-webhook — this must be the exact WebHookUrl sent to CardCom's
// Create Low Profile call in create-cardcom-payment.js.

const admin = require('./_firebase-admin');
const db = admin.firestore();

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getLpResult(lowProfileId) {
  const payload = {
    TerminalNumber: Number(process.env.CARDCOM_TERMINAL_NUMBER),
    ApiName: process.env.CARDCOM_API_NAME,
    ApiPassword: process.env.CARDCOM_API_PASSWORD,
    LowProfileId: lowProfileId,
  };
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
  try {
    const r = await fetchWithTimeout('https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult', opts, 5000);
    return await r.json();
  } catch (e) {
    // one retry on HTTP/timeout error
    const r = await fetchWithTimeout('https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult', opts, 5000);
    return await r.json();
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  if (!process.env.CARDCOM_TERMINAL_NUMBER || !process.env.CARDCOM_API_NAME || !process.env.CARDCOM_API_PASSWORD) {
    console.error('Missing CARDCOM_TERMINAL_NUMBER / CARDCOM_API_NAME / CARDCOM_API_PASSWORD env vars');
    res.status(500).end();
    return;
  }
  const { LowProfileId } = req.body || {};
  if (!LowProfileId) {
    res.status(200).end();
    return;
  }

  const q = await db.collection('orders').where('cardcomLowProfileId', '==', LowProfileId).limit(1).get();
  if (q.empty) {
    console.error('CardCom webhook: no order found for LowProfileId', LowProfileId);
    res.status(200).end(); // acknowledge — nothing more we can do without an order
    return;
  }
  const orderDoc = q.docs[0];
  const order = orderDoc.data();

  if (order.cardcomTranzactionId) {
    res.status(200).end(); // already processed — idempotent
    return;
  }

  let result;
  try {
    result = await getLpResult(LowProfileId);
  } catch (e) {
    console.error('GetLpResult failed after retry:', e.message);
    res.status(500).json({ error: e.message });
    return;
  }

  const update = {
    cardcomResponseCode: result.ResponseCode,
    cardcomDescription: result.Description || '',
    cardcomDocumentType: result.DocumentInfo?.DocumentType || null,
    cardcomDocumentNumber: result.DocumentInfo?.DocumentNumber || null,
    cardcomToken: result.TokenInfo?.Token || null,
    cardcomTokenCardYear: result.TokenInfo?.CardYear || null,
    cardcomTokenCardMonth: result.TokenInfo?.CardMonth || null,
  };

  if (result.ResponseCode !== 0) {
    update.status = 'failed';
    await orderDoc.ref.update(update);
    res.status(200).end();
    return;
  }

  if (result.Operation === 'ChargeOnly') {
    update.status = 'paid';
    update.cardcomTranzactionId = result.TranzactionId;
    // decrement stock for each item
    await db.runTransaction(async (tx) => {
      for (const item of order.items) {
        const ref = db.collection('products').doc(item.id);
        const snap = await tx.get(ref);
        if (!snap.exists) continue;
        const stock = (snap.data().stock ?? 0) - item.qty;
        tx.update(ref, { stock: Math.max(0, stock) });
      }
      tx.update(orderDoc.ref, update);
    });
  } else if (result.Operation === 'CreateTokenOnly') {
    update.status = 'pending_charge';
    update.cardcomTranzactionId = 0;
    await orderDoc.ref.update(update);
  } else {
    await orderDoc.ref.update(update);
  }

  res.status(200).end();
};
