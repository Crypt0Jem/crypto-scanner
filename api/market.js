export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, symbol, interval, limit } = req.query;

  try {
    let data;

    if (type === 'tickers') {
      // Fetch each symbol individually to guarantee array response
      const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','SUIUSDT'];
      const results = await Promise.all(
        syms.map(s => fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${s}`).then(r => r.json()))
      );
      data = results;
    }
    else if (type === 'klines') {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit||100}`);
      data = await r.json();
    }
    else if (type === 'funding') {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
      data = await r.json();
    }
    else if (type === 'oi') {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
      data = await r.json();
    }
    else if (type === 'fg') {
      const r = await fetch('https://api.alternative.me/fng/?limit=1');
      data = await r.json();
    }
    else {
      return res.status(400).json({ error: 'Unknown type' });
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
