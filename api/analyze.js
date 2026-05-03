export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { coin, price, rsi, trend, funding, fgValue, change24h, atr, oi, support, resistance, tf } = req.body;

    const prompt = `You are a professional crypto trading analyst. Analyze this setup and respond in JSON only.

Coin: ${coin}
Timeframe: ${tf}
Current price: $${price}
24h change: ${change24h}%
RSI (14): ${rsi}
Trend (EMA structure): ${trend}
Funding rate: ${funding}%
Open Interest: $${oi}B
Fear & Greed index: ${fgValue}
ATR: $${atr}
Key support: $${support}
Key resistance: $${resistance}

Return ONLY this JSON structure (no markdown, no explanation):
{
  "conviction": "high" | "medium" | "low",
  "bias": "long" | "short" | "neutral",
  "summary": "2-3 sentence analysis of current setup",
  "longCase": "1-2 sentence bull case",
  "shortCase": "1-2 sentence bear case",
  "keyRisk": "single biggest risk to watch",
  "historicalPattern": "what this setup historically leads to in 1-3 sentences",
  "suggestedAction": "specific actionable guidance in 1 sentence"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
