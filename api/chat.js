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
    const { messages, system, max_tokens } = req.body;
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
    const { matches } = await lookupProducts(customerQuestion, supabase);

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
    const finalSystem = `${system}

${foundInDb ? productContext : "Note: No specific database match found for this query."}

CRITICAL: If the user asks about Loyalty, use this EXACT text:
Every shop at Kindly is a vote for a plastic-free future—why not get rewarded for it? 🌍

Join our community and turn your planet-positive choices into treats. **Every £1 you spend earns you 1 point.** Check out the rewards:
• **250 points** = **£5 OFF** your shop
• **500 points** = **£10 OFF** your shop

Sign up takes just 30 seconds at the till, or you can **[click here to join the revolution and start earning now!](https://start.mylty.co/?id=21913)**. Ready to make your shop count?

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
        model: "claude-haiku-4-5-20251001",
        max_tokens: max_tokens || 400,
        system: finalSystem,
        messages: messages // The frontend now passes correctly labeled images
      })
    });

    // We name the response variable 'claudeData' to avoid conflict with 'data'
    const claudeData = await response.json();

    if (claudeData.error) {
      console.error('Claude API Error:', claudeData.error);
      return res.status(500).json({ error: claudeData.error.message });
    }

    // 5. LOG TO SUPABASE
    const solAnswer = claudeData.content?.[0]?.text || '';
    // Note: Use .then() or await so the function doesn't close before logging
    await supabase.from('sol_question_log').insert([{
      question: customerQuestion,
      answer: solAnswer,
      had_image: hadImage,
      asked_at: new Date().toISOString()
    }]);

    return res.status(200).json(claudeData);

  } catch (err) {
    console.error('Vercel Handler Error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

// ── Search Strategy ──────────────────────────────────────────────────
async function lookupProducts(text, supabase) {
  if (!text || text.length < 3) return { matches: [], method: 'none' };

  const codeMatch = text.match(/\b(\d{4})\b/);
  if (codeMatch) {
    const code = codeMatch[1];
    const { data } = await supabase.from('sol_products')
      .select('product_name, brand, ingredients, allergens, impact_line')
      .or(`epos_id.eq.${code},infinity_sku.eq.${code}`)
      .eq('approved', true).limit(1);
    if (data?.length > 0) return { matches: data, method: 'code' };
  }

  const { data: phraseData } = await supabase.from('sol_products')
    .select('product_name, brand, ingredients, allergens, impact_line')
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
