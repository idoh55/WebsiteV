// Deploy as a serverless function (Vercel: /api). Server-side only.
// Requires: FIREBASE_SERVICE_ACCOUNT, CARDCOM_TERMINAL_NUMBER, CARDCOM_API_NAME env vars.
// See SETUP-FIREBASE.md for setup.
//
// Trusts only { id, qty } from the client — real name/price/stock always come from
// Firestore, so a tampered client request can't change what gets charged.

const admin = require('./_firebase-admin');
const db = admin.firestore();

const CARDCOM_ENDPOINT = 'https://secure.cardcom.solutions/api/v11/LowProfile/Create';
const YOUR_SITE_URL = 'https://your-domain.example';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const { items, fullName, phone } = req.body;
    if (!items || !items.length) {
      res.status(400).json({ error: 'Cart is empty' });
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

    const orderRef = await db.collection('orders').add({
      items: resolvedItems,
      amount,
      fullName: fullName || '',
      phone: phone || '',
      status: 'pending',
      cardcomLowProfileId: null,
      cardcomTranzactionId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const payload = {
      TerminalNumber: Number(process.env.CARDCOM_TERMINAL_NUMBER || 1000),
      ApiName: process.env.CARDCOM_API_NAME || 'CardTest1994',
      Operation: 'ChargeOnly',
      ReturnValue: orderRef.id,
      Amount: amount,
      SuccessRedirectUrl: `${YOUR_SITE_URL}/?checkout=success`,
      FailedRedirectUrl: `${YOUR_SITE_URL}/?checkout=cancelled`,
      WebHookUrl: `${YOUR_SITE_URL}/api/cardcom-webhook`,
      Language: 'he',
      ISOCoinId: 1,
      UIDefinition: {
        CardOwnerNameValue: fullName || '',
        CardOwnerPhoneValue: phone || '',
      },
      Document: {
        DocumentTypeToCreate: 'Auto',
        IsAllowEditDocument: true,
        Name: fullName || 'Customer',
        Mobile: phone || '',
        Language: 'he',
        Products: resolvedItems.map(i => ({
          Description: i.name,
          UnitCost: i.price,
          Quantity: i.qty,
        })),
      },
    };

    const cardcomRes = await fetch(CARDCOM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await cardcomRes.json();

    if (data.ResponseCode !== 0) {
      console.error('CardCom error:', data.Description);
      await orderRef.update({ status: 'failed', cardcomDescription: data.Description || '' });
      res.status(502).json({ error: 'Payment page could not be created' });
      return;
    }

    await orderRef.update({ cardcomLowProfileId: data.LowProfileId, cardcomOperation: 'ChargeOnly' });
    res.status(200).json({ url: data.Url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
