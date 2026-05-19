/**
 * api/whatsapp.js — Sol WhatsApp Handler
 * DB-first: Supabase answers first, Claude only as last resort
 * No async iteration — uses event-based stream reading for compatibility
 */

export default async function handler(req, res) {

  res.setHeader('Content-Type', 'text/xml');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // ── Parse Twilio form body (event-based, compatible with all Node versions) ─
  let parsedBody = {};
  try {
    const rawBody = await new Promise(function(resolve, reject) {
      var data = '';
      req.on('data', function(chunk) { data += chunk.toString(); });
      req.on('end', function() { resolve(data); });
      req.on('error', reject);
    });
    console.log('Raw body length:', rawBody.length, 'preview:', rawBody.substring(0, 80));
    if (rawBody) {
      var params = new URLSearchParams(rawBody);
      params.forEach(function(val, key) { parsedBody[key] = val; });
    }
    if (Object.keys(parsedBody).length === 0 && req.body && typeof req.body === 'object') {
      parsedBody = req.body;
    }
  } catch (parseErr) {
    console.error('Body parse error:', parseErr.message);
    if (req.body && typeof req.body === 'object') parsedBody = req.body;
  }

  var from  = parsedBody.From || '';
  var msgBody = (parsedBody.Body || '').trim();
  var customerPhone = from.replace('whatsapp:', '').replace(/[^0-9+]/g, '');

  console.log('From:', from, 'Body:', msgBody.substring(0, 50));

  if (!msgBody) {
    return twimlReply(res, "Hey! I'm Sol, Kindly Brighton's product guide. Ask me anything about our range, opening hours, or ingredients! 🌱");
  }

  var apiKey      = process.env.CLAUDE_API_KEY;
  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseKey = process.env.SUPABASE_KEY;
  var scriptUrl   = process.env.SHOPIFY_ORDERS_SCRIPT_URL;

  var qLower  = msgBody.toLowerCase();
  var solReply = '';
  var fromDb   = false;

  try {

    // ── Detect question type ──────────────────────────────────────────────────
    var isTGTG      = /\b(tgtg|too good to go|magic bag|food bag|surplus bag)\b/.test(qLower);
    var isStoreInfo = !isTGTG && /\b(open|close|opening|closing|hours|time|address|location|find|where|get to|park)\b/.test(qLower);
    var isHiring    = /\b(hiring|hire|job|jobs|vacancy|vacancies|work here|career|apply|join the team|recruitment|any roles|openings)\b/.test(qLower);
    var isAbout     = /\b(about kindly|who are you|what is kindly|kindly story|founded|mission|impact|plastic|co2|environment)\b/.test(qLower);
    var isLoyalty   = /\b(loyalty|points|reward|loyalzoo|sign up|membership)\b/.test(qLower);
    var isOrder     = /\b(order|my order|order status|track|when.*deliver|delivery.*when|shipped|dispatch|parcel)\b/.test(qLower) || /\d{3,6}/.test(msgBody);
    var isOffTopic  = /\b(weather|news|sport|politics|stock|crypto|bitcoin|how to cook|tell me a joke)\b/.test(qLower);
    var isPhone     = /\b(phone|call|telephone|ring|contact number|speak to someone|talk to someone)\b/.test(qLower);
    var isStaff     = /\b(how many (people|staff|team|employee)|headcount|team size)\b/.test(qLower);
    var isSupplier  = /\b(how many supplier|supplier|who do you work with)\b/.test(qLower);
    var isTopSell   = /\b(top sell|best sell|popular|most popular|recommend|favourite|top product)\b/.test(qLower);

    var orderNumMatch = msgBody.match(/#?(\d{3,6})/);
    var emailMatch    = msgBody.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/i);

    // ── Quick direct answers (no DB or Claude needed) ─────────────────────────
    if (isOffTopic) {
      solReply = "I'm Sol — Kindly Brighton's product guide. I'm best at questions about our range, hours, ingredients and allergens! Is there anything Kindly-related I can help with? 🌱";
      fromDb = true;

    } else if (isTGTG) {
      solReply = "Yes! Kindly partners with Too Good To Go 🌱 Search for Kindly of Brighton in the TGTG app to see today's magic bag and pickup time. Bags tend to go fast so grab it early!";
      fromDb = true;

    } else if (isPhone) {
      solReply = "We don't have a customer phone line — best way to reach us is to pop into store or email hello@kindlyofbrighton.com 🌱\nYork Place: Mon-Sat 8am-8pm, Sun 10am-7pm\nDyke Road: Mon-Thu 9am-8pm, Fri-Sat 9am-7pm, Sun 10am-7pm";
      fromDb = true;

    } else if (isStaff) {
      solReply = "We have 26 team members across our two Brighton stores — a passionate bunch of locals who genuinely care about sustainability and good food 🌱";
      fromDb = true;

    } else if (isSupplier) {
      solReply = "We work with hundreds of suppliers — a mix of local Brighton producers and small ethical UK brands. We prioritise organic, independent, and community-rooted suppliers wherever possible 🌱";
      fromDb = true;

    } else if (isTopSell) {
      solReply = "Some of our most popular picks are the Biona organic range, Clearspring products, and our bulk refill staples like oats, lentils, and nuts. Our freshly baked bread and the LoofCo cleaning range always go down well too! 🌱";
      fromDb = false;

    // ── Store info from Supabase ──────────────────────────────────────────────
    } else if ((isStoreInfo || isHiring || isAbout || isLoyalty) && supabaseUrl && supabaseKey) {
      try {
        var info = await fetchStoreInfo(supabaseUrl, supabaseKey);
        if (info) {
          fromDb = true;
          if (isLoyalty) {
            var loyalLink = info.loyalzoo_link || 'https://start.mylty.co?id=21913';
            solReply = "Our loyalty scheme earns you points on every purchase — redeemable for discounts. Sign up here: " + loyalLink + " Takes 30 seconds! ⭐";

          } else if (isHiring) {
            var hireStatus = info.hiring_status || 'Check our website for current openings';
            solReply = hireStatus + " For current opportunities visit kindlyofbrighton.com or pop into either store 🌱";

          } else if (isAbout) {
            var plastic = info.plastic_units_diverted || '344,000+';
            var plasticClean = String(plastic).replace(/[^0-9]/g, '');
            var plasticFmt = plasticClean.length > 3 ? Math.round(parseInt(plasticClean) / 1000) + 'K+' : plastic;
            var co2 = info.co2_saved || '66t';
            var co2Clean = String(co2).replace(/\s*(of CO|CO|saved|through.*)/i, '').trim() || '66t';
            solReply = "Kindly is Brighton's sustainable supermarket — 100% plant-based, ~80% organic, plastic-free refill options. Founded by Shiv Misra in 2019. We've diverted over " + plasticFmt + " single-use plastic units and saved " + co2Clean + " of CO₂. 66p of every £1 stays in the Brighton economy 🌱";

          } else if (isStoreInfo) {
            var yp = info.york_place_hours || 'Mon-Sat 8am-8pm, Sun 10am-7pm';
            var dr = info.dyke_road_hours  || 'Mon-Thu 9am-8pm, Fri-Sat 9am-7pm, Sun 10am-7pm';
            var ya = info.york_place_address || '20-21 York Place, Brighton BN1 4GU';
            var da = info.dyke_road_address  || '110-114 Dyke Road, Brighton BN1 3TE';
            var asksYork  = qLower.includes('york');
            var asksDyke  = qLower.includes('dyke');
            var asksAddr  = /address|location|where|find|get to/.test(qLower);
            if (asksYork && !asksDyke) {
              solReply = asksAddr ? "York Place: " + ya + "\nHours: " + yp : "York Place hours: " + yp;
            } else if (asksDyke && !asksYork) {
              solReply = asksAddr ? "Dyke Road: " + da + "\nHours: " + dr : "Dyke Road hours: " + dr;
            } else {
              solReply = "York Place: " + yp + "\nDyke Road: " + dr;
              if (asksAddr) solReply = "York Place: " + ya + "\nHours: " + yp + "\n\nDyke Road: " + da + "\nHours: " + dr;
            }
          }
        }
      } catch (storeErr) {
        console.error('Store info error:', storeErr.message);
      }

    // ── Order status ──────────────────────────────────────────────────────────
    } else if (isOrder) {
      if (orderNumMatch && (emailMatch || customerPhone)) {
        try {
          if (scriptUrl) {
            var orderParams = 'order=' + encodeURIComponent(orderNumMatch[1]);
            if (emailMatch) orderParams += '&email=' + encodeURIComponent(emailMatch[0].toLowerCase());
            if (customerPhone) orderParams += '&phone=' + encodeURIComponent(customerPhone);
            console.log('Order lookup for:', orderNumMatch[1]);
            var orderRes = await fetch(scriptUrl + '?' + orderParams);
            console.log('Order response status:', orderRes.status);
            if (orderRes.ok) {
              var orderData = await orderRes.json();
              console.log('Order found:', orderData.found);
              if (orderData.found) {
                fromDb = true;
                var confirmStr = orderData.masked_phone
                  ? '(number ending ' + orderData.masked_phone.trim().slice(-3) + ')'
                  : orderData.masked_email ? '(' + orderData.masked_email.trim() + ')' : '';
                solReply = orderData.status.emoji + ' Order #' + orderData.order_number + ' ' + confirmStr + '\n' +
                  'Status: ' + orderData.status.label + '\n' + orderData.status.detail + '\n' +
                  (orderData.delivery_date ? 'Delivery: ' + orderData.delivery_date + '\n' : '') +
                  'Total: £' + orderData.total_amount;
              } else {
                fromDb = true;
                solReply = "I couldn't find an order matching those details. Please check your order number (#XXXX from your confirmation email) and email. Contact hello@kindlyofbrighton.com if you need help 🌱";
              }
            }
          } else {
            console.error('SHOPIFY_ORDERS_SCRIPT_URL not set');
          }
        } catch (orderErr) {
          console.error('Order lookup error:', orderErr.message);
        }
      } else {
        fromDb = true;
        solReply = customerPhone
          ? "I can look that up! Just send me your order number — it's #XXXX in your Kindly confirmation email. Your phone number will verify your identity automatically 🌱"
          : "I can look that up! I need your order number (#XXXX from your confirmation email) and the email you used when ordering 🌱";
      }
    }

    // ── Product lookup from Supabase ──────────────────────────────────────────
    if (!solReply && supabaseUrl && supabaseKey) {
      try {
        var products = await lookupProduct(supabaseUrl, supabaseKey, msgBody);
        if (products && products.length > 0) {
          var p = products[0];
          fromDb = true;
          var reply = '*' + p.product_name + '*';
          if (p.brand) reply += ' by ' + p.brand;
          if (p.description) reply += '\n' + p.description;
          if (p.ingredients) reply += '\nIngredients: ' + p.ingredients;
          if (p.allergens) reply += '\nAllergens: ' + p.allergens;
          var flags = [];
          if (p.vegan === 'true' || p.vegan === true) flags.push('Vegan ✓');
          if (p.organic === 'true' || p.organic === true) flags.push('Organic ✓');
          if (p.gluten_free === 'true' || p.gluten_free === true) flags.push('Gluten free ✓');
          if (flags.length > 0) reply += '\n' + flags.join(' · ');
          solReply = reply;
          if (p.allergens || p.ingredients) {
            solReply += '\n\nFor severe allergies please check the physical label and confirm with staff in store 🌱';
          }
        }
      } catch (productErr) {
        console.error('Product lookup error:', productErr.message);
      }
    }

    // ── Claude as last resort ─────────────────────────────────────────────────
    if (!solReply && apiKey) {
      try {
        var claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 300,
            system:     "You are Sol, Kindly Brighton's WhatsApp product guide. Be warm and brief — 3-4 sentences max. No markdown.\n\nKindly stores:\nYork Place (20-21 York Place BN1 4GU): Mon-Sat 8am-8pm, Sun 10am-7pm\nDyke Road (110-114 Dyke Road BN1 3TE): Mon-Thu 9am-8pm, Fri-Sat 9am-7pm, Sun 10am-7pm\n\n100% plant-based, ~80% organic, plastic-free refill options.\nFor allergens always say: check the label and confirm with staff.",
            messages:   [{ role: 'user', content: msgBody }],
          }),
        });
        if (claudeRes.ok) {
          var claudeData = await claudeRes.json();
          solReply = (claudeData && claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
        } else {
          var errText = await claudeRes.text();
          console.error('Claude API error:', claudeRes.status, errText.substring(0, 100));
        }
      } catch (claudeErr) {
        console.error('Claude error:', claudeErr.message);
      }
    }

    if (!solReply) {
      solReply = "I'm not sure about that one! Try asking about our products, opening hours, or ingredients and I'll do my best to help 🌱";
    }

  } catch (err) {
    console.error('Handler error:', err.message);
    solReply = "Sorry, having a little trouble right now! Please try again or email hello@kindlyofbrighton.com 🌱";
  }

  // ── Clean up ──────────────────────────────────────────────────────────────
  solReply = solReply
    .replace(/📋\s*\*?From Kindly[^\n]*/g, '')
    .replace(/💡\s*\*?General knowledge[^\n]*/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // ── Log to Supabase ──────────────────────────────────────────────────────
  if (supabaseUrl && supabaseKey && msgBody) {
    fetch(supabaseUrl + '/rest/v1/sol_question_log', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        question:  msgBody,
        answer:    solReply,
        had_image: false,
        from_db:   fromDb,
        off_topic: false,
        channel:   'whatsapp',
        asked_at:  new Date().toISOString(),
      }),
    }).catch(function() {});
  }

  // ── Forward unanswered to Slack ──────────────────────────────────────────
  if (!fromDb) {
    forwardToSlack(from, msgBody, solReply).catch(function() {});
  }

  return twimlReply(res, solReply);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchStoreInfo(supabaseUrl, supabaseKey) {
  var r = await fetch(supabaseUrl + '/rest/v1/sol_store_info?select=*', {
    headers: {
      'apikey':        supabaseKey,
      'Authorization': 'Bearer ' + supabaseKey,
      'Range':         '0-99',
    },
  });
  if (!r.ok) return null;
  var rows = await r.json();
  if (!rows || rows.length === 0) return null;
  var info = {};
  rows.forEach(function(row) { if (row.key && row.value) info[row.key] = row.value; });
  return info;
}

async function lookupProduct(supabaseUrl, supabaseKey, question) {
  var stopWords = new Set(['is','the','a','an','what','does','do','have','has','any','are',
    'it','this','that','for','and','or','with','about','tell','me','can','you',
    'please','i','my','your','how','much','does','contain','ingredients','allergens']);
  var terms = question.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 2 && !stopWords.has(w); })
    .slice(0, 3);
  if (terms.length === 0) return null;
  for (var i = 0; i < terms.length; i++) {
    var url = supabaseUrl + '/rest/v1/sol_products' +
      '?approved=eq.true&product_name=ilike.*' + encodeURIComponent(terms[i]) + '*' +
      '&select=product_name,brand,description,ingredients,allergens,vegan,organic,gluten_free' +
      '&limit=1';
    var r = await fetch(url, {
      headers: {
        'apikey':        supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Range':         '0-0',
      },
    });
    if (r.ok) {
      var rows = await r.json();
      if (rows && rows.length > 0) return rows;
    }
  }
  return null;
}

function twimlReply(res, message) {
  var escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return res.status(200).send(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + escaped + '</Message></Response>'
  );
}

async function forwardToSlack(from, question, answer) {
  var webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;
  var num = from.replace('whatsapp:', '');
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '💬 *WhatsApp — Sol used general knowledge*\n*From:* ' + num + '\n*Q:* ' + question + '\n*A:* ' + answer.substring(0, 150),
    }),
  });
}

export const config = {
  api: { bodyParser: false },
};
