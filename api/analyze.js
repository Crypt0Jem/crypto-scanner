export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const {
      coin, tf, price, change24h, rsi, trend, funding, fgValue,
      atr, oi, support, resistance, optimalLongEntry, optimalShortEntry,
      entryMode, candles
    } = req.body;

    // Format candles as compact OHLCV string for pattern analysis
    const candleStr = candles && candles.length
      ? candles.slice(-50).map((c, i) =>
          `${i + 1}. O:${c.o} H:${c.h} L:${c.l} C:${c.c} V:${Math.round(c.v)}`
        ).join('\n')
      : 'No candle data provided';

    const prompt = `You are an expert crypto chart analyst and trading strategist. Analyze the following ${tf} candle data and market context for ${coin}, then provide a comprehensive trading analysis.

## Market Context
Coin: ${coin} | Timeframe: ${tf}
Current price: $${price} | 24h change: ${change24h}%
RSI(14): ${rsi} | EMA trend: ${trend}
Funding rate: ${funding}% | Fear & Greed: ${fgValue}
ATR: $${atr} | OI: $${oi}B
Support: $${support} | Resistance: $${resistance}
Optimal long entry: $${optimalLongEntry} | Optimal short entry: $${optimalShortEntry}

## Last 50 ${tf} Candles (OHLCV) — most recent is last:
${candleStr}

## Your Task
1. Analyze the candle sequence to identify chart patterns (flags, wedges, triangles, H&S, double top/bottom, engulfing, doji, hammer, cup and handle, etc.)
2. Determine the current pattern stage (forming, near breakout, confirmed breakout, failed)
3. Use pattern structure to calculate precise entries, stops, and targets
4. Cross-reference with RSI, funding, OI for confluence

Respond with ONLY this JSON (no markdown, no explanation):
{
  "conviction": "high|medium|low",
  "bias": "long|short|neutral",
  "summary": "2-3 sentence overall market read combining pattern + indicators",
  "pattern": {
    "name": "exact pattern name e.g. Bull Flag, Ascending Triangle, Double Bottom",
    "stage": "forming|near breakout|confirmed|failed|none",
    "confidence": "high|medium|low",
    "description": "1-2 sentences describing what you see in the candles",
    "historicalWinRate": "approximate win rate % for this pattern e.g. 65%",
    "patternTarget": price or null,
    "patternInvalidation": price or null
  },
  "patternEntry": {
    "longEntry": price,
    "longStop": price,
    "longTP1": price,
    "longTP2": price,
    "shortEntry": price,
    "shortStop": price,
    "shortTP1": price,
    "shortTP2": price,
    "entryRationale": "1 sentence explaining why this entry based on pattern"
  },
  "longCase": "bull case based on pattern + indicators",
  "shortCase": "bear case based on pattern + indicators",
  "keyRisk": "biggest risk to the trade",
  "watchLevel": "specific price level to watch for confirmation",
  "suggestedAction": "precise actionable instruction e.g. wait for close above X then enter long targeting Y with stop at Z",
  "historicalPattern": "what this pattern typically leads to based on historical crypto data"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text = (data.content || []).map(b => b.text || '').join('').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1) return res.status(500).json({ error: 'No JSON in response' });

    const parsed = JSON.parse(text.substring(start, end + 1));
    return res.status(200).json(parsed);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
