/**
 * api/whatsapp.js
 * ═══════════════════════════════════════════════════════════════
 * Sol WhatsApp Integration via Twilio
 * ───────────────────────────────────────────────────────────────
 * Flow:
 *   Customer sends WhatsApp message to Kindly number
 *   → Twilio sends HTTP POST to this webhook
 *   → We call Sol's existing chat logic
 *   → We reply with TwiML so Twilio sends the response back
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';

export default async function handler(req, res) {

  // ── Only accept POST from Twilio ──────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // ── Verify request is genuinely from Twilio ───────────────────
  // This prevents anyone else from hitting your webhook and
  // generating Claude API calls at your expense
  const twilioSignature = req.headers['x-twilio-signature'];
  const authToken      = process.env.TWILIO_AUTH_TOKEN;
  const webhookUrl     = process.env.TWILIO_WEBHOOK_URL; // your full Vercel URL

  if (authToken && webhookUrl && twilioSignature) {
    const isValid = validateTwilioSignature(
      authToken,
      webhookUrl,
      req.body,
      twilioSignature
    );
    if (!isValid) {
      console.error('Invalid Twilio signature — request rejected');
      return res.status(403).send('Forbidden');
    }
  }

  // ── Extract message from Twilio's form-encoded body ───────────
  const from    = req.body.From    || '';  // e.g. "whatsapp:+447911123456"
  const body    = req.body.Body    || '';  // the customer's message text
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  console.log(`WhatsApp message from ${from}: "${body}" (${numMedia} media)`);

  if (!body && numMedia === 0) {
    return twimlReply(res, "Hey! ☀️ I'm Sol, Kindly's product guide. Send me a message and I'll help with ingredients, allergens, opening hours, or anything about our range!");
  }

  // ── Build message for Sol ─────────────────────────────────────
  const solUrl = 'https://ask-sol.vercel.app/api/chat';

  // Extract clean phone number from Twilio's "whatsapp:+447782561688" format
  const customerPhone = from ? from.replace('whatsapp:', '').replace(/[^0-9+]/g, '') : '';

  const messages = [
    {
      role: 'user',
      content: body || 'Hello'
    }
  ];

  // ── Call Sol's existing chat endpoint ─────────────────────────
  let solReply = '';
  try {
    const solRes = await fetch(solUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:           'claude-haiku-4-5-20251001',
        max_tokens:      500,
        system:          buildWhatsAppSystemPrompt(),
        messages,
        _customer_phone: customerPhone,  // passed through for order lookup
        _channel:        'whatsapp',
      }),
    });

    if (!solRes.ok) {
      throw new Error(`Sol API returned ${solRes.status}`);
    }

    const data = await solRes.json();
    solReply = data?.content?.[0]?.text || '';

  } catch (err) {
    console.error('Sol API error:', err.message);
    solReply = "Sorry, I'm having a little trouble right now! 🌱 Pop into the shop or call us and the team will help. York Place: Mon–Fri 8am–7pm, Sat 9am–7pm, Sun 10am–5pm.";
  }

  // ── Clean up Sol's response for WhatsApp ─────────────────────
  // WhatsApp doesn't render markdown — strip asterisks and backticks
  solReply = cleanForWhatsApp(solReply);

  // ── Log question to Supabase with channel=whatsapp ────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (supabaseUrl && supabaseKey && body) {
    fetch(`${supabaseUrl}/rest/v1/sol_question_log`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        question:  body,
        answer:    solReply,
        had_image: false,
        from_db:   false,
        off_topic: false,
        channel:   'whatsapp',
        asked_at:  new Date().toISOString(),
      }),
    }).catch(() => {});
  }

  // ── If Sol used general knowledge, forward to Slack for team follow-up ──
  const isUncertain = solReply.includes('💡') || solReply.includes('General knowledge');
  if (isUncertain && from) {
    forwardToSlack(from, body, solReply).catch(() => {});
  }

  // ── Reply via TwiML ───────────────────────────────────────────
  return twimlReply(res, solReply);
}

// ── Helpers ───────────────────────────────────────────────────────

function buildWhatsAppSystemPrompt() {
  return `You are Sol, the friendly product guide for Kindly of Brighton — the UK's first hybrid sustainable supermarket. You're answering via WhatsApp so keep responses concise and conversational.

KINDLY FACTS:
- Two stores in Brighton (not York the city — York Place is a street in Brighton):
  • York Place store: 20-21 York Place, Brighton BN1 4GU — Mon–Fri 8am–7pm, Sat 9am–7pm, Sun 10am–5pm
  • Dyke Road store: 110-114 Dyke Road, Brighton BN1 3TE — Mon–Sat 9am–6pm, Sun 10am–4pm
- 100% plant-based, ~80% organic, plastic-free refill options
- Website: kindlyofbrighton.com | Instagram/TikTok: @kindlybrighton
- Loyalty scheme: https://start.mylty.co?id=21913

CRITICAL — STORE NAMES:
There are only TWO Kindly stores, both in Brighton. "York Place" and "York" both refer to the same single store at 20-21 York Place, Brighton. Never ask "which York Place store" — there is only one. Never confuse York Place (a street in Brighton) with York (a city in Yorkshire).

OPENING HOURS — always answer exactly like this when asked:
York Place: Mon–Fri 8am–7pm, Sat 9am–7pm, Sun 10am–5pm
Dyke Road: Mon–Sat 9am–6pm, Sun 10am–4pm

WHATSAPP RULES:
- Keep replies SHORT — 3-5 sentences max for WhatsApp
- No markdown formatting (no **bold**, no dashes for bullets, use • instead)
- Be warm and human — this is a real conversation
- If you don't know something specific, say so honestly and suggest they call or visit
- For allergen questions always add: "Please check with the team in store to be 100% sure"
- Never make up product details you're not certain about
- Do NOT add any source indicators or tags at the end of messages`;
}

function cleanForWhatsApp(text) {
  return text
    // Remove DB/knowledge indicators FIRST — before markdown stripping
    // Handle both with and without asterisks (in case already stripped)
    .replace(/📋\s*\*?From Kindly.*?\*?\n?/g, '')
    .replace(/💡\s*\*?General knowledge.*?\*?\n?/g, '')
    .replace(/📋\s*\*?From Kindly[^\n]*/g, '')
    .replace(/💡\s*\*?General[^\n]*/g, '')
    // Now strip markdown formatting
    .replace(/\*\*(.*?)\*\*/g, '$1')      // remove **bold**
    .replace(/\*(.*?)\*/g, '$1')          // remove *italic*
    .replace(/`(.*?)`/g, '$1')            // remove `code`
    .replace(/^[-•]\s/gm, '• ')          // normalise bullet points
    .replace(/\n{3,}/g, '\n\n')           // max double line breaks
    .trim();
}

function twimlReply(res, message) {
  // Escape XML special characters
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escaped}</Message>
</Response>`
  );
}

function validateTwilioSignature(authToken, url, params, signature) {
  // Twilio signature validation
  // https://www.twilio.com/docs/usage/security#validating-signatures-from-twilio
  try {
    const sortedParams = Object.keys(params)
      .sort()
      .reduce((str, key) => str + key + params[key], url);

    const hmac = crypto
      .createHmac('sha1', authToken)
      .update(sortedParams)
      .digest('base64');

    return hmac === signature;
  } catch (e) {
    return false;
  }
}

// ── Tell Vercel this route accepts URL-encoded form data from Twilio ──
export const config = {
  api: {
    bodyParser: {
      type: 'application/x-www-form-urlencoded',
    },
  },
};

// ── Forward unanswered questions to Slack ─────────────────────────────────
// Called when Sol's answer contains the 💡 indicator (general knowledge only)
// Posts to your weekly-reports Slack channel so the team can follow up
async function forwardToSlack(from, question, solAnswer) {
  const slackWebhook = process.env.SLACK_WEBHOOK_URL;
  if (!slackWebhook) return;

  const customerNumber = from.replace('whatsapp:', '');
  const message = {
    text: `📱 *WhatsApp question Sol couldn't fully answer*\n` +
          `*From:* ${customerNumber}\n` +
          `*Question:* ${question}\n` +
          `*Sol replied:* ${solAnswer.substring(0, 200)}${solAnswer.length > 200 ? '...' : ''}\n` +
          `_Reply directly to ${customerNumber} on WhatsApp if you can help_`,
  };

  try {
    await fetch(slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch(e) {
    console.error('Slack forward error:', e.message);
  }
}
