export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return res.status(500).json({ error: 'Telegram credentials not configured' });

  try {
    const {
      coin, tf, price, score, bias, conviction,
      pattern, patternStage, patternConfidence, winRate,
      longEntry, longStop, longTP1, longTP2,
      shortEntry, shortStop, shortTP1, shortTP2,
      rsi, trend, funding, fgValue, leverage,
      liqLong, liqShort, suggestedAction, watchLevel,
      stopDistPct, maxSafeStopPct, longMaxSafeLev, shortMaxSafeLev
    } = req.body;

    // Evaluate confluences for each direction independently
    const patternHighConf = patternConfidence === 'high';
    const patternReady    = patternStage === 'confirmed' || patternStage === 'near breakout';
    const patternOk       = patternHighConf && patternReady;
    const highScore       = parseInt(score) >= 7;

    // Long confluences: high score + pattern confirmed + AI bias long/neutral
    const longConfluence  = highScore && patternOk && (bias === 'long' || bias === 'neutral');
    // Short confluences: high score + pattern confirmed + AI bias short
    // OR: score >= 5 + pattern confirmed + AI bias short + funding high (overleveraged longs)
    const shortConfluence = patternOk && (
      (highScore && bias === 'short') ||
      (parseInt(score) >= 5 && bias === 'short' && parseFloat(funding) > 0.03)
    );

    if (!longConfluence && !shortConfluence) {
      return res.status(200).json({
        sent: false,
        reason: `No confluence: score ${score}/10, bias ${bias}, pattern ${patternConfidence}/${patternStage}`
      });
    }

    // Tag which direction is the primary signal
    const primaryBias = longConfluence && !shortConfluence ? 'long'
      : shortConfluence && !longConfluence ? 'short'
      : bias; // both aligned — use AI bias

    const lev = parseInt(leverage) || 1;
    const dec = price > 1000 ? 1 : price > 10 ? 2 : price > 1 ? 4 : 4;
    const fmt = n => n ? parseFloat(n).toLocaleString('en-US', {minimumFractionDigits: dec, maximumFractionDigits: dec}) : '—';
    const fmtPct = n => n ? parseFloat(n).toFixed(3) + '%' : '—';

    // Leverage suitability helper
    function suitLabel(selectedLev, maxSafe) {
      if (!maxSafe) return '';
      return selectedLev <= parseInt(maxSafe)
        ? `✅ ${selectedLev}x safe (max ${maxSafe}x)`
        : `⛔ Too high — max safe: ${maxSafe}x`;
    }

    // Long stop safety
    const longStopDist = parseFloat(stopDistPct) || 0;
    const longMaxSafe  = parseFloat(maxSafeStopPct) || 0;
    const longStopSafe = longStopDist < longMaxSafe || longMaxSafe === 0;

    // Short stop safety
    const shortStopDist = shortEntry && shortStop
      ? Math.abs(parseFloat(shortEntry) - parseFloat(shortStop)) / parseFloat(shortEntry) * 100
      : 0;
    const shortMaxSafeStop = shortMaxSafeLev
      ? (() => { const m=lev>=100?0.005:lev>=25?0.004:0.003; return((1/lev)-m)*0.6*100; })()
      : 0;
    const shortStopSafe = shortStopDist < shortMaxSafeStop || shortMaxSafeStop === 0;

    const biasEmoji = primaryBias === 'long' ? '🟢' : primaryBias === 'short' ? '🔴' : '🟡';
    const convTag = conviction === 'high' ? '🔥 HIGH' : conviction === 'medium' ? '⚡ MED' : '📊 LOW';
    const levTag = lev > 1 ? ` @ ${lev}x` : '';

    let msg = `${biasEmoji} *SIGNAL — ${coin}/USDT${levTag}*\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 Score: *${score}/10* | ${tf.toUpperCase()} | Conviction: ${convTag}\n`;
    msg += `💰 Price: *$${fmt(price)}*\n`;
    msg += `🤖 Signal: *${primaryBias.toUpperCase()}* ${primaryBias==='long'?'🟢':'🔴'} — ${
      longConfluence && shortConfluence ? 'both setups aligned' :
      longConfluence ? 'long confluences met' : 'short confluences met'
    }\n\n`;

    if (pattern && pattern !== 'None') {
      msg += `🔍 *Pattern: ${pattern}*\n`;
      msg += `Stage: ${patternStage} | Confidence: ${patternConfidence}`;
      if (winRate) msg += ` | Win rate: ${winRate}`;
      msg += `\n\n`;
    }

    // ── LONG SETUP (always shown) ──────────────────────────
    msg += `🟢 *LONG SETUP${levTag}*${longConfluence ? ' ✅ CONFLUENCES MET' : ''}\n`;
    msg += `┌ Entry:  $${fmt(longEntry)}\n`;
    msg += `├ Stop:   $${fmt(longStop)} (-${fmtPct(longStopDist)})\n`;
    msg += `├ TP1:    $${fmt(longTP1)}\n`;
    msg += `├ TP2:    $${fmt(longTP2)}\n`;
    if (liqLong && lev > 1) {
      msg += `├ Liq:    $${fmt(liqLong)}\n`;
    }
    if (lev > 1) {
      msg += `└ ${suitLabel(lev, longMaxSafeLev)}\n`;
      if (!longStopSafe) msg += `  ⛔ Stop wider than safe — use max ${longMaxSafeLev}x\n`;
    }
    msg += `\n`;

    // ── SHORT SETUP (always shown) ─────────────────────────
    msg += `🔴 *SHORT SETUP${levTag}*${shortConfluence ? ' ✅ CONFLUENCES MET' : ''}\n`;
    msg += `┌ Entry:  $${fmt(shortEntry)}\n`;
    msg += `├ Stop:   $${fmt(shortStop)} (+${fmtPct(shortStopDist)})\n`;
    msg += `├ TP1:    $${fmt(shortTP1)}\n`;
    msg += `├ TP2:    $${fmt(shortTP2)}\n`;
    if (liqShort && lev > 1) {
      msg += `├ Liq:    $${fmt(liqShort)}\n`;
    }
    if (lev > 1) {
      msg += `└ ${suitLabel(lev, shortMaxSafeLev)}\n`;
      if (!shortStopSafe) msg += `  ⛔ Stop wider than safe — use max ${shortMaxSafeLev}x\n`;
    }
    msg += `\n`;

    // ── INDICATORS ─────────────────────────────────────────
    msg += `📈 *Indicators*\n`;
    msg += `RSI: ${parseFloat(rsi).toFixed(1)} | Trend: ${trend} | Funding: ${parseFloat(funding).toFixed(4)}%\n`;
    msg += `Fear & Greed: ${fgValue}\n\n`;

    if (watchLevel) msg += `👁 Watch: $${watchLevel}\n`;
    if (suggestedAction) msg += `⚡ ${suggestedAction}\n`;

    msg += `\n_Signal Scanner (Blofin) — Not financial advice_`;

    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });

    const d = await r.json();
    if (!d.ok) return res.status(500).json({ error: 'TG error', details: d });
    return res.status(200).json({ sent: true, messageId: d.result?.message_id });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
