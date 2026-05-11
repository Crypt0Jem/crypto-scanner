export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, symbol, interval, limit } = req.query;

  // Map Bybit symbol + interval to Coinbase format
  const coinbaseProductMap = {
    'BTCUSDT':'BTC-USD', 'ETHUSDT':'ETH-USD', 'SOLUSDT':'SOL-USD',
    'XRPUSDT':'XRP-USD', 'SUIUSDT':'SUI-USD'
  };
  const coinbaseGranMap = {
    'D':'86400', 'W':'604800', '240':'14400', '60':'3600', '15':'900', '5':'300', '1':'60'
  };

  try {
    // ── Klines ────────────────────────────────────────────────────────────────
    if (type === 'klines') {
      const sym  = symbol || 'BTCUSDT';
      const iv   = interval || 'D';
      const lim  = parseInt(limit) || 100;
      const cbSym  = coinbaseProductMap[sym] || 'BTC-USD';
      const gran   = coinbaseGranMap[iv] || '86400';
      const end    = Math.floor(Date.now() / 1000);
      const start  = end - (lim * parseInt(gran));

      try {
        const r = await fetch(
          `https://api.exchange.coinbase.com/products/${cbSym}/candles?granularity=${gran}&start=${start}&end=${end}`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
        );
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j) && j.length > 0) {
            // Coinbase format: [time, low, high, open, close, volume]
            // Convert to Bybit format: [timestamp, open, high, low, close, volume]
            const list = j.map(k => [String(k[0] * 1000), String(k[3]), String(k[2]), String(k[1]), String(k[4]), String(k[5])]);
            return res.status(200).json({ result: { list } });
          }
        }
      } catch(e) {}

      // Fallback: Binance
      const binanceIntervalMap = { 'D':'1d','W':'1w','240':'4h','60':'1h','15':'15m','5':'5m','1':'1m' };
      const binanceInterval = binanceIntervalMap[iv] || '1d';
      const rb = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${binanceInterval}&limit=${lim}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const jb = await rb.json();
      if (Array.isArray(jb)) {
        const list = jb.map(k => [k[0], k[1], k[2], k[3], k[4], k[5]]).reverse();
        return res.status(200).json({ result: { list } });
      }
      return res.status(500).json({ error: 'Klines unavailable' });
    }

    // ── Recent trades (for CVD) ───────────────────────────────────────────────
    if (type === 'trades') {
      const sym   = symbol || 'BTCUSDT';
      const lim   = parseInt(limit) || 1000;
      const cbSym = coinbaseProductMap[sym] || 'BTC-USD';
      try {
        const r = await fetch(
          `https://api.exchange.coinbase.com/products/${cbSym}/trades?limit=${Math.min(lim, 1000)}`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
        );
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j)) {
            const list = j.map(t => ({
              T: String(new Date(t.time).getTime()),
              S: t.side === 'buy' ? 'Buy' : 'Sell',
              v: String(t.size),
              p: String(t.price)
            }));
            return res.status(200).json({ result: { list } });
          }
        }
      } catch(e) {}
      // Fallback: Binance
      const rb = await fetch(
        `https://fapi.binance.com/fapi/v1/trades?symbol=${sym}&limit=500`,
        { headers: { 'Accept': 'application/json' } }
      );
      const jb = await rb.json();
      if (Array.isArray(jb)) {
        const list = jb.map(t => ({ T: String(t.time), S: t.isBuyerMaker ? 'Sell' : 'Buy', v: t.qty, p: t.price }));
        return res.status(200).json({ result: { list } });
      }
      return res.status(200).json({ result: { list: [] } });
    }

    // ── Funding history ───────────────────────────────────────────────────────
    if (type === 'funding_history') {
      const sym = symbol || 'BTCUSDT';
      const lim = parseInt(limit) || 8;
      // Binance is most reliable for funding history
      try {
        const rb = await fetch(
          `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=${lim}`,
          { headers: { 'Accept': 'application/json' } }
        );
        const jb = await rb.json();
        if (Array.isArray(jb)) {
          const list = jb.map(f => ({ fundingRate: f.fundingRate, fundingRateTimestamp: String(f.fundingTime) }));
          return res.status(200).json({ result: { list } });
        }
      } catch(e) {}
      return res.status(200).json({ result: { list: [] } });
    }

    // ── Order book ────────────────────────────────────────────────────────────
    if (type === 'orderbook') {
      const sym   = symbol || 'BTCUSDT';
      const lim   = parseInt(limit) || 50;
      const cbSym = coinbaseProductMap[sym] || 'BTC-USD';
      try {
        const r = await fetch(
          `https://api.exchange.coinbase.com/products/${cbSym}/book?level=2`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
        );
        if (r.ok) {
          const j = await r.json();
          return res.status(200).json({ result: { b: j.bids || [], a: j.asks || [] } });
        }
      } catch(e) {}
      // Fallback: Binance
      const rb = await fetch(
        `https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=${lim}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const jb = await rb.json();
      if (jb.bids) return res.status(200).json({ result: { b: jb.bids, a: jb.asks } });
      return res.status(200).json({ result: { b: [], a: [] } });
    }

    // ── Tickers ───────────────────────────────────────────────────────────────
    if (type === 'tickers') {
      const ids = 'bitcoin,ethereum,solana,ripple,sui';
      const r = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`,
        { headers: { 'Accept': 'application/json' } }
      );
      const coins = await r.json();
      if (!Array.isArray(coins)) return res.status(500).json({ error: 'CoinGecko error' });
      const idMap = { bitcoin:'BTCUSDT', ethereum:'ETHUSDT', solana:'SOLUSDT', ripple:'XRPUSDT', sui:'SUIUSDT' };
      const data = coins.map(c => ({
        symbol: idMap[c.id],
        lastPrice: String(c.current_price),
        priceChangePercent: String(c.price_change_percentage_24h?.toFixed(4) || '0'),
        highPrice: String(c.high_24h), lowPrice: String(c.low_24h),
        quoteVolume: String(c.total_volume), marketCap: String(c.market_cap), ath: String(c.ath)
      }));
      return res.status(200).json(data);
    }

    if (type === 'funding') return res.status(200).json({ lastFundingRate: '0.0001' });
    if (type === 'oi')      return res.status(200).json({ openInterest: '0' });

    if (type === 'fg') {
      const r = await fetch('https://api.alternative.me/fng/?limit=1', { headers: { 'Accept': 'application/json' } });
      const j = await r.json();
      return res.status(200).json(j);
    }

    return res.status(400).json({ error: 'Unknown type: ' + type });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
