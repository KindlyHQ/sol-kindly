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

    // ── Look up product data from Supabase ──────────────────────────────
    let productContext = '';
    let foundInDb = false;

    console.log('Question:', customerQuestion.substring(0, 80));

    if (supabaseUrl && supabaseKey && customerQuestion && !hadImage) {
      try {
        const products = await lookupProducts(supabaseUrl, supabaseKey, customerQuestion);
        if (products && products.length > 0) {
          productContext = formatProductContext(products);
          foundInDb = true;
          console.log('DB hit:', products[0].product_name);
        } else {
          console.log('No DB match');
        }
      } catch(e) {
        console.error('Supabase lookup error:', e.message);
      }
    }

    // ── Build system prompt ─────────────────────────────────────────────
    const requestBody = { ...req.body };
    const existingSystem = requestBody.system || '';

    if (foundInDb) {
      requestBody.system = existingSystem +
        '\n\n' + productContext +
        '\n\nIMPORTANT: This answer is based on verified data from the Kindly product database. ' +
        'End your response with a new line containing exactly: ' +
        '"📋 *From Kindly\'s product database*"';
    } else {
      requestBody.system = existingSystem +
        '\n\nIMPORTANT: No specific product data was found in the Kindly database for this question. ' +
        'Answer from your general knowledge but be appropriately cautious about specifics. ' +
        'End your response with a new line containing exactly: ' +
        '"💡 *General knowledge — product details may vary*"';
    }

    // ── Call Claude ─────────────────────────────────────────────────────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    const solAnswer = data.content?.[0]?.text || '';

    // ── Log question ────────────────────────────────────────────────────
    if (supabaseUrl && supabaseKey && customerQuestion) {
      logQuestion({ supabaseUrl, supabaseKey, question: customerQuestion,
                    answer: solAnswer, had_image: hadImage })
        .catch(err => console.error('Log error:', err));
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}


// ── Product lookup — phrase-first, then specific terms ────────────────────
async function lookupProducts(supabaseUrl, supabaseKey, question) {
  const stopWords = new Set([
    'tell','me','about','your','is','are','the','a','an','what','how','much',
    'does','do','have','has','i','my','for','with','in','please','can','you',
    'pls','any','some','there','its','it','this','that','they','their','these',
    'those','where','when','why','who','get','give','show','find','know',
    'want','need','like','use','make','just','also','than','then','from',
    'organic', // too generic — skip as standalone search term
  ]);

  // Words that are too generic to search on their own
  const genericWords = new Set([
    'seeds','beans','nuts','flakes','flour','rice','oats','mix','blend',
    'powder','oil','sauce','paste','spread','butter','milk','cream','bits',
    'pieces','whole','ground','raw','roasted','dried','fresh',
  ]);

  const allTerms = question.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (allTerms.length === 0) return null;

  // Specific terms — exclude generic standalone words unless no other option
  const specificTerms = allTerms.filter(w => !genericWords.has(w));
  const searchTerms   = specificTerms.length > 0 ? specificTerms : allTerms;

  console.log('All terms:', allTerms);
  console.log('Search terms (specific):', searchTerms);

  const supabaseQuery = async (term) => {
    const url = `${supabaseUrl}/rest/v1/sol_products` +
      `?approved=eq.true` +
      `&product_name=ilike.*${term}*` +
      `&limit=3` +
      `&select=product_name,brand,supplier,ingredients,allergens,may_contain,` +
      `free_from,vegan,organic,gluten_free,kcal,protein,carbs,fat,fibre,salt,` +
      `description,origin,impact_line`;

    const r = await fetch(url, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Range-Unit': 'items',
        'Range': '0-9',
      }
    });

    if (!r.ok) return null;
    const data = await r.json();
    return data && data.length > 0 ? data : null;
  };

  // Strategy 1: try 2-word phrase (most precise)
  if (searchTerms.length >= 2) {
    const phrase = searchTerms.slice(0, 2).join('+');
    // Use full text search with two terms combined
    const url2 = `${supabaseUrl}/rest/v1/sol_products` +
      `?approved=eq.true` +
      `&product_name=ilike.*${searchTerms[0]}*` +
      `&product_name=ilike.*${searchTerms[1]}*` +
      `&limit=3` +
      `&select=product_name,brand,supplier,ingredients,allergens,may_contain,` +
      `free_from,vegan,organic,gluten_free,kcal,protein,carbs,fat,fibre,salt,` +
      `description,origin,impact_line`;

    const r2 = await fetch(url2, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      }
    });
    if (r2.ok) {
      const d2 = await r2.json();
      if (d2 && d2.length > 0) {
        console.log('Phrase match:', d2[0].product_name);
        return d2;
      }
    }
  }

  // Strategy 2: most specific single term
  for (const term of searchTerms.slice(0, 3)) {
    const result = await supabaseQuery(term);
    if (result) {
      console.log('Single term match for "' + term + '":', result[0].product_name);
      return result;
    }
  }

  return null;
}


// ── Format product data as context for Sol ────────────────────────────────
function formatProductContext(products) {
  if (!products || products.length === 0) return '';

  const lines = ['VERIFIED KINDLY PRODUCT DATA — answer from this data:'];

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


// ── Log question ──────────────────────────────────────────────────────────
async function logQuestion({ supabaseUrl, supabaseKey, question, answer, had_image }) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/sol_question_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({ question, answer, had_image, asked_at: new Date().toISOString() }),
    });
  } catch(e) {
    console.error('Log failed:', e.message);
  }
}
