export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured on server' });

  try {
    const { coin, price, rsi, trend, funding, fgValue, change24h, atr, oi, support, resistance, tf, entryMode, optimalLongEntry, optimalShortEntry } = req.body;

    const prompt = `You are a professional crypto trading analyst. Respond in raw JSON only, no markdown, no code blocks.

Coin: ${coin}, Timeframe: ${tf}, Price: $${price}, 24h: ${change24h}%, RSI: ${rsi}, Trend: ${trend}, Funding: ${funding}%, OI: $${oi}B, Fear&Greed: ${fgValue}, ATR: $${atr}, Support: $${support}, Resistance: $${resistance}

Return ONLY this JSON:
{"conviction":"high","bias":"long","summary":"your summary","longCase":"bull case","shortCase":"bear case","keyRisk":"key risk","historicalPattern":"pattern","suggestedAction":"action"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text = (data.content || []).map(b => b.text || '').join('').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return res.status(500).json({ error: 'No JSON in response' });

    const parsed = JSON.
