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
    if (supabaseUrl && supabaseKey && customerQuestion && !hadImage) {
      try {
        const products = await lookupProducts(supabaseUrl, supabaseKey, customerQuestion);
        if (products && products.length > 0) {
          productContext = formatProductContext(products);
        }
      } catch(e) {
        console.error('Supabase lookup error:', e.message);
        // Non-fatal — Sol still answers from training knowledge
      }
    }

    // ── Inject product data into system prompt if found ─────────────────
    const requestBody = { ...req.body };
    if (productContext) {
      const existingSystem = requestBody.system || '';
      requestBody.system = existingSystem + '\n\n' + productContext;
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
      logQuestion({ supabaseUrl, supabaseKey, question: customerQuestion,
                    answer: solAnswer, had_image: hadImage })
        .catch(err => console.error('Log error:', err));
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}


// ── Search Supabase for products matching the customer's question ─────────
async function lookupProducts(supabaseUrl, supabaseKey, question) {
  // Extract meaningful search terms from the question
  // Remove common words and focus on product-like terms
  const stopWords = new Set(['tell','me','about','your','is','are','the','a','an',
    'what','how','much','does','do','have','has','i','my','for','with','in',
    'please','can','you','pls','any','some','there','its','it','this','that',
    'they','their','these','those','where','when','why','who']);

  const terms = question.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (terms.length === 0) return null;

  // Search by product name — try up to 3 most meaningful terms
  const searchTerm = terms.slice(0, 3).join(' & ');

  const res = await fetch(
    `${supabaseUrl}/rest/v1/sol_products?approved=eq.true` +
    `&product_name=ilike.*${encodeURIComponent(terms[0])}*` +
    `&limit=3&select=product_name,brand,supplier,ingredients,allergens,may_contain,` +
    `free_from,vegan,organic,gluten_free,kcal,protein,carbs,fat,fibre,salt,` +
    `description,origin,impact_line`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Range-Unit': 'items',
        'Range': '0-9',
      }
    }
  );

  if (!res.ok) return null;
  const data = await res.json();

  // If first term got nothing, try second term
  if ((!data || data.length === 0) && terms.length > 1) {
    const res2 = await fetch(
      `${supabaseUrl}/rest/v1/sol_products?approved=eq.true` +
      `&product_name=ilike.*${encodeURIComponent(terms[1])}*` +
      `&limit=3&select=product_name,brand,supplier,ingredients,allergens,may_contain,` +
      `free_from,vegan,organic,gluten_free,kcal,protein,carbs,fat,fibre,salt,` +
      `description,origin,impact_line`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Range-Unit': 'items',
          'Range': '0-9',
        }
      }
    );
    if (!res2.ok) return null;
    return await res2.json();
  }

  return data;
}


// ── Format product data as context for Sol ────────────────────────────────
function formatProductContext(products) {
  if (!products || products.length === 0) return '';

  const lines = ['KINDLY PRODUCT DATA FROM KNOWLEDGE BASE — use this for your answer:'];

  for (const p of products) {
    lines.push(`\nProduct: ${p.product_name}${p.brand ? ' by ' + p.brand : ''}`);
    if (p.supplier)     lines.push(`Supplier: ${p.supplier}`);
    if (p.ingredients)  lines.push(`Ingredients: ${p.ingredients}`);
    if (p.allergens)    lines.push(`Allergens: ${p.allergens}`);
    if (p.may_contain && p.may_contain.trim())
                        lines.push(`May contain: ${p.may_contain}`);
    if (p.free_from)    lines.push(`Free from: ${p.free_from}`);
    if (p.vegan)        lines.push(`Vegan: ${p.vegan}`);
    if (p.organic)      lines.push(`Organic: ${p.organic}`);
    if (p.gluten_free)  lines.push(`Gluten free: ${p.gluten_free}`);
    if (p.kcal)         lines.push(`Nutrition per 100g: ${p.kcal} kcal${p.protein ? ', protein ' + p.protein + 'g' : ''}${p.carbs ? ', carbs ' + p.carbs + 'g' : ''}${p.fat ? ', fat ' + p.fat + 'g' : ''}${p.fibre ? ', fibre ' + p.fibre + 'g' : ''}${p.salt ? ', salt ' + p.salt + 'g' : ''}`);
    if (p.description)  lines.push(`Description: ${p.description}`);
    if (p.origin)       lines.push(`Origin: ${p.origin}`);
    if (p.impact_line)  lines.push(`Impact: ${p.impact_line}`);
  }

  lines.push('\nAnswer using the above data. Quote specific figures where relevant. If the question is about a product NOT in this data, say you do not have the full details yet.');

  return lines.join('\n');
}


// ── Log question to Supabase ──────────────────────────────────────────────
async function logQuestion({ supabaseUrl, supabaseKey, question, answer, had_image }) {
  await fetch(`${supabaseUrl}/rest/v1/sol_question_log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      question,
      answer,
      had_image,
      asked_at: new Date().toISOString(),
    }),
  });
}
