export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, symbol, interval, limit } = req.query;

  // Bybit interval mapping from Binance-style
  const intervalMap = { '1d':'D','4h':'240','1h':'60','15m':'15','1m':'1' };

  try {
    let data;

    if (type === 'tickers') {
      const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','SUIUSDT'];
      const results = await Promise.all(syms.map(async s => {
        const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`);
        const j = await r.json();
        const t = j?.result?.list?.[0];
        if (!t) return null;
        const price = parseFloat(t.lastPrice);
        const open24 = parseFloat(t.prevPrice24h);
        const change24h = open24 ? ((price - open24) / open24 * 100) : 0;
        return {
          symbol: s,
          lastPrice: t.lastPrice,
          priceChangePercent: change24h.toFixed(4),
          highPrice: t.highPrice24h,
          lowPrice: t.lowPrice24h,
          quoteVolume: t.turnover24h
        };
      }));
      data = results.filter(Boolean);
    }
    else if (type === 'klines') {
      if (!symbol || !interval) return res.status(400).json({ error: 'symbol and interval required' });
      const bybitInterval = intervalMap[interval] || interval;
      const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit||100}`);
      const j = await r.json();
      const list = j?.result?.list;
      if (!Array.isArray(list)) return res.status(500).json({ error: 'Bad klines response', raw: j });
      // Bybit returns newest first, reverse to oldest first
      // Format: [startTime, open, high, low, close, volume, turnover]
      data = list.reverse().map(k => [
        parseInt(k[0]), // timestamp
        k[1], // open
        k[2], // high
        k[3], // low
        k[4], // close
        k[5]  // volume
      ]);
    }
    else if (type === 'funding') {
      if (!symbol) return res.status(400).json({ error: 'symbol required' });
      const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
      const j = await r.json();
      const t = j?.result?.list?.[0];
      data = { lastFundingRate: t?.fundingRate || '0' };
    }
    else if (type === 'oi') {
      if (!symbol) return res.status(400).json({ error: 'symbol required' });
      const r = await fetch(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=1`);
      const j = await r.json();
      const oi = j?.result?.list?.[0]?.openInterest || '0';
      data = { openInterest: oi };
    }
    else if (type === 'fg') {
      const r = await fetch('https://api.alternative.me/fng/?limit=1');
      data = await r.json();
    }
    else {
      return res.status(400).json({ error: 'Unknown type: ' + type });
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
