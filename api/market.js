export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, symbol, interval, limit, category } = req.query;

  try {
    // ── Klines (candlestick data) ─────────────────────────────────────────────
    if (type === 'klines') {
      const sym = symbol || 'BTCUSDT';
      const iv  = interval || 'D';
      const lim = limit || '100';
      const r = await fetch(
        `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${iv}&limit=${lim}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const j = await r.json();
      return res.status(200).json(j);
    }

    // ── Recent trades (for CVD) ───────────────────────────────────────────────
    if (type === 'trades') {
      const sym = symbol || 'BTCUSDT';
      const lim = limit || '1000';
      const r = await fetch(
        `https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${sym}&limit=${lim}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const j = await r.json();
      return res.status(200).json(j);
    }

    // ── Funding history ───────────────────────────────────────────────────────
    if (type === 'funding_history') {
      const sym = symbol || 'BTCUSDT';
      const lim = limit || '8';
      const r = await fetch(
        `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&limit=${lim}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const j = await r.json();
      return res.status(200).json(j);
    }

    // ── Order book ────────────────────────────────────────────────────────────
    if (type === 'orderbook') {
      const sym = symbol || 'BTCUSDT';
      const lim = limit || '50';
      const r = await fetch(
        `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${sym}&limit=${lim}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const j = await r.json();
      return res.status(200).json(j);
    }

    // ── Tickers (prices via CoinGecko) ────────────────────────────────────────
    if (type === 'tickers') {
      const ids = 'bitcoin,ethereum,solana,ripple,sui';
      const r = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`,
        { headers: { 'Accept': 'application/json' } }
      );
      const coins = await r.json();
      if (!Array.isArray(coins)) return res.status(500).json({ error: 'CoinGecko error', raw: coins });
      const idMap = { bitcoin:'BTCUSDT', ethereum:'ETHUSDT', solana:'SOLUSDT', ripple:'XRPUSDT', sui:'SUIUSDT' };
      const data = coins.map(c => ({
        symbol: idMap[c.id],
        lastPrice: String(c.current_price),
        priceChangePercent: String(c.price_change_percentage_24h?.toFixed(4) || '0'),
        highPrice: String(c.high_24h),
        lowPrice: String(c.low_24h),
        quoteVolume: String(c.total_volume),
        marketCap: String(c.market_cap),
        ath: String(c.ath)
      }));
      return res.status(200).json(data);
    }

    // ── Funding rate (current) ────────────────────────────────────────────────
    if (type === 'funding') {
      return res.status(200).json({ lastFundingRate: '0.0001' });
    }

    // ── Open interest ─────────────────────────────────────────────────────────
    if (type === 'oi') {
      return res.status(200).json({ openInterest: '0' });
    }

    // ── Fear & Greed ──────────────────────────────────────────────────────────
    if (type === 'fg') {
      const r = await fetch('https://api.alternative.me/fng/?limit=1', {
        headers: { 'Accept': 'application/json' }
      });
      const j = await r.json();
      return res.status(200).json(j);
    }

    return res.status(400).json({ error: 'Unknown type: ' + type });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
