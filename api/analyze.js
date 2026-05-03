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
      entryMode, mode, mtfSummary, liqZones, candles
    } = req.body;

    // Format candles
    const candleStr = candles && candles.length
      ? candles.slice(-50).map((c, i) =>
          `${i+1}. O:${c.o} H:${c.h} L:${c.l} C:${c.c} V:${Math.round(c.v)}`
        ).join('\n')
      : 'No candle data';

    // Format MTF summary
    let liqStr = '';
    if (liqZones) {
      liqStr = `
## Estimated Liquidation Zones
Market bias: ${liqZones.fundingBias}
Long liquidation cluster (10x-50x longs get wiped): ${liqZones.majorLongCluster}
Short liquidation cluster (10x-50x shorts get wiped): ${liqZones.majorShortCluster}
Nearest long sweep target: $${liqZones.nearestLongSweep} (125x longs)
Nearest short squeeze target: $${liqZones.nearestShortSweep} (125x shorts)
High-significance long liq levels: $${liqZones.topLongLiq}
High-significance short liq levels: $${liqZones.topShortLiq}

Use this data to:
1. Identify likely liquidity sweep targets before real moves
2. Avoid placing stops at obvious liquidation levels
3. Target entries near major liq clusters (price magnets)
4. Flag if current price is near a major cluster (reversal risk)
`;
    }

    let mtfStr = '';
    if (mtfSummary) {
      const tfLines = mtfSummary.labels.map((lbl, i) => {
        const tfKey = Object.keys(mtfSummary.trendByTF)[i];
        return `  ${lbl}: ${mtfSummary.trendByTF[tfKey] || 'unknown'}`;
      }).join('\n');
      mtfStr = `
## Multi-Timeframe Analysis (${mode === 'swing' ? 'SWING' : 'SCALP'} MODE)
Confluence: ${mtfSummary.confluenceLabel}
${tfLines}
Filter status: ${mtfSummary.filterStatus}
${mtfSummary.filterMsg}
Position size multiplier: ${(mtfSummary.positionSizeMultiplier * 100).toFixed(0)}%
`;
    }

    const modeContext = mode === 'swing'
      ? 'This is a SWING TRADE setup. Weekly trend is the dominant filter. Focus on multi-day to multi-week holds. Entries should be at key Daily/4H levels with 1H confirmation.'
      : 'This is a SCALP TRADE setup. 4H trend is the dominant filter. Focus on 15min to 4-hour holds. Entries should be tight with 5M/15M confirmation.';

    const prompt = `You are an expert crypto trading analyst specializing in ${mode === 'swing' ? 'swing' : 'scalp'} trading with high leverage. Analyze this setup and respond in raw JSON only.

## Trade Mode
${modeContext}

## Market Context
Coin: ${coin} | Timeframe: ${tf} | Price: $${price} | 24h: ${change24h}%
RSI(14): ${rsi} | EMA trend: ${trend} | Funding: ${funding}% | Fear&Greed: ${fgValue}
ATR: $${atr} | OI: $${oi}B | Support: $${support} | Resistance: $${resistance}
Optimal long entry: $${optimalLongEntry} | Optimal short entry: $${optimalShortEntry}
${mtfStr}${liqStr}

## Last 50 ${tf} Candles (OHLCV) — oldest to newest:
${candleStr}

## Instructions
1. Analyze candle structure for chart patterns
2. Consider ALL timeframe data — weight higher timeframes more heavily for swing, lower for scalp
3. If MTF shows counter-trend warning, reduce conviction and flag it clearly
4. Factor liquidation zones into entry/target recommendations — note if price is near a liq cluster
5. Mention the nearest sweep target in your suggested action if relevant
4. For swing mode: identify multi-day pattern, key daily levels, 1H entry trigger
5. For scalp mode: identify micro pattern, tight entry, quick targets
6. Factor the position size multiplier from MTF into your recommendation

Respond ONLY with this JSON (no markdown, no explanation):
{
  "conviction": "high|medium|low",
  "bias": "long|short|neutral",
  "summary": "2-3 sentences combining pattern + MTF confluence",
  "mtfVerdict": "1 sentence on what the MTF stack says overall",
  "counterTrend": true or false,
  "counterTrendWarning": "if counter-trend, explain risk in 1 sentence, else null",
  "pattern": {
    "name": "pattern name",
    "stage": "forming|near breakout|confirmed|failed|none",
    "confidence": "high|medium|low",
    "description": "1-2 sentences on what you see in candles",
    "historicalWinRate": "approximate % for this pattern",
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
    "entryRationale": "1 sentence — why this entry based on pattern + MTF"
  },
  "longCase": "bull case incorporating MTF alignment",
  "shortCase": "bear case incorporating MTF alignment",
  "keyRisk": "biggest risk considering MTF",
  "watchLevel": "specific price to watch for confirmation",
  "suggestedAction": "precise action with timeframe context e.g. wait for 1H close above X then enter targeting Y",
  "historicalPattern": "what this pattern + MTF setup historically leads to",
  "positionSizeNote": "recommendation on position size based on MTF alignment"
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
        max_tokens: 1400,
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
