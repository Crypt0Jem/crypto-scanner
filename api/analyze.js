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
      coin, tf, price, change24h, high24h, low24h, volume24h,
      rsi, trend, funding, fgValue, atr, oi,
      support, resistance, poc, ema20,
      optimalLongEntry, optimalShortEntry, entryMode, mode,
      leverage, liqLong, liqShort, maxSafeStopPct,
      longStopPct, shortStopPct,
      signalDir, score, scoreLong, scoreShort,
      scoreBreakdown, bonusCount, bonusSignals,
      oiDelta, fundingDelta, oiMomentum,
      summaryCard, mtfSummary, liqZones, cvdSummary, candles
    } = req.body;

    // ── Candles ────────────────────────────────────────────────────────────
    const candleStr = candles && candles.length
      ? candles.slice(-50).map((c, i) =>
          `${i+1}. O:${c.o} H:${c.h} L:${c.l} C:${c.c} V:${Math.round(c.v)}`
        ).join('\n')
      : 'No candle data';

    // ── Leverage section ───────────────────────────────────────────────────
    const levStr = `
## LEVERAGE & RISK PARAMETERS ⚠ (read before placing any stops)
Selected leverage: ${leverage}x
Max safe stop loss: ${maxSafeStopPct ? parseFloat(maxSafeStopPct).toFixed(3) : '?'}% from entry — HARD LIMIT, do not exceed
Long liquidation price: $${liqLong || '?'}
Short liquidation price: $${liqShort || '?'}
Current long stop distance: ${longStopPct ? parseFloat(longStopPct).toFixed(3) : '?'}%
Current short stop distance: ${shortStopPct ? parseFloat(shortStopPct).toFixed(3) : '?'}%
ALL stop losses in patternEntry MUST be within ${maxSafeStopPct ? parseFloat(maxSafeStopPct).toFixed(3) : '?'}% of entry at ${leverage}x leverage.`;

    // ── Summary card context ───────────────────────────────────────────────
    const sumStr = summaryCard ? `
## PRE-ANALYZED SETUP (scanner output — use as context)
Primary signal: ${summaryCard.direction} | Score: ${score}/10
Directional scores: LONG ${scoreLong||'?'}/10 vs SHORT ${scoreShort||'?'}/10 — use the higher score direction
Bonuses active: ${bonusCount}/7
Scanner status: ${summaryCard.status}
Confirmed factors: ${(summaryCard.working||[]).join(' | ') || 'none'}
Missing/weak: ${(summaryCard.missing||[]).join(' | ') || 'none'}
${summaryCard.atKeyLevel ? `Price IS at key level: $${summaryCard.atKeyLevel.val} (${summaryCard.atKeyLevel.label})` : ''}
${summaryCard.waitLevel ? `Suggested entry zone: $${summaryCard.waitLevel.val} (${summaryCard.waitLevel.label})` : ''}` : '';

    // ── Score breakdown ────────────────────────────────────────────────────
    const bdStr = scoreBreakdown ? `
## SIGNAL SCORE BREAKDOWN (${score}/10)
Liq zone proximity: ${scoreBreakdown.liq}/3 | CVD: ${scoreBreakdown.cvd}/3 | MTF confluence: ${scoreBreakdown.mtf}/3
Volume spike: ${scoreBreakdown.vol}/2 | Session quality: ${scoreBreakdown.session} | RSI extreme: ${scoreBreakdown.rsi}
Bonus signals (capped at 3): ${scoreBreakdown.bonusRaw} raw → ${scoreBreakdown.bonusCapped} applied` : '';

    // ── Bonus signals ──────────────────────────────────────────────────────
    const bonusStr = bonusSignals ? `
## ACTIVE BONUS SIGNALS (${bonusCount}/7)
BB squeeze breakout: ${bonusSignals.bbSqueeze ? 'YES ✓' : 'no'}
VWAP reclaim: ${bonusSignals.vwapReclaim ? 'YES ✓' : 'no'}
Structure break (BOS): ${bonusSignals.bos ? `YES ✓ (${bonusSignals.bosType||''})` : 'no'}
RSI divergence: ${bonusSignals.rsiDiv ? `YES ✓ (${bonusSignals.rsiDivLabel||''})` : 'no'}
POC proximity: ${bonusSignals.poc ? 'YES ✓' : 'no'}
OI expanding in signal direction: ${bonusSignals.oiDelta ? 'YES ✓' : 'no'}
Funding flip/acceleration: ${bonusSignals.fundingFlip ? 'YES ✓' : 'no'}` : '';

    // ── OI & funding ───────────────────────────────────────────────────────
    const oiStr = `
## OPEN INTEREST & FUNDING
OI trend: ${oiMomentum?.trend||'unknown'} (${oiMomentum?.changePct||0}% change)${oiMomentum?.spike ? ' ⚠ SPIKE — forced liquidations likely' : ''}
OI delta direction: ${oiDelta?.bullishConfirm ? 'Bullish confirmed — new longs entering' : oiDelta?.bearishConfirm ? 'Bearish confirmed — new shorts entering' : oiDelta?.expanding ? 'Expanding (direction unclear)' : 'Contracting or flat'} (${oiDelta?.changePct||0}% over 5 periods)
Funding rate: ${funding}% | Direction: ${fundingDelta?.direction||'neutral'}
Funding momentum: ${fundingDelta?.flipping ? '⚡ FLIPPING — high significance event' : fundingDelta?.accelerating ? 'Accelerating' : 'Stable'}${fundingDelta?.extreme ? ' ⚠ EXTREME FUNDING' : ''}`;

    // ── MTF ────────────────────────────────────────────────────────────────
    let mtfStr = '';
    if (mtfSummary) {
      const tfLines = mtfSummary.labels.map((lbl, i) => {
        const tfKey = Object.keys(mtfSummary.trendByTF)[i];
        return `  ${lbl}: ${mtfSummary.trendByTF[tfKey]||'unknown'}`;
      }).join('\n');
      mtfStr = `
## MULTI-TIMEFRAME ANALYSIS
Confluence: ${mtfSummary.confluenceLabel}
${tfLines}
Filter: ${mtfSummary.filterStatus} — ${mtfSummary.filterMsg}
Position size multiplier: ${(mtfSummary.positionSizeMultiplier*100).toFixed(0)}%`;
    }

    // ── CVD ────────────────────────────────────────────────────────────────
    let cvdStr = '';
    if (cvdSummary) {
      cvdStr = `
## ORDER FLOW (CVD)
CVD trend: ${cvdSummary.trend} (${cvdSummary.recentBias})
${cvdSummary.divergence ? `⚠ DIVERGENCE: ${cvdSummary.divergence} — ${cvdSummary.divergenceDesc}` : 'No divergence — price and order flow aligned'}`;
    }

    // ── Liq zones ──────────────────────────────────────────────────────────
    let liqStr = '';
    if (liqZones) {
      const lse = liqZones.longSweepEntry;
      const sse = liqZones.shortSweepEntry;
      liqStr = `
## LIQUIDATION ZONES
Bias: ${liqZones.fundingBias}
Long liq cluster: ${liqZones.majorLongCluster} | Short liq cluster: ${liqZones.majorShortCluster}
Nearest long sweep: $${liqZones.nearestLongSweep} | Nearest short squeeze: $${liqZones.nearestShortSweep}
Long sweep entry: $${lse?.entry} → TP1:$${lse?.tp1} TP2:$${lse?.tp2} Stop:$${lse?.stop}
Short sweep entry: $${sse?.entry} → TP1:$${sse?.tp1} TP2:$${sse?.tp2} Stop:$${sse?.stop}`;
    }

    const modeCtx = mode === 'swing'
      ? 'SWING TRADE — multi-day holds, entries at Daily/4H levels, 1H confirmation'
      : 'SCALP TRADE — hours-long holds, tight entries, 5M/15M confirmation';

    const prompt = `You are an expert crypto leverage trader. The scanner has pre-analyzed this setup. Give ONE precise, actionable entry decision.

## TRADE MODE
${modeCtx}

## MARKET DATA
${coin} | ${tf} | Price: $${price} | 24h: ${change24h}% | High: $${high24h} | Low: $${low24h}
RSI: ${rsi} | Trend: ${trend} | ATR: $${atr} | OI: $${oi}B
Support: $${support} | Resistance: $${resistance} | POC: $${poc||'?'} | EMA20: $${ema20||'?'}
Funding: ${funding}% | Fear&Greed: ${fgValue}
${levStr}
${sumStr}
${bdStr}
${bonusStr}
${oiStr}
${mtfStr}
${cvdStr}
${liqStr}

## LAST 50 ${tf} CANDLES (oldest→newest):
${candleStr}

## INSTRUCTIONS
1. Your primary output is entryDecision — ONE clear recommendation
2. Stop loss MUST be within ${maxSafeStopPct ? parseFloat(maxSafeStopPct).toFixed(3) : '?'}% of entry (${leverage}x leverage hard limit)
3. Use scanner's pre-analyzed context — don't re-derive what's already computed
4. Flag counter-trend setups, reduce conviction accordingly
5. Weight CVD divergence heavily — it overrides price trend signals
6. Give exact prices to match coin's precision (${price} decimals as reference)
7. entryTrigger must be a specific, testable condition — not vague

Respond ONLY in raw JSON:
{
  "entryDecision": {
    "action": "ENTER_NOW|WAIT|AVOID",
    "direction": "long|short|neutral",
    "entryPrice": price,
    "entryTrigger": "exact condition e.g. '4H close above $X with volume >2x'",
    "stopLoss": price,
    "stopRationale": "why this stop — structure level + distance % at ${leverage}x",
    "tp1": price,
    "tp2": price,
    "riskReward": "X:1",
    "leverageNote": "is ${leverage}x safe for this stop, or suggest lower"
  },
  "conviction": "high|medium|low",
  "bias": "long|short|neutral",
  "summary": "2-3 sentences: pattern + MTF + CVD + OI combined",
  "mtfVerdict": "1 sentence on MTF stack",
  "counterTrend": true,
  "counterTrendWarning": "string or null",
  "pattern": {
    "name": "pattern name",
    "stage": "forming|near breakout|confirmed|failed|none",
    "confidence": "high|medium|low",
    "description": "1-2 sentences on candle structure",
    "historicalWinRate": "X%",
    "patternTarget": price,
    "patternInvalidation": price
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
    "entryRationale": "1 sentence — pattern + MTF + CVD rationale"
  },
  "longCase": "bull case with MTF + CVD + OI context",
  "shortCase": "bear case with MTF + CVD + OI context",
  "keyRisk": "biggest risk for this setup at ${leverage}x",
  "watchLevel": "price to watch for confirmation",
  "suggestedAction": "precise next action with timeframe",
  "historicalPattern": "what this combined setup historically leads to",
  "positionSizeNote": "size recommendation given ${leverage}x and MTF alignment"
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
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text = (data.content||[]).map(b=>b.text||'').join('').trim();
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1) return res.status(500).json({ error: 'No JSON in response' });

    const parsed = JSON.parse(text.substring(start, end+1));
    return res.status(200).json(parsed);

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
