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

    // ── Supabase product lookup ─────────────────────────────────────────
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

    // ── Build request with data source instruction ──────────────────────
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

    // ── Log to Supabase (fire and forget) ───────────────────────────────
    if (supabaseUrl && supabaseKey && customerQuestion) {
      logQuestion({
        supabaseUrl, supabaseKey,
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


// ── Product lookup with synonym expansion ─────────────────────────────────
async function lookupProducts(supabaseUrl, supabaseKey, question) {
  const stopWords = new Set([
    'tell','me','about','your','is','are','the','a','an','what','how','much',
    'does','do','have','has','i','my','for','with','in','please','can','you',
    'pls','any','some','there','its','it','this','that','they','their','these',
    'those','where','when','why','who','get','give','show','find','know',
    'want','need','like','use','make','just','also','than','then','from',
    'stock','stocks','stocked','sell','selling','carry','carrying','got',
  ]);

  // Normalise common brand/product name variations before tokenising
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

  // Strategy 1: two-term AND match (most precise — avoids false positives)
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

  // Strategy 2: single specific term (skip generic words first)
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


// ── Format product data as context ───────────────────────────────────────
function formatProductContext(products) {
  if (!products || products.length === 0) return '';

  const lines = [
    // 'VERIFIED KINDLY PRODUCT DATA — answer from this data, not general knowledge:',
    'VERIFIED KINDLY PRODUCT DATA — use this to answer naturally in 2-4 sentences. DO NOT list all fields. Pick the most relevant facts for the question asked. Never format as a product card or use bullet points.',
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
async function logQuestion({ supabaseUrl, supabaseKey, question, answer, had_image, from_db }) {
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
      from_db:  from_db || false,
      asked_at: new Date().toISOString(),
    }),
  });
}
