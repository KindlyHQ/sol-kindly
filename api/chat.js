import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // 1. CORS and Method Handling
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.CLAUDE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { messages, system, model, max_tokens } = req.body;
    const lastMessage = messages[messages.length - 1];
    
    // Extract text from the last message (could be a string or array)
    let customerQuestion = '';
    let hadImage = false;

    if (Array.isArray(lastMessage.content)) {
      customerQuestion = lastMessage.content.find(c => c.type === 'text')?.text || "";
      hadImage = lastMessage.content.some(c => c.type === 'image');
    } else {
      customerQuestion = lastMessage.content || "";
    }

    // 2. TIERED LOOKUP LOGIC (Now works with images!)
    const { matches, method } = await lookupProducts(customerQuestion, supabase);

    let productContext = '';
    let foundInDb = false;

    if (matches && matches.length > 0) {
      productContext = formatProductContext(matches);
      foundInDb = true;
      console.log(`DB hit using ${method}:`, matches[0].product_name);
    }

    // 3. BUILD ENHANCED SYSTEM PROMPT
    let dataSourceTag = foundInDb 
        ? "📋 *From Kindly's product database*" 
        : "💡 *General knowledge — product details may vary*";

    const enhancedSystem = `${system}
    
    ${foundInDb ? productContext : "No specific product data found in database."}
    
    CRITICAL INSTRUCTIONS:
    - If there is a 4-digit code in the photo (like 1038), it is a REFILL. Focus on that match.
    - If looking at a shelf/deli pot and the database is missing, read labels from the photo.
    - ALWAYS end your response with exactly: ${dataSourceTag}`;

    // 4. CALL CLAUDE
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || "claude-3-haiku-20240307",
        max_tokens: max_tokens || 400,
        system: enhancedSystem,
        messages: messages
      })
    });

    const data = await response.json();
    const solAnswer = data.content?.[0]?.text || '';

    // 5. LOG QUESTION (Fire and forget)
    supabase.from('sol_question_log').insert([{
      question: customerQuestion,
      answer: solAnswer,
      had_image: hadImage,
      asked_at: new Date().toISOString()
    }]).then();

    return res.status(200).json(data);

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}

// ── Search Strategy: Code -> Phrase -> Fuzzy ──────────────────────────
async function lookupProducts(text, supabase) {
  // A. REFILL CODE MATCH (e.g. 1038)
  const codeMatch = text.match(/(?<![.\d])\b(\d{3,5})\b(?![.\d])/);
  if (codeMatch) {
    const code = codeMatch[1];
    const { data } = await supabase.from('sol_products')
      .select('*')
      .or(`infinity_sku.eq.${code},suma_code.eq.${code},epos_id.eq.${code}`)
      .eq('approved', true).limit(1);
    if (data?.length > 0) return { matches: data, method: 'code' };
  }

  // B. EXACT PHRASE MATCH (For "Vegetable & Chickpea Curry")
  if (text.length > 4) {
    const { data } = await supabase.from('sol_products')
      .select('*')
      .ilike('product_name', `*${text.trim()}*`)
      .eq('approved', true).limit(2);
    if (data?.length > 0) return { matches: data, method: 'phrase' };
  }

  // C. KEYWORD FUZZY MATCH (For Shelves)
  const terms = text.split(/\s+/).filter(t => t.length > 3);
  if (terms.length > 0) {
    const pattern = `*${terms.slice(0, 2).join('*')}*`;
    const { data } = await supabase.from('sol_products')
      .select('*')
      .ilike('product_name', pattern)
      .eq('approved', true).limit(3);
    if (data?.length > 0) return { matches: data, method: 'fuzzy' };
  }

  return { matches: [], method: 'none' };
}

// ── Formatting Logic (Keep your existing format) ──────────────────────
function formatProductContext(products) {
  const lines = ['VERIFIED KINDLY PRODUCT DATA:'];
  for (const p of products) {
    lines.push(`\nProduct: ${p.product_name}${p.brand ? ' by ' + p.brand : ''}`);
    if (p.ingredients) lines.push(`Ingredients: ${p.ingredients}`);
    if (p.allergens)   lines.push(`Allergens: ${p.allergens}`);
    if (p.vegan)       lines.push(`Vegan: ${p.vegan}`);
    if (p.organic)     lines.push(`Organic: ${p.organic}`);
    if (p.description) lines.push(`Description: ${p.description}`);
  }
  return lines.join('\n');
}
