import express from 'express';
import { config } from '../config.js';
import { shopifyHmacValid } from '../lib/crypto.js';
import { getOrder } from '../integrations/shopify.js';
import { processOrder } from '../services/orders.js';

export const webhooks = express.Router();

// Raw body is needed to verify Shopify's HMAC.
webhooks.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  if (!shopifyHmacValid(req.body, req.get('X-Shopify-Hmac-Sha256'), config.shopify.webhookSecret)) return res.sendStatus(401);
  res.sendStatus(200); // acknowledge fast; the nightly reconcile catches anything that fails below
  try {
    const payload = JSON.parse(req.body.toString('utf8'));
    const topic = req.get('X-Shopify-Topic') || '';
    const orderId = topic.startsWith('refunds/') ? payload.order_id : payload.id;
    if (!orderId) return;
    const order = await getOrder(`gid://shopify/Order/${orderId}`);
    if (order) await processOrder(order);
  } catch (e) {
    console.error('webhook processing failed', e.message);
  }
});
