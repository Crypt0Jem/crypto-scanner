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
      entryMode, mode, mtfSummary, liqZones, cvdSummary, candles
    } = req.body;

    const candleStr = candles && candles.length
      ? candles.slice(-50).map((c, i) =>
          `${i+1}. O:${c.o} H:${c.h} L:${c.l} C:${c.c} V:${Math.round(c.v)}`
        ).join('\n')
      : 'No candle data';

    let liqStr = '';
    if (liqZones) {
      const lse = liqZones.longSweepEntry;
      const sse = liqZones.shortSweepEntry;
      liqStr = `
## Estimated Liquidation Zones & Sweep Entries
Market bias: ${liqZones.fundingBias}
Long liq cluster (10x-50x longs): ${liqZones.majorLongCluster}
Short liq cluster (10x-50x shorts): ${liqZones.majorShortCluster}
Nearest long sweep target: $${liqZones.nearestLongSweep} (125x longs)
Nearest short squeeze target: $${liqZones.nearestShortSweep} (125x shorts)

## Liquidity Sweep Entry Setups
LONG SWEEP ENTRY (enter after long liq zone is swept):
  Entry: $${lse?.entry} | Stop: $${lse?.stop} | TP1: $${lse?.tp1} | TP2: $${lse?.tp2} | TP3: $${lse?.tp3}
  Logic: ${lse?.logic}

SHORT SWEEP ENTRY (enter after short liq zone is squeezed):
  Entry: $${sse?.entry} | Stop: $${sse?.stop} | TP1: $${sse?.tp1} | TP2: $${sse?.tp2} | TP3: $${sse?.tp3}
  Logic: ${sse?.logic}
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

    let cvdStr = '';
    if (cvdSummary) {
      const divLine = cvdSummary.divergence
        ? `DIVERGENCE DETECTED: ${cvdSummary.divergence}\n  Detail: ${cvdSummary.divergenceDesc}\n  Type: ${cvdSummary.divergenceType} -- price and order flow moving in opposite directions`
        : 'No divergence -- price and order flow are aligned';
      cvdStr = `
## Order Flow -- CVD (Cumulative Volume Delta)
CVD trend: ${cvdSummary.trend} (${cvdSummary.recentBias})
CVD direction last 20 bars: ${cvdSummary.cvdDirection}
${divLine}

CVD measures real buying vs selling pressure beyond what price shows:
- Rising CVD = net buying pressure accumulating, supports long bias
- Falling CVD = net selling pressure accumulating, supports short bias
- CVD divergence from price = early reversal warning -- weight this heavily
`;
    }

    const modeContext = mode === 'swing'
      ? 'SWING TRADE setup. Weekly trend is the dominant filter. Focus on multi-day to multi-week holds. Entries at key Daily/4H levels with 1H confirmation.'
      : 'SCALP TRADE setup. 4H trend is the dominant filter. Focus on 15min to 4-hour holds. Tight entries with 5M/15M confirmation.';

    const prompt = `You are an expert crypto trading analyst. Analyze this setup and respond in raw JSON only.

## Trade Mode
${modeContext}

## Market Data
Coin: ${coin} | Timeframe: ${tf} | Price: $${price} | 24h: ${change24h}%
RSI(14): ${rsi} | EMA trend: ${trend} | Funding: ${funding}% | Fear&Greed: ${fgValue}
ATR: $${atr} | OI: $${oi}B | Support: $${support} | Resistance: $${resistance}
Optimal long entry: $${optimalLongEntry} | Optimal short entry: $${optimalShortEntry}
${mtfStr}${cvdStr}${liqStr}
## Last 50 ${tf} Candles (OHLCV) -- oldest to newest:
${candleStr}

## Instructions
1. Analyze candle structure for chart patterns
2. Weight higher timeframes more for swing, lower for scalp
3. Flag counter-trend setups clearly and reduce conviction
4. Factor liquidation zones into entries/targets
5. IMPORTANT: Weight CVD heavily -- divergence lowers conviction for the price trend; confirmation raises it
6. Factor position size multiplier from MTF into recommendation

Respond ONLY with this JSON (no markdown, no explanation):
{
  "conviction": "high|medium|low",
  "bias": "long|short|neutral",
  "summary": "2-3 sentences combining pattern + MTF confluence + CVD order flow",
  "mtfVerdict": "1 sentence on what the MTF stack says overall",
  "counterTrend": true or false,
  "counterTrendWarning": "if counter-trend explain risk in 1 sentence, else null",
  "pattern": {
    "name": "pattern name",
    "stage": "forming|near breakout|confirmed|failed|none",
    "confidence": "high|medium|low",
    "description": "1-2 sentences on candle structure",
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
    "entryRationale": "1 sentence -- why this entry based on pattern + MTF + CVD"
  },
  "longCase": "bull case incorporating MTF and CVD order flow",
  "shortCase": "bear case incorporating MTF and CVD order flow",
  "keyRisk": "biggest risk considering MTF and order flow",
  "watchLevel": "specific price to watch for confirmation",
  "suggestedAction": "precise action with timeframe e.g. wait for 1H close above X then enter targeting Y",
  "historicalPattern": "what this pattern + MTF + CVD setup historically leads to",
  "positionSizeNote": "position size recommendation based on MTF alignment and CVD confirmation"
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
