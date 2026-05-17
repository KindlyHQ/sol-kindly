/**
 * api/whatsapp.js — Sol WhatsApp Integration via Twilio
 *
 * ARCHITECTURE: DB-first, Claude as last resort
 *   1. Detect question type
 *   2. Try Supabase first (store info, products, orders)
 *   3. Only call Claude if Supabase doesn't have the answer
 *   4. Reply via TwiML
 */

import crypto from 'crypto';

export default async function handler(req, res) {

  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── Twilio signature validation ──────────────────────────────────────────
  const twilioSignature = req.headers['x-twilio-signature'];
  const authToken       = process.env.TWILIO_AUTH_TOKEN;
  const webhookUrl      = process.env.TWILIO_WEBHOOK_URL;

  if (authToken && webhookUrl && twilioSignature) {
    if (!validateTwilioSignature(authToken, webhookUrl, req.body, twilioSignature)) {
      console.error('Invalid Twilio signature');
      return res.status(403).send('Forbidden');
    }
  }

  // ── Extract message ──────────────────────────────────────────────────────
  const from  = req.body.From || '';
  const body  = (req.body.Body || '').trim();
  const customerPhone = from.replace('whatsapp:', '').replace(/[^0-9+]/g, '');

  if (!body) {
    return twimlReply(res,
      "Hey! ☀️ I'm Sol, Kindly's product guide. Ask me anything about our range, opening hours, or ingredients!"
    );
  }

  // ── Environment ──────────────────────────────────────────────────────────
  const apiKey      = process.env.CLAUDE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const scriptUrl   = process.env.SHOPIFY_ORDERS_SCRIPT_URL;

  const qLower = body.toLowerCase();

  let solReply   = '';
  let fromDb     = false;

  try {

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1: Detect question type
    // ════════════════════════════════════════════════════════════════════════
    const isStoreInfo = /\b(open|close|opening|closing|hours|time|address|location|find you|where are|get to|park)\b/.test(qLower);
    const isHiring    = /\b(hiring|job|jobs|vacancy|work here|career|apply|join the team)\b/.test(qLower);
    const isAbout     = /\b(about kindly|who are you|what is kindly|kindly story|founded|mission|impact|plastic|co2|environment)\b/.test(qLower);
    const isLoyalty   = /\b(loyalty|points|reward|loyalzoo|sign up|membership|lty)\b/.test(qLower);
    const isOrder     = /\b(order|my order|order status|track|when.*deliver|delivery.*when|shipped|dispatch|parcel)\b/.test(qLower);
    const isOffTopic  = /\b(weather|news|sport|politics|stock|crypto|bitcoin|recipe for|how to cook|tell me a joke|who is the president)\b/.test(qLower);

    // Order number and email extraction
    const orderNumMatch = body.match(/#?(\d{3,6})/);
    const emailMatch    = body.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/i);

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2: Off-topic guard
    // ════════════════════════════════════════════════════════════════════════
    if (isOffTopic) {
      solReply = "I'm Sol — Kindly Brighton's product guide, so I'm best at questions about our range, hours, ingredients and allergens! 🌱 Is there anything Kindly-related I can help with?";
      fromDb = false;

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3: Store info — answer directly from Supabase (no Claude needed)
    // ════════════════════════════════════════════════════════════════════════
    } else if ((isStoreInfo || isHiring || isAbout || isLoyalty) && supabaseUrl && supabaseKey) {
      try {
        const info = await fetchStoreInfo(supabaseUrl, supabaseKey);
        if (info) {
          fromDb = true;
          if (isLoyalty) {
            solReply = info.loyalzoo_link
              ? `Our loyalty scheme is through LoyalZoo — every £1 earns points redeemable for discounts. ${info.loyalzoo_link} Takes 30 seconds to sign up!`
              : "Sign up for our loyalty scheme at the till — every £1 earns points. Ask any team member! ⭐";
          } else if (isHiring) {
            const status = info.hiring_status || 'Check our website for current openings';
            const link   = info.jobs_page || 'kindlyofbrighton.com';
            solReply = `${status} You can find current openings at ${link} 🌱`;
          } else if (isStoreInfo) {
            const yp = info.york_place_hours || 'Mon-Sat 8am-8pm, Sun 10am-7pm';
            const dr = info.dyke_road_hours  || 'Mon-Thu 9am-8pm, Fri-Sat 9am-7pm, Sun 10am-7pm';
            const ya = info.york_place_address || '20-21 York Place, Brighton BN1 4GU';
            const da = info.dyke_road_address  || '110-114 Dyke Road, Brighton BN1 3TE';
            if (qLower.includes('york') || qLower.includes('address')) {
              solReply = `York Place: ${ya}\nHours: ${yp}\n\nDyke Road: ${da}\nHours: ${dr}`;
            } else {
              solReply = `York Place: ${yp}\nDyke Road: ${dr}`;
            }
          } else if (isAbout) {
            const plastic = info.plastic_units_diverted || '344,000+';
            const co2     = info.co2_saved || '66t';
            solReply = `Kindly is Brighton's sustainable supermarket — 100% plant-based, plastic-free refill options, ~80% organic. We've diverted ${plastic} plastic units and saved ${co2} of CO₂. Founded by Shiv Misra in 2019. 66p of every £1 stays in the Brighton economy 🌱`;
          }
        }
      } catch(e) {
        console.error('Store info lookup error:', e.message);
      }

    // ════════════════════════════════════════════════════════════════════════
    // STEP 4: Order status — fetch from Apps Script (no Claude needed)
    // ════════════════════════════════════════════════════════════════════════
    } else if (isOrder) {
      if (orderNumMatch && (emailMatch || customerPhone)) {
        try {
          if (scriptUrl) {
            const params = new URLSearchParams({ order: orderNumMatch[1] });
            if (emailMatch)    params.set('email', emailMatch[0].toLowerCase());
            if (customerPhone) params.set('phone', customerPhone);
            const r = await fetch(`${scriptUrl}?${params.toString()}`);
            if (r.ok) {
              const d = await r.json();
              if (d.found) {
                fromDb = true;
                const confirm = d.masked_phone
                  ? `(number ending ${d.masked_phone.trim().slice(-3)})`
                  : d.masked_email ? `(${d.masked_email.trim()})` : '';
                solReply = `${d.status.emoji} Order #${d.order_number} ${confirm}\n` +
                  `Status: ${d.status.label}\n${d.status.detail}\n` +
                  (d.delivery_date ? `Delivery: ${d.delivery_date}\n` : '') +
                  `Total: £${d.total_amount}`;
              } else {
                fromDb = true;
                solReply = "I couldn't find an order matching those details. Please check your order number (#XXXX from your confirmation email) and the email you used when ordering. Contact hello@kindlyofbrighton.com if you need help 🌱";
              }
            }
          }
        } catch(e) {
          console.error('Order lookup error:', e.message);
        }
      } else {
        // Ask for details - WhatsApp phone auto-verifies so only need order number
        fromDb = true;
        solReply = customerPhone
          ? "I can look that up! Just send me your order number — you'll find it as #XXXX in your confirmation email. Your phone number will be used to verify your identity automatically 🌱"
          : "I can look that up! I need your order number (e.g. #2421 from your confirmation email) and the email address you used when ordering 🌱";
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // STEP 5: Product question — try Supabase first, Claude as fallback
    // ════════════════════════════════════════════════════════════════════════
    if (!solReply && supabaseUrl && supabaseKey) {
      try {
        const products = await lookupProductsSimple(supabaseUrl, supabaseKey, body);
        if (products && products.length > 0) {
          fromDb = true;
          const p = products[0];
          let reply = `*${p.product_name}*`;
          if (p.brand)       reply += ` by ${p.brand}`;
          if (p.description) reply += `\n${p.description}`;
          if (p.ingredients) reply += `\nIngredients: ${p.ingredients}`;
          if (p.allergens)   reply += `\nAllergens: ${p.allergens}`;
          if (p.vegan)       reply += `\nVegan: ${p.vegan}`;
          if (p.organic)     reply += `\nOrganic: ${p.organic}`;
          if (p.gluten_free) reply += `\nGluten free: ${p.gluten_free}`;
          solReply = reply;
          if (p.allergens || p.ingredients) {
            solReply += '\n\nFor severe allergies please check the physical label and confirm with staff 🌱';
          }
        }
      } catch(e) {
        console.error('Product lookup error:', e.message);
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // STEP 6: Claude as last resort — only if Supabase had nothing
    // ════════════════════════════════════════════════════════════════════════
    if (!solReply && apiKey) {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system:     buildSystemPrompt(),
          messages:   [{ role: 'user', content: body }],
        }),
      });

      if (claudeRes.ok) {
        const data = await claudeRes.json();
        solReply = data?.content?.[0]?.text || '';
      } else {
        throw new Error(`Claude ${claudeRes.status}`);
      }
    }

    if (!solReply) {
      solReply = "I'm not sure about that one! Try asking about our products, opening hours, or ingredients and I'll do my best to help 🌱";
    }

  } catch (err) {
    console.error('WhatsApp handler error:', err.message);
    solReply = "Sorry, I'm having a little trouble right now! Please try again in a moment, or email hello@kindlyofbrighton.com 🌱";
  }

  // ── Clean and reply ──────────────────────────────────────────────────────
  solReply = cleanForWhatsApp(solReply);

  // ── Log to Supabase ──────────────────────────────────────────────────────
  const supabaseUrl2 = process.env.SUPABASE_URL;
  const supabaseKey2 = process.env.SUPABASE_KEY;
  if (supabaseUrl2 && supabaseKey2 && body) {
    fetch(`${supabaseUrl2}/rest/v1/sol_question_log`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        supabaseKey2,
        'Authorization': `Bearer ${supabaseKey2}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        question: body,
        answer:   solReply,
        had_image: false,
        from_db:   fromDb,
        off_topic: false,
        channel:   'whatsapp',
        asked_at:  new Date().toISOString(),
      }),
    }).catch(() => {});
  }

  // ── Forward unanswered to Slack ──────────────────────────────────────────
  if (!fromDb) {
    forwardToSlack(from, body, solReply).catch(() => {});
  }

  return twimlReply(res, solReply);
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function fetchStoreInfo(supabaseUrl, supabaseKey) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/sol_store_info?select=*`,
    {
      headers: {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Range-Unit':    'items',
        'Range':         '0-99',
      },
    }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows || rows.length === 0) return null;
  const info = {};
  for (const row of rows) {
    if (row.key && row.value) info[row.key] = row.value;
  }
  return info;
}

async function lookupProductsSimple(supabaseUrl, supabaseKey, question) {
  // Extract key search terms — strip common words
  const stopWords = new Set(['is','the','a','an','what','does','do','have','has','any','are','it','this','that','for','and','or','with','about','tell','me','can','you','please','i','my','your','their','how','much','price','stock','available']);
  const terms = question.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 3);

  if (terms.length === 0) return null;

  // Try each term, return first hit
  for (const term of terms) {
    const url = `${supabaseUrl}/rest/v1/sol_products` +
      `?approved=eq.true&product_name=ilike.*${encodeURIComponent(term)}*` +
      `&select=product_name,brand,description,ingredients,allergens,vegan,organic,gluten_free` +
      `&limit=1`;
    const res = await fetch(url, {
      headers: {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Range-Unit':    'items',
        'Range':         '0-0',
      },
    });
    if (res.ok) {
      const rows = await res.json();
      if (rows && rows.length > 0) return rows;
    }
  }
  return null;
}

// ── System prompt (Claude fallback only) ─────────────────────────────────────
function buildSystemPrompt() {
  return `You are Sol, Kindly Brighton's product guide on WhatsApp. Be warm, brief, 3-4 sentences max. No markdown.

Kindly has two Brighton stores:
York Place (20-21 York Place BN1 4GU): Mon-Sat 8am-8pm, Sun 10am-7pm
Dyke Road (110-114 Dyke Road BN1 3TE): Mon-Thu 9am-8pm, Fri-Sat 9am-7pm, Sun 10am-7pm

100% plant-based, ~80% organic, plastic-free refill options.
Loyalty: https://start.mylty.co?id=21913
For allergens always say: check the label and confirm with staff.
If you don't know something specific, say so honestly.`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function cleanForWhatsApp(text) {
  return text
    .replace(/📋\s*\*?From Kindly[^\n]*/g, '')
    .replace(/💡\s*\*?General knowledge[^\n]*/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/^[-•]\s/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function twimlReply(res, message) {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escaped}</Message></Response>`
  );
}

function validateTwilioSignature(authToken, url, params, signature) {
  try {
    const sortedParams = Object.keys(params).sort()
      .reduce((str, key) => str + key + params[key], url);
    const hmac = crypto.createHmac('sha1', authToken)
      .update(sortedParams).digest('base64');
    return hmac === signature;
  } catch(e) { return false; }
}

async function forwardToSlack(from, question, answer) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;
  const num = from.replace('whatsapp:', '');
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `💬 *WhatsApp question Sol couldn't answer from DB*\n*From:* ${num}\n*Question:* ${question}\n*Sol replied:* ${answer.substring(0, 150)}`,
    }),
  });
}

export const config = {
  api: { bodyParser: { type: 'application/x-www-form-urlencoded' } },
};
