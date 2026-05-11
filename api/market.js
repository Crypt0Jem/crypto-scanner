export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, symbol, interval, limit } = req.query;

  try {
    // ── Klines — Binance Futures (most reliable, no auth needed) ─────────────
    if (type === 'klines') {
      const sym = symbol || 'BTCUSDT';
      const iv  = interval || 'D';
      const lim = parseInt(limit) || 100;
      const binanceIntervalMap = { 'D':'1d','W':'1w','240':'4h','60':'1h','15':'15m','5':'5m','1':'1m' };
      const binanceInterval = binanceIntervalMap[iv] || '1d';
      const r = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${binanceInterval}&limit=${lim}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const j = await r.json();
      if (Array.isArray(j) && j.length > 0) {
        // Convert Binance [time,open,high,low,close,vol] to Bybit format (reversed = oldest first)
        const list = j.map(k => [String(k[0]), String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5])]);
        return res.status(200).json({ result: { list: list.reverse() } });
      }
      // Fallback: Binance spot
      const rs = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${binanceInterval}&limit=${lim}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const js = await rs.json();
      if (Array.isArray(js) && js.length > 0) {
        const list = js.map(k => [String(k[0]), String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5])]);
        return res.status(200).json({ result: { list: list.reverse() } });
      }
      return res.status(500).json({ error: 'Klines unavailable' });
    }

    // ── Recent trades (for CVD) ───────────────────────────────────────────────
    if (type === 'trades') {
      const sym = symbol || 'BTCUSDT';
      const lim = Math.min(parseInt(limit) || 1000, 1000);
      try {
        const r = await fetch(
          `https://fapi.binance.com/fapi/v1/trades?symbol=${sym}&limit=${lim}`,
          { headers: { 'Accept': 'application/json' } }
        );
        const j = await r.json();
        if (Array.isArray(j)) {
          const list = j.map(t => ({ T: String(t.time), S: t.isBuyerMaker ? 'Sell' : 'Buy', v: String(t.qty), p: String(t.price) }));
          return res.status(200).json({ result: { list } });
        }
      } catch(e) {}
      return res.status(200).json({ result: { list: [] } });
    }

    // ── Funding history ───────────────────────────────────────────────────────
    if (type === 'funding_history') {
      const sym = symbol || 'BTCUSDT';
      const lim = parseInt(limit) || 8;
      try {
        const r = await fetch(
          `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=${lim}`,
          { headers: { 'Accept': 'application/json' } }
        );
        const j = await r.json();
        if (Array.isArray(j)) {
          const list = j.map(f => ({ fundingRate: f.fundingRate, fundingRateTimestamp: String(f.fundingTime) }));
          return res.status(200).json({ result: { list } });
        }
      } catch(e) {}
      return res.status(200).json({ result: { list: [] } });
    }

    // ── Order book ────────────────────────────────────────────────────────────
    if (type === 'orderbook') {
      const sym = symbol || 'BTCUSDT';
      const lim = parseInt(limit) || 50;
      try {
        const r = await fetch(
          `https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=${lim}`,
          { headers: { 'Accept': 'application/json' } }
        );
        const j = await r.json();
        if (j.bids) return res.status(200).json({ result: { b: j.bids, a: j.asks } });
      } catch(e) {}
      return res.status(200).json({ result: { b: [], a: [] } });
    }

    // ── Tickers (CoinGecko) ───────────────────────────────────────────────────
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
