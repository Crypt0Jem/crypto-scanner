export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, symbol, interval, limit } = req.query;

  try {
    // ── Klines ────────────────────────────────────────────────────────────────
    if (type === 'klines') {
      const sym = symbol || 'BTCUSDT';
      const iv  = interval || 'D';
      const lim = parseInt(limit) || 100;

      const binanceInt = { 'D':'1d','W':'1w','240':'4h','60':'1h','15':'15m','5':'5m','1':'1m' }[iv] || '1d';

      // 1. Try Binance Futures
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${binanceInt}&limit=${lim}`);
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j) && j.length > 0) {
            const list = j.map(k=>[String(k[0]),String(k[1]),String(k[2]),String(k[3]),String(k[4]),String(k[5])]).reverse();
            return res.status(200).json({ result:{ list }, source:'binance-futures' });
          }
        }
      } catch(e) {}

      // 2. Try Binance Spot
      try {
        const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${binanceInt}&limit=${lim}`);
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j) && j.length > 0) {
            const list = j.map(k=>[String(k[0]),String(k[1]),String(k[2]),String(k[3]),String(k[4]),String(k[5])]).reverse();
            return res.status(200).json({ result:{ list }, source:'binance-spot' });
          }
        }
      } catch(e) {}

      // 3. Try OKX
      try {
        const okxSymMap = {'BTCUSDT':'BTC-USDT-SWAP','ETHUSDT':'ETH-USDT-SWAP','SOLUSDT':'SOL-USDT-SWAP','XRPUSDT':'XRP-USDT-SWAP','SUIUSDT':'SUI-USDT-SWAP'};
        const okxBarMap = {'D':'1D','W':'1W','240':'4H','60':'1H','15':'15m','5':'5m','1':'1m'};
        const okxSym = okxSymMap[sym] || 'BTC-USDT-SWAP';
        const okxBar = okxBarMap[iv] || '1D';
        const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=${okxBar}&limit=${lim}`);
        if (r.ok) {
          const j = await r.json();
          if (j.data && j.data.length > 0) {
            // OKX: [ts, open, high, low, close, vol, ...]
            const list = j.data.map(k=>[String(k[0]),String(k[1]),String(k[2]),String(k[3]),String(k[4]),String(k[5])]);
            return res.status(200).json({ result:{ list }, source:'okx' });
          }
        }
      } catch(e) {}

      // 4. Try Gate.io
      try {
        const gateSymMap = {'BTCUSDT':'BTC_USDT','ETHUSDT':'ETH_USDT','SOLUSDT':'SOL_USDT','XRPUSDT':'XRP_USDT','SUIUSDT':'SUI_USDT'};
        const gateIntMap = {'D':'1d','W':'7d','240':'4h','60':'1h','15':'15m','5':'5m','1':'1m'};
        const gateSym = gateSymMap[sym] || 'BTC_USDT';
        const gateInt = gateIntMap[iv] || '1d';
        const r = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${gateSym}&interval=${gateInt}&limit=${lim}`);
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j) && j.length > 0) {
            const list = j.map(k=>[String(k.t*1000),String(k.o),String(k.h),String(k.l),String(k.c),String(k.v)]).reverse();
            return res.status(200).json({ result:{ list }, source:'gateio' });
          }
        }
      } catch(e) {}


      // 5. Try Kraken (spot - good for BTC/ETH/XRP/SOL)
      try {
        const krakenSymMap = {'BTCUSDT':'XBTUSD','ETHUSDT':'ETHUSD','SOLUSDT':'SOLUSD','XRPUSDT':'XRPUSD','SUIUSDT':'SUIUSD'};
        const krakenIntMap = {'D':'1440','W':'10080','240':'240','60':'60','15':'15','5':'5','1':'1'};
        const krakenSym = krakenSymMap[sym] || 'XBTUSD';
        const krakenInt = krakenIntMap[iv] || '1440';
        const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${krakenSym}&interval=${krakenInt}`);
        if (r.ok) {
          const j = await r.json();
          const pairs = j.result;
          const key = Object.keys(pairs).find(k => k !== 'last');
          if (key && Array.isArray(pairs[key]) && pairs[key].length > 0) {
            const list = pairs[key].slice(-lim).map(k=>[String(k[0]*1000),String(k[1]),String(k[2]),String(k[3]),String(k[4]),String(k[6])]).reverse();
            return res.status(200).json({ result:{ list }, source:'kraken' });
          }
        }
      } catch(e) {}

      // 6. Try MEXC (Binance-compatible format)
      try {
        const r = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${sym}&interval=${binanceInt}&limit=${lim}`);
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j) && j.length > 0) {
            const list = j.map(k=>[String(k[0]),String(k[1]),String(k[2]),String(k[3]),String(k[4]),String(k[5])]).reverse();
            return res.status(200).json({ result:{ list }, source:'mexc' });
          }
        }
      } catch(e) {}

      // 7. CoinGecko OHLC (daily only — fallback for 1D)
      if (iv === 'D' || iv === 'W') {
        try {
          const cgIdMap = {'BTCUSDT':'bitcoin','ETHUSDT':'ethereum','SOLUSDT':'solana','XRPUSDT':'ripple','SUIUSDT':'sui'};
          const cgId = cgIdMap[sym] || 'bitcoin';
          const days = Math.min(lim, 90);
          const r = await fetch(`https://api.coingecko.com/api/v3/coins/${cgId}/ohlc?vs_currency=usd&days=${days}`);
          if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j) && j.length > 0) {
              const list = j.map(k=>[String(k[0]),String(k[1]),String(k[2]),String(k[3]),String(k[4]),'0']).reverse();
              return res.status(200).json({ result:{ list }, source:'coingecko' });
            }
          }
        } catch(e) {}
      }

      return res.status(500).json({ error:'All kline sources failed' });
    }

    // ── Recent trades (CVD) ───────────────────────────────────────────────────
    if (type === 'trades') {
      const sym = symbol || 'BTCUSDT';
      const lim = Math.min(parseInt(limit)||1000, 1000);
      // Try Binance futures, then spot, then OKX
      for (const url of [
        `https://fapi.binance.com/fapi/v1/trades?symbol=${sym}&limit=${lim}`,
        `https://api.binance.com/api/v3/trades?symbol=${sym}&limit=${lim}`
      ]) {
        try {
          const r = await fetch(url);
          if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j)) {
              const list = j.map(t=>({ T:String(t.time), S:t.isBuyerMaker?'Sell':'Buy', v:String(t.qty), p:String(t.price) }));
              return res.status(200).json({ result:{ list } });
            }
          }
        } catch(e) {}
      }
      return res.status(200).json({ result:{ list:[] } });
    }

    // ── Funding history ───────────────────────────────────────────────────────
    if (type === 'funding_history') {
      const sym = symbol || 'BTCUSDT';
      const lim = parseInt(limit) || 8;
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=${lim}`);
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j)) {
            const list = j.map(f=>({ fundingRate:f.fundingRate, fundingRateTimestamp:String(f.fundingTime) }));
            return res.status(200).json({ result:{ list } });
          }
        }
      } catch(e) {}
      return res.status(200).json({ result:{ list:[] } });
    }

    // ── Order book ────────────────────────────────────────────────────────────
    if (type === 'orderbook') {
      const sym = symbol || 'BTCUSDT';
      const lim = parseInt(limit) || 50;
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=${lim}`);
        if (r.ok) {
          const j = await r.json();
          if (j.bids) return res.status(200).json({ result:{ b:j.bids, a:j.asks } });
        }
      } catch(e) {}
      return res.status(200).json({ result:{ b:[], a:[] } });
    }

    // ── Tickers ───────────────────────────────────────────────────────────────
    if (type === 'tickers') {
      const ids = 'bitcoin,ethereum,solana,ripple,sui';
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`);
      const coins = await r.json();
      if (!Array.isArray(coins)) return res.status(500).json({ error:'CoinGecko error' });
      const idMap = { bitcoin:'BTCUSDT', ethereum:'ETHUSDT', solana:'SOLUSDT', ripple:'XRPUSDT', sui:'SUIUSDT' };
      const data = coins.map(c=>({
        symbol: idMap[c.id], lastPrice: String(c.current_price),
        priceChangePercent: String(c.price_change_percentage_24h?.toFixed(4)||'0'),
        highPrice: String(c.high_24h), lowPrice: String(c.low_24h),
        quoteVolume: String(c.total_volume), marketCap: String(c.market_cap), ath: String(c.ath)
      }));
      return res.status(200).json(data);
    }

    if (type === 'funding') return res.status(200).json({ lastFundingRate:'0.0001' });
    if (type === 'oi')      return res.status(200).json({ openInterest:'0' });
    if (type === 'fg') {
      const r = await fetch('https://api.alternative.me/fng/?limit=1');
      return res.status(200).json(await r.json());
    }

    return res.status(400).json({ error:'Unknown type: '+type });
  } catch(e) {
    return res.status(500).json({ error:e.message });
  }
}
