export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey      = process.env.CLAUDE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  // ── Plastic counter special action ────────────────────────────────────────
  if (req.body && req.body._action === 'get_plastic_counter') {
    try {
      const info = supabaseUrl && supabaseKey
        ? await fetchStoreInfo(supabaseUrl, supabaseKey)
        : null;
      return res.status(200).json({
        plastic_counter: info && info.plastic_units_diverted
          ? info.plastic_units_diverted : null
      });
    } catch(e) {
      return res.status(200).json({ plastic_counter: null });
    }
  }

  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const messages      = req.body.messages || [];
    const customerPhone = req.body._customer_phone || '';
    const lastMessage   = messages[messages.length - 1];

    let customerQuestion = '';
    let hadImage = false;

    if (lastMessage && lastMessage.role === 'user') {
      if (Array.isArray(lastMessage.content)) {
        const textPart = lastMessage.content.find(c => c.type === 'text');
        const imgPart  = lastMessage.content.find(c => c.type === 'image');
        if (textPart) customerQuestion = textPart.text;
        if (imgPart)  hadImage = true;
      } else {
        customerQuestion = lastMessage.content || '';
      }
    }

    // ── Off-topic guard ────────────────────────────────────────────────────
    if (isOffTopic(customerQuestion)) {
      const reply = offTopicResponse();
      if (supabaseUrl && supabaseKey && customerQuestion) {
        logQuestion({ supabaseUrl, supabaseKey, question: customerQuestion,
          answer: reply, had_image: hadImage, from_db: false,
          off_topic: true, channel: 'website' }).catch(() => {});
      }
      return res.status(200).json({ content: [{ type: 'text', text: reply }] });
    }

    // ── Classify ───────────────────────────────────────────────────────────
    const qLower           = customerQuestion.toLowerCase();
    const isStoreInfo      = detectStoreInfoQuestion(qLower);
    const isHiring         = detectHiringQuestion(qLower);
    const isAboutKindly    = detectAboutKindlyQuestion(qLower);
    const isSurpriseMe     = detectSurpriseMe(qLower);
    const dietaryFilter    = detectDietaryFilter(qLower);
    const isBasketBuilder  = detectBasketBuilder(qLower);
    const isRecipeRequest  = detectRecipeRequest(qLower);
    const isRefillGuide    = detectRefillGuide(qLower);
    const isProductPairing = detectProductPairing(qLower);
    const isPositiveFeedback = detectGoogleReview(qLower);
    const isOrderQuery     = detectOrderQuery(qLower);
    const orderDetails     = isOrderQuery ? extractOrderDetails(customerQuestion) : {};

    let productContext = '';
    let storeContext   = '';
    let foundInDb      = false;
    let foundStoreInfo = false;

    // ── Supabase lookups ───────────────────────────────────────────────────
    if (supabaseUrl && supabaseKey) {

      // Order status lookup
      if (isOrderQuery) {
        if (orderDetails.orderNumber && (orderDetails.email || customerPhone)) {
          try {
            const scriptUrl = process.env.SHOPIFY_ORDERS_SCRIPT_URL;
            if (scriptUrl) {
              const params = new URLSearchParams({ order: orderDetails.orderNumber });
              if (orderDetails.email) params.set('email', orderDetails.email);
              if (customerPhone) params.set('phone', customerPhone.replace(/[^0-9+]/g,''));
              const r = await fetch(`${scriptUrl}?${params.toString()}`);
              if (r.ok) {
                const d = await r.json();
                if (d.found) {
                  const isCancelled = d.raw_status === 'Cancelled';
                  productContext =
                    `ORDER STATUS:\nOrder: #${d.order_number}\nCustomer: ${d.customer_name}\n` +
                    `Status: ${d.status.emoji} ${d.status.label}\nDetail: ${d.status.detail}\n` +
                    (d.delivery_date ? `Scheduled delivery: ${d.delivery_date}\n` : '') +
                    `Total: £${d.total_amount}\nItems: ${d.items_summary}\n` +
                    (isCancelled && d.shipping_address ? `Delivery address on order: ${d.shipping_address}\n` : '') +
                    (d.masked_phone ? `masked_phone:${d.masked_phone}\n` : '') +
                    (d.masked_email ? `masked_email:${d.masked_email}\n` : '');
                  foundInDb = true;
                } else {
                  productContext = 'ORDER_NOT_FOUND';
                  foundInDb = true;
                }
              }
            }
          } catch(e) { console.error('Order lookup:', e.message); }
        } else {
          productContext = 'ORDER_MISSING_DETAILS';
          foundInDb = true;
        }
      }

      // Surprise me
      if (!isOrderQuery && isSurpriseMe) {
        try {
          const p = await fetchRandomProductStory(supabaseUrl, supabaseKey);
          if (p) { productContext = formatProductStoryContext(p); foundInDb = true; }
        } catch(e) {}
      }

      // Store info
      if (!isOrderQuery && !isSurpriseMe && (isStoreInfo || isHiring || isAboutKindly)) {
        try {
          const info = await fetchStoreInfo(supabaseUrl, supabaseKey);
          if (info) {
            storeContext   = formatStoreContext(info, isHiring);
            foundStoreInfo = true;
          }
        } catch(e) {}
      }

      // Dietary filter
      if (!foundStoreInfo && !isOrderQuery && !isSurpriseMe && dietaryFilter.diet) {
        try {
          const products = await lookupByDietaryFilter(
            supabaseUrl, supabaseKey, dietaryFilter.diet, dietaryFilter.category);
          if (products && products.length > 0) {
            productContext = formatDietaryResults(products, dietaryFilter.diet, dietaryFilter.category);
            foundInDb = true;
          }
        } catch(e) {}
      }

      // Refill guide
      if (!foundStoreInfo && !isOrderQuery && isRefillGuide) {
        try {
          const info = await fetchStoreInfo(supabaseUrl, supabaseKey);
          productContext = 'REFILL GUIDE:\n' +
            (info && info.refill_guide ? info.refill_guide
              : 'Bring any clean container. We weigh it empty (tare weight), fill it, weigh again — you only pay for what you take. Ask any team member for help!');
          foundInDb = true;
        } catch(e) {}
      }

      // Basket builder
      if (!foundStoreInfo && !isOrderQuery && !isSurpriseMe && !dietaryFilter.diet && isBasketBuilder) {
        try {
          const products = await lookupBasketProducts(supabaseUrl, supabaseKey, customerQuestion);
          if (products && products.length > 0) {
            productContext = formatBasketContext(products, customerQuestion);
            foundInDb = true;
          }
        } catch(e) {}
      }

      // Product lookup
      if (!foundStoreInfo && !isOrderQuery && !isSurpriseMe && !dietaryFilter.diet
          && !isBasketBuilder && !isRefillGuide && customerQuestion && !hadImage) {
        try {
          const products = await lookupProducts(supabaseUrl, supabaseKey, customerQuestion);
          if (products && products.length > 0) {
            productContext = formatProductContext(products);
            foundInDb = true;
          }
        } catch(e) {}
      }
    }

    // ── Build context block ────────────────────────────────────────────────
    let contextBlock = '';

    if (isOrderQuery && foundInDb && productContext) {
      if (productContext.startsWith('ORDER STATUS:')) {
        const isCancelledOrder = productContext.includes('Cancelled');
        if (isCancelledOrder) {
          const addrMatch   = productContext.match(/Delivery address on order: ([^\n]+)/);
          const deliveryAddr = addrMatch ? addrMatch[1].trim() : '';
          const doorMatch   = deliveryAddr.match(/^(\d+[a-zA-Z]?)/);
          const doorNumber  = doorMatch ? doorMatch[1] : '';
          const pcMatch     = deliveryAddr.match(/\b([A-Z]{1,2}[0-9][0-9A-Z]?)\s*[0-9][A-Z]{2}\b/i);
          const pcArea      = pcMatch ? pcMatch[1].toUpperCase() : '';
          const addrHint    = doorNumber && pcArea
            ? `door number ${doorNumber} with postcode area ${pcArea}`
            : pcArea || 'the address provided';
          contextBlock = '\n\n' + productContext +
            `\n\nIMPORTANT: Order cancelled — outside delivery area. Tell the customer warmly: ` +
            `(1) Address shows ${addrHint} — do NOT show full address. ` +
            (pcArea ? `(2) ${pcArea} is outside Kindly's delivery area. ` : '') +
            `(3) Kindly delivers to BN1, BN2, BN3 only. ` +
            `(4) Full refund processed to same payment method — back in account within 2-4 working days. ` +
            `(5) Apologise sincerely. (6) Invite them to visit York Place or Dyke Road in person. ` +
            `Be warm and human. Do NOT add any source tag.`;
        } else {
          const maskedPhone = (productContext.match(/masked_phone:([^\n]+)/) || [])[1] || '';
          const maskedEmail = (productContext.match(/masked_email:([^\n]+)/) || [])[1] || '';
          const confirmLine = maskedPhone
            ? `The number on this order is ${maskedPhone.trim()}. Email: ${maskedEmail.trim()}.`
            : maskedEmail ? `The email on this order is ${maskedEmail.trim()}.` : '';
          contextBlock = '\n\n' + productContext +
            `\n\nIMPORTANT: Give a warm order update. First confirm identity: ${confirmLine} ` +
            `Lead with status emoji and label. Mention delivery date if available. ` +
            `Summarise items if list is long. Friendly and reassuring. Do NOT add any source tag.`;
        }
      } else if (productContext === 'ORDER_NOT_FOUND') {
        contextBlock = '\n\nOrder not found. Ask customer to check their order number (#XXXX from confirmation email) and email address. Suggest hello@kindlyofbrighton.com if still stuck. Be warm.';
      } else {
        // Missing details — be smart about what we already have
        const isWa      = !!customerPhone;
        const hasOrderNum = orderDetails && orderDetails.orderNumber;
        if (isWa) {
          contextBlock = hasOrderNum
            ? `\n\nCustomer gave order number ${orderDetails.orderNumber}. Their WhatsApp phone will verify them. Confirm you\'re looking it up using their phone number automatically — no email needed.`
            : '\n\nAsk warmly for their order number only (e.g. #2421 from their confirmation email). Explain their WhatsApp phone number verifies them automatically so no email is needed.';
        } else {
          contextBlock = hasOrderNum
            ? `\n\nCustomer gave order number ${orderDetails.orderNumber} but no email yet. Ask ONLY for the email address they used when placing this order. Do NOT ask for the order number again. Do NOT say "go to the website" — Sol can look this up.`
            : '\n\nAsk for their order number (#XXXX from confirmation email) AND email used when ordering. Do NOT tell them to go to the website — Sol handles order lookups directly.';
        }
      }

    } else if (isSurpriseMe && foundInDb && productContext) {
      contextBlock = '\n\n' + productContext +
        '\n\nTell a warm surprise product story in Sol\'s Brighton personality. ' +
        '2-3 sentences max. End with a fun emoji. Do NOT add any source tag.';

    } else if (isRefillGuide && foundInDb && productContext) {
      contextBlock = '\n\n' + productContext +
        '\n\nExplain refilling clearly and warmly — step by step, no jargon. ' +
        'Easy and approachable especially for first-timers. Do NOT add any source tag.';

    } else if (isProductPairing && foundInDb && productContext) {
      contextBlock = '\n\n' + productContext +
        '\n\nSuggest 2-3 specific complementary products from Kindly. ' +
        'Be specific with names and brands. Conversational and friendly. Do NOT add any source tag.';

    } else if (isBasketBuilder && foundInDb && productContext) {
      contextBlock = '\n\n' + productContext +
        '\n\nBuild a basket using ONLY the specific products listed. Name each exactly. ' +
        'For refill items note they are plastic-free. For non-refill say nothing about packaging. ' +
        'Do NOT say "everything is zero-waste". 5-6 items max. Do NOT add any source tag.';

    } else if (dietaryFilter.diet && foundInDb && productContext) {
      contextBlock = '\n\n' + productContext +
        `\n\nList products for ${dietaryFilter.diet}${dietaryFilter.category ? ' / ' + dietaryFilter.category : ''}. ` +
        'Be specific and helpful. Do NOT add any source tag.';

    } else if (foundStoreInfo && storeContext) {
      contextBlock = '\n\n' + storeContext +
        '\n\nAnswer using the verified Kindly store information above. ' +
        'Give a natural conversational answer. Do NOT add any source tag.';

    } else if (foundInDb && productContext) {
      contextBlock = '\n\n' + productContext +
        '\n\nAnswer using these specific Kindly products. Be accurate and helpful. ' +
        '\nEnd with: "📋 *From Kindly\'s product database*"';

    } else {
      const waNumber = process.env.KINDLY_WHATSAPP_NUMBER || '';
      const waLine   = waNumber
        ? `\n\nIf you could not fully answer, add: "💬 *Still need help? WhatsApp the Kindly team at https://wa.me/${waNumber.replace(/[^0-9]/g,'')}*"`
        : '';
      contextBlock = '\n\nNo specific data found. Answer only if relates to Kindly, products, or sustainable shopping. ' +
        'Be appropriately cautious about specifics.' +
        '\nEnd with: "💡 *General knowledge — product details may vary*"' + waLine;
    }

    // ── Build request ──────────────────────────────────────────────────────
    const requestBody    = { ...req.body };
    const existingSystem = requestBody.system || '';
    const waNumber       = process.env.KINDLY_WHATSAPP_NUMBER || '';
    const waInject       = waNumber
      ? `\n\nKINDLY WHATSAPP: https://wa.me/${waNumber.replace(/[^0-9]/g,'')}` : '';

    requestBody.system = existingSystem + waInject + contextBlock;

    // ── Call Claude ────────────────────────────────────────────────────────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    let solAnswer = data.content?.[0]?.text || '';

    // Google review nudge on positive feedback
    if (isPositiveFeedback && solAnswer && !hadImage && Math.random() < 0.5) {
      solAnswer = solAnswer + '\n\n😊 *So glad I could help! A quick Google review means the world to a small independent shop: https://g.page/r/kindly-brighton/review*';
    }

    // Log to Supabase
    let identifiedProduct = '';
    if (hadImage && solAnswer) {
      const m = solAnswer.match(/(?:this is|i can see|looking at|that's|that is)\s+(?:a\s+)?([A-Z][\w\s&'-]{3,50}?)(?:\.|\/|,|\s+by\s+|\s+from\s+|\s+—|\s+which|\s+that|\s+is|\s+\()/i);
      if (m) identifiedProduct = m[1].trim();
    }

    if (supabaseUrl && supabaseKey && customerQuestion) {
      logQuestion({
        supabaseUrl, supabaseKey,
        question: customerQuestion, answer: solAnswer,
        had_image: hadImage, from_db: foundInDb,
        identified_product: identifiedProduct,
        channel: 'website',
      }).catch(() => {});
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}

function isOffTopic(question) {
  if (!question || question.trim().length < 3) return false;

  const q = question.toLowerCase();

  // Always allow anything Kindly or shopping related
  const alwaysAllow = [
    'kindly','vegan','organic','plastic','refill','sustainable','allergen',
    'ingredient','gluten','dairy','nut','soy','wheat','sugar','calorie',
    'protein','carb','fat','nutrition','price','cost','buy','stock','carry',
    'shop','store','hours','open','close','address','location','park',
    'delivery','online','order','loyalty','member','reward','discount',
    'offer','bulk','loose','packaging','wrapper','bottle','container',
    'where','when','product','brand','supplier','origin','provenance',
    'recipe','cook','eat','drink','food','snack','meal','coffee','tea',
    'brighton','york place','dyke road','hire','hiring','job','work','team',
    'volunteer','apprentice','partner','fareshare','team domenica','tgtg',
    'too good to go','award','certificate','bcorp','fairtrade',
    'plastic free','zero waste','carbon','impact','environment','green',
    'surprise','story','tell me','about kindly','what is kindly',
  ];
  if (alwaysAllow.some(term => q.includes(term))) return false;

  // "tell me more" / "more please" — always allow, Sol will ask for clarification
  if (/^(tell me more|more please|more pls|tell me more pls|can you tell me more|go on|and|more\??)$/i.test(q.trim())) return false;

  // Block clearly off-topic subjects
  const offTopicPatterns = [
    /\b(weather|forecast|temperature|rain|sun|wind|snow)\b/,
    /\b(news|politics|election|government|parliament|prime minister|president)\b/,
    /\b(sport|football|cricket|tennis|rugby|formula.one|f1|nba|nfl)\b/,
    /\b(movie|film|tv.show|series|netflix|disney|cinema|actor|actress)\b/,
    /\b(music|song|artist|album|spotify|playlist|concert)\b/,
    /\b(stock.market|crypto|bitcoin|investment|shares|trading|forex)\b/,
    /\b(homework|essay|history|geography|maths|science|exam|revision)\b/,
    /\b(write me|write a|generate|create an image|draw|paint|program)\b/,
    /\b(joke|riddle|quiz|game|play|entertain)\b/,
    /\b(relationship|dating|love|breakup|marriage|divorce)\b/,
    /\b(medical|doctor|hospital|prescription|diagnosis|symptom)\b/,
    /\b(legal|lawyer|sue|court|law)\b/,
  ];

  return offTopicPatterns.some(p => p.test(q));
}

function offTopicResponse() {
  return `Hey there! ☀️ I'm Sol, Kindly's in-store product guide — I'm here to help with anything about our products, ingredients, allergens, opening hours, or anything else Kindly-related.

For anything outside of that, I'm not quite the right tool! Is there something about our range I can help with? 🌱`;
}


// ── Question type detection ────────────────────────────────────────────────
function detectBasketBuilder(q) {
  return /\b(build.*(basket|shop|list)|basket.*for|shop.*for|what.*pick up|what.*buy|what.*get|help me.*make|products.*for|suggest.*for|build me|make a.*meal|meal.*idea|cook.*tonight|what.*stock.*for|ingredients.*for)\b/.test(q);
}

function detectRecipeRequest(q) {
  return /\b(recipe|how.*cook|how.*make|what.*make with|cook with|dish.*with|meal.*with|ideas.*with|use.*for cooking|bake.*with)\b/.test(q);
}

function detectDietaryFilter(q) {
  // Returns {diet, category} or {diet: null}
  const dietMap = {
    'gluten free':  ['gluten free', 'gluten-free', 'coeliac', 'celiac', 'no gluten', 'wheat free', 'wheat-free'],
    'vegan':        ['vegan', "i'm vegan", 'plant based', 'plant-based'],
    'dairy free':   ['dairy free', 'dairy-free', 'lactose', 'no dairy', 'no milk'],
    'organic':      ['organic only', 'only organic', 'all organic'],
    'nut free':     ['nut free', 'nut-free', 'no nuts', 'nut allergy'],
    'soy free':     ['soy free', 'soy-free', 'no soy', 'no soya', 'soya free'],
  };

  let matchedDiet = null;
  for (const [diet, keywords] of Object.entries(dietMap)) {
    if (keywords.some(kw => q.includes(kw))) {
      matchedDiet = diet;
      break;
    }
  }
  if (!matchedDiet) return { diet: null };

  // Extract category if mentioned
  const categoryKeywords = [
    'pasta','bread','snack','snacks','biscuit','biscuits','chocolate','cereal',
    'flour','milk','cheese','yogurt','yoghurt','sauce','soup','rice','noodle',
    'noodles','cracker','crackers','cake','cakes','bar','bars','spread','butter',
    'oil','vinegar','condiment','drink','drinks','juice','tea','coffee',
    'protein','supplement','grain','grains','seed','seeds','nut','nuts',
    'dried fruit','fruit','vegetable','veg','frozen','chilled','fresh',
  ];
  let category = null;
  for (const kw of categoryKeywords) {
    if (q.includes(kw)) { category = kw; break; }
  }

  return { diet: matchedDiet, category };
}

function detectSurpriseMe(q) {
  return /(surprise|surprise me|product story|tell me a story|random product|what's interesting|what\'s interesting|something interesting|something cool|something special|recommend something|pick something|choose something|what should i try)/.test(q);
}

function detectStoreInfoQuestion(q) {
  return /\b(open|close|opening|closing|hours|time|address|location|find you|where are|get to|park|parking|both stores|york place|dyke road)\b/.test(q);
}

function detectHiringQuestion(q) {
  return /\b(hiring|hire|job|jobs|vacancy|vacancies|work here|recruit|employ|career|position|role|apply|application|join the team|join kindly)\b/.test(q);
}

function detectOrderQuery(q) {
  return /\b(order|my order|where.*order|order.*status|track.*order|when.*deliver|delivery.*when|has.*shipped|shipped|dispatch|parcel|tracking|order number|check.*order|status of my order|status.*order|order.*\d{3,6}|\d{3,6}.*order)\b/.test(q);
}

function extractOrderDetails(text) {
  const orderMatch = text.match(/#?(\d{3,6})/);
  const emailMatch = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/i);
  return {
    orderNumber: orderMatch ? orderMatch[1] : null,
    email:       emailMatch ? emailMatch[0].toLowerCase() : null,
  };
}

function detectRefillGuide(q) {
  return /\b(how.*refill|refill.*work|how does refill|bring.*container|own container|how.*bulk|bulk.*work|first time|never refill|new.*refill|refill.*first|how.*shop|weigh|tare|how do i use|get started|how.*kindly work)\b/.test(q);
}

function detectProductPairing(q) {
  return /\b(goes well|pair with|what.*with|serve with|works with|complement|what.*use.*with|cook.*with|match.*with|good with|combine with|recipe.*with|make.*with|buy.*with|what else|suggestions|recommend.*with)\b/.test(q);
}

function detectGoogleReview(q) {
  return /\b(thank|thanks|thank you|helpful|great|love|amazing|brilliant|perfect|excellent|fantastic|wonderful|cheers|appreciate|superb|awesome|perfect)\b/.test(q);
}

function detectAboutKindlyQuestion(q) {
  return /\b(about kindly|what is kindly|who are kindly|kindly story|started|founded|founder|mission|values|impact|environmental|sustainability|plastic diverted|plastic saved|units saved|units diverted|co2|carbon|water|community|fareshare|team domenica|award|accolade|how many (people|staff|employees)|next for kindly|future|expand|loyalty|loyalzoo|local economy|reinvest|brighton economy)\b/.test(q);
}


// ── Dietary filter product lookup ─────────────────────────────────────────
async function lookupByDietaryFilter(supabaseUrl, supabaseKey, diet, category) {
  const fields = 'product_name,brand,supplier,description,vegan,organic,gluten_free,free_from,allergens,impact_line';
  const headers = {
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Range-Unit':    'items',
    'Range':         '0-11',
  };

  // Build dietary flag filter — handles "1", "yes", "Yes", "YES", "true", "True" etc
  // Uses OR logic across all truthy representations via Supabase's ilike
  function dietFlag(col, term) {
    // For free_from/allergens text fields, search for the term
    if (col === 'free_from' || col === 'allergens') {
      return `&${col}=ilike.*${term}*`;
    }
    // For flag columns (1/0 or yes/no), accept both formats
    return `&or=(${col}.ilike.*yes*,${col}.ilike.*1*,${col}.ilike.*true*)`;
  }

  let flagParam = '';
  if (diet === 'vegan')       flagParam = dietFlag('vegan', '');
  else if (diet === 'gluten free') flagParam = dietFlag('gluten_free', '');
  else if (diet === 'organic') flagParam = dietFlag('organic', '');
  else if (diet === 'dairy free') flagParam = dietFlag('free_from', 'dairy');
  else if (diet === 'nut free')   flagParam = dietFlag('free_from', 'nut');
  else if (diet === 'soy free')   flagParam = dietFlag('free_from', 'soy');

  // Category search — try product_name, description, AND category column
  // Use OR across all three fields so "bread" matches any of them
  function categoryParam(cat) {
    const enc = encodeURIComponent(cat);
    return `&or=(product_name.ilike.*${enc}*,description.ilike.*${enc}*,category.ilike.*${enc}*)`;
  }

  async function runQuery(withCategory) {
    let url = `${supabaseUrl}/rest/v1/sol_products?approved=eq.true` + flagParam;
    if (withCategory && category) url += categoryParam(category);
    url += `&limit=12&select=${fields}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return await res.json();
  }

  // Try with category first, fall back without if no results
  if (category) {
    const withCat = await runQuery(true);
    if (withCat && withCat.length > 0) return withCat;
  }

  // No category or no results with category — return without category filter
  return await runQuery(false);
}

// ── Meal to ingredient keyword map ───────────────────────────────────────
const MEAL_KEYWORD_MAP = {
  // Lunches
  'packed lunch':     ['bread','spread','hummus','salad','fruit','snack','crackers','dip'],
  'lunch':            ['bread','spread','salad','soup','crackers','hummus'],
  'sandwich':         ['bread','spread','hummus','pickle','mustard'],
  // Dinners
  'pasta':            ['pasta','tomato','sauce','lentil','basil','olive oil','nutritional yeast'],
  'thai curry':       ['coconut','curry paste','noodles','rice','tamari','lime','ginger'],
  'curry':            ['lentil','chickpea','rice','coconut','spice','tomato','onion'],
  'stir fry':         ['noodles','tamari','sesame','ginger','rice','tofu'],
  'soup':             ['lentil','stock','tomato','coconut','carrot','spice'],
  'stew':             ['lentil','chickpea','tomato','stock','carrot','potato'],
  'salad':            ['quinoa','chickpea','olive oil','vinegar','seed','nut','tahini'],
  'bowl':             ['rice','quinoa','chickpea','tahini','seed','avocado','tamari'],
  'pizza':            ['flour','tomato','yeast','olive oil','nutritional yeast','basil'],
  'burger':           ['bread','bean','lentil','spice','tomato','mustard'],
  // Breakfast
  'breakfast':        ['oat','granola','nut butter','fruit','seed','milk','coffee','tea'],
  'porridge':         ['oat','milk','seed','fruit','maple','cinnamon'],
  'smoothie':         ['oat','seed','nut butter','fruit','milk','protein'],
  'overnight oats':   ['oat','milk','chia','seed','maple','fruit'],
  // Snacks
  'snack':            ['nut','seed','cracker','fruit','chocolate','bar','hummus'],
  'snacks':           ['nut','seed','cracker','fruit','chocolate','bar'],
  // Baking
  'baking':           ['flour','sugar','oil','vanilla','baking powder','chocolate','oat'],
  'cake':             ['flour','sugar','oil','vanilla','baking powder','chocolate'],
  'bread':            ['flour','yeast','oil','salt','seed'],
  'cookies':          ['flour','sugar','oil','chocolate','vanilla','oat'],
  // Drinks
  'drinks':           ['tea','coffee','oat milk','juice','kombucha'],
  'smoothie bowl':    ['oat','seed','nut butter','milk','fruit'],
};

function getMealKeywords(mealQuery) {
  const q = mealQuery.toLowerCase();
  for (const [meal, keywords] of Object.entries(MEAL_KEYWORD_MAP)) {
    if (q.includes(meal)) return keywords;
  }
  // Fallback: use words from the query itself as search terms
  const stopWords = new Set(['help','me','build','basket','make','cook','for','with','a','the','and','or','some','good','quick','easy','healthy','vegan','organic']);
  return q.split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w)).slice(0, 5);
}

async function lookupBasketProducts(supabaseUrl, supabaseKey, mealQuery) {
  const keywords = getMealKeywords(mealQuery);
  const fields   = 'product_name,brand,category,description,vegan,organic,gluten_free';
  const headers  = {
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Range-Unit':    'items',
    'Range':         '0-4',
  };

  const results    = [];
  const seen       = new Set();

  for (const keyword of keywords.slice(0, 6)) {
    const url = `${supabaseUrl}/rest/v1/sol_products?approved=eq.true` +
      `&product_name=ilike.*${encodeURIComponent(keyword)}*` +
      `&limit=3&select=${fields}`;
    try {
      const res  = await fetch(url, { headers });
      if (!res.ok) continue;
      const rows = await res.json();
      for (const row of (rows || [])) {
        if (!seen.has(row.product_name)) {
          seen.add(row.product_name);
          results.push(row);
        }
      }
    } catch(e) { continue; }
  }
  return results;
}

function isRefill(product) {
  return product.category && product.category.toLowerCase().includes('refill');
}

function formatBasketContext(products, mealQuery) {
  if (!products || products.length === 0) return '';
  const lines = [
    `REAL KINDLY PRODUCTS for "${mealQuery}" — recommend ONLY these specific products, using exact names:`,
  ];
  for (const p of products) {
    let line = `• ${p.product_name}`;
    if (p.brand)       line += ` by ${p.brand}`;
    if (isRefill(p))   line += ` [REFILL — plastic-free]`;
    if (p.description) line += ` — ${p.description.substring(0, 60)}`;
    lines.push(line);
  }
  lines.push('');
  lines.push('RULES: Only name the specific products listed above. For refill items mark them as plastic-free. For non-refill items say nothing about packaging. Never say "everything is zero-waste" — only refill products are plastic-free.');
  return lines.join('\n');
}

function formatDietaryResults(products, diet, category) {
  if (!products || products.length === 0) return '';
  const lines = [
    `DIETARY FILTER RESULTS — ${diet.toUpperCase()}${category ? ' / ' + category.toUpperCase() : ''}:`,
    `Found ${products.length} matching products in Kindly's database:`,
  ];
  for (const p of products) {
    let line = `• ${p.product_name}`;
    if (p.brand) line += ` (${p.brand})`;
    if (p.description) line += ` — ${p.description.substring(0, 80)}`;
    lines.push(line);
  }
  return lines.join('\n');
}

// ── Fetch a random product with a story from Supabase ────────────────────
async function fetchRandomProductStory(supabaseUrl, supabaseKey) {
  // Fetch products that have either a supplier_story or impact_line
  // Use offset randomisation to get a different one each time
  const randomOffset = Math.floor(Math.random() * 50);
  const res = await fetch(
    `${supabaseUrl}/rest/v1/sol_products?approved=eq.true` +
    `&supplier_story=not.is.null&supplier_story=neq.` +
    `&select=product_name,brand,supplier,supplier_story,impact_line,origin,description` +
    `&limit=1&offset=${randomOffset}`,
    {
      headers: {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Range-Unit':    'items',
        'Range':         '0-0',
      },
    }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  // If offset too large, fall back to offset 0
  if (!rows || rows.length === 0) {
    const res2 = await fetch(
      `${supabaseUrl}/rest/v1/sol_products?approved=eq.true` +
      `&supplier_story=not.is.null` +
      `&select=product_name,brand,supplier,supplier_story,impact_line,origin,description` +
      `&limit=1&offset=0`,
      {
        headers: {
          'apikey':        supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Range-Unit':    'items',
          'Range':         '0-0',
        },
      }
    );
    if (!res2.ok) return null;
    const rows2 = await res2.json();
    return rows2?.[0] || null;
  }
  return rows[0];
}

function formatProductStoryContext(p) {
  if (!p) return '';
  const lines = ['PRODUCT STORY DATA — use this to tell a surprise product story:'];
  if (p.product_name) lines.push(`Product: ${p.product_name}`);
  if (p.brand)        lines.push(`Brand: ${p.brand}`);
  if (p.supplier)     lines.push(`Supplier: ${p.supplier}`);
  if (p.origin)       lines.push(`Origin: ${p.origin}`);
  if (p.supplier_story) lines.push(`Story: ${p.supplier_story}`);
  if (p.impact_line)  lines.push(`Impact: ${p.impact_line}`);
  if (p.description)  lines.push(`Description: ${p.description}`);
  return lines.join('\n');
}

// ── Fetch store info from Supabase ─────────────────────────────────────────
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

  // Convert array of {key, value} rows into a plain object
  const info = {};
  for (const row of rows) {
    if (row.key && row.value) info[row.key] = row.value;
  }
  return info;
}


// ── Format store context for Claude ───────────────────────────────────────
function formatStoreContext(info, isHiringQuestion) {
  const lines = ['VERIFIED KINDLY STORE INFORMATION — answer from this data:'];

  if (info.york_place_address)     lines.push(`York Place address: ${info.york_place_address}`);
  if (info.york_place_hours)       lines.push(`York Place opening hours: ${info.york_place_hours}`);
  if (info.dyke_road_address)      lines.push(`Dyke Road address: ${info.dyke_road_address}`);
  if (info.dyke_road_hours)        lines.push(`Dyke Road opening hours: ${info.dyke_road_hours}`);
  if (info.website)                lines.push(`Website: ${info.website}`);
  if (info.instagram)              lines.push(`Instagram: ${info.instagram}`);
  if (info.facebook)               lines.push(`Facebook: ${info.facebook}`);
  if (info.tiktok)                 lines.push(`TikTok: ${info.tiktok}`);
  if (info.plastic_units_diverted) lines.push(`Single-use plastic units diverted to date: ${info.plastic_units_diverted}`);
  if (info.co2_saved)              lines.push(`CO₂ saved: ${info.co2_saved}`);
  if (info.water_saved)            lines.push(`Water saved: ${info.water_saved}`);
  if (info.founded)                lines.push(`Founded: ${info.founded}`);
  if (info.founder)                lines.push(`Founder: ${info.founder}`);
  if (info.mission)                lines.push(`Mission: ${info.mission}`);
  if (info.employees)              lines.push(`Team size: ${info.employees}`);
  if (info.community_partners)     lines.push(`Community partners: ${info.community_partners}`);
  if (info.awards)                 lines.push(`Awards: ${info.awards}`);
  if (info.local_economy)          lines.push(`Local economy impact: ${info.local_economy}`);
  if (info.loyalzoo_link)          lines.push(`Loyalty scheme: ${info.loyalzoo_link}`);

  if (isHiringQuestion) {
    if (info.jobs_page)      lines.push(`Jobs page: ${info.jobs_page}`);
    if (info.hiring_status)  lines.push(`Current hiring status: ${info.hiring_status}`);
  }

  return lines.join('\n');
}


// ── Product lookup ─────────────────────────────────────────────────────────
async function lookupProducts(supabaseUrl, supabaseKey, question) {
  const stopWords = new Set([
    'tell','me','about','your','is','are','the','a','an','what','how','much',
    'does','do','have','has','i','my','for','with','in','please','can','you',
    'pls','any','some','there','its','it','this','that','they','their','these',
    'those','where','when','why','who','get','give','show','find','know',
    'want','need','like','use','make','just','also','than','then','from',
    'stock','stocks','stocked','sell','selling','carry','carrying','got',
  ]);

  let normalised = question.toLowerCase()
    .replace(/clear\s+spot/g,      'clearspot')
    .replace(/clear\s+spring/g,    'clearspring')
    .replace(/trail\s+mix/g,       'fruit nut mix')
    .replace(/flax\s*seed/g,       'linseed')
    .replace(/navy\s+bean/g,       'haricot')
    .replace(/omega\s+seed/g,      'omega four seed')
    .replace(/mixed\s+seed/g,      'omega four seed')
    .replace(/black\s+bean/g,      'black turtle')
    .replace(/garbanzo/g,          'chickpea')
    .replace(/porridge\s+oat/g,    'oatflakes')
    .replace(/rolled\s+oat/g,      'oatflakes');

  const terms = normalised
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (terms.length === 0) return null;

  const headers = {
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Range-Unit':    'items',
    'Range':         '0-9',
  };

  const fields =
    `product_name,brand,supplier,ingredients,allergens,may_contain,` +
    `free_from,vegan,organic,gluten_free,kcal,protein,carbs,fat,fibre,salt,` +
    `description,origin,impact_line`;

  if (terms.length >= 2) {
    for (let i = 0; i < Math.min(terms.length - 1, 3); i++) {
      const t1 = terms[i];
      const t2 = terms[i + 1];
      const res = await fetch(
        `${supabaseUrl}/rest/v1/sol_products?approved=eq.true` +
        `&product_name=ilike.*${t1}*` +
        `&product_name=ilike.*${t2}*` +
        `&limit=3&select=${fields}`,
        { headers }
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.length > 0) return data;
    }
  }

  const genericWords = new Set([
    'organic','plain','whole','fresh','natural','raw','dried',
    'mix','seeds','beans','nuts','rice','flour','powder',
  ]);
  const specificTerms = terms.filter(t => !genericWords.has(t));

  for (const term of (specificTerms.length ? specificTerms : terms).slice(0, 4)) {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/sol_products?approved=eq.true` +
      `&product_name=ilike.*${term}*` +
      `&limit=3&select=${fields}`,
      { headers }
    );
    if (!res.ok) continue;
    const data = await res.json();
    if (data && data.length > 0) return data;
  }

  return null;
}


// ── Format product data as context ────────────────────────────────────────
function formatProductContext(products) {
  if (!products || products.length === 0) return '';

  const lines = [
    'VERIFIED KINDLY PRODUCT DATA — answer from this data, not general knowledge:',
  ];

  for (const p of products) {
    lines.push(`\nProduct: ${p.product_name}${p.brand ? ' by ' + p.brand : ''}`);
    if (p.supplier)    lines.push(`Supplier: ${p.supplier}`);
    if (p.ingredients) lines.push(`Ingredients: ${p.ingredients}`);
    if (p.allergens)   lines.push(`Allergens: ${p.allergens}`);
    if (p.may_contain && p.may_contain.trim())
                       lines.push(`May contain: ${p.may_contain}`);
    if (p.free_from)   lines.push(`Free from: ${p.free_from}`);
    if (p.vegan)       lines.push(`Vegan: ${p.vegan}`);
    if (p.organic)     lines.push(`Organic: ${p.organic}`);
    if (p.gluten_free) lines.push(`Gluten free: ${p.gluten_free}`);
    if (p.kcal) {
      let n = `Nutrition per 100g: ${p.kcal} kcal`;
      if (p.protein) n += `, protein ${p.protein}g`;
      if (p.carbs)   n += `, carbs ${p.carbs}g`;
      if (p.fat)     n += `, fat ${p.fat}g`;
      if (p.fibre)   n += `, fibre ${p.fibre}g`;
      if (p.salt)    n += `, salt ${p.salt}g`;
      lines.push(n);
    }
    if (p.description) lines.push(`Description: ${p.description}`);
    if (p.origin)      lines.push(`Origin: ${p.origin}`);
    if (p.impact_line) lines.push(`Impact: ${p.impact_line}`);
  }

  return lines.join('\n');
}


// ── Log question to Supabase ──────────────────────────────────────────────
async function logQuestion({ supabaseUrl, supabaseKey, question, answer, had_image, from_db, off_topic, identified_product, channel }) {
  await fetch(`${supabaseUrl}/rest/v1/sol_question_log`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({
      question,
      answer,
      had_image,
      from_db:            from_db  || false,
      off_topic:          off_topic || false,
      identified_product: identified_product || '',
      channel:            channel || 'website',
      asked_at:           new Date().toISOString(),
    }),
  });
}
