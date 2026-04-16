import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // 1. Handle CORS and Options
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 2. Initialize Supabase
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  try {
    const { messages, system, model, max_tokens } = req.body;
    const lastMessage = messages[messages.length - 1];
    
    // Extract text for database lookup
    let customerQuestion = "";
    let hadImage = false;

    if (Array.isArray(lastMessage.content)) {
      customerQuestion = lastMessage.content.find(c => c.type === 'text')?.text || "";
      hadImage = lastMessage.content.some(c => c.type === 'image');
    } else {
      customerQuestion = lastMessage.content || "";
    }

    // --- SMART TIERED LOOKUP ---
    const { matches, method } = await lookupProducts(customerQuestion, supabase);

    let productContext = '';
    let foundInDb = false;

    if (matches && matches.length > 0) {
      productContext = formatProductContext(matches);
      foundInDb = true;
    }

    const dataSourceTag = foundInDb 
        ? "📋 *From Kindly's product database*" 
        : "💡 *General knowledge*";

    // 3. COMBINE SYSTEM PROMPT
    // We append the database data to the system prompt sent from index.html
    const finalSystem = `${system}

${foundInDb ? productContext : "Note: No specific database match found for this query."}

CRITICAL: If the user asks about Loyalty or Hours, use the EXACT text provided in the instructions above. 
ALWAYS end your response with: ${dataSourceTag}`;

    // 4. CALL CLAUDE
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || "claude-3-haiku-20240307",
        max_tokens: max_tokens || 400,
        system: finalSystem,
        messages: messages
      })
    });

    const data = await response.json();

    // Error handling for API response
    if (data.error) {
      console.error('Claude API Error:', data.error);
      return res.status(500).json({ error: data.error.message });
    }

    // 5. LOG TO SUPABASE (Optional/Background)
    const solAnswer = data.content?.[0]?.text || '';
    supabase.from('sol_question_log').insert([{
      question: customerQuestion,
      answer: solAnswer,
      had_image: hadImage,
      asked_at: new Date().toISOString()
    }]).then();

    return res.status(200).json(data);

  } catch (err) {
    console.error('Vercel Handler Error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

// ── Search Strategy ──────────────────────────────────────────────────
async function lookupProducts(text, supabase) {
  if (!text || text.length < 3) return { matches: [], method: 'none' };

  // A. REFILL CODE (4-digit)
  const codeMatch = text.match(/\b(\d{4})\b/);
  if (codeMatch) {
    const code = codeMatch[1];
    const { data } = await supabase.from('sol_products')
      .select('*')
      .or(`epos_id.eq.${code},infinity_sku.eq.${code}`)
      .eq('approved', true).limit(1);
    if (data?.length > 0) return { matches: data, method: 'code' };
  }

  // B. PHRASE MATCH
  const { data: phraseData } = await supabase.from('sol_products')
    .select('*')
    .ilike('product_name', `%${text.trim()}%`)
    .eq('approved', true).limit(1);
  if (phraseData?.length > 0) return { matches: phraseData, method: 'phrase' };

  return { matches: [], method: 'none' };
}

// ── Context Formatting ───────────────────────────────────────────────
function formatProductContext(products) {
  let context = "\nVERIFIED DATABASE DATA:\n";
  products.forEach(p => {
    context += `- Product: ${p.product_name}\n`;
    if (p.brand) context += `  Brand: ${p.brand}\n`;
    if (p.ingredients) context += `  Ingredients: ${p.ingredients}\n`;
    if (p.allergens) context += `  Allergens: ${p.allergens}\n`;
    if (p.impact_line) context += `  Impact: ${p.impact_line}\n`;
  });
  return context;
}
