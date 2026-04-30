export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey      = process.env.CLAUDE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  // ── Special action: return plastic counter for the UI banner ─────────────
  if (req.body && req.body._action === 'get_plastic_counter') {
    if (supabaseUrl && supabaseKey) {
      try {
        const storeInfo = await fetchStoreInfo(supabaseUrl, supabaseKey);
        const counter = storeInfo && storeInfo.plastic_units_diverted
          ? storeInfo.plastic_units_diverted
          : null;
        return res.status(200).json({ plastic_counter: counter });
      } catch(e) {
        return res.status(200).json({ plastic_counter: null });
      }
    }
    return res.status(200).json({ plastic_counter: null });
  }

  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const messages = req.body.messages || [];
    const lastMessage = messages[messages.length - 1];
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
    // If the question is clearly unrelated to Kindly, return a friendly
    // redirect without calling Claude at all — saves cost and keeps Sol focused
    if (isOffTopic(customerQuestion)) {
      const offTopicReply = offTopicResponse();
      if (supabaseUrl && supabaseKey && customerQuestion) {
        logQuestion({
          supabaseUrl, supabaseKey,
          question:  customerQuestion,
          answer:    offTopicReply,
          had_image: hadImage,
          from_db:   false,
          off_topic: true,
        }).catch(() => {});
      }
      return res.status(200).json({
        content: [{ type: 'text', text: offTopicReply }],
        off_topic: true,
      });
    }

    // ── Classify question type ─────────────────────────────────────────────
    const qLower = customerQuestion.toLowerCase();
    const isStoreInfoQuestion = detectStoreInfoQuestion(qLower);
    const isHiringQuestion    = detectHiringQuestion(qLower);
    const isAboutKindly       = detectAboutKindlyQuestion(qLower);
    const isSurpriseMe        = detectSurpriseMe(qLower);
    const dietaryFilter       = detectDietaryFilter(qLower);

    // ── Supabase lookups ───────────────────────────────────────────────────
    let productContext  = '';
    let storeContext    = '';
    let foundInDb       = false;
    let foundStoreInfo  = false;

    if (supabaseUrl && supabaseKey) {

      // Surprise me — fetch a random product with a supplier story
      if (isSurpriseMe) {
        try {
          const storyProduct = await fetchRandomProductStory(supabaseUrl, supabaseKey);
          if (storyProduct) {
            productContext = formatProductStoryContext(storyProduct);
            foundInDb      = true;
          }
        } catch(e) {
          console.error('Random story lookup error:', e.message);
        }
      }

      // Store info lookup — hours, addresses, hiring, about Kindly
      if (!isSurpriseMe && (isStoreInfoQuestion || isHiringQuestion || isAboutKindly)) {
        try {
          const storeInfo = await fetchStoreInfo(supabaseUrl, supabaseKey);
          if (storeInfo) {
            storeContext   = formatStoreContext(storeInfo, isHiringQuestion);
            foundStoreInfo = true;
            foundInDb      = true;
          }
        } catch(e) {
          console.error('Store info lookup error:', e.message);
        }
      }

      // Dietary filter lookup — query by flag + optional category
      if (!foundStoreInfo && !isSurpriseMe && dietaryFilter.diet) {
        try {
          const products = await lookupByDietaryFilter(
            supabaseUrl, supabaseKey,
            dietaryFilter.diet,
            dietaryFilter.category
          );
          if (products && products.length > 0) {
            productContext = formatDietaryResults(products, dietaryFilter.diet, dietaryFilter.category);
            foundInDb      = true;
          }
        } catch(e) {
          console.error('Dietary filter lookup error:', e.message);
        }
      }

      // Product lookup — only if not already answered by store info or surprise
      if (!foundStoreInfo && !isSurpriseMe && !dietaryFilter.diet && customerQuestion && !hadImage) {
        try {
          const products = await lookupProducts(supabaseUrl, supabaseKey, customerQuestion);
          if (products && products.length > 0) {
            productContext = formatProductContext(products);
            foundInDb      = true;
          }
        } catch(e) {
          console.error('Supabase product lookup error:', e.message);
        }
      }
    }

    // ── Build system prompt injection ──────────────────────────────────────
    const requestBody    = { ...req.body };
    const existingSystem = requestBody.system || '';

    let contextBlock = '';
    if (dietaryFilter.diet && foundInDb && productContext) {
      contextBlock = '\n\n' + productContext +
        `\n\nIMPORTANT: The customer is looking for ${dietaryFilter.diet} products` +
        (dietaryFilter.category ? ` in the ${dietaryFilter.category} category` : '') +
        '. List the products clearly with their key benefits. ' +
        'Be specific and helpful — this is exactly what they need to know to shop confidently. ' +
        'End with a note that they can ask Sol about any specific product for more detail. ' +
        '\nEnd your response with: "📋 *From Kindly\'s product database*"';
    } else if (isSurpriseMe && foundInDb && productContext) {
      contextBlock = '\n\n' + productContext +
        '\n\nIMPORTANT: The customer wants to be surprised with a product story. ' +
        'Tell the story of this product in Sol\'s warm Brighton personality — where it comes from, ' +
        'who makes it, why it\'s special, what makes it a Kindly favourite. ' +
        'Make it feel like a recommendation from a knowledgeable friend, not a product description. ' +
        '2-3 sentences max. End with a fun emoji. ' +
        'Do NOT append any database indicator.';
    } else if (foundStoreInfo && storeContext) {
      contextBlock = '\n\n' + storeContext +
        '\n\nIMPORTANT: Answer using the verified Kindly store information above. ' +
        'End your response with a new line containing exactly: ' +
        '"📋 *From Kindly\'s store information*"';
    } else if (foundInDb && productContext) {
      contextBlock = '\n\n' + productContext +
        '\n\nIMPORTANT: Answer ONLY from the verified product data above. ' +
        'Do not supplement with general knowledge. ' +
        'End your response with a new line containing exactly: ' +
        '"📋 *From Kindly\'s product database*"';
    } else {
      // Check if this is a vague follow-up with no context
      const isVagueFollowUp = /^(tell me more|more please|more pls|tell me more pls|can you tell me more|go on|more\??)$/i.test(customerQuestion.trim());
      if (isVagueFollowUp) {
        contextBlock = '\n\nIMPORTANT: The customer has said "tell me more" or similar but there is no previous product context. ' +
          'Respond warmly asking what they would like to know more about — e.g. a specific product, opening hours, our story, or our environmental impact. ' +
          'Keep it brief and friendly. Do NOT append any database indicator emoji.';
      } else {
        contextBlock = '\n\nIMPORTANT: No specific data was found in the Kindly database for this question. ' +
          'Answer only if this relates to Kindly, our products, sustainable shopping, or the Brighton community. ' +
          'Answer from your general knowledge but be appropriately cautious about specifics. ' +
          'End your response with a new line containing exactly: ' +
          '"💡 *General knowledge — product details may vary*"';
      }
    }

    requestBody.system = existingSystem + contextBlock;

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

    const solAnswer = data.content?.[0]?.text || '';

    // ── Extract product name from Sol's answer (for image queries) ──────────
    let identifiedProduct = '';
    if (hadImage && solAnswer) {
      // Sol typically says "I can see [Product Name]" or "This is [Product Name]"
      const productMatch = solAnswer.match(
        /(?:this is|i can see|looking at|that\'s|that is|i see)\s+(?:a\s+)?([A-Z][\w\s&'-]{3,50}?)(?:\.|\/|,|\s+by\s+|\s+from\s+|\s+—|\s+which|\s+that|\s+is|\s+\()/i
      );
      if (productMatch) identifiedProduct = productMatch[1].trim();
    }

    // ── Log question (fire and forget) ────────────────────────────────────
    if (supabaseUrl && supabaseKey && customerQuestion) {
      logQuestion({
        supabaseUrl, supabaseKey,
        question:           customerQuestion,
        answer:             solAnswer,
        had_image:          hadImage,
        from_db:            foundInDb,
        identified_product: identifiedProduct,
      }).catch(err => console.error('Log error:', err));
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}


// ── Off-topic detection ────────────────────────────────────────────────────
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

function detectAboutKindlyQuestion(q) {
  return /\b(about kindly|what is kindly|who are kindly|kindly story|started|founded|founder|mission|values|impact|environmental|sustainability|plastic diverted|plastic saved|units saved|units diverted|co2|carbon|water|community|fareshare|team domenica|award|accolade|how many (people|staff|employees)|next for kindly|future|expand|loyalty|loyalzoo|local economy|reinvest|brighton economy)\b/.test(q);
}


// ── Dietary filter product lookup ─────────────────────────────────────────
async function lookupByDietaryFilter(supabaseUrl, supabaseKey, diet, category) {
  // Map diet name to Supabase column
  const dietColMap = {
    'gluten free': 'gluten_free',
    'vegan':       'vegan',
    'dairy free':  'free_from',  // check free_from contains dairy
    'organic':     'organic',
    'nut free':    'free_from',
    'soy free':    'free_from',
  };

  const fields = 'product_name,brand,supplier,description,vegan,organic,gluten_free,free_from,allergens,impact_line';
  let url = `${supabaseUrl}/rest/v1/sol_products?approved=eq.true`;

  // Apply dietary flag filter
  if (diet === 'vegan') {
    url += `&vegan=ilike.*yes*`;
  } else if (diet === 'gluten free') {
    url += `&gluten_free=ilike.*yes*`;
  } else if (diet === 'organic') {
    url += `&organic=ilike.*yes*`;
  } else if (diet === 'dairy free' || diet === 'nut free' || diet === 'soy free') {
    // These use the free_from field
    const term = diet === 'dairy free' ? 'dairy' : diet === 'nut free' ? 'nut' : 'soy';
    url += `&free_from=ilike.*${term}*`;
  }

  // Apply category filter if provided
  if (category) {
    url += `&product_name=ilike.*${encodeURIComponent(category)}*`;
  }

  url += `&limit=12&select=${fields}`;

  const res = await fetch(url, {
    headers: {
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Range-Unit':    'items',
      'Range':         '0-11',
    },
  });

  if (!res.ok) return null;
  const rows = await res.json();

  // If category filter returned nothing, try without it
  if ((!rows || rows.length === 0) && category) {
    const urlNoCategory = url
      .replace(`&product_name=ilike.*${encodeURIComponent(category)}*`, '')
      .replace('&limit=12', '&limit=8');
    const res2 = await fetch(urlNoCategory, {
      headers: {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Range-Unit':    'items',
        'Range':         '0-7',
      },
    });
    if (!res2.ok) return null;
    return await res2.json();
  }

  return rows;
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
async function logQuestion({ supabaseUrl, supabaseKey, question, answer, had_image, from_db, off_topic, identified_product }) {
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
      asked_at:           new Date().toISOString(),
    }),
  });
}
