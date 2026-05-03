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
      stopDistPct, maxSafeStopPct
    } = req.body;

    // STRICT: require score >= 7 AND high confidence AND confirmed/near breakout
    const highScore = parseInt(score) >= 7;
    const patternHighConf = patternConfidence === 'high';
    const patternReady = patternStage === 'confirmed' || patternStage === 'near breakout';

    if (!highScore || !patternHighConf || !patternReady) {
      return res.status(200).json({
        sent: false,
        reason: `Score ${score}/10 (need 7+) | Pattern: ${patternConfidence}/${patternStage} (need high/confirmed or near breakout)`
      });
    }

    const lev = parseInt(leverage) || 1;
    const dec = price > 1000 ? 1 : price > 10 ? 2 : price > 1 ? 4 : 4;
    const fmt = n => n ? parseFloat(n).toLocaleString('en-US', {minimumFractionDigits: dec, maximumFractionDigits: dec}) : '—';
    const fmtPct = n => n ? parseFloat(n).toFixed(3) + '%' : '—';

    // Safety check for high leverage
    const stopPct = parseFloat(stopDistPct) || 0;
    const maxSafe = parseFloat(maxSafeStopPct) || 0;
    const stopSafe = stopPct < maxSafe || maxSafe === 0;
    const safetyWarning = !stopSafe && lev > 1
      ? `\n⛔ *STOP TOO WIDE FOR ${lev}x* — stop dist ${fmtPct(stopPct)} exceeds max safe ${fmtPct(maxSafe)} — reduce leverage or use pattern entry`
      : '';

    const biasEmoji = bias === 'long' ? '🟢' : bias === 'short' ? '🔴' : '🟡';
    const levTag = lev > 1 ? ` @ ${lev}x` : '';
    const convTag = conviction === 'high' ? '🔥 HIGH' : conviction === 'medium' ? '⚡ MEDIUM' : '📊 LOW';

    let msg = `${biasEmoji} *SIGNAL — ${coin}/USDT${levTag}*\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 Score: *${score}/10* | ${tf.toUpperCase()} | Conviction: ${convTag}\n`;
    msg += `💰 Price: *$${fmt(price)}*\n\n`;

    msg += `🔍 *Pattern: ${pattern}*\n`;
    msg += `Stage: ${patternStage} | Confidence: ${patternConfidence}`;
    if (winRate) msg += ` | Win rate: ${winRate}`;
    msg += `\n\n`;

    if (bias === 'long' || bias === 'neutral') {
      msg += `🟢 *LONG SETUP${levTag}*\n`;
      msg += `┌ Entry:  $${fmt(longEntry)}\n`;
      msg += `├ Stop:   $${fmt(longStop)} (-${fmtPct(stopPct)})\n`;
      msg += `├ TP1:    $${fmt(longTP1)}\n`;
      msg += `├ TP2:    $${fmt(longTP2)}\n`;
      if (liqLong && lev > 1) msg += `└ Liq:    $${fmt(liqLong)} ⚠\n`;
      msg += `Max safe stop @ ${lev}x: ${fmtPct(maxSafe)}\n`;
      msg += `Stop status: ${stopSafe ? '✅ Safe' : '❌ Beyond liq'}\n`;
      if (longMaxSafeLev) {
        const suit = lev <= parseInt(longMaxSafeLev) ? `✅ ${lev}x is safe (max ${longMaxSafeLev}x)` : `⛔ Too high — max safe leverage: ${longMaxSafeLev}x`;
        msg += `Leverage suitability: ${suit}\n`;
      }
      msg += safetyWarning + `\n`;
    }

    if (bias === 'short') {
      msg += `🔴 *SHORT SETUP${levTag}*\n`;
      msg += `┌ Entry:  $${fmt(shortEntry)}\n`;
      msg += `├ Stop:   $${fmt(shortStop)}\n`;
      msg += `├ TP1:    $${fmt(shortTP1)}\n`;
      msg += `├ TP2:    $${fmt(shortTP2)}\n`;
      if (liqShort && lev > 1) msg += `└ Liq:    $${fmt(liqShort)} ⚠\n`;
      msg += safetyWarning + `\n`;
    }

    msg += `📈 RSI: ${parseFloat(rsi).toFixed(1)} | ${trend} | Funding: ${parseFloat(funding).toFixed(4)}%\n`;
    msg += `😰 Fear & Greed: ${fgValue}\n\n`;

    if (watchLevel) msg += `👁 Watch: $${watchLevel}\n`;
    if (suggestedAction) msg += `⚡ ${suggestedAction}\n`;
    msg += `\n_Signal Scanner (Blofin) — Not financial advice_`;

    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true })
    });
    const d = await r.json();
    if (!d.ok) return res.status(500).json({ error: 'TG error', details: d });
    return res.status(200).json({ sent: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
