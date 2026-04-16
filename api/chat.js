import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  try {
    const { messages, system, model, max_tokens } = req.body;
    const lastMessage = messages[messages.length - 1];
    
    let customerQuestion = '';
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
        : "💡 *General knowledge — product details may vary*";

    const enhancedSystem = `${system}
    
    ${foundInDb ? productContext : "No specific product match in database."}
    
    CRITICAL INSTRUCTIONS:
        - ALWAYS use bullet points (•) and clear new lines for lists (Hours or Rewards).
        - If the user asks about loyalty, use the £5 and £10 reward tiers and sound enthusiastic.
        - End with exactly: ${dataSourceTag}`;

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
        system: enhancedSystem,
        messages: messages
      })
    });

    const data = await response.json();
    const solAnswer = data.content?.[0]?.text || '';

    // Log to Supabase
    supabase.from('sol_question_log').insert([{
      question: customerQuestion,
      answer: solAnswer,
      had_image: hadImage,
      asked_at: new Date().toISOString()
    }]).then();

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function lookupProducts(text, supabase) {
  // A. REFILL CODE (Regex for 4-digit code)
  const codeMatch = text.match(/\b(\d{4})\b/);
  if (codeMatch) {
    const code = codeMatch[1];
    const { data } = await supabase.from('sol_products')
      .select('*')
      .or(`epos_id.eq.${code},infinity_sku.eq.${code}`)
      .eq('approved', true).limit(1);
    if (data?.length > 0) return { matches: data, method: 'code' };
  }

  // B. EXACT PHRASE
  if (text.length > 5) {
    const { data } = await supabase.from('sol_products')
      .select('*')
      .ilike('product_name', `*${text.trim()}*`)
      .eq('approved', true).limit(2);
    if (data?.length > 0) return { matches: data, method: 'phrase' };
  }

  // C. FUZZY
  const terms = text.split(/\s+/).filter(t => t.length > 3);
  if (terms.length > 0) {
    const pattern = `*${terms.slice(0, 2).join('*')}*`;
    const { data } = await supabase.from('sol_products')
      .select('*')
      .ilike('product_name', pattern)
      .eq('approved', true).limit(3);
    return { matches: data || [], method: 'fuzzy' };
  }

  return { matches: [], method: 'none' };
}

function formatProductContext(products) {
  const lines = ['KINDLY DATABASE DATA:'];
  for (const p of products) {
    lines.push(`\n- Product: ${p.product_name}`);
    if (p.ingredients) lines.push(`- Ingredients: ${p.ingredients}`);
    if (p.allergens)   lines.push(`- Allergens: ${p.allergens}`);
    if (p.impact_line) lines.push(`- Why it's kindly: ${p.impact_line}`);
  }
  return lines.join('\n');
}
