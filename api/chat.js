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

    if (supabaseUrl && supabaseKey && customerQuestion && !hadImage) {
      try {
        const products = await lookupProducts(supabaseUrl, supabaseKey, customerQuestion);
        if (products && products.length > 0) {
          productContext = formatProductContext(products);
          foundInDb = true;
        }
      } catch(e) {
        console.error('Supabase lookup error:', e.message);
      }
    }

    // ── Build system prompt with data source instruction ────────────────
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

    // ── Log question to Supabase (fire and forget) ──────────────────────
    if (supabaseUrl && supabaseKey && customerQuestion) {
      logQuestion({
        supabaseUrl,
        supabaseKey,
        question:  customerQuestion,
        answer:    solAnswer,
        had_image: hadImage,
        from_db:   foundInDb,
      }).catch(err => console.error('Log error:', err));
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}


// ── Search Supabase for products matching the customer's question ─────────
async function lookupProducts(supabaseUrl, supabaseKey, question) {
  const stopWords = new Set([
    'tell','me','about','your','is','are','the','a','an','what','how','much',
    'does','do','have','has','i','my','for','with','in','please','can','you',
    'pls','any','some','there','its','it','this','that','they','their','these',
    'those','where','when','why','who','get','give','show','find','know',
    'want','need','like','use','make','just','also','than','then','from',
  ]);

  const terms = question.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (terms.length === 0) return null;

  // Try each term until we get results
  // %25 is URL-encoded % — Supabase ilike wildcard requires % not *
  for (const term of terms.slice(0, 4)) {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/sol_products` +
      `?approved=eq.true` +
      `&product_name=ilike.%25${term}%25` +
      `&limit=3` +
      `&select=product_name,brand,supplier,ingredients,allergens,may_contain,` +
      `free_from,vegan,organic,gluten_free,kcal,protein,carbs,fat,fibre,salt,` +
      `description,origin,impact_line`,
      {
        headers: {
          'apikey':        supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Range-Unit':    'items',
          'Range':         '0-9',
        }
      }
    );

    if (!res.ok) continue;
    const data = await res.json();
    if (data && data.length > 0) return data;
  }

  return null;
}


// ── Format product data as context for Sol ────────────────────────────────
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
      let nutrition = `Nutrition per 100g: ${p.kcal} kcal`;
      if (p.protein) nutrition += `, protein ${p.protein}g`;
      if (p.carbs)   nutrition += `, carbs ${p.carbs}g`;
      if (p.fat)     nutrition += `, fat ${p.fat}g`;
      if (p.fibre)   nutrition += `, fibre ${p.fibre}g`;
      if (p.salt)    nutrition += `, salt ${p.salt}g`;
      lines.push(nutrition);
    }
    if (p.description) lines.push(`Description: ${p.description}`);
    if (p.origin)      lines.push(`Origin: ${p.origin}`);
    if (p.impact_line) lines.push(`Impact: ${p.impact_line}`);
  }

  return lines.join('\n');
}


// ── Log question to Supabase ──────────────────────────────────────────────
async function logQuestion({ supabaseUrl, supabaseKey, question, answer, had_image, from_db }) {
  await fetch(`${supabaseUrl}/rest/v1/sol_question_log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({
      question,
      answer,
      had_image,
      from_db:  from_db || false,
      asked_at: new Date().toISOString(),
    }),
  });
}
