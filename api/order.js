/**
 * api/order.js — Sol Order Status Lookup
 * Proxies to the Shopify Orders Apps Script web app
 * which reads directly from the Google Sheet.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { order_number, email, phone } = req.body || {};
  const scriptUrl = process.env.SHOPIFY_ORDERS_SCRIPT_URL;

  if (!scriptUrl)    return res.status(500).json({ error: 'Order lookup not configured' });
  if (!order_number) return res.status(400).json({ error: 'Order number required' });
  if (!email && !phone) return res.status(400).json({ error: 'Email or phone required' });

  try {
    const params = new URLSearchParams({ order: String(order_number).trim() });
if (email) params.set('email', String(email).trim().toLowerCase());
if (phone) params.set('phone', String(phone).trim().replace(/[^0-9+]/g, ''));
const url = `${scriptUrl}?${params.toString()}`;
    const r   = await fetch(url, { method: 'GET' });
    if (!r.ok) return res.status(502).json({ error: 'Order lookup service unavailable' });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Order lookup error:', err.message);
    return res.status(500).json({ error: 'Order lookup failed' });
  }
}
