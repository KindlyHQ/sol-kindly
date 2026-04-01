export default async function handler(req, res) {
  // 1. Only allow POST requests from your chatbot
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 2. Check if the API Key exists in Vercel environment variables
  if (!process.env.CLAUDE_API_KEY) {
    return res.status(500).json({ error: 'API Key missing in Vercel settings.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.body.model || 'claude-3-5-sonnet-20240620',
        max_tokens: req.body.max_tokens || 1024,
        system: req.body.system,
        messages: req.body.messages
      })
    });

    const data = await response.json();

    // 3. Handle errors from Anthropic (e.g., invalid key or quota)
    if (!response.ok) {
      console.error('Anthropic API Error:', data);
      return res.status(response.status).json(data);
    }

    // 4. Send the successful response back to your website
    return res.status(200).json(data);

  } catch (error) {
    console.error('Serverless Function Error:', error);
    return res.status(500).json({ error: 'Failed to communicate with Claude' });
  }
}
