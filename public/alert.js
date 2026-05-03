export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return res.status(500).json({ error: 'Telegram credentials not configured' });
  }

  try {
    const {
      coin, tf, price, score, signal, bias, conviction,
      pattern, patternStage, patternConfidence, winRate,
      longEntry, longStop, longTP1, longTP2, longRR,
      shortEntry, shortStop, shortTP1, shortTP2, shortRR,
      rsi, trend, funding, fgValue, leverage,
      liqPrice, suggestedAction, watchLevel
    } = req.body;

    // Only send if all three signals align
    const highScore = score >= 7;
    const patternConfirmed = patternConfidence === 'high' || patternStage === 'confirmed' || patternStage === 'near breakout';
    const priceAtEntry = Math.abs(price - longEntry) / price < 0.015; // within 1.5% of entry

    if (!highScore && !patternConfirmed) {
      return res.status(200).json({ sent: false, reason: 'Signals not aligned yet' });
    }

    const biasEmoji = bias === 'long' ? '🟢' : bias === 'short' ? '🔴' : '🟡';
    const convEmoji = conviction === 'high' ? '🔥' : conviction === 'medium' ? '⚡' : '📊';
    const levText = leverage && leverage > 1 ? ` @ ${leverage}x` : '';

    let message = `${biasEmoji} *SIGNAL ALERT — ${coin}/USDT* ${convEmoji}\n`;
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 Score: *${score}/10* | TF: ${tf.toUpperCase()} | Bias: ${(bias||'').toUpperCase()}\n`;
    message += `💰 Price: *$${parseFloat(price).toLocaleString()}*\n\n`;

    if (pattern && pattern !== 'No clear pattern') {
      message += `🔍 *Pattern: ${pattern}*\n`;
      message += `Stage: ${patternStage} | Confidence: ${patternConfidence}`;
      if (winRate) message += ` | Win rate: ${winRate}`;
      message += `\n\n`;
    }

    if (bias === 'long' || !bias || bias === 'neutral') {
      message += `🟢 *LONG SETUP${levText}*\n`;
      message += `Entry: $${parseFloat(longEntry).toFixed(4)}\n`;
      message += `Stop: $${parseFloat(longStop).toFixed(4)}\n`;
      message += `TP1: $${parseFloat(longTP1).toFixed(4)}\n`;
      message += `TP2: $${parseFloat(longTP2).toFixed(4)}\n`;
      message += `R:R: ${parseFloat(longRR).toFixed(2)}:1\n`;
      if (liqPrice && leverage > 1) message += `Liq: $${parseFloat(liqPrice).toFixed(4)}\n`;
      message += `\n`;
    }

    if (bias === 'short' || (!bias || bias === 'neutral')) {
      message += `🔴 *SHORT SETUP${levText}*\n`;
      message += `Entry: $${parseFloat(shortEntry).toFixed(4)}\n`;
      message += `Stop: $${parseFloat(shortStop).toFixed(4)}\n`;
      message += `TP1: $${parseFloat(shortTP1).toFixed(4)}\n`;
      message += `TP2: $${parseFloat(shortTP2).toFixed(4)}\n`;
      message += `R:R: ${parseFloat(shortRR).toFixed(2)}:1\n\n`;
    }

    message += `📈 *Indicators*\n`;
    message += `RSI: ${parseFloat(rsi).toFixed(1)} | Trend: ${trend} | Funding: ${parseFloat(funding).toFixed(4)}%\n`;
    message += `Fear & Greed: ${fgValue}\n\n`;

    if (watchLevel) message += `👁 *Watch level:* ${watchLevel}\n`;
    if (suggestedAction) message += `⚡ *Action:* ${suggestedAction}\n`;

    message += `\n_Signal Scanner — Not financial advice_`;

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });

    const tgData = await tgRes.json();
    if (!tgData.ok) {
      return res.status(500).json({ error: 'Telegram API error', details: tgData });
    }

    return res.status(200).json({ sent: true, messageId: tgData.result?.message_id });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
