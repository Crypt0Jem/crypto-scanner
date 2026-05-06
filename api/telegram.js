// /api/telegram.js — Telegram webhook handler for bot commands
// Register this URL with Telegram:
// https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://crypto-scanner-khaki.vercel.app/api/telegram

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
  if (!BOT_TOKEN) return res.status(200).json({ ok: false, error: 'No bot token' });

  async function sendMsg(chatId, text) {
    await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  }

  try {
    const body = req.body;
    const msg  = body?.message || body?.channel_post;
    if (!msg) return res.status(200).json({ ok: true });

    const chatId = msg.chat?.id;
    const text   = (msg.text || '').trim().toLowerCase();
    const userId = msg.from?.id;

    // Security: only respond to the registered chat
    if (CHAT_ID && String(chatId) !== String(CHAT_ID)) {
      console.log('Ignoring message from unknown chat:', chatId);
      return res.status(200).json({ ok: true });
    }

    // ── Command handlers ──────────────────────────────────────────────────────

    if (text === '/start' || text === '/help') {
      await sendMsg(chatId,
        '📊 <b>Signal Scanner Bot</b>\n\n' +
        'I send real-time trade signals for BTC, ETH, XRP, SOL, SUI on Blofin.\n\n' +
        '<b>Commands:</b>\n' +
        '/help — Show this message\n' +
        '/status — Current scanner status\n' +
        '/signals — What signals are active right now\n' +
        '/thresholds — Current alert thresholds\n' +
        '/about — About this scanner\n\n' +
        '<b>Alert types:</b>\n' +
        '⚡ Sweep alert — fires immediately on liq sweep detection\n' +
        '📈 Signal alert — fires when score ≥7 + HIGH conviction AI pattern\n\n' +
        '<i>Signal Scanner (Blofin) — Not financial advice</i>'
      );
      return res.status(200).json({ ok: true });
    }

    if (text === '/status') {
      const now = new Date().toUTCString();
      await sendMsg(chatId,
        '🟢 <b>Scanner Status</b>\n\n' +
        '✅ Bot: Online\n' +
        '✅ API: Connected\n' +
        '✅ Alerts: Active\n\n' +
        '🕐 Server time: ' + now + '\n\n' +
        '<b>Alert gates:</b>\n' +
        '• Score ≥ 7/10\n' +
        '• Pattern: confirmed or near breakout\n' +
        '• Conviction: HIGH (or MEDIUM + score ≥7)\n' +
        '• Mode: Swing only\n' +
        '• Dedup: once per coin per daily candle\n\n' +
        '<i>Signal Scanner (Blofin) — Not financial advice</i>'
      );
      return res.status(200).json({ ok: true });
    }

    if (text === '/thresholds') {
      await sendMsg(chatId,
        '⚙️ <b>Current Alert Thresholds</b>\n\n' +
        '<b>Standard signal alert:</b>\n' +
        '• Min score: 7/10\n' +
        '• Pattern stage: confirmed or near breakout\n' +
        '• Conviction: HIGH required (or MEDIUM if score ≥7)\n' +
        '• Mode: Swing only (scalp alerts suppressed)\n' +
        '• Dedup: 1 alert per coin per day\n\n' +
        '<b>Sweep alert:</b>\n' +
        '• Fires immediately on liq sweep detection\n' +
        '• Requires confirmed candle close back above/below zone\n' +
        '• Dedup: 1 per sweep event\n\n' +
        '<b>Coins monitored:</b> BTC, ETH, XRP, SOL, SUI\n' +
        '<b>Exchange:</b> Blofin (Bybit WS data)\n\n' +
        '<i>Signal Scanner (Blofin) — Not financial advice</i>'
      );
      return res.status(200).json({ ok: true });
    }

    if (text === '/signals') {
      await sendMsg(chatId,
        '📊 <b>Signal Info</b>\n\n' +
        'Live signal status is visible in the scanner app:\n' +
        '🌐 crypto-scanner-khaki.vercel.app\n\n' +
        '<b>Signal scoring (out of 10):</b>\n' +
        '• RSI position (+1-2)\n' +
        '• EMA trend alignment (+1-2)\n' +
        '• Funding rate momentum (+0-1)\n' +
        '• OI direction (+0-1)\n' +
        '• MTF confluence (+0-2)\n' +
        '• CVD order flow (+0-1)\n' +
        '• Liq zone proximity (+0-1)\n\n' +
        '<b>Signal types:</b>\n' +
        '📈 Swing Lock — daily/4H confluence locked signal\n' +
        '⚡ Post-Sweep — precision entry after liq sweep\n' +
        '🎯 Liq Scale-In — counter-trend inside liq cluster\n' +
        '🔄 Sweep Opportunity — pre-sweep setup\n\n' +
        '<i>Signal Scanner (Blofin) — Not financial advice</i>'
      );
      return res.status(200).json({ ok: true });
    }

    if (text === '/about') {
      await sendMsg(chatId,
        'ℹ️ <b>About Signal Scanner</b>\n\n' +
        'A custom crypto trade signal scanner built for Blofin futures trading.\n\n' +
        '<b>Data sources:</b>\n' +
        '• Bybit API (prices, klines, funding, OI, liquidations)\n' +
        '• Alternative.me (Fear & Greed)\n' +
        '• TradingView (charts)\n' +
        '• Claude AI (pattern recognition)\n\n' +
        '<b>Features:</b>\n' +
        '• Multi-timeframe confluence (swing + scalp modes)\n' +
        '• Real-time liquidation heatmap\n' +
        '• CVD order flow analysis\n' +
        '• Post-sweep precision entries\n' +
        '• Leverage-aware stops and TPs\n' +
        '• Trade outcome tracker\n' +
        '• Risk calculator\n\n' +
        'Typical leverage: 50x-125x isolated margin\n\n' +
        '<i>Not financial advice. Trade responsibly.</i>'
      );
      return res.status(200).json({ ok: true });
    }

    // Unknown command
    if (text.startsWith('/')) {
      await sendMsg(chatId,
        '❓ Unknown command: ' + text + '\n\nSend /help to see available commands.'
      );
      return res.status(200).json({ ok: true });
    }

    // Ignore non-command messages silently
    return res.status(200).json({ ok: true });

  } catch(e) {
    console.error('Telegram webhook error:', e);
    return res.status(200).json({ ok: true }); // always 200 to Telegram
  }
}
