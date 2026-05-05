const APP_VERSION='phase3-ws-v1';
const COINS={
  BTC:{sym:'BTCUSDT',tv:'BINANCE:BTCUSDT',dec:0,name:'Bitcoin'},
  ETH:{sym:'ETHUSDT',tv:'BINANCE:ETHUSDT',dec:2,name:'Ethereum'},
  SOL:{sym:'SOLUSDT',tv:'BINANCE:SOLUSDT',dec:3,name:'Solana'},
  XRP:{sym:'XRPUSDT',tv:'BINANCE:XRPUSDT',dec:4,name:'XRP'},
  SUI:{sym:'SUIUSDT',tv:'BINANCE:SUIUSDT',dec:4,name:'Sui'}
};
const TF_TV={'1d':'D','4h':'240','1h':'60','15m':'15'};
const TF_BI={'1d':'1d','4h':'4h','1h':'1h','15m':'15m'};

let activeCoin='BTC',activeTF='1d',entryMode='optimal',activeLev=50,activeMode='swing';
let mktData={},klCache={},aiCache={};

// Phase 3: Bybit WebSocket globals
let bybitWS = null;
let bybitLiqQueue = [];
let bybitTickerCache = {};
let wsReconnectAttempts = 0;
const WS_MAX_RECONNECT = 5;
const WS_STALE_MS = 300000;

// Layer 2 globals
let fundingHistoryCache = {};
let oiHistoryCache = {};
let fundingLastFetch = {};

// ── SWING SIGNAL LOCKING ─────────────────────────────────────────────────────
// Frozen setups that persist across refreshes. Scalp mode never locks.
let swingSignals = {};  // in-memory, keyed by "BTC_1d" etc.

const TF_MS = { '1d':86400000, '4h':14400000, '1h':3600000, '15m':900000, '5m':300000, '1w':604800000 };
function getTfMs(tf){ return TF_MS[tf] || 3600000; }
function getCurrentCandleTime(tf){ const ms=getTfMs(tf); return Math.floor(Date.now()/ms)*ms; }

function loadSwingSignals(){
  try{
    const raw=localStorage.getItem('swingSignals_v1');
    if(!raw) return;
    const parsed=JSON.parse(raw);
    // Validate each signal has required fields before loading
    Object.entries(parsed).forEach(([k,sig])=>{
      if(sig && sig.lockedSetup && sig.lockedAt && sig.symbol && sig.tf &&
         typeof sig.lockedSetup.entry==='number' && sig.lockedSetup.entry>0){
        swingSignals[k]=sig;
      }
    });
    console.log('Loaded swing signals:', Object.keys(swingSignals));
  } catch(e){ console.warn('Could not load swing signals:', e); swingSignals={}; }
}

function saveSwingSignals(){
  try{ localStorage.setItem('swingSignals_v1', JSON.stringify(swingSignals)); }
  catch(e){ console.warn('Could not save swing signals:', e); }
}

function lockSignal(coin, tf, ta, setup, sc, price, pivots, liqZones){
  const key = coin+'_'+tf;
  const candleTime = getCurrentCandleTime(tf);
  swingSignals[key] = {
    key, symbol:coin, tf, mode:'swing',
    lockedAt: Date.now(),
    lockedCandleTime: candleTime,

    lockedSetup: {
      bias: null,                        // filled in when AI resolves
      support:    ta.support,
      resistance: ta.resistance,
      entry:      setup.lE,
      stopLoss:   setup.lSL,
      takeProfits:[setup.lTP1, setup.lTP2],
      shortEntry: setup.sE,
      shortStop:  setup.sSL,
      shortTPs:   [setup.sTP1, setup.sTP2],
      liqLong:    setup.liqLong,
      liqShort:   setup.liqShort,
      atr:        ta.atr,
      invalidationLevel: ta.support      // price candle-close below this kills signal
    },

    // Pivot levels frozen at lock time (so invalidation threshold never drifts)
    lockedPivots: pivots ? { highs:[...pivots.highs], lows:[...pivots.lows] } : { highs:[], lows:[] },

    snapshot: {
      score:         sc,
      rsi:           ta.rsi,
      trend:         ta.trend,
      lockedPrice:   price,
      oiAtLock:      (typeof mktData[coin]!=='undefined') ? mktData[coin].oiNotional : 0,
      fundingAtLock: (typeof mktData[coin]!=='undefined') ? mktData[coin].funding : 0,
      aiSummary:     null,           // filled post-AI
      aiInterestZone:null,
      aiConviction:  null,
      aiBias:        null
    },

    dynamic: {
      status:        'active',       // active | triggered | tp1Hit | expired | invalidated
      candlesElapsed:0,
      lastCheckedCandle: candleTime,
      consecutiveLowScore: 0
    },

    // Phase 2: smart re-eval stubs (wired up by Grok in Phase 2)
    reEval: {
      lastChecked:          Date.now(),
      structureBreaks:      0,
      lastLiqSweepDetected: null,
      aiInterestZoneMatch:  true,
      needsReview:          false
    }
  };
  saveSwingSignals();
  console.log(`Signal locked: ${key} @ $${price}, score ${sc}`);
}

function updateSignalAI(coin, tf, ai){
  const key = coin+'_'+tf;
  const sig = swingSignals[key];
  if(!sig) return;
  sig.lockedSetup.bias      = ai.bias || null;
  sig.snapshot.aiSummary    = ai.summary || null;
  sig.snapshot.aiConviction = ai.conviction || null;
  sig.snapshot.aiBias       = ai.bias || null;
  sig.snapshot.aiInterestZone = ai.watchLevel || null;
  saveSwingSignals();
}

function invalidateSignal(coin, tf, reason){
  const key = coin+'_'+tf;
  if(!swingSignals[key]) return;
  console.log(`Signal invalidated: ${key} — ${reason}`);
  delete swingSignals[key];
  saveSwingSignals();
}

// ── PHASE 2 HELPERS ─────────────────────────────────────────────────────────

// Detect wick-based sweep (polling, no WS needed)
// Long sweep: wick pierced invalidation level but candle closed back above
// Short sweep: wick pierced resistance but candle closed back below
function detectWickSweep(sig, klines) {
  if (!klines || klines.length < 2) return false;
  const c = klines[klines.length - 1];  // current candle
  const inv = sig.lockedSetup.invalidationLevel;
  const bias = sig.lockedSetup.bias;
  if (bias === 'short') {
    return c.h >= inv && c.c < inv;   // wick up through resistance, closed back below
  }
  // long or null
  return c.l <= inv && c.c > inv;     // wick down through support, closed back above
}

// Volume spike: wick candle volume vs median of last 20
function getVolumeMultiple(klines) {
  if (!klines || klines.length < 21) return 1;
  const last20 = klines.slice(-21, -1).map(k => k.v).sort((a,b) => a - b);
  const median = last20[Math.floor(last20.length / 2)] || 1;
  const current = klines[klines.length - 1].v;
  return current / median;
}

// CVD flip: current trend opposite to previous trend for 2 consecutive readings
// Uses cvdData.trend from fetchCVDData — we store prev trend in reEval
function checkCVDFlip(sig, cvdData) {
  if (!cvdData || !cvdData.trend) return false;
  const prev = sig.reEval.prevCVDTrend;
  const curr = cvdData.trend;
  const bias = sig.lockedSetup.bias;
  // For a long sweep: we want CVD flipping FROM bearish TO bullish
  // For a short sweep: CVD flipping FROM bullish TO bearish
  if (bias === 'short') return prev === 'bullish' && curr === 'bearish';
  return prev === 'bearish' && curr === 'bullish';
}

// OI delta % since signal locked
function getOIDelta(sig, currentOINotional) {
  const locked = sig.snapshot.oiAtLock;
  if (!locked || locked === 0) return 0;
  return ((currentOINotional - locked) / locked) * 100;
}

// Calculate confluence score 0-4
function calcConfluenceScore(sig, klines, cvdData, currentOINotional) {
  let score = 0;
  if (detectWickSweep(sig, klines))                    score++;
  if (getVolumeMultiple(klines) >= 2.5)                score++;
  if (checkCVDFlip(sig, cvdData))                      score++;
  if (Math.abs(getOIDelta(sig, currentOINotional)) > 3) score++;
  return score;
}

// Spawn a secondary "Sweep Opportunity" signal linked to the primary
function spawnSecondarySignal(primarySig, klines, cvdData, currentOINotional, dec) {
  const secKey = primarySig.key + '_sweep';
  if (swingSignals[secKey]) return; // already spawned

  const c = klines[klines.length - 1];
  const volMult = getVolumeMultiple(klines);
  const oiDelta = getOIDelta(primarySig, currentOINotional);
  const reason = {
    trigger:       'liq_sweep_reversal',
    sweepPrice:    primarySig.lockedSetup.bias === 'short' ? c.h : c.l,
    volumeMultiple:+volMult.toFixed(2),
    cvdFlipped:    checkCVDFlip(primarySig, cvdData),
    oiDeltaPct:    +oiDelta.toFixed(2),
    fundingAtLock: primarySig.snapshot.fundingAtLock,
    spawnedAt:     Date.now()
  };

  // Fresh entry at current candle close
  const entry = c.c;
  const mmr   = 0.005, imr = 1/50, fee = 0.0005; // use 50x as base for sweep entries
  const maxSD = (imr - mmr) * 0.6;
  const isLong = primarySig.lockedSetup.bias !== 'short';
  const stop  = isLong ? +(entry*(1-maxSD)).toFixed(dec) : +(entry*(1+maxSD)).toFixed(dec);
  const tp1   = isLong ? +(entry*1.018).toFixed(dec) : +(entry*0.982).toFixed(dec);
  const tp2   = isLong ? +(entry*1.038).toFixed(dec) : +(entry*0.962).toFixed(dec);

  swingSignals[secKey] = {
    key:        secKey,
    symbol:     primarySig.symbol,
    tf:         primarySig.tf,
    mode:       'swing',
    isSecondary:true,
    parentKey:  primarySig.key,
    evolvedReason: reason,
    lockedAt:   Date.now(),
    lockedCandleTime: getCurrentCandleTime(primarySig.tf),
    lockedSetup: {
      bias:             isLong ? 'bullish' : 'bearish',
      entry, stop, tp1, tp2,
      invalidationLevel: isLong ? stop : stop,
      support:    primarySig.lockedSetup.support,
      resistance: primarySig.lockedSetup.resistance,
      atr:        primarySig.lockedSetup.atr
    },
    snapshot: {
      score: 7.5,
      oiAtLock: currentOINotional,
      fundingAtLock: primarySig.snapshot.fundingAtLock,
      lockedPrice: entry
    },
    dynamic: {
      status: 'active',
      candlesElapsed: 0,
      lastCheckedCandle: getCurrentCandleTime(primarySig.tf),
      consecutiveLowScore: 0
    },
    reEval: {
      lastChecked: Date.now(),
      structureBreaks: 0,
      prevCVDTrend: cvdData?.trend || 'neutral',
      needsReview: false
    }
  };
  saveSwingSignals();
  console.log('Sweep signal spawned:', secKey, reason);
}

// Run Phase 2 re-eval on a signal after every render
function runPhase2ReEval(sig, klines, cvdData, currentOINotional, dec) {
  if (!sig || sig.isSecondary) return; // only run on primary signals

  // Update prevCVDTrend for next cycle's flip detection
  sig.reEval.prevCVDTrend = cvdData?.trend || sig.reEval.prevCVDTrend || 'neutral';
  sig.reEval.lastChecked = Date.now();
  const dWS = mktData[sig.symbol]||{};
  const realSweep = checkForRealSweep(sig, dWS.price||0);
  if (realSweep.hit) { sig.reEval.lastLiqSweepDetected = {price:realSweep.price,side:realSweep.side,ts:realSweep.timestamp}; }

  const confluence = calcConfluenceScore(sig, klines, cvdData, currentOINotional);

  if (confluence >= 2) {
    sig.reEval.needsReview = true;
  }
  if (confluence >= 3) {
    spawnSecondarySignal(sig, klines, cvdData, currentOINotional, dec);
  }

  saveSwingSignals();
}

// Returns the locked signal if valid, null if should recalculate
function checkSignalValidity(coin, tf, currentPrice, currentScore){
  const key = coin+'_'+tf;
  const sig = swingSignals[key];
  if(!sig) return null;
  if(sig.mode !== 'swing') return null;

  const candleTime = getCurrentCandleTime(tf);

  // Count candles elapsed
  if(candleTime > sig.dynamic.lastCheckedCandle){
    const tfMs = getTfMs(tf);
    const elapsed = Math.round((candleTime - sig.lockedCandleTime) / tfMs);
    sig.dynamic.candlesElapsed = elapsed;
    sig.dynamic.lastCheckedCandle = candleTime;
    saveSwingSignals();
  }

  // INVALIDATION RULES
  // 1. Expired (too many candles — 5 daily = 5 days, 5 weekly = 5 weeks)
  if(sig.dynamic.candlesElapsed >= 5){
    invalidateSignal(coin, tf, 'expired after 5 candles');
    return null;
  }

  // 2. Price closed a candle below invalidation level (for longs) or above (for shorts)
  const inv = sig.lockedSetup.invalidationLevel;
  if(sig.lockedSetup.bias !== 'short' && currentPrice < inv * 0.998){
    invalidateSignal(coin, tf, `price ${currentPrice} broke invalidation ${inv}`);
    return null;
  }

  // 3. Score dropped below 4 for 2 consecutive refreshes
  if(currentScore < 4){
    sig.dynamic.consecutiveLowScore = (sig.dynamic.consecutiveLowScore||0) + 1;
    if(sig.dynamic.consecutiveLowScore >= 2){
      invalidateSignal(coin, tf, 'score below 4 for 2 refreshes');
      return null;
    }
    saveSwingSignals();
  } else {
    sig.dynamic.consecutiveLowScore = 0;
  }

  // Signal is valid — update status flags
  const ls = sig.lockedSetup;
  if(currentPrice <= ls.entry * 1.002 && currentPrice >= ls.entry * 0.998)
    sig.dynamic.status = 'triggered';
  if(currentPrice >= ls.takeProfits[0])
    sig.dynamic.status = 'tp1Hit';

  return sig;
}

const fn=(n,d)=>n==null?'—':Number(n).toLocaleString('en-US',{minimumFractionDigits:d??0,maximumFractionDigits:d??0});

// Fetch with timeout
async function fetchWithTimeout(url, ms=8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  } catch(e) {
    clearTimeout(id);
    throw e;
  }
}
const fp=n=>(n>=0?'+':'')+Number(n).toFixed(2)+'%';

async function api(params){
  const qs=new URLSearchParams(params).toString();
  return fetchWithTimeout(`/api/market?${qs}`, 10000);
}

async function fetchMarket(){
  // Fetch all data directly from Bybit browser API — no proxy needed
  const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','SUIUSDT'];
  const cgIds = {BTCUSDT:'bitcoin',ETHUSDT:'ethereum',SOLUSDT:'solana',XRPUSDT:'ripple',SUIUSDT:'sui'};

  // Prices from Bybit (browser CORS works)
  const tickerResults = await Promise.allSettled(syms.map(s =>
    fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`, 6000)
  ));

  tickerResults.forEach((r, i) => {
    const s = syms[i];
    const coin = Object.keys(COINS).find(c => COINS[c].sym === s);
    if (!coin) return;
    let price = 0, change24h = 0, high24h = 0, low24h = 0, volume24h = 0;
    if (r.status === 'fulfilled') {
      const t = r.value?.result?.list?.[0];
      if (t) {
        price = parseFloat(t.lastPrice) || 0;
        const open24 = parseFloat(t.prevPrice24h) || price;
        change24h = open24 ? (price - open24) / open24 * 100 : 0;
        high24h = parseFloat(t.highPrice24h) || 0;
        low24h = parseFloat(t.lowPrice24h) || 0;
        volume24h = parseFloat(t.turnover24h) || 0;
      }
    }
    mktData[coin] = { price, change24h, high24h, low24h, volume24h, funding: 0, oi: 0, oiNotional: 0, fgValue: 50, fgLabel: 'Neutral' };
  });

  // Funding + OI from Bybit (best effort)
  await Promise.allSettled(Object.entries(COINS).map(async ([coin, meta]) => {
    try {
      const t = (await fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${meta.sym}`, 5000))?.result?.list?.[0];
      if (t) {
        mktData[coin].funding = parseFloat(t.fundingRate) * 100 || 0;
        const oi = parseFloat(t.openInterest) || 0;
        mktData[coin].oi = oi;
        mktData[coin].oiNotional = oi * mktData[coin].price;
      }
    } catch(e) {}
  }));

  // Fear & Greed (best effort)
  try {
    const fg = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', 5000);
    const val = parseInt(fg.data[0]?.value || 50);
    const lbl = fg.data[0]?.value_classification || 'Neutral';
    Object.keys(COINS).forEach(c => { mktData[c].fgValue = val; mktData[c].fgLabel = lbl; });
  } catch(e) {}
}


async function fetchKlines(coin,tf){
  const key=coin+'_'+tf;
  if(klCache[key])return klCache[key];
  // Bybit allows browser CORS — fetch klines directly
  const intervalMap={'1w':'W','1d':'D','4h':'240','1h':'60','15m':'15','5m':'5'};
  const bybitInterval=intervalMap[tf]||'D';
  try{
    const r=await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${COINS[coin].sym}&interval=${bybitInterval}&limit=100`,{signal:AbortSignal.timeout(8000)});
    const j=await r.json();
    const list=j?.result?.list;
    if(Array.isArray(list)&&list.length>0){
      const klines=list.reverse().map(k=>({t:parseInt(k[0]),o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
      klCache[key]=klines;return klines;
    }
  }catch(e){console.warn('Bybit klines failed, using fallback',e);}
  // Fallback: generate synthetic klines from current price for TA calculations
  const price=mktData[coin]?.price||1;
  const klines=Array.from({length:60},(_,i)=>{
    const base=price*(1+(Math.random()-0.5)*0.02);
    const h=base*(1+Math.random()*0.01),l=base*(1-Math.random()*0.01);
    return{t:Date.now()-(60-i)*86400000,o:base,h,l,c:base*(1+(Math.random()-0.5)*0.005),v:1000000};
  });
  klCache[key]=klines;return klines;
}








// ── Pivot swing high/low detection ──────────────────────────────────────────
// strength=3 means candle must be highest/lowest in a 7-candle window around it
function findPivotLevels(klines, strength=3) {
  if (!klines || klines.length < strength*2+2) return { highs:[], lows:[] };
  const highs=[], lows=[];
  for(let i=strength; i<klines.length-strength; i++){
    let isH=true, isL=true;
    for(let j=i-strength; j<=i+strength; j++){
      if(j===i) continue;
      if(klines[j].h >= klines[i].h) isH=false;
      if(klines[j].l <= klines[i].l) isL=false;
    }
    if(isH) highs.push(klines[i].h);
    if(isL)  lows.push(klines[i].l);
  }
  return { highs:highs.slice(-6), lows:lows.slice(-6) };
}

function calcTA(klines){
  if(!klines||klines.length<14)return{rsi:50,ema20:0,ema50:null,atr:0,trend:'neutral',support:0,resistance:0,volProfile:[],poc:0};
  const cl=klines.map(k=>k.c),hi=klines.map(k=>k.h),lo=klines.map(k=>k.l);
  function ema(arr,p){const k=2/(p+1);let e=arr.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<arr.length;i++)e=arr[i]*k+e*(1-k);return e;}
  const ema20=ema(cl,20);
  const ema50=cl.length>=50?ema(cl,50):null;
  let g=0,l=0;
  for(let i=cl.length-14;i<cl.length;i++){const d=cl[i]-cl[i-1];if(d>0)g+=d;else l+=Math.abs(d);}
  const rsi=100-(100/(1+(l===0?999:g/l)));
  let atrS=0;
  for(let i=klines.length-14;i<klines.length;i++){const prev=cl[i-1]||cl[i];atrS+=Math.max(hi[i]-lo[i],Math.abs(hi[i]-prev),Math.abs(lo[i]-prev));}
  const atr=atrS/14;
  const curr=cl[cl.length-1];
  let trend='neutral';
  if(ema50){if(curr>ema20&&ema20>ema50)trend='bullish';else if(curr<ema20&&ema20<ema50)trend='bearish';else if(curr>ema50)trend='mild-bullish';else trend='mild-bearish';}
  else trend=curr>ema20?'bullish':'bearish';
  // Pivot-based support/resistance — stable across refreshes
  const pivots=findPivotLevels(klines.slice(-60),3);
  const pivotsBelow=pivots.lows.filter(p=>p<curr);
  const pivotsAbove=pivots.highs.filter(p=>p>curr);
  const rec=klines.slice(-20);
  const support   =pivotsBelow.length>0?Math.max(...pivotsBelow):Math.min(...rec.map(k=>k.l));
  const resistance=pivotsAbove.length>0?Math.min(...pivotsAbove):Math.max(...rec.map(k=>k.h));
  const minP=Math.min(...lo),maxP=Math.max(...hi),range=maxP-minP,buckets=8;
  const volProfile=Array.from({length:buckets},(_,i)=>({price:minP+range*(i+0.5)/buckets,vol:0,pct:0}));
  klines.forEach(k=>{const mid=(k.h+k.l)/2;const idx=Math.min(buckets-1,Math.floor((mid-minP)/range*buckets));if(volProfile[idx])volProfile[idx].vol+=k.v;});
  const maxVol=Math.max(...volProfile.map(b=>b.vol));
  volProfile.forEach(b=>{b.pct=maxVol>0?b.vol/maxVol:0;});
  const poc=volProfile.reduce((a,b)=>b.vol>a.vol?b:a,volProfile[0]).price;
  return{rsi,ema20,ema50,atr,trend,support,resistance,volProfile,poc};
}

function calcEntries(price,ta,dec){
  const atr=ta.atr||price*0.02;
  const supportEntry=+(ta.support+atr*0.3).toFixed(dec);
  const pullbackEntry=+(price-atr*0.75).toFixed(dec);
  // Long entry must be BELOW current price (waiting for pullback)
  const optimalLong=Math.min(Math.max(supportEntry,pullbackEntry), price);
  const resistEntry=+(ta.resistance-atr*0.3).toFixed(dec);
  const rallyEntry=+(price+atr*0.75).toFixed(dec);
  // Short entry must be ABOVE current price (waiting for rally to resistance)
  // If resistance is already below current price, use rallyEntry instead
  const optimalShort=resistEntry>price ? Math.min(resistEntry,rallyEntry) : rallyEntry;
  const isOpt=entryMode==='optimal';
  return{long:isOpt?optimalLong:price,short:isOpt?optimalShort:price,atr,pullbackPct:((price-(isOpt?optimalLong:price))/price*100),rallyPct:(((isOpt?optimalShort:price)-price)/price*100)};
}

function calcSetups(entries,dec){
  const{long:lE,short:sE,atr}=entries;

  // Calculate max safe stop distance based on selected leverage (Blofin formula)
  const mmr=activeLev>=100?0.005:activeLev>=25?0.004:0.003;
  const imr=1/activeLev;
  const liqDist=(imr-mmr); // as decimal
  const maxStopDec=liqDist*0.6; // max 60% of liq distance

  // ATR-based stop as decimal
  const atrStopLong=atr*1.5/lE;
  const atrStopShort=atr*1.5/sE;

  // Use tighter of ATR stop or leverage-adjusted max stop
  const longStopDec=activeLev>1?Math.min(atrStopLong,maxStopDec):atrStopLong;
  const shortStopDec=activeLev>1?Math.min(atrStopShort,maxStopDec):atrStopShort;

  // Long setup
  const lSL=+(lE*(1-longStopDec)).toFixed(dec);
  const lRisk=longStopDec*100;
  // TP scaled proportionally to risk — minimum 2:1 R:R
  const lTP1=+(lE*(1+longStopDec*2.5)).toFixed(dec);
  const lTP2=+(lE*(1+longStopDec*4.0)).toFixed(dec);
  const lRew=(lTP1-lE)/lE*100;
  const lRR=lRew/lRisk;

  // Short setup
  const sSL=+(sE*(1+shortStopDec)).toFixed(dec);
  const sRisk=shortStopDec*100;
  const sTP1=+(sE*(1-shortStopDec*2.5)).toFixed(dec);
  const sTP2=+(sE*(1-shortStopDec*4.0)).toFixed(dec);
  const sRew=(sE-sTP1)/sE*100;
  const sRR=sRew/sRisk;

  // Flag if leverage-adjusted (stop was capped by lev)
  const levAdjustedLong=activeLev>1&&atrStopLong>maxStopDec;
  const levAdjustedShort=activeLev>1&&atrStopShort>maxStopDec;

  // Liquidation prices inline (Blofin isolated formula)
  const takerFee=0.0005;
  const liqLong  = +(lE*(1-imr+mmr+takerFee)).toFixed(dec);
  const liqShort = +(sE*(1+imr-mmr-takerFee)).toFixed(dec);
  const liqDistPct = (imr-mmr)*100; // total liq distance %

  return{lE,lSL,lTP1,lTP2,lRisk,lRew,lRR,sE,sSL,sTP1,sTP2,sRisk,sRew,sRR,
    levAdjustedLong,levAdjustedShort,
    maxStopPct:maxStopDec*100,
    atrStopLongPct:atrStopLong*100,
    atrStopShortPct:atrStopShort*100,
    liqLong,liqShort,liqDistPct};
}

function calcLiqZones(price, atr, oi, funding, oiNotional) {
  // Estimate liquidation clusters using price action + OI + funding
  // Methodology:
  // - Funding > 0 = long-heavy market = long liq clusters BELOW price
  // - Funding < 0 = short-heavy market = short liq clusters ABOVE price
  // - ATR used to estimate typical stop distances at each leverage tier
  // - OI size determines cluster significance

  const fundingBias = funding > 0.01 ? 'long-heavy' : funding < -0.01 ? 'short-heavy' : 'neutral';
  const oiB = oiNotional || (oi * price) || 0;

  // Leverage tiers and their typical stop distances from entry
  const leverageTiers = [
    { lev: 10,  stopPct: 0.09, label: '10x' },
    { lev: 25,  stopPct: 0.038, label: '25x' },
    { lev: 50,  stopPct: 0.018, label: '50x' },
    { lev: 100, stopPct: 0.009, label: '100x' },
    { lev: 125, stopPct: 0.007, label: '125x' },
  ];

  // ATR-based key levels (recent swing highs/lows where positions were opened)
  const atrMult = atr / price; // ATR as % of price

  // Long liquidation zones (below price) — where longs get wiped
  const longLiqZones = leverageTiers.map(t => {
    const liqPrice = +(price * (1 - t.stopPct)).toFixed(2);
    // Weight by how likely positions exist here (funding + ATR proximity)
    const fundingWeight = fundingBias === 'long-heavy' ? 1.5 : fundingBias === 'neutral' ? 1.0 : 0.6;
    const significance = fundingWeight * (t.lev / 125); // higher lev = smaller cluster usually
    return {
      price: liqPrice,
      leverage: t.label,
      distance: (t.stopPct * 100).toFixed(2) + '%',
      significance: significance > 1 ? 'high' : significance > 0.6 ? 'medium' : 'low'
    };
  });

  // Short liquidation zones (above price) — where shorts get wiped
  const shortLiqZones = leverageTiers.map(t => {
    const liqPrice = +(price * (1 + t.stopPct)).toFixed(2);
    const fundingWeight = fundingBias === 'short-heavy' ? 1.5 : fundingBias === 'neutral' ? 1.0 : 0.6;
    const significance = fundingWeight * (t.lev / 125);
    return {
      price: liqPrice,
      leverage: t.label,
      distance: (t.stopPct * 100).toFixed(2) + '%',
      significance: significance > 1 ? 'high' : significance > 0.6 ? 'medium' : 'low'
    };
  });

  // Find the most significant clusters (highest OI concentration)
  const topLongLiq = longLiqZones.filter(z => z.significance !== 'low');
  const topShortLiq = shortLiqZones.filter(z => z.significance !== 'low');

  // Key insight: nearest HIGH significance cluster is the most likely sweep target
  const nearestLongSweep = longLiqZones[longLiqZones.length - 1]; // 125x cluster = nearest
  const nearestShortSweep = shortLiqZones[shortLiqZones.length - 1];

  // Major cluster = where most leverage tiers converge (10x-50x range)
  const majorLongCluster = {
    priceRange: `$${longLiqZones[2].price.toLocaleString()} - $${longLiqZones[0].price.toLocaleString()}`,
    low: longLiqZones[0].price,
    high: longLiqZones[2].price,
    label: `Major long liq zone (10x-50x)`
  };
  const majorShortCluster = {
    priceRange: `$${shortLiqZones[2].price.toLocaleString()} - $${shortLiqZones[0].price.toLocaleString()}`,
    low: shortLiqZones[2].price,
    high: shortLiqZones[0].price,
    label: `Major short liq zone (10x-50x)`
  };

  // Liq sweep entry setups
  // Long sweep entry: enter at top of long liq cluster (after sweep wipes longs)
  // Stop: just below the cluster bottom (where even 10x longs get wiped)
  // Target: short liq cluster above (next magnet)
  const longSweepEntry = {
    entry: +(price * (1 - 0.018)).toFixed(2),  // 50x liq level - enter here after sweep
    stop:  +(price * (1 - 0.095)).toFixed(2),   // just below 10x liq = fully swept
    tp1:   +(price * (1 + 0.018)).toFixed(2),   // back to current price
    tp2:   +(price * (1 + 0.038)).toFixed(2),   // short 25x liq cluster above
    tp3:   +(price * (1 + 0.095)).toFixed(2),   // major short liq cluster
    rr:    +((0.018 + 0.038) / (0.018 - 0 + 0.095 - 0.018)).toFixed(2),
    type:  'Long after long liq sweep',
    logic: 'Enter long inside long liq zone after sweep, target short liq above'
  };

  // Short sweep entry: enter at bottom of short liq cluster (after squeeze wipes shorts)
  const shortSweepEntry = {
    entry: +(price * (1 + 0.018)).toFixed(2),  // 50x short liq level
    stop:  +(price * (1 + 0.095)).toFixed(2),   // just above 10x short liq
    tp1:   +(price * (1 - 0.018)).toFixed(2),   // back to current price
    tp2:   +(price * (1 - 0.038)).toFixed(2),   // long 25x liq cluster below
    tp3:   +(price * (1 - 0.095)).toFixed(2),   // major long liq cluster
    rr:    +((0.018 + 0.038) / (0.095 - 0.018)).toFixed(2),
    type:  'Short after short liq squeeze',
    logic: 'Enter short inside short liq zone after squeeze, target long liq below'
  };

  return {
    fundingBias, oiB,
    longLiqZones, shortLiqZones,
    topLongLiq, topShortLiq,
    nearestLongSweep, nearestShortSweep,
    majorLongCluster, majorShortCluster,
    longSweepEntry, shortSweepEntry
  };
}

// Safe number formatter — handles 0, NaN, undefined without throwing
function safeFormat(n, dec) {
  const v = parseFloat(n);
  if (!isFinite(v) || v === 0) return '\u2014';
  try {
    return v.toLocaleString('en-US', { minimumFractionDigits: Math.min(dec,2), maximumFractionDigits: Math.min(dec,2) });
  } catch(e) {
    return v.toFixed(Math.min(dec,2));
  }
}

// ── Liq zones table card (above-price / below-price cluster rows) ──────────────
function renderLiqCard(liq, price, dec) {
  if (!liq) return '';
  try {
    const fn2 = n => safeFormat(n, dec);
    const biasColor = liq.fundingBias === 'long-heavy' ? 'var(--green)' : liq.fundingBias === 'short-heavy' ? 'var(--red)' : 'var(--amber)';
    const longRows = liq.longLiqZones.map(z =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text2)">${z.leverage} longs</span>
        <span style="font-family:var(--mono);font-size:12px;color:var(--red)">$${fn2(z.price)}</span>
        <span style="font-size:10px;color:var(--text3)">${z.distance} below</span>
        <span style="font-size:9px;padding:2px 6px;border-radius:3px;background:${z.significance==='high'?'rgba(255,77,77,.2)':'rgba(255,77,77,.08)'};color:var(--red)">${z.significance}</span>
      </div>`
    ).join('');
    const shortRows = liq.shortLiqZones.map(z =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text2)">${z.leverage} shorts</span>
        <span style="font-family:var(--mono);font-size:12px;color:var(--green)">$${fn2(z.price)}</span>
        <span style="font-size:10px;color:var(--text3)">${z.distance} above</span>
        <span style="font-size:9px;padding:2px 6px;border-radius:3px;background:${z.significance==='high'?'rgba(0,208,132,.2)':'rgba(0,208,132,.08)'};color:var(--green)">${z.significance}</span>
      </div>`
    ).join('');
    return `<div class="card full" style="border-color:rgba(167,139,250,0.25)">
      <div class="card-title" style="color:var(--purple)">Estimated liquidation zones
        <span style="margin-left:10px;font-size:10px;padding:2px 8px;border-radius:3px;background:rgba(167,139,250,.15);color:var(--purple)">Calculated \u2022 Not Coinglass</span>
        <span style="margin-left:6px;font-size:10px;color:${biasColor};font-family:var(--mono)">${liq.fundingBias.toUpperCase()}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:12px">
        <div style="background:rgba(255,77,77,0.05);border:1px solid var(--red-b);border-radius:8px;padding:12px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--red);font-family:var(--mono);margin-bottom:8px">\uD83D\uDD34 Long liquidations (below price)</div>
          ${longRows}
          <div style="margin-top:8px;padding:6px 8px;background:rgba(255,77,77,.1);border-radius:5px;font-size:11px;color:var(--red);font-family:var(--mono)">
            Major cluster: ${liq.majorLongCluster.priceRange}
          </div>
        </div>
        <div style="background:rgba(0,208,132,0.05);border:1px solid var(--green-b);border-radius:8px;padding:12px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--green);font-family:var(--mono);margin-bottom:8px">\uD83D\uDFE2 Short liquidations (above price)</div>
          ${shortRows}
          <div style="margin-top:8px;padding:6px 8px;background:rgba(0,208,132,.1);border-radius:5px;font-size:11px;color:var(--green);font-family:var(--mono)">
            Major cluster: ${liq.majorShortCluster.priceRange}
          </div>
        </div>
      </div>
      <div style="padding:8px 12px;background:rgba(167,139,250,.05);border:1px solid rgba(167,139,250,.2);border-radius:6px;font-size:11px;color:var(--text2);font-family:var(--mono);line-height:1.6">
        \uD83D\uDCA1 Price often sweeps nearest cluster before reversing. Long liq at $${fn2(liq.nearestLongSweep.price)} and short liq at $${fn2(liq.nearestShortSweep.price)} are closest high-leverage targets.
      </div>
    </div>`;
  } catch(e) {
    console.warn('renderLiqCard error:', e);
    return `<div class="card full" style="border-color:rgba(167,139,250,0.25)"><div class="card-title" style="color:var(--purple)">Estimated liquidation zones</div><div style="font-size:11px;color:var(--text3);font-family:var(--mono)">Liq zone data error: ${e.message}</div></div>`;
  }
}

// ── Sweep entry card — separate card so it always renders independently ────────
// OLD renderSweepCard kept for rollback — no longer called
// function renderSweepCard is preserved below after renderLiqScaleInCard

// ── Liq Zone Scale-In Setup card (replaces sweep card) ────────────────────────
// Shows only when price is within 1.5 ATR of the liq cluster top.
// Uses pivot-anchored cluster levels (stable across refreshes).
// Reuses: findPivotLevels, getVolumeMultiple, ta.atr, cvdData, mktData
function renderLiqScaleInCard(coin, tf, price, ta, klines, cvdData, dec, liqZones) {
  try {
    if (!klines || klines.length < 20 || !ta || !ta.atr) return '';
    const atr = ta.atr;
    const fn2 = n => safeFormat(n, dec);
    const d   = mktData[coin] || {};

    // ── Build one card for long side, one for short side ─────────────────────
    function buildCard(side, zones) {
      if (!zones || zones.length < 3) return '';
      const isLong = side === 'long';

      const z125 = zones.find(z => z.leverage === '125x') || zones[0];
      const z50  = zones.find(z => z.leverage === '50x')  || zones[1];
      const z25  = zones.find(z => z.leverage === '25x')  || zones[2];
      const z10  = zones.find(z => z.leverage === '10x')  || zones[zones.length-1];

      // Long: cluster is BELOW price. Short: cluster is ABOVE price.
      const clusterTop    = isLong ? z125.price : z125.price; // nearest to price
      const clusterMid    = z50.price;
      const clusterBottom = isLong ? z25.price  : z25.price;  // furthest from price
      const zoneRange     = Math.abs(clusterTop - clusterBottom).toFixed(dec);

      // Leverage-aware stop — capped to max safe distance for selected leverage
      // Uses same Blofin formula as the main setup cards
      const mmrS    = activeLev >= 100 ? 0.005 : activeLev >= 25 ? 0.004 : 0.003;
      const imrS    = 1 / activeLev;
      const maxSDpct = (imrS - mmrS) * 0.6;   // max safe stop as decimal

      // For low leverage (≤25x) the ATR-based stop is fine and tighter
      // For high leverage (>25x) cap to max safe distance
      const useATRStop = activeLev <= 25;

      const stopLoss = isLong
        ? useATRStop
          ? +(z10.price - atr * 0.5).toFixed(dec)             // low lev: below 10x cluster
          : +(clusterBottom * (1 - maxSDpct)).toFixed(dec)     // high lev: max safe below bottom
        : useATRStop
          ? +(z10.price + atr * 0.5).toFixed(dec)             // low lev: above 10x cluster
          : +(clusterBottom * (1 + maxSDpct)).toFixed(dec);    // high lev: max safe above bottom

      const stopPctDisplay = Math.abs(stopLoss - (isLong ? clusterTop : clusterTop)) / clusterTop * 100;

      // Long TPs: target short liq cluster above (price goes up)
      // Short TPs: target long liq cluster below (price goes down)
      const longTP1  = ta.resistance || +(price * 1.018).toFixed(dec);
      const longTP2  = +(price * 1.038).toFixed(dec);
      const shortTP1 = +(price * 0.982).toFixed(dec);   // back to current price area
      const shortTP2 = z10 ? +(z10.price * 0.998).toFixed(dec) : +(price * 0.962).toFixed(dec); // long liq cluster below
      const tp1 = isLong ? longTP1 : shortTP1;
      const tp2 = isLong ? longTP2 : shortTP2;

      // Proximity: show if price is within 1.5 ATR of nearest cluster level
      // Long: nearest cluster is clusterTop (below price)
      // Short: nearest cluster is clusterTop (above price, sorted ascending so [0] is nearest)
      const nearest = clusterTop;
      if (Math.abs(price - nearest) > atr * 1.5) return '';

      // Confidence filters
      const volMult       = getVolumeMultiple(klines);
      const isVolumeQuiet = volMult < 1.8;
      const isCVDAligned  = cvdData && (isLong
        ? (cvdData.trend === 'bearish' || cvdData.trend === 'neutral')  // selling into sweep = good for long
        : (cvdData.trend === 'bullish' || cvdData.trend === 'neutral')); // buying into squeeze = good for short
      const isFundingAligned = isLong
        ? (d.funding || 0) > 0    // longs heavy = more longs to sweep
        : (d.funding || 0) < 0;   // shorts heavy = more shorts to squeeze
      const isEMAAligned  = isLong
        ? (ta.ema50 ? price > ta.ema50 : price > ta.ema20)
        : (ta.ema50 ? price < ta.ema50 : price < ta.ema20);
      const isNearCluster = Math.abs(price - nearest) < atr;

      let confScore = 0;
      if (isVolumeQuiet)   confScore++;
      if (isCVDAligned)    confScore++;
      if (isFundingAligned)confScore++;
      if (isEMAAligned)    confScore++;
      if (isNearCluster)   confScore++;

      const confLabel = confScore >= 4 ? 'HIGH' : confScore >= 3 ? 'MEDIUM' : 'LOW';
      const confColor = confScore >= 4 ? 'var(--green)' : confScore >= 3 ? 'var(--amber)' : 'var(--red)';
      const confBg    = confScore >= 4 ? 'rgba(0,208,132,0.15)' : confScore >= 3 ? 'rgba(245,166,35,0.15)' : 'rgba(255,77,77,0.15)';
      const borderCol = isLong ? 'rgba(0,208,132,0.4)' : 'rgba(255,77,77,0.4)';
      const headCol   = isLong ? 'var(--green)' : 'var(--red)';
      const sideLabel = isLong ? 'Long' : 'Short';
      const distPct   = ((Math.abs(price - nearest)) / price * 100).toFixed(2);

      const filterRows = [
        { label: 'Volume quiet (no spike)',          pass: isVolumeQuiet,    val: volMult.toFixed(1)+'x' },
        { label: 'CVD '+(isLong?'neutral/bearish':'neutral/bullish'), pass: isCVDAligned, val: cvdData ? cvdData.trend : '--' },
        { label: 'Funding '+(isLong?'positive (longs heavy)':'negative (shorts heavy)'), pass: isFundingAligned, val: d.funding ? d.funding.toFixed(4)+'%' : '--' },
        { label: 'Price '+(isLong?'above':'below')+' 50 EMA (structure)', pass: isEMAAligned, val: isEMAAligned ? 'yes' : 'no' },
        { label: 'Within 1 ATR of cluster',          pass: isNearCluster,    val: distPct+'% away' }
      ].map(f => '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
        + '<span style="font-size:10px;color:var(--text2);font-family:var(--mono)">'+(f.pass ? '✓ ' : '✗ ')+f.label+'</span>'
        + '<span style="font-size:10px;color:'+(f.pass?'var(--green)':'var(--red)')+';font-family:var(--mono)">'+f.val+'</span>'
        + '</div>').join('');

      const levWarn = activeLev > 50
        ? '<div style="background:rgba(255,77,77,0.1);border:1px solid var(--red-b);border-radius:6px;padding:8px 12px;margin-top:10px;font-size:11px;color:var(--red);font-family:var(--mono)">DANGER: You are on '+activeLev+'x. Use 25-50x max for this setup or size 10-20% of normal.</div>'
        : '';

      const alreadyLabel = isLong
        ? (price < clusterTop ? 'Already swept? Enter full size at current price, stop below $'+fn2(stopLoss) : '')
        : (price > clusterTop ? 'Already squeezed? Enter full size at current price, stop above $'+fn2(stopLoss) : '');
      const alreadyHtml = alreadyLabel
        ? '<div style="background:rgba(74,158,255,0.08);border:1px solid var(--blue-b);border-radius:6px;padding:8px 12px;margin-top:10px;font-size:11px;color:var(--blue);font-family:var(--mono)">'+alreadyLabel+'</div>'
        : '';

      return '<div class="card" style="border-color:'+borderCol+';background:rgba(0,0,0,0.02);flex:1;min-width:300px">'
        + '<div class="card-title" style="color:'+headCol+';display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">'
        + '<span>'+sideLabel+' Scale-In</span>'
        + '<span style="font-size:10px;background:'+confBg+';color:'+confColor+';border:1px solid '+confColor+';border-radius:3px;padding:2px 8px;font-family:var(--mono)">'+confScore+'/5 '+confLabel+'</span>'
        + '</div>'

        // Zone range
        + '<div style="background:var(--bg3);border-radius:8px;padding:10px;margin-bottom:10px">'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        + '<span style="font-size:9px;color:var(--text3);font-family:var(--mono)">SWEEP ZONE</span>'
        + '<span style="font-size:9px;color:var(--amber);font-family:var(--mono)">$'+fn2(zoneRange)+' range</span>'
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;font-family:var(--mono)">'
        + '<span style="font-size:12px;color:'+headCol+'">$'+fn2(isLong ? clusterTop : clusterBottom)+'</span>'
        + '<span style="font-size:9px;color:var(--text3)">--zone--</span>'
        + '<span style="font-size:12px;color:'+(isLong?'var(--red)':'var(--green)')+'">$'+fn2(isLong ? clusterBottom : clusterTop)+'</span>'
        + '</div></div>'

        // Scale-in levels
        + '<div style="margin-bottom:10px">'
        + '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);margin-bottom:6px">Scale-in levels</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">'
        + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Entry 1 — '+(isLong?'Top':'Bottom')+' (40%)</span>'
        + '<span style="font-size:13px;font-weight:700;color:var(--blue);font-family:var(--mono)">$'+fn2(clusterTop)+'</span></div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">'
        + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Entry 2 — Mid (35%)</span>'
        + '<span style="font-size:13px;font-weight:700;color:var(--blue);font-family:var(--mono)">$'+fn2(clusterMid)+'</span></div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0">'
        + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Entry 3 — '+(isLong?'Bottom':'Top')+' (25%)</span>'
        + '<span style="font-size:13px;font-weight:700;color:var(--blue);font-family:var(--mono)">$'+fn2(clusterBottom)+'</span></div>'
        + '</div>'

        // Stop + TPs
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">'
        + '<div style="background:rgba(255,77,77,0.07);border:1px solid var(--red-b);border-radius:7px;padding:8px;text-align:center">'
        + '<div style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-bottom:3px">STOP</div>'
        + '<div style="font-size:13px;font-weight:700;color:var(--red);font-family:var(--mono)">$'+fn2(stopLoss)+'</div>'
        + '<div style="font-size:9px;color:var(--text3);font-family:var(--mono)">'+(useATRStop ? 'below cluster' : 'capped for '+activeLev+'x')+'</div></div>'
        + '<div style="background:rgba(0,208,132,0.07);border:1px solid var(--green-b);border-radius:7px;padding:8px;text-align:center">'
        + '<div style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-bottom:3px">TP1</div>'
        + '<div style="font-size:13px;font-weight:700;color:var(--green);font-family:var(--mono)">$'+fn2(tp1)+'</div></div>'
        + '<div style="background:rgba(0,208,132,0.07);border:1px solid var(--green-b);border-radius:7px;padding:8px;text-align:center">'
        + '<div style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-bottom:3px">TP2</div>'
        + '<div style="font-size:13px;font-weight:700;color:var(--green);font-family:var(--mono)">$'+fn2(tp2)+'</div></div>'
        + '</div>'

        // Confidence filters
        + '<div style="background:var(--bg3);border-radius:7px;padding:8px">'
        + '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);margin-bottom:5px">Confidence filters</div>'
        + filterRows + '</div>'
        + levWarn + alreadyHtml
        + '</div>';
    }

    // Build both sides
    const longCard  = liqZones ? buildCard('long',  liqZones.longLiqZones)  : '';
    const shortCard = liqZones ? buildCard('short', liqZones.shortLiqZones) : '';

    if (!longCard && !shortCard) return '';

    return '<div class="card full" style="border-color:rgba(245,166,35,0.4);background:rgba(245,166,35,0.02)">'
      + '<div class="card-title" style="color:var(--amber)">Liq Zone Scale-In Setup'
      + '<span style="margin-left:10px;font-size:10px;color:var(--text3);font-family:var(--mono)">Only shows when price is near a cluster</span></div>'
      + '<p style="font-size:11px;color:var(--text2);font-family:var(--mono);margin:0 0 12px;line-height:1.6">Counter-trend entry inside the liq cluster as price sweeps through. Scale in as it moves. Stop below the full zone. Use 25-50x max.</p>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">'
      + (longCard  || '<div style="background:var(--bg3);border-radius:10px;padding:14px;display:flex;align-items:center;justify-content:center"><span style="font-size:11px;color:var(--text3);font-family:var(--mono)">Long cluster not in range</span></div>')
      + (shortCard || '<div style="background:var(--bg3);border-radius:10px;padding:14px;display:flex;align-items:center;justify-content:center"><span style="font-size:11px;color:var(--text3);font-family:var(--mono)">Short cluster not in range</span></div>')
      + '</div></div>';

  } catch(e) {
    console.warn('renderLiqScaleInCard error:', e);
    return '';
  }
}

function renderSweepCard(liq, dec) {
  if (!liq || !liq.longSweepEntry || !liq.shortSweepEntry) return '';
  try {
    const fn2 = n => safeFormat(n, dec);
    const ls = liq.longSweepEntry;
    const ss = liq.shortSweepEntry;

    // Blofin leverage params for current selection
    const mmr      = activeLev >= 100 ? 0.005 : activeLev >= 25 ? 0.004 : 0.003;
    const imr      = 1 / activeLev;
    const fee      = 0.0005;
    const maxStopD = (imr - mmr) * 0.6;   // max safe stop as decimal

    // Long sweep: liq price at this leverage from the sweep entry
    const lsLiq      = +(ls.entry * (1 - imr + mmr + fee)).toFixed(dec);
    const lsLiqDistP = (ls.entry - lsLiq) / ls.entry * 100;
    const lsStopDistP= (ls.entry - ls.stop) / ls.entry * 100;
    const lsDanger   = lsStopDistP > lsLiqDistP;      // stop is PAST liq — would liquidate first
    const lsSafe     = +(ls.entry * (1 - maxStopD)).toFixed(dec);

    // Short sweep
    const ssLiq      = +(ss.entry * (1 + imr - mmr - fee)).toFixed(dec);
    const ssLiqDistP = (ssLiq - ss.entry) / ss.entry * 100;
    const ssStopDistP= (ss.stop - ss.entry) / ss.entry * 100;
    const ssDanger   = ssStopDistP > ssLiqDistP;
    const ssSafe     = +(ss.entry * (1 + maxStopD)).toFixed(dec);

    const anyDanger  = lsDanger || ssDanger;
    const levNote    = anyDanger
      ? `<span style="margin-left:10px;font-size:10px;background:rgba(255,77,77,.2);color:var(--red);padding:2px 8px;border-radius:3px;font-family:var(--mono)">DANGER: ${activeLev}x liquidates before sweep stops</span>`
      : `<span style="margin-left:10px;font-size:10px;background:rgba(0,208,132,.1);color:var(--green);padding:2px 8px;border-radius:3px;font-family:var(--mono)">Stops safe at ${activeLev}x</span>`;

    function dangerBox(danger, liq, liqP, stopP, safeStop, isLong) {
      if (!danger) return `<div style="background:rgba(0,208,132,0.06);border:1px solid var(--green-b);border-radius:4px;padding:5px 8px;margin-bottom:8px;font-size:10px;font-family:var(--mono);color:var(--green)">Liq $${fn2(liq)} (${liqP.toFixed(3)}%) — stop triggers first. Safe at ${activeLev}x.</div>`;
      return `<div style="background:rgba(255,77,77,0.12);border:1px solid var(--red-b);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-family:var(--mono);font-size:10px;color:var(--red);line-height:1.6">
        <strong>DANGER at ${activeLev}x:</strong> Liq fires at $${fn2(liq)} (${liqP.toFixed(3)}%) — your stop at ${stopP.toFixed(2)}% away fires AFTER liq. You get liquidated, not stopped out.<br>
        <span style="color:var(--amber)"><strong>Use instead: $${fn2(safeStop)} (${(maxStopD*100).toFixed(3)}% max safe for ${activeLev}x)</strong></span>
      </div>`;
    }

    function stopRow(danger, originalStop, safeStop, isLong) {
      const displayStop = danger ? safeStop : originalStop;
      const label = danger ? `Safe stop (${activeLev}x)` : 'Stop';
      const struck = danger
        ? `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:10px;color:var(--text3);font-family:var(--mono)">Original stop (NOT for ${activeLev}x)</span>
            <span style="font-size:10px;color:var(--text3);font-family:var(--mono);text-decoration:line-through">$${fn2(originalStop)}</span>
           </div>`
        : '';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:11px;color:${danger?'var(--amber)':'var(--text2)'};font-family:var(--mono)">${label}</span>
          <span style="font-size:12px;color:var(--red);font-family:var(--mono)">$${fn2(displayStop)}</span>
        </div>${struck}`;
    }

    function liqRow(liqPrice, liqDistP) {
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Liq @ ${activeLev}x</span>
        <span style="font-size:11px;color:rgba(255,77,77,0.6);font-family:var(--mono)">$${fn2(liqPrice)} (${liqDistP.toFixed(3)}%)</span>
      </div>`;
    }

    function tpRow(label, price) {
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:11px;color:var(--text2);font-family:var(--mono)">${label}</span>
        <span style="font-size:12px;color:var(--green);font-family:var(--mono)">$${fn2(price)}</span>
      </div>`;
    }

    return `<div class="card full" style="border-color:rgba(167,139,250,0.3);background:rgba(167,139,250,0.03)">
      <div class="card-title" style="color:var(--purple)">\u26A1 Liquidity sweep entry setups
        <span style="margin-left:8px;font-size:10px;color:var(--text3);font-family:var(--mono)">Enter AFTER sweep confirms, not before</span>
        ${levNote}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">

        <!-- Long sweep -->
        <div style="background:rgba(0,208,132,0.05);border:1px solid var(--green-b);border-radius:8px;padding:14px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--green);font-family:var(--mono);margin-bottom:6px">\uD83D\uDFE2 Long after long liq sweep</div>
          <div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:10px;line-height:1.4">${ls.logic}</div>
          ${dangerBox(lsDanger, lsLiq, lsLiqDistP, lsStopDistP, lsSafe, true)}
          <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Enter at</span>
            <span style="font-size:14px;font-weight:700;color:var(--blue);font-family:var(--mono)">$${fn2(ls.entry)}</span>
          </div>
          ${stopRow(lsDanger, ls.stop, lsSafe, true)}
          ${liqRow(lsLiq, lsLiqDistP)}
          ${tpRow('TP1', ls.tp1)}
          ${tpRow('TP2', ls.tp2)}
          <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0">
            <span style="font-size:11px;color:var(--text2);font-family:var(--mono)">TP3 (major)</span>
            <span style="font-size:12px;color:var(--green);font-family:var(--mono)">$${fn2(ls.tp3)}</span>
          </div>
          <div style="margin-top:10px;padding:6px 10px;background:rgba(0,208,132,.1);border-radius:4px;font-size:10px;font-family:var(--mono);color:var(--green)">
            Wait for sweep candle, enter on next 1H close above entry
          </div>
        </div>

        <!-- Short squeeze -->
        <div style="background:rgba(255,77,77,0.05);border:1px solid var(--red-b);border-radius:8px;padding:14px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--red);font-family:var(--mono);margin-bottom:6px">\uD83D\uDD34 Short after short liq squeeze</div>
          <div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:10px;line-height:1.4">${ss.logic}</div>
          ${dangerBox(ssDanger, ssLiq, ssLiqDistP, ssStopDistP, ssSafe, false)}
          <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Enter at</span>
            <span style="font-size:14px;font-weight:700;color:var(--blue);font-family:var(--mono)">$${fn2(ss.entry)}</span>
          </div>
          ${stopRow(ssDanger, ss.stop, ssSafe, false)}
          ${liqRow(ssLiq, ssLiqDistP)}
          ${tpRow('TP1', ss.tp1)}
          ${tpRow('TP2', ss.tp2)}
          <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0">
            <span style="font-size:11px;color:var(--text2);font-family:var(--mono)">TP3 (major)</span>
            <span style="font-size:12px;color:var(--green);font-family:var(--mono)">$${fn2(ss.tp3)}</span>
          </div>
          <div style="margin-top:10px;padding:6px 10px;background:rgba(255,77,77,.1);border-radius:4px;font-size:10px;font-family:var(--mono);color:var(--red)">
            Wait for squeeze candle, enter on next 1H close below entry
          </div>
        </div>
      </div>
    </div>`;
  } catch(e) {
    console.warn('renderSweepCard error:', e);
    return `<div class="card full" style="border-color:rgba(167,139,250,0.3)"><div class="card-title" style="color:var(--purple)">\u26A1 Sweep entry setups</div><div style="font-size:11px;color:var(--text3);font-family:var(--mono)">Sweep data error: ${e.message}</div></div>`;
  }
}

function calcCVDFromKlines(klines) {
  const empty = { source:'kline', deltas:[], cvd:[], divergence:null, trend:'neutral',
    cvdValue:0, cvdChange:0, buyPct:'--', sellPct:'--', tradeCount:0, timeSpanMin:0 };
  if (!klines || klines.length < 5) return empty;
  const deltas = klines.map(k => {
    const range = k.h - k.l;
    if (range === 0) return 0;
    return k.v * (2 * (k.c - k.l) / range - 1);
  });
  let cum = 0;
  const cvd = deltas.map(d => { cum += d; return cum; });
  const lookback = Math.min(20, klines.length - 1);
  const priceOld  = klines[klines.length - 1 - lookback].c;
  const priceCurr = klines[klines.length - 1].c;
  const cvdChange = cvd[cvd.length-1] - cvd[cvd.length-1-lookback];
  const priceChgPct = priceOld !== 0 ? (priceCurr - priceOld) / priceOld : 0;
  const cvdRange  = (Math.max(...cvd) - Math.min(...cvd)) || 1;
  const cvdChgPct = cvdChange / cvdRange;
  let divergence = null;
  if (Math.abs(priceChgPct) > 0.003) {
    if (priceChgPct > 0 && cvdChgPct < -0.12)
      divergence = { type:'bearish', label:'Bearish CVD div', desc:'Price rising but sell pressure accumulating - hidden distribution' };
    else if (priceChgPct < 0 && cvdChgPct > 0.12)
      divergence = { type:'bullish', label:'Bullish CVD div', desc:'Price falling but buy pressure accumulating - hidden accumulation' };
  }
  const trend = cvdChange > 0 ? 'bullish' : cvdChange < 0 ? 'bearish' : 'neutral';
  let buyV=0, sellV=0;
  deltas.forEach(d => { if(d>0) buyV+=d; else sellV+=Math.abs(d); });
  const tot = buyV+sellV||1;
  return { source:'kline', deltas, cvd, divergence, trend, cvdValue:cvd[cvd.length-1],
    cvdChange, priceChgPct, buyPct:(buyV/tot*100).toFixed(1), sellPct:(sellV/tot*100).toFixed(1),
    tradeCount:klines.length, timeSpanMin:0 };
}

// ─── CVD from real Bybit trade tape (primary source) ────────────────────────
// Fetches last 1000 individual trades (Buy/Sell + size), buckets by TF candle size,
// accumulates delta = buyVol - sellVol. Falls back to kline estimate on failure.
async function fetchCVDData(coin, tf) {
  const bucketMs = {'5m':300000,'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000,'1w':604800000}[tf]||3600000;
  try {
    const sym = COINS[coin].sym;
    const r = await fetchWithTimeout(
      `https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${sym}&limit=1000`,
      8000
    );
    const trades = r?.result?.list;
    if (!Array.isArray(trades) || trades.length < 10) {
      return calcCVDFromKlines(klCache[coin+'_'+tf]||[]);
    }

    // Bybit returns newest first — sort oldest first
    const sorted = [...trades].sort((a, b) => parseInt(a.time) - parseInt(b.time));

    // Bucket into TF-sized windows
    const bmap = {};
    let totalBuy = 0, totalSell = 0;
    sorted.forEach(t => {
      const ts  = parseInt(t.time);
      const bk  = Math.floor(ts / bucketMs) * bucketMs;
      if (!bmap[bk]) bmap[bk] = { t:bk, buyVol:0, sellVol:0, count:0 };
      const vol = parseFloat(t.size) || 0;
      if (t.side === 'Buy') { bmap[bk].buyVol  += vol; totalBuy  += vol; }
      else                  { bmap[bk].sellVol += vol; totalSell += vol; }
      bmap[bk].count++;
    });

    const buckets = Object.values(bmap).sort((a, b) => a.t - b.t);
    if (buckets.length < 2) return calcCVDFromKlines(klCache[coin+'_'+tf]||[]);

    // Per-bucket delta and cumulative CVD
    const deltas = buckets.map(b => b.buyVol - b.sellVol);
    let cum = 0;
    const cvd = deltas.map(d => { cum += d; return cum; });

    // Divergence: price direction vs CVD direction across the data window
    const firstPrice   = parseFloat(sorted[0].price) || 0;
    const lastPrice    = parseFloat(sorted[sorted.length-1].price) || firstPrice;
    const priceChgPct  = firstPrice > 0 ? (lastPrice - firstPrice) / firstPrice : 0;
    const cvdRange     = (Math.max(...cvd) - Math.min(...cvd)) || 1;
    const cvdChange    = cvd[cvd.length-1] - cvd[0];
    const cvdChgPct    = cvdChange / cvdRange;

    let divergence = null;
    if (Math.abs(priceChgPct) > 0.001) {
      if (priceChgPct > 0 && cvdChgPct < -0.08)
        divergence = { type:'bearish', label:'Bearish CVD div',
          desc:'Price moving up but real sellers are more aggressive - distribution, high reversal risk' };
      else if (priceChgPct < 0 && cvdChgPct > 0.08)
        divergence = { type:'bullish', label:'Bullish CVD div',
          desc:'Price falling but real buyers absorbing - accumulation, watch for reversal' };
    }

    const totalVol   = totalBuy + totalSell || 1;
    const buyPct     = (totalBuy  / totalVol * 100).toFixed(1);
    const sellPct    = (totalSell / totalVol * 100).toFixed(1);
    const trend      = cvdChange > 0 ? 'bullish' : cvdChange < 0 ? 'bearish' : 'neutral';
    const spanMs     = buckets[buckets.length-1].t - buckets[0].t + bucketMs;
    const timeSpanMin = Math.round(spanMs / 60000);

    return {
      source:'live', buckets, deltas, cvd, divergence, trend,
      cvdValue: cvd[cvd.length-1],
      cvdChange, priceChgPct,
      buyVol:totalBuy, sellVol:totalSell,
      buyPct, sellPct, totalVol,
      tradeCount: trades.length, timeSpanMin,
      firstPrice, lastPrice
    };
  } catch(e) {
    console.warn('CVD trade fetch failed, using kline fallback:', e.message);
    return calcCVDFromKlines(klCache[coin+'_'+tf]||[]);
  }
}

function scoreSignal(coin,ta,mtf){
  const d=mktData[coin];if(!d)return 0;
  let s=0;
  if(ta.trend==='bullish')s+=2;else if(ta.trend==='mild-bullish')s+=1;
  if(ta.rsi<35)s+=2;else if(ta.rsi<50)s+=1;
  if(d.funding<0)s+=2;else if(d.funding<0.01)s+=2;else if(d.funding<0.03)s+=1;
  if(d.fgValue<30)s+=2;else if(d.fgValue<50)s+=1;
  if(d.change24h>0&&d.change24h<4)s+=1;else if(d.change24h>=-2&&d.change24h<0)s+=1;
  let base=Math.round((s/8)*10);
  // MTF confluence adjustment
  if(mtf){
    base+=mtf.confluenceScore; // +3 strong, +2 good, +1 partial, -1 conflicted
    // Counter-trend penalty
    if(mtf.positionSizeMultiplier<0.5)base=Math.max(0,base-3);
    else if(mtf.positionSizeMultiplier<1)base=Math.max(0,base-1);
  }
  // Layer 2: funding momentum bonus
  const sym = (COINS[coin]||{}).sym;
  const fMom = sym ? calcFundingMomentum(fundingHistoryCache[sym]||[]) : null;
  if (fMom) {
    if (fMom.flipped) base += 1;                          // funding flip = sentiment shift
    if (fMom.momentum === 'accelerating_negative') base += 1; // shorts paying more = long signal
    if (fMom.momentum === 'accelerating_positive' && ta.trend === 'bearish') base += 1; // longs paying into downtrend
  }
  // OI spike penalty (forced liqs = unreliable signal)
  const oiM = sym ? calcOIMomentum(sym) : null;
  if (oiM && oiM.spike) base = Math.max(0, base - 1);

  return Math.min(10,Math.max(0,base));
}

function verdictOf(sc){
  if(sc>=7)return{text:'Long setup',cls:'cbl'};
  if(sc>=5)return{text:'Watch',cls:'cbw'};
  if(sc>=3)return{text:'Neutral',cls:'cbn'};
  return{text:'Short bias',cls:'cbs'};
}

async function setLev(lev,btn){
  activeLev=lev;
  aiCache={};
  document.querySelectorAll('.lev-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  // Re-render detail if data loaded — pass cached mtfData if available
  const klines=klCache[activeCoin+'_'+activeTF]||[];
  if(klines.length&&mktData[activeCoin]?.price){
    let mtf=null;
    try{const mk=await fetchMTFKlines(activeCoin);mtf=calcMTFAnalysis(mk);}catch(e){}
    await renderDetail(activeCoin,klines,mtf);
  }
}

function calcLeverage(entry,stop,price,lev,isLong){
  const stopDist=Math.abs(entry-stop)/entry*100;

  // Blofin isolated margin liquidation formula
  // MMR (maintenance margin rate) tiers for Blofin:
  // <=125x: MMR = 0.004 (0.4%) for most alts, 0.005 (0.5%) for BTC/ETH at high notional
  // Liq formula (isolated, long): liq = entry * (1 - IMR + MMR)
  //   where IMR = 1/leverage
  // Liq formula (isolated, short): liq = entry * (1 + IMR - MMR)
  // Blofin also charges taker fee on liquidation (~0.05%)
  const imr = 1 / lev; // initial margin rate
  const mmr = lev >= 100 ? 0.005 : lev >= 50 ? 0.004 : 0.003; // maintenance margin rate
  const takerFee = 0.0005; // blofin taker fee applied at liquidation

  // Long liq: entry * (1 - IMR + MMR + takerFee)
  const liqLong  = +(entry * (1 - imr + mmr + takerFee)).toFixed(2);
  // Short liq: entry * (1 + IMR - MMR - takerFee)
  const liqShort = +(entry * (1 + imr - mmr - takerFee)).toFixed(2);

  const liqPrice = isLong ? liqLong : liqShort;
  const liqDist  = Math.abs(entry - liqPrice) / entry * 100;
  const maxStopForLev = liqDist * 0.6; // keep stop within 60% of liq distance

  // Position sizing: risk 1% of account per trade
  const positionSizeUSDT = stopDist > 0 ? (1 / stopDist * 100) : 0;
  const warningLevel = lev >= 75 ? 'extreme' : lev >= 50 ? 'high' : lev >= 25 ? 'medium' : 'low';

  return { stopDist, liqDist, liqPrice, liqLong, liqShort, maxStopPct: maxStopForLev, positionSizeUSDT, warningLevel, imr, mmr };
}

function calcMaxSafeLeverage(entry, stop) {
  // Find highest leverage where stop distance < 60% of liquidation distance
  // Blofin MMR tiers: 0.003 (<25x), 0.004 (25-99x), 0.005 (100x+)
  const stopDist = Math.abs(entry - stop) / entry;
  const leverages = [1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125];
  let maxSafe = 1;
  for (const lev of leverages) {
    const mmr = lev >= 100 ? 0.005 : lev >= 25 ? 0.004 : 0.003;
    const imr = 1 / lev;
    const liqDist = (imr - mmr); // as decimal
    const maxStop = liqDist * 0.6; // 60% of liq distance
    if (stopDist <= maxStop) maxSafe = lev;
    else break;
  }
  return maxSafe;
}

function getLeverageSuitability(entry, stop, selectedLev) {
  const maxSafe = calcMaxSafeLeverage(entry, stop);
  const stopDist = Math.abs(entry - stop) / entry * 100;
  const isOk = selectedLev <= maxSafe;
  let rating, color, emoji;
  if (selectedLev <= maxSafe * 0.6) { rating = 'Conservative'; color = 'var(--green)'; emoji = '✅'; }
  else if (selectedLev <= maxSafe) { rating = 'Acceptable'; color = 'var(--amber)'; emoji = '⚠️'; }
  else if (selectedLev <= maxSafe * 1.5) { rating = 'Risky'; color = 'var(--red)'; emoji = '🔴'; }
  else { rating = 'Dangerous'; color = 'var(--red)'; emoji = '⛔'; }
  return { maxSafe, stopDist, isOk, rating, color, emoji };
}

function buildCustomChart(klines, setup, dec, lev) {
  const canvas = document.getElementById('custom-chart');
  if (!canvas || !klines || klines.length < 2) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const wrap = canvas.parentElement;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  ctx.scale(dpr, dpr);
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const PAD = { t: 20, r: 70, b: 30, l: 10 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;

  // Show last 60 candles
  const data = klines.slice(-60);
  const allPrices = [
    ...data.map(k => k.h), ...data.map(k => k.l),
    setup.lE, setup.lSL, setup.lTP2, setup.sE, setup.sSL, setup.sTP2,
    setup.lLiq || 0, setup.sLiq || 0
  ].filter(Boolean);
  const minP = Math.min(...allPrices) * 0.998;
  const maxP = Math.max(...allPrices) * 1.002;
  const range = maxP - minP;

  const xScale = i => PAD.l + (i / (data.length - 1)) * cW;
  const yScale = p => PAD.t + (1 - (p - minP) / range) * cH;
  const candleW = Math.max(2, (cW / data.length) * 0.7);

  // Background
  ctx.fillStyle = '#181818';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = PAD.t + (i / 5) * cH;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
    const price = maxP - (i / 5) * range;
    ctx.fillStyle = '#444';
    ctx.font = '9px DM Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('$' + price.toFixed(dec > 2 ? 2 : dec), W - PAD.r + 4, y + 3);
  }

  // Draw level lines
  function drawLevel(price, color, label, dash = []) {
    if (!price || price <= 0) return;
    const y = yScale(price);
    if (y < PAD.t - 5 || y > H - PAD.b + 5) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = 'bold 9px DM Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, W - PAD.r + 4, y + 3);
    ctx.restore();
  }

  drawLevel(setup.lTP2, '#00d084', 'TP2', [4,3]);
  drawLevel(setup.lTP1, '#00d084', 'TP1', [4,3]);
  drawLevel(setup.lE, '#4a9eff', 'L.Entry', [6,2]);
  drawLevel(setup.sE, '#f5a623', 'S.Entry', [6,2]);
  drawLevel(setup.lSL, '#ff4d4d', 'L.Stop', [3,3]);
  drawLevel(setup.sSL, '#ff4d4d', 'S.Stop', [3,3]);
  if (setup.lLiq) drawLevel(setup.lLiq, 'rgba(255,77,77,0.4)', 'L.Liq', [2,4]);
  if (setup.sLiq) drawLevel(setup.sLiq, 'rgba(255,77,77,0.4)', 'S.Liq', [2,4]);

  // Draw candles
  data.forEach((k, i) => {
    const x = xScale(i);
    const isUp = k.c >= k.o;
    const color = isUp ? '#00d084' : '#ff4d4d';
    const yH = yScale(k.h), yL = yScale(k.l);
    const yO = yScale(k.o), yC = yScale(k.c);

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yH); ctx.lineTo(x, yL);
    ctx.stroke();

    // Body
    ctx.fillStyle = color;
    const bodyTop = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
  });

  // Current price line
  const lastClose = data[data.length - 1].c;
  const y = yScale(lastClose);
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
  ctx.setLineDash([]);
}

// ── CVD mini-chart — delta bars (bottom 40%) + cumulative line (top 55%) ─────
function buildCVDChart(klines, cvdData) {
  const canvas = document.getElementById('cvd-chart');
  if (!canvas || !cvdData || cvdData.cvd.length < 2) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth  * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width  = wrap.clientWidth  + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  ctx.scale(dpr, dpr);
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const PAD = { t:28, r:72, b:18, l:8 };
  const cW = W - PAD.l - PAD.r;
  const totalH = H - PAD.t - PAD.b;
  const cvdH = totalH * 0.52, gapH = totalH * 0.06, barH = totalH * 0.42;
  const cvdTop = PAD.t, barTop = PAD.t + cvdH + gapH;

  const deltas  = cvdData.deltas.slice(-60);
  const cvdVals = cvdData.cvd.slice(-60);
  const n = Math.max(deltas.length, 1);

  ctx.fillStyle = '#181818';
  ctx.fillRect(0, 0, W, H);

  // Source badge + buy/sell stats in top bar
  const isLive = cvdData.source === 'live';
  const srcLabel = isLive
    ? (cvdData.timeSpanMin > 0 ? `LIVE  ${cvdData.tradeCount} trades  ${cvdData.timeSpanMin}min` : `LIVE  ${cvdData.tradeCount} trades`)
    : 'ESTIMATED (kline)';
  ctx.font = 'bold 8px DM Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = isLive ? '#00d084' : '#888';
  ctx.fillText(srcLabel, PAD.l, 10);

  // Buy% / Sell% bar across top
  if (cvdData.buyPct && cvdData.sellPct) {
    const barY = 15, barH2 = 5, barW2 = cW * 0.45;
    const buyFrac = parseFloat(cvdData.buyPct) / 100;
    ctx.fillStyle = 'rgba(0,208,132,0.25)';
    ctx.fillRect(PAD.l, barY, barW2, barH2);
    ctx.fillStyle = '#00d084';
    ctx.fillRect(PAD.l, barY, barW2 * buyFrac, barH2);
    ctx.font = '8px DM Mono, monospace';
    ctx.fillStyle = '#00d084';
    ctx.fillText('B ' + cvdData.buyPct + '%', PAD.l + barW2 + 4, barY + 4);
    const sellX = PAD.l + barW2 * 1.25;
    ctx.fillStyle = 'rgba(255,77,77,0.25)';
    ctx.fillRect(sellX, barY, barW2, barH2);
    ctx.fillStyle = '#ff4d4d';
    ctx.fillRect(sellX, barY, barW2 * (1 - buyFrac), barH2);
    ctx.fillStyle = '#ff4d4d';
    ctx.fillText('S ' + cvdData.sellPct + '%', sellX + barW2 + 4, barY + 4);
  }

  // Section divider
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD.l, barTop-gapH/2); ctx.lineTo(W-PAD.r, barTop-gapH/2); ctx.stroke();

  // Section labels
  ctx.fillStyle = '#444';
  ctx.font = 'bold 7px DM Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('CVD', PAD.l, cvdTop - 4);
  ctx.fillText('DELTA', PAD.l, barTop - 3);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  for (let i=0; i<=3; i++) {
    const y = cvdTop + (i/3)*cvdH;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W-PAD.r, y); ctx.stroke();
  }

  const xScale = i => PAD.l + (i / Math.max(n-1, 1)) * cW;
  const barW   = Math.max(2, (cW/n) * 0.72);

  // Delta bars (buy green, sell red)
  const maxD  = Math.max(...deltas.map(Math.abs)) || 1;
  const zeroY = barTop + barH/2;
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1; ctx.setLineDash([3,4]);
  ctx.beginPath(); ctx.moveTo(PAD.l, zeroY); ctx.lineTo(W-PAD.r, zeroY); ctx.stroke();
  ctx.setLineDash([]);
  deltas.forEach((d, i) => {
    const x  = xScale(i);
    const bh = Math.abs(d) / maxD * (barH/2);
    ctx.fillStyle = d >= 0 ? 'rgba(0,208,132,0.8)' : 'rgba(255,77,77,0.8)';
    ctx.fillRect(x - barW/2, d >= 0 ? zeroY-bh : zeroY, barW, bh || 1);
  });

  // CVD cumulative line + gradient fill
  const minC = Math.min(...cvdVals), maxC = Math.max(...cvdVals), rng = maxC-minC || 1;
  const cvdY = v => cvdTop + cvdH - ((v-minC)/rng)*cvdH;
  const isUp = cvdData.trend === 'bullish';
  const grad = ctx.createLinearGradient(0, cvdTop, 0, cvdTop+cvdH);
  grad.addColorStop(0, isUp ? 'rgba(0,208,132,0.20)' : 'rgba(255,77,77,0.20)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  cvdVals.forEach((v,i) => { const x=xScale(i); i===0?ctx.moveTo(x,cvdY(v)):ctx.lineTo(x,cvdY(v)); });
  ctx.lineTo(xScale(n-1), cvdTop+cvdH); ctx.lineTo(xScale(0), cvdTop+cvdH); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  const lineCol = cvdData.trend==='bullish'?'#00d084':cvdData.trend==='bearish'?'#ff4d4d':'#4a9eff';
  ctx.strokeStyle = lineCol; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  ctx.beginPath();
  cvdVals.forEach((v,i) => { const x=xScale(i); i===0?ctx.moveTo(x,cvdY(v)):ctx.lineTo(x,cvdY(v)); });
  ctx.stroke();

  // Right-axis value labels
  const fmt = v => { const a=Math.abs(v); return a>=1e9?(v/1e9).toFixed(1)+'B':a>=1e6?(v/1e6).toFixed(1)+'M':a>=1e3?(v/1e3).toFixed(1)+'K':v.toFixed(0); };
  ctx.font = '9px DM Mono, monospace'; ctx.textAlign = 'left';
  ctx.fillStyle = lineCol;
  ctx.fillText(fmt(cvdVals[n-1]), W-PAD.r+4, cvdY(cvdVals[n-1])+3);
  ctx.fillStyle = '#555';
  ctx.fillText(fmt(maxC), W-PAD.r+4, cvdTop+9);
  ctx.fillText(fmt(minC), W-PAD.r+4, cvdTop+cvdH-2);

  // Divergence label (top-right of CVD panel)
  if (cvdData.divergence) {
    const divCol = cvdData.divergence.type==='bearish'?'#ff4d4d':'#00d084';
    ctx.font = 'bold 9px DM Mono, monospace'; ctx.textAlign = 'right';
    ctx.fillStyle = divCol;
    ctx.fillText(cvdData.divergence.label, W-PAD.r-6, cvdTop+14);
  }
}
function buildLevCard(price, setup, lev, dec) {
  const longLev  = calcLeverage(setup.lE, setup.lSL, price, lev, true);
  const shortLev = calcLeverage(setup.sE, setup.sSL, price, lev, false);
  const longSuit  = getLeverageSuitability(setup.lE, setup.lSL, lev);
  const shortSuit = getLeverageSuitability(setup.sE, setup.sSL, lev);

  // Store for chart and alerts
  setup.lLiq = longLev.liqPrice;
  setup.sLiq = shortLev.liqPrice;
  setup.longMaxSafeLev  = longSuit.maxSafe;
  setup.shortMaxSafeLev = shortSuit.maxSafe;

  const grid  = document.getElementById('lev-grid');
  const warn  = document.getElementById('lev-warning-text');
  const badge = document.getElementById('lev-warning-badge');
  const title = document.getElementById('lev-suit-title');
  if (!grid) return;

  // Suitability badge
  if (badge) {
    badge.textContent = `${longSuit.emoji} ${longSuit.rating} for ${lev}x`;
    badge.style.background = longSuit.isOk ? 'rgba(245,166,35,.15)' : 'rgba(255,77,77,.25)';
    badge.style.color = longSuit.color;
  }

  // Suitability banner — most prominent element
  const suitBanner = longSuit.isOk
    ? `<div style="background:rgba(245,166,35,.08);border:1px solid rgba(245,166,35,.3);border-radius:7px;padding:10px 12px;margin-bottom:10px;font-family:var(--mono)">
        <div style="font-size:10px;color:var(--amber);font-weight:500;margin-bottom:4px">${longSuit.emoji} LEVERAGE SUITABILITY — ${longSuit.rating.toUpperCase()}</div>
        <div style="font-size:11px;color:var(--text)">Your <strong>${lev}x</strong> is within the max safe leverage of <strong>${longSuit.maxSafe}x</strong> for this setup's stop distance (${longSuit.stopDist.toFixed(3)}%)</div>
      </div>`
    : `<div style="background:rgba(255,77,77,.1);border:1px solid rgba(255,77,77,.4);border-radius:7px;padding:10px 12px;margin-bottom:10px;font-family:var(--mono)">
        <div style="font-size:10px;color:var(--red);font-weight:500;margin-bottom:4px">⛔ LEVERAGE TOO HIGH FOR THIS SETUP</div>
        <div style="font-size:12px;color:var(--text);margin-bottom:6px">Your selected <strong style="color:var(--red)">${lev}x</strong> exceeds the max safe leverage of <strong style="color:var(--green)">${longSuit.maxSafe}x</strong> for this stop distance (${longSuit.stopDist.toFixed(3)}%)</div>
        <div style="font-size:11px;color:var(--red)">→ Reduce to <strong>${longSuit.maxSafe}x</strong> or less, OR use the tighter pattern entry to reduce stop distance</div>
      </div>`;

  const stopSafeL = longLev.stopDist < longLev.liqDist;
  grid.innerHTML = suitBanner + `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px">
      <div class="lev-item"><div class="li-label">Selected leverage</div><div class="li-val" style="color:${longSuit.color}">${lev}x</div></div>
      <div class="lev-item"><div class="li-label">Max safe leverage</div><div class="li-val" style="color:${longSuit.isOk?'var(--green)':'var(--red)'}">${longSuit.maxSafe}x</div></div>
      <div class="lev-item"><div class="li-label">Long liq price</div><div class="li-val" style="color:var(--red)">$${fn(longLev.liqPrice, dec)}</div></div>
      <div class="lev-item"><div class="li-label">Short liq price</div><div class="li-val" style="color:var(--red)">$${fn(shortLev.liqPrice, dec)}</div></div>
      <div class="lev-item"><div class="li-label">Stop distance</div><div class="li-val" style="color:${stopSafeL?'var(--green)':'var(--red)'}">${longLev.stopDist.toFixed(3)}%</div></div>
      <div class="lev-item"><div class="li-label">Max safe stop</div><div class="li-val">${longLev.maxStopPct.toFixed(3)}%</div></div>
      <div class="lev-item"><div class="li-label">Liq distance</div><div class="li-val">${longLev.liqDist.toFixed(3)}%</div></div>
      <div class="lev-item"><div class="li-label">Rec. position size</div><div class="li-val vg">${longLev.positionSizeUSDT.toFixed(1)}% of acct</div></div>
    </div>
  `;

  const warnMsgs = [];
  if (!longSuit.isOk) {
    warnMsgs.push(`⛔ Max safe leverage for this stop: ${longSuit.maxSafe}x — your ${lev}x will liquidate before stop is hit`);
  }
  if (lev >= 50) {
    warnMsgs.push(`⚠ At ${lev}x price needs to move only ${longLev.liqDist.toFixed(3)}% to liquidate — use limit orders, never market`);
  }
  warnMsgs.push(`Long: entry $${fn(setup.lE, dec)} | stop $${fn(setup.lSL, dec)} | liq $${fn(longLev.liqPrice, dec)}`);
  warnMsgs.push(`Blofin isolated margin (IMR ${(longLev.imr*100).toFixed(2)}% MMR ${(longLev.mmr*100).toFixed(2)}% fee 0.05%). Always verify on Blofin.`);
  if (warn) warn.innerHTML = warnMsgs.join('<br>');
}

function buildTVChart(coin,tf){
  const c=document.getElementById('tv-chart');if(!c)return;
  c.innerHTML='';
  const s=document.createElement('script');
  s.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  s.async=true;
  s.innerHTML=JSON.stringify({autosize:true,symbol:COINS[coin].tv,interval:TF_TV[tf],timezone:'Etc/UTC',theme:'dark',style:'1',locale:'en',enable_publishing:false,backgroundColor:'rgba(17,17,17,1)',gridColor:'rgba(255,255,255,0.04)',hide_top_toolbar:false,hide_legend:false,save_image:false,hide_volume:false,support_host:'https://www.tradingview.com'});
  c.appendChild(s);
}

async function fetchAI(coin,ta,sc,setup,klines,mtfData,liqZones,cvdData){
  const key=coin+'_'+activeTF+'_'+entryMode;
  if(aiCache[key])return aiCache[key];
  const d=mktData[coin];
  try{
    const res=await fetch('/api/analyze',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        coin,tf:activeTF,price:d.price,change24h:d.change24h,
        rsi:ta.rsi.toFixed(1),trend:ta.trend,
        funding:d.funding.toFixed(4),fgValue:d.fgValue,
        atr:ta.atr.toFixed(COINS[coin].dec>2?2:COINS[coin].dec),
        oi:(d.oiNotional/1e9).toFixed(2),
        support:ta.support,resistance:ta.resistance,
        optimalLongEntry:setup.lE,optimalShortEntry:setup.sE,
        entryMode,
        mode: activeMode,
        liqZones: liqZones ? {
          fundingBias: liqZones.fundingBias,
          majorLongCluster: liqZones.majorLongCluster.priceRange,
          majorShortCluster: liqZones.majorShortCluster.priceRange,
          nearestLongSweep: liqZones.nearestLongSweep.price,
          nearestShortSweep: liqZones.nearestShortSweep.price,
          topLongLiq: liqZones.topLongLiq.map(z=>z.price).join(', '),
          topShortLiq: liqZones.topShortLiq.map(z=>z.price).join(', '),
          longSweepEntry: liqZones.longSweepEntry,
          shortSweepEntry: liqZones.shortSweepEntry
        } : null,
        mtfSummary: mtfData ? {
          confluenceLabel: mtfData.confluenceLabel,
          confluenceScore: mtfData.confluenceScore,
          filterStatus: mtfData.filterStatus,
          filterMsg: mtfData.filterMsg,
          positionSizeMultiplier: mtfData.positionSizeMultiplier,
          trendByTF: mtfData.trendSummary,
          labels: mtfData.stack.labels
        } : null,
        cvdSummary: cvdData ? {
          trend: cvdData.trend,
          divergence: cvdData.divergence ? cvdData.divergence.label : null,
          divergenceDesc: cvdData.divergence ? cvdData.divergence.desc : null,
          divergenceType: cvdData.divergence ? cvdData.divergence.type : null,
          cvdDirection: cvdData.cvdChange > 0 ? 'rising' : 'falling',
          recentBias: cvdData.cvdChange > 0 ? 'net buying pressure' : 'net selling pressure'
        } : null,
        candles:klines.slice(-50).map(k=>({o:+k.o.toFixed(COINS[coin].dec),h:+k.h.toFixed(COINS[coin].dec),l:+k.l.toFixed(COINS[coin].dec),c:+k.c.toFixed(COINS[coin].dec),v:Math.round(k.v)}))
      })
    });
    if(!res.ok)throw new Error('API '+res.status);
    const json=await res.json();
    if(json.error)throw new Error(json.error);
    aiCache[key]=json;return json;
  }catch(e){console.error('AI:',e);return null;}
}

// ── MTF Stack definitions ────────────────────────────────────────────────────
const MTF_STACKS = {
  swing: { tfs: ['1w','1d','4h','1h'], labels: ['Weekly','Daily','4H','1H'], entryTF: '1h', desc: 'W/D/4H/1H • swing trades' },
  scalp: { tfs: ['4h','1h','15m','5m'], labels: ['4H','1H','15M','5M'], entryTF: '5m', desc: '4H/1H/15M/5M • scalp trades' }
};

function setMode(mode, btn) {
  activeMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.remove('active','swing-active','scalp-active');
  });
  btn.classList.add('active', mode === 'swing' ? 'swing-active' : 'scalp-active');
  const desc = document.getElementById('mode-desc');
  if (desc) desc.textContent = MTF_STACKS[mode].desc;
  // Re-render with new mode
  aiCache = {};
  klCache = {};
  // Scalp mode never uses swing locks — clear in-memory (localStorage preserved for when you switch back)
  if(mode === 'scalp') swingSignals = {};
  const klines = klCache[activeCoin+'_'+activeTF] || [];
  selectCoin(activeCoin);
}

async function fetchMTFKlines(coin) {
  const stack = MTF_STACKS[activeMode];
  const results = {};
  await Promise.allSettled(stack.tfs.map(async tf => {
    try {
      results[tf] = await Promise.race([
        fetchKlines(coin, tf),
        new Promise((_,reject) => setTimeout(() => reject(new Error('MTF timeout')), 7000))
      ]);
    } catch(e) {
      console.warn('MTF klines failed for', tf, e.message);
      results[tf] = [];
    }
  }));
  return results;
}

function calcMTFAnalysis(mtfKlines) {
  const stack = MTF_STACKS[activeMode];
  const analyses = {};
  stack.tfs.forEach(tf => {
    const kl = mtfKlines[tf] || [];
    analyses[tf] = calcTA(kl);
  });

  // Score confluence
  let bullCount = 0, bearCount = 0, neutralCount = 0;
  const trendSummary = {};
  stack.tfs.forEach(tf => {
    const t = analyses[tf].trend;
    trendSummary[tf] = t;
    if (t === 'bullish' || t === 'mild-bullish') bullCount++;
    else if (t === 'bearish' || t === 'mild-bearish') bearCount++;
    else neutralCount++;
  });

  // Weekly (swing) or 4H (scalp) is the hard filter
  const filterTF = stack.tfs[0];
  const filterTA = analyses[filterTF];
  const filterBull = filterTA.trend === 'bullish' || filterTA.trend === 'mild-bullish';
  const filterBear = filterTA.trend === 'bearish' || filterTA.trend === 'mild-bearish';

  // Confluence score
  const total = stack.tfs.length;
  let confluenceScore, confluenceLabel, confluenceClass;
  const maxAgree = Math.max(bullCount, bearCount);

  if (maxAgree === total) { confluenceScore = 3; confluenceLabel = `Strong ${bullCount > bearCount ? 'Bull' : 'Bear'} (${total}/${total})`; confluenceClass = bullCount > bearCount ? 'mtf-strong' : 'mtf-weak'; }
  else if (maxAgree >= total - 1) { confluenceScore = 2; confluenceLabel = `Good ${bullCount > bearCount ? 'Bull' : 'Bear'} (${maxAgree}/${total})`; confluenceClass = bullCount > bearCount ? 'mtf-good' : 'mtf-mixed'; }
  else if (maxAgree >= Math.ceil(total / 2)) { confluenceScore = 1; confluenceLabel = `Partial (${maxAgree}/${total})`; confluenceClass = 'mtf-mixed'; }
  else { confluenceScore = -1; confluenceLabel = `Conflicted (${maxAgree}/${total})`; confluenceClass = 'mtf-weak'; }

  // Weekly/top TF filter result
  let filterStatus, filterClass, filterMsg, positionSizeMultiplier;
  if (filterBull && bullCount > bearCount) {
    filterStatus = '✅ Trend aligned — full position size';
    filterClass = 'wf-bull';
    filterMsg = `${stack.labels[0]} is ${filterTA.trend} — trade WITH the trend`;
    positionSizeMultiplier = 1.0;
  } else if (filterBear && bearCount > bullCount) {
    filterStatus = '✅ Trend aligned — full position size';
    filterClass = 'wf-bear';
    filterMsg = `${stack.labels[0]} is ${filterTA.trend} — trade WITH the trend`;
    positionSizeMultiplier = 1.0;
  } else if (filterBull && bearCount > bullCount) {
    filterStatus = '⚠ Counter-trend — reduce size 50%';
    filterClass = 'wf-bear';
    filterMsg = `${stack.labels[0]} bullish but lower TFs bearish — counter-trend risk`;
    positionSizeMultiplier = 0.5;
  } else if (filterBear && bullCount > bearCount) {
    filterStatus = '⛔ Counter-trend — avoid at high leverage';
    filterClass = 'wf-bear';
    filterMsg = `${stack.labels[0]} bearish — long setups are counter-trend, high failure rate`;
    positionSizeMultiplier = 0.25;
  } else {
    filterStatus = '🟡 Neutral — wait for trend clarity';
    filterClass = 'wf-neutral';
    filterMsg = `${stack.labels[0]} is neutral — no clear institutional bias`;
    positionSizeMultiplier = 0.5;
  }

  // Entry TF analysis for precise entry
  const entryTA = analyses[stack.entryTF] || analyses[stack.tfs[stack.tfs.length - 1]];

  return {
    analyses, trendSummary,
    bullCount, bearCount, neutralCount,
    confluenceScore, confluenceLabel, confluenceClass,
    filterStatus, filterClass, filterMsg, positionSizeMultiplier,
    filterTA, entryTA, stack
  };
}


function renderMTFCard(mtf, dec) {
  if (!mtf) return '<div class="mtf-card"><div style="color:var(--text3);font-family:var(--mono);font-size:12px">MTF data loading...</div></div>';

  const trendColor = t => {
    if (t === 'bullish') return 'var(--green)';
    if (t === 'mild-bullish') return '#7de0b0';
    if (t === 'mild-bearish') return 'var(--amber)';
    if (t === 'bearish') return 'var(--red)';
    return 'var(--text2)';
  };
  const trendShort = t => {
    if (t === 'bullish') return '▲ Bullish';
    if (t === 'mild-bullish') return '↗ Mild Bull';
    if (t === 'mild-bearish') return '↘ Mild Bear';
    if (t === 'bearish') return '▼ Bearish';
    return '→ Neutral';
  };

  const tfCells = mtf.stack.tfs.map((tf, i) => {
    const ta = mtf.analyses[tf] || {};
    const isFilter = i === 0;
    const isEntry = i === mtf.stack.tfs.length - 1;
    return `<div class="mtf-tf" style="${isFilter ? 'border-color:var(--border2);border-width:2px' : ''}${isEntry ? ';border-style:dashed' : ''}">
      <div class="mtf-tf-label">${mtf.stack.labels[i]}${isFilter ? ' 🔒' : ''}${isEntry ? ' 🎯' : ''}</div>
      <div class="mtf-tf-trend" style="color:${trendColor(ta.trend)}">${trendShort(ta.trend)}</div>
      <div class="mtf-tf-rsi">RSI: ${ta.rsi ? ta.rsi.toFixed(1) : '—'}</div>
      <div class="mtf-tf-detail">EMA: ${ta.ema20 ? '$'+fn(ta.ema20, dec>2?2:dec) : '—'}</div>
    </div>`;
  }).join('');

  const posSize = mtf.positionSizeMultiplier;
  const posSizeColor = posSize >= 1 ? 'var(--green)' : posSize >= 0.5 ? 'var(--amber)' : 'var(--red)';

  return `<div class="mtf-card full">
    <div class="mtf-header">
      <span class="mtf-title">Multi-timeframe confluence — ${activeMode === 'swing' ? 'Swing' : 'Scalp'} mode</span>
      <span class="mtf-score-pill ${mtf.confluenceClass}">${mtf.confluenceLabel}</span>
    </div>
    <div class="mtf-grid">${tfCells}</div>
    <div class="weekly-filter ${mtf.filterClass}">
      <strong>${mtf.filterStatus}</strong><br>
      ${mtf.filterMsg}<br>
      <span style="opacity:.8">Position size multiplier: <strong style="color:${posSizeColor}">${(posSize*100).toFixed(0)}% of normal</strong>${posSize < 1 ? ' — ' + (activeMode==='swing'?'Weekly':'4H') + ' filter reducing risk' : ''}</span>
    </div>
  </div>`;
}

function renderSidebar(scores){
  const sorted=Object.keys(COINS).map(c=>({c,sc:scores[c]||0})).sort((a,b)=>b.sc-a.sc);
  document.getElementById('coin-list').innerHTML=sorted.map(({c,sc})=>{
    const d=mktData[c]||{};const v=verdictOf(sc);
    return`<button class="coin-btn ${c===activeCoin?'active':''}" onclick="selectCoin('${c}')">
      <span class="coin-name">${c}</span>
      <span class="coin-meta">
        <span class="coin-px">$${fn(d.price,COINS[c].dec)} <span class="${(d.change24h||0)>=0?'pos':'neg'}">${fp(d.change24h||0)}</span></span>
        <span class="cbadge ${v.cls}">${v.text}</span>
      </span>
    </button>`;
  }).join('');
}

function renderAlerts(scores){
  const fired=Object.entries(scores).filter(([,sc])=>sc>=7);
  const el=document.getElementById('alerts-bar');
  if(!fired.length){el.innerHTML='';return;}
  el.innerHTML=`<div class="alerts-bar"><span class="alert-lbl">High conviction</span>${fired.map(([c,sc])=>`<span class="alert-item">${c} — ${sc}/10 Long setup</span>`).join('')}</div>`;
}

async function renderDetail(coin,klines,mtfData){
  const d=mktData[coin];
  const dec=COINS[coin].dec;
  const ta=calcTA(klines);
  const cvdData=await fetchCVDData(coin,activeTF);
  // Layer 2: funding history + OI momentum for active coin
  const bybitSym = COINS[coin].sym;
  const fundingHist = await fetchFundingHistory(bybitSym);
  const fundingMom  = calcFundingMomentum(fundingHist);
  const oiMom       = calcOIMomentum(bybitSym);
  const sc=scoreSignal(coin,ta,mtfData);
  let liqZones=null;
  try{ liqZones=calcLiqZones(d.price,ta.atr||d.price*0.02,d.oi,d.funding,d.oiNotional,klines); }
  catch(e){ console.warn('LiqZones failed:',e); }
  const v=verdictOf(sc);
  const entries=calcEntries(d.price,ta,dec);
  const freshSetup=calcSetups(entries,dec);

  // ── Signal locking: swing mode only ────────────────────────────────────────
  let setup=freshSetup;
  let lockedSig=null;
  if(activeMode==='swing'){
    const pivots=findPivotLevels(klines.slice(-60),3);
    // Check if existing signal is still valid
    lockedSig=checkSignalValidity(coin,activeTF,d.price,sc);
    if(lockedSig){
      // Use frozen entry/TP levels — but recalculate stop and liq live from those entries
      const ls=lockedSig.lockedSetup;
      const mmrL  = activeLev>=100?0.005:activeLev>=25?0.004:0.003;
      const imrL  = 1/activeLev;
      const feeL  = 0.0005;
      const maxSD = (imrL-mmrL)*0.6;  // max safe stop decimal
      // Stop = max safe stop distance from locked entry
      const liqLongLive  = +(ls.entry*(1-imrL+mmrL+feeL)).toFixed(dec);
      const liqShortLive = +((ls.shortEntry||ls.entry)*(1+imrL-mmrL-feeL)).toFixed(dec);
      const lSLlive  = +(ls.entry*(1-maxSD)).toFixed(dec);
      const sSLlive  = +((ls.shortEntry||ls.entry)*(1+maxSD)).toFixed(dec);
      const liqDistPct = (imrL-mmrL)*100;
      const lRisk = maxSD*100;
      const sRisk = maxSD*100;
      setup={...freshSetup,
        lE:ls.entry,
        lSL:lSLlive, lRisk,
        lTP1:ls.takeProfits[0], lTP2:ls.takeProfits[1],
        sE:ls.shortEntry||freshSetup.sE,
        sSL:sSLlive, sRisk,
        sTP1:ls.shortTPs?.[0]||freshSetup.sTP1, sTP2:ls.shortTPs?.[1]||freshSetup.sTP2,
        liqLong:liqLongLive, liqShort:liqShortLive,
        liqDistPct,
        levAdjustedLong:true, levAdjustedShort:true,
        atrStopLongPct:freshSetup.atrStopLongPct||0,
        atrStopShortPct:freshSetup.atrStopShortPct||0,
        maxStopPct:maxSD*100
      };
    } else if(sc>=7){
      // No active signal + score qualifies → lock a new one
      lockSignal(coin,activeTF,ta,freshSetup,sc,d.price,pivots,liqZones);
      lockedSig=swingSignals[coin+'_'+activeTF];
    }
  }
  const isLocked=!!lockedSig;

  // Phase 2: pre-compute secondary signal card HTML (avoids nested IIFEs in template)
  const secKey2 = coin+'_'+activeTF+'_sweep';
  const sec2 = swingSignals[secKey2];
  let sweepCardHtml = '';
  if(sec2){
    const fn2s = n => safeFormat(n, dec);
    const er = sec2.evolvedReason || {};
    const minsAgo = er.spawnedAt ? Math.round((Date.now()-er.spawnedAt)/60000) : 0;
    sweepCardHtml = '<div class="card full" style="border-color:rgba(167,139,250,0.5);background:rgba(167,139,250,0.06);border-width:2px">'
      + '<div class="card-title" style="color:var(--purple);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">'
      + '<span>Sweep Opportunity <span style="font-size:9px;background:rgba(167,139,250,.2);color:var(--purple);border:1px solid rgba(167,139,250,.4);border-radius:3px;padding:2px 7px;margin-left:6px;font-family:var(--mono)">EVOLVED</span></span>'
      + '<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">' + minsAgo + ' min ago - vol ' + (er.volumeMultiple||'?') + 'x - CVD ' + (er.cvdFlipped?'flipped':'neutral') + ' - OI ' + (er.oiDeltaPct>0?'+':'') + (er.oiDeltaPct||0) + '%</span>'
      + '<button onclick="delete swingSignals[\''+secKey2+'\'];saveSwingSignals();selectCoin(\''+coin+'\')" style="font-size:9px;background:rgba(255,77,77,0.1);color:var(--red);border:1px solid var(--red-b);border-radius:3px;padding:2px 8px;cursor:pointer;font-family:var(--mono)">Dismiss</button>'
      + '</div>'
      + '<p style="font-size:11px;color:var(--text2);font-family:var(--mono);margin:0 0 12px;line-height:1.6">Liq sweep at $' + fn2s(er.sweepPrice) + ' with ' + (er.volumeMultiple||'?') + 'x volume. Evolved from locked signal. Enter AFTER sweep candle closes.</p>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px">'
      + '<div style="background:var(--bg3);border-radius:7px;padding:10px;text-align:center"><div style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">ENTRY</div><div style="font-size:15px;font-weight:700;color:var(--blue);font-family:var(--mono)">$' + fn2s(sec2.lockedSetup.entry) + '</div></div>'
      + '<div style="background:var(--bg3);border-radius:7px;padding:10px;text-align:center"><div style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">STOP</div><div style="font-size:15px;font-weight:700;color:var(--red);font-family:var(--mono)">$' + fn2s(sec2.lockedSetup.stop) + '</div></div>'
      + '<div style="background:var(--bg3);border-radius:7px;padding:10px;text-align:center"><div style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">TP1</div><div style="font-size:15px;font-weight:700;color:var(--green);font-family:var(--mono)">$' + fn2s(sec2.lockedSetup.tp1) + '</div></div>'
      + '<div style="background:var(--bg3);border-radius:7px;padding:10px;text-align:center"><div style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">TP2</div><div style="font-size:15px;font-weight:700;color:var(--green);font-family:var(--mono)">$' + fn2s(sec2.lockedSetup.tp2) + '</div></div>'
      + '</div></div>';
  }
  const primarySig2 = swingSignals[coin+'_'+activeTF];
  const needsReviewHtml = (primarySig2 && primarySig2.reEval && primarySig2.reEval.needsReview)
    ? '<div style="background:rgba(245,166,35,0.08);border:1px solid rgba(245,166,35,0.35);border-radius:8px;padding:10px 14px;margin-bottom:0;display:flex;align-items:center;gap:10px">'
      + '<div><div style="font-size:12px;color:var(--amber);font-family:var(--mono);font-weight:600">Review recommended - market conditions shifted</div>'
      + '<div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-top:2px">2+ confluence factors detected. Locked levels still valid but verify before entering.</div></div></div>'
    : '';

  const scColor=sc>=7?'var(--green)':sc>=5?'var(--amber)':sc>=3?'var(--text2)':'var(--red)';
  const chCls=d.change24h>=0?'pos':'neg';
  const bullP=Math.min(85,Math.max(20,35+sc*5+(ta.trend==='bullish'?12:ta.trend==='mild-bullish'?6:0)));
  const bearP=100-bullP;
  const pm=(ta.atr/d.price*100);
  const bullT=+(d.price*(1+pm/100)).toFixed(dec);
  const bearT=+(d.price*(1-pm/100)).toFixed(dec);

  let tCol='var(--text2)',tLbl='Neutral';
  if(ta.trend==='bullish'){tCol='var(--green)';tLbl='Bullish';}
  else if(ta.trend==='mild-bullish'){tCol='#7de0b0';tLbl='Mild bullish';}
  else if(ta.trend==='mild-bearish'){tCol='var(--amber)';tLbl='Mild bearish';}
  else if(ta.trend==='bearish'){tCol='var(--red)';tLbl='Bearish';}

  const rsiCol=ta.rsi<35?'var(--green)':ta.rsi>65?'var(--red)':'var(--text)';
  const fCol=d.funding<0.01?'var(--green)':d.funding>0.04?'var(--red)':'var(--text)';

  let volHTML='';
  if(ta.volProfile.length){
    [...ta.volProfile].reverse().forEach(b=>{
      const pct=Math.round(b.pct*100);const isPOC=pct>=88;
      volHTML+=`<div class="vrow"><span class="vp-lbl" style="color:${isPOC?'var(--blue)':'var(--text3)'}">$${fn(b.price,dec>2?2:dec)}</span><div class="vtrack"><div class="vfill" style="width:${pct}%;background:${isPOC?'var(--blue)':'rgba(255,255,255,.15)'}"></div></div><span class="vpct">${pct}%${isPOC?' POC':''}</span></div>`;
    });
  }

  const lNote=entryMode==='optimal'&&entries.pullbackPct>0.05?`<div class="opt-note">Wait for pullback ${entries.pullbackPct.toFixed(2)}% → $${fn(setup.lE,dec)}</div>`:'';
  const sNote=entryMode==='optimal'&&entries.rallyPct>0.05?`<div class="opt-note">Wait for rally ${entries.rallyPct.toFixed(2)}% → $${fn(setup.sE,dec)}</div>`:'';

  document.getElementById('main-content').innerHTML=`
    <div class="mhdr">
      <div>
        <div class="coin-tf">${coin} / USDT — ${activeTF}</div>
        <div class="coin-full">${COINS[coin].name}</div>
        <div class="price-row">
          <span class="price-big">$${fn(d.price,dec)}</span>
          <span class="price-chg ${chCls}">${fp(d.change24h)}</span>
          <span class="cbadge ${v.cls}" style="margin-left:6px">${v.text}</span>
        </div>
      </div>
      <div class="score-box">
        <div class="score-num" style="color:${scColor}">${sc}<span style="font-size:15px;color:var(--text3)">/10</span></div>
        <div class="score-lbl">Signal score</div>
      </div>
    </div>

    <div class="entry-toggle">
      <span class="et-label">Entry mode:</span>
      <div class="et-btns">
        <button class="et-btn ${entryMode==='optimal'?'active':''}" onclick="setEntryMode('optimal')">Optimal entry</button>
        <button class="et-btn ${entryMode==='current'?'active':''}" onclick="setEntryMode('current')">Current price</button>
      </div>
      <span class="et-info">${entryMode==='optimal'?'Waits for best pullback/rally price':'Enters at current market price'}</span>
    </div>

    <div class="content">

      <!-- Charts: TradingView + Custom with levels -->
      <div class="card full">
        <div class="card-title">Live chart — TradingView (${activeTF} candlesticks)</div>
        <div class="tv-wrap"><div class="tradingview-widget-container" id="tv-chart" style="height:100%;width:100%"></div></div>
      </div>

      <!-- Custom chart with auto levels -->
      <div class="card full">
        <div class="card-title">Trade levels chart — entry, stops & targets drawn automatically</div>
        <div class="chart-legend">
          <span class="cl-item"><span class="cl-line" style="background:#4a9eff"></span>Price</span>
          <span class="cl-item"><span class="cl-line" style="background:#00d084;border-top:2px dashed #00d084"></span>Long entry</span>
          <span class="cl-item"><span class="cl-line" style="background:#ff4d4d;border-top:2px dashed #ff4d4d"></span>Stop loss</span>
          <span class="cl-item"><span class="cl-line" style="background:#00d084"></span>TP1 / TP2</span>
          <span class="cl-item"><span class="cl-line" style="background:#f5a623"></span>Short entry</span>
          <span class="cl-item"><span class="cl-line" style="background:#ff4d4d;opacity:.5"></span>Liquidation</span>
        </div>
        <div class="chart-canvas-wrap">
          <canvas id="custom-chart" role="img" aria-label="${coin} price chart with trade levels drawn"></canvas>
        </div>
        <!-- CVD / Order Flow Delta -->
        <div style="margin-top:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;flex-wrap:wrap;gap:6px">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:var(--text3);font-family:var(--mono)">Order flow — CVD (Cumulative Volume Delta)</span>
              <span style="font-size:9px;color:${cvdData.trend==='bullish'?'var(--green)':cvdData.trend==='bearish'?'var(--red)':'var(--text2)'};font-family:var(--mono);font-weight:600">${cvdData.trend.toUpperCase()}</span>
            </div>
            ${cvdData.divergence
              ? `<span style="font-size:9px;padding:2px 8px;border-radius:3px;font-family:var(--mono);background:${cvdData.divergence.type==='bearish'?'rgba(255,77,77,.2)':'rgba(0,208,132,.2)'};color:${cvdData.divergence.type==='bearish'?'var(--red)':'var(--green)'}">${cvdData.divergence.label}</span>`
              : '<span style="font-size:9px;color:var(--text3);font-family:var(--mono)">No divergence</span>'
            }
          </div>
          <div class="cvd-canvas-wrap">
            <canvas id="cvd-chart" role="img" aria-label="CVD order flow delta chart"></canvas>
          </div>
        </div>
      </div>

      <!-- Leverage card -->
      <div class="lev-card full" id="lev-card">
        <div class="card-title" style="color:var(--red)">Leverage analysis — ${activeLev}x
          <span id="lev-warning-badge" style="margin-left:8px;font-size:8px;padding:2px 8px;border-radius:3px;background:rgba(255,77,77,.2);color:var(--red)">HIGH RISK</span>
        </div>
        <div class="lev-grid" id="lev-grid"></div>
        <div class="liq-warning" id="lev-warning-text"></div>
      </div>

      <!-- MTF Confluence -->
      ${mtfData ? renderMTFCard(mtfData, dec) : ''}
      ${liqZones ? renderLiqCard(liqZones, d.price, dec) : ''}
      ${renderLiqScaleInCard(coin, activeTF, d.price, ta, klines, cvdData, dec, liqZones)}
      ${liqZones ? renderPostSweepCard(detectPostSweepConfirmation(klines, liqZones, dec), dec) : ''}

      <!-- Phase 2: sweep opportunity + review banner (pre-computed above) -->
      ${sweepCardHtml}
      ${needsReviewHtml}
      <!-- Long setup -->
      <div class="card" style="border-left:3px solid var(--green)${isLocked?';border-top:1px solid rgba(245,166,35,0.4)':''}">
        <div class="card-title" style="color:var(--green);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
          <span>Long setup ${isLocked?`<span style="font-size:9px;background:rgba(245,166,35,0.15);color:var(--amber);border:1px solid rgba(245,166,35,0.4);border-radius:3px;padding:2px 7px;margin-left:6px;font-family:var(--mono);letter-spacing:.06em">LOCKED</span>`:''}
          ${isLocked&&lockedSig?`<span style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-left:6px">${lockedSig.dynamic.candlesElapsed} candle${lockedSig.dynamic.candlesElapsed!==1?'s':''} ago</span>`:''}
          </span>
          ${isLocked?`<button onclick="invalidateSignal('${coin}','${activeTF}','dismissed');selectCoin('${coin}')" style="font-size:9px;background:rgba(255,77,77,0.1);color:var(--red);border:1px solid var(--red-b);border-radius:3px;padding:2px 8px;cursor:pointer;font-family:var(--mono)">✕ Dismiss</button>`:''}
        </div>
        <div class="srow"><span class="skey">${entryMode==='optimal'?'Optimal entry':'Entry (market)'}</span><span class="sval vb">$${fn(setup.lE,dec)}</span></div>
        <div class="srow" style="${setup.levAdjustedLong?'background:rgba(74,158,255,0.05);border-radius:6px;padding:6px 4px;margin-bottom:2px':''}">
          <span class="skey">Stop loss</span>
          <span class="sval vr">
            $${fn(setup.lSL,dec)}
            <span style="font-size:11px;color:var(--text2);margin-left:3px">-${setup.lRisk.toFixed(3)}%</span>
            ${setup.levAdjustedLong
              ? `<span style="display:block;font-size:10px;color:var(--blue);margin-top:3px;font-family:var(--mono)">
                  ⚡ Capped for ${activeLev}x — ATR stop would be ${setup.atrStopLongPct.toFixed(3)}% → max safe: ${setup.maxStopPct.toFixed(3)}%
                </span>`
              : ''}
          </span>
        </div>
        <div class="srow"><span class="skey">Liq price @ ${activeLev}x</span><span class="sval" style="color:rgba(255,77,77,0.7);font-family:var(--mono)">$${fn(setup.liqLong,dec)} <span style="font-size:10px;color:var(--text3)">(${setup.liqDistPct.toFixed(3)}% from entry)</span></span></div>
        <div class="srow"><span class="skey">Take profit 1</span><span class="sval vg">$${fn(setup.lTP1,dec)} <span style="font-size:11px;color:var(--text2)">+${setup.lRew.toFixed(3)}%</span></span></div>
        <div class="srow"><span class="skey">Take profit 2</span><span class="sval vg">$${fn(setup.lTP2,dec)}</span></div>
        <div class="srow"><span class="skey">R:R ratio</span><span class="sval">${setup.lRR.toFixed(2)}:1 <span class="rrtag ${setup.lRR>=1.5?'rrg':'rrr'}">${setup.lRR>=1.5?'good':'weak'}</span></span></div>
        <div class="srow"><span class="skey">ATR volatility</span><span class="sval">$${fn(ta.atr,dec>2?2:dec)}</span></div>

        <div class="srow" style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
          <span class="skey">CVD signal</span>
          <span class="sval" style="color:${cvdData.trend==='bullish'?'var(--green)':cvdData.trend==='bearish'?'var(--red)':'var(--text2)'}">
            ${cvdData.trend==='bullish'?'✓ Confirms long':cvdData.trend==='bearish'?'✗ Conflicts (sellers dominant)':'— Neutral flow'}
            <span style="font-size:10px;color:var(--text3);margin-left:4px">buy ${cvdData.buyPct}% / sell ${cvdData.sellPct}%${cvdData.source==='live'?' (live)':' (est)'}</span>
          </span>
        </div>
        ${lNote}
        <div class="pattern-note" id="pattern-long-note">Analyzing chart pattern for refined entry...</div>
      </div>

      <!-- Short setup -->
      <div class="card" style="border-left:3px solid var(--red)${isLocked?';border-top:1px solid rgba(245,166,35,0.4)':''}">
        <div class="card-title" style="color:var(--red);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
          <span>Short setup ${isLocked?`<span style="font-size:9px;background:rgba(245,166,35,0.15);color:var(--amber);border:1px solid rgba(245,166,35,0.4);border-radius:3px;padding:2px 7px;margin-left:6px;font-family:var(--mono);letter-spacing:.06em">LOCKED</span>`:''}
          ${isLocked&&lockedSig?`<span style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-left:6px">${lockedSig.dynamic.candlesElapsed} candle${lockedSig.dynamic.candlesElapsed!==1?'s':''} ago</span>`:''}
          </span>
        </div>
        <div class="srow"><span class="skey">${entryMode==='optimal'?'Optimal entry':'Entry (market)'}</span><span class="sval vb">$${fn(setup.sE,dec)}</span></div>
        <div class="srow" style="${setup.levAdjustedShort?'background:rgba(74,158,255,0.05);border-radius:6px;padding:6px 4px;margin-bottom:2px':''}">
          <span class="skey">Stop loss</span>
          <span class="sval vr">
            $${fn(setup.sSL,dec)}
            <span style="font-size:11px;color:var(--text2);margin-left:3px">+${setup.sRisk.toFixed(3)}%</span>
            ${setup.levAdjustedShort
              ? `<span style="display:block;font-size:10px;color:var(--blue);margin-top:3px;font-family:var(--mono)">
                  ⚡ Capped for ${activeLev}x — ATR stop would be ${setup.atrStopShortPct.toFixed(3)}% → max safe: ${setup.maxStopPct.toFixed(3)}%
                </span>`
              : ''}
          </span>
        </div>
        <div class="srow"><span class="skey">Liq price @ ${activeLev}x</span><span class="sval" style="color:rgba(255,77,77,0.7);font-family:var(--mono)">$${fn(setup.liqShort,dec)} <span style="font-size:10px;color:var(--text3)">(${setup.liqDistPct.toFixed(3)}% from entry)</span></span></div>
        <div class="srow"><span class="skey">Take profit 1</span><span class="sval vg">$${fn(setup.sTP1,dec)} <span style="font-size:11px;color:var(--text2)">-${setup.sRew.toFixed(3)}%</span></span></div>
        <div class="srow"><span class="skey">Take profit 2</span><span class="sval vg">$${fn(setup.sTP2,dec)}</span></div>
        <div class="srow"><span class="skey">R:R ratio</span><span class="sval">${setup.sRR.toFixed(2)}:1 <span class="rrtag ${setup.sRR>=1.5?'rrg':'rrr'}">${setup.sRR>=1.5?'good':'weak'}</span></span></div>
        <div class="srow"><span class="skey">ATR volatility</span><span class="sval">$${fn(ta.atr,dec>2?2:dec)}</span></div>

        <div class="srow" style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
          <span class="skey">CVD signal</span>
          <span class="sval" style="color:${cvdData.trend==='bearish'?'var(--green)':cvdData.trend==='bullish'?'var(--red)':'var(--text2)'}">
            ${cvdData.trend==='bearish'?'✓ Confirms short':cvdData.trend==='bullish'?'✗ Conflicts (buyers dominant)':'— Neutral flow'}
            <span style="font-size:10px;color:var(--text3);margin-left:4px">sell ${cvdData.sellPct}% / buy ${cvdData.buyPct}%${cvdData.source==='live'?' (live)':' (est)'}</span>
          </span>
        </div>
        ${sNote}
        <div class="pattern-note" id="pattern-short-note">Analyzing chart pattern for refined entry...</div>
      </div>

      <!-- Pattern Recognition -->
      <div class="pattern-card full" id="pattern-section">
        <div class="card-title" style="color:var(--purple)">Chart pattern recognition — Claude AI</div>
        <div class="ai-loading"><div class="spin"></div><span>Analyzing ${activeTF} candle structure for ${coin}...</span></div>
      </div>

      <!-- Technical indicators -->
      <div class="card full">
        <div class="card-title">Technical indicators</div>
        <div class="metrics-grid">
          <div class="metric"><div class="mlbl">RSI 14</div><div class="mval" style="color:${rsiCol}">${ta.rsi.toFixed(1)}</div><div class="msub">${ta.rsi<30?'Oversold':ta.rsi>70?'Overbought':ta.rsi<45?'Neutral low':'Neutral high'}</div></div>
          <div class="metric"><div class="mlbl">EMA 20</div><div class="mval">$${fn(ta.ema20,dec>2?2:dec)}</div><div class="msub" style="color:${d.price>ta.ema20?'var(--green)':'var(--red)'}">${d.price>ta.ema20?'Above':'Below'}</div></div>
          <div class="metric"><div class="mlbl">ATR 14</div><div class="mval">$${fn(ta.atr,dec>2?2:dec)}</div><div class="msub">Volatility range</div></div>
          <div class="metric"><div class="mlbl">Trend</div><div class="mval" style="color:${tCol};font-size:11px">${tLbl}</div><div class="msub">EMA structure</div></div>
          <div class="metric"><div class="mlbl">Fear & Greed</div><div class="mval">${d.fgValue}</div><div class="msub">${d.fgLabel}</div></div>
          <div class="metric"><div class="mlbl">Funding rate</div>
            <div class="mval" style="color:${fCol}">${d.funding.toFixed(4)}%</div>
            <div class="msub" style="color:${fundingMom.momentum==='flipping'?'var(--amber)':fundingMom.momentum.includes('accelerating')?'var(--red)':'var(--text3)'}">
              ${fundingMom.momentum==='flipping'?'Flipping direction':fundingMom.direction==='rising'?'Rising (longs paying more)':fundingMom.direction==='falling'?'Falling (shorts paying more)':'Stable'} ${fundingMom.flipped?'— just flipped':''}
            </div>
          </div>
        </div>
      </div>

      <!-- OI -->
      <div class="card">
        <div class="card-title">Open interest</div>
        <div class="oi-grid">
          <div class="oic"><div class="oil">OI notional</div>
            <div class="oiv">$${(d.oiNotional/1e9).toFixed(1)}B</div>
            <div class="ois" style="color:${oiMom.spike?'var(--red)':oiMom.trend==='rising'?'var(--green)':oiMom.trend==='falling'?'var(--amber)':'var(--text3)'}">
              ${oiMom.spike?'SPIKE: '+oiMom.changePct+'% — forced liqs likely':oiMom.trend==='rising'?'+'+oiMom.changePct+'% building':oiMom.trend==='falling'?oiMom.changePct+'% unwinding':'Stable'}
            </div>
          </div>
          <div class="oic"><div class="oil">Funding rate</div><div class="oiv" style="color:${fCol}">${d.funding.toFixed(4)}%</div><div class="ois">Positive = longs pay</div></div>
          <div class="oic"><div class="oil">OI signal</div><div class="oiv" style="font-size:10px;color:var(--text2)">${d.funding<0.005?'Longs underfunded':d.funding>0.04?'Overleveraged long':'Balanced'}</div></div>
        </div>
      </div>

      <!-- Volume profile -->
      <div class="card">
        <div class="card-title">Volume profile — ${activeTF}</div>
        ${volHTML||'<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">Insufficient data</span>'}
      </div>

      <!-- Predictive -->
      <div class="card full">
        <div class="card-title">Predictive movement model</div>
        <div class="prow">
          <span class="pk">Bull scenario — +${pm.toFixed(2)}% (1 ATR)</span>
          <div class="pright"><span class="pval vg">$${fn(bullT,dec)}</span><div class="pbar-w"><div class="pbar" style="width:${bullP}%;background:var(--green)"></div></div><span class="ppct">${bullP}%</span></div>
        </div>
        <div class="prow">
          <span class="pk">Bear scenario — -${pm.toFixed(2)}% (1 ATR)</span>
          <div class="pright"><span class="pval vr">$${fn(bearT,dec)}</span><div class="pbar-w"><div class="pbar" style="width:${bearP}%;background:var(--red)"></div></div><span class="ppct">${bearP}%</span></div>
        </div>
        <div class="pred-levels">
          <div class="metric"><div class="mlbl">Key support</div><div class="mval vb">$${fn(ta.support,dec)}</div></div>
          <div class="metric"><div class="mlbl">Key resistance</div><div class="mval va">$${fn(ta.resistance,dec)}</div></div>
          <div class="metric"><div class="mlbl">Volume POC</div><div class="mval vb">$${fn(ta.poc,dec>2?2:dec)}</div></div>
        </div>
      </div>

      <!-- AI Analysis summary -->
      <div class="ai-card full" id="ai-section">
        <div class="card-title" style="color:var(--blue)">AI analysis — Claude</div>
        <div class="ai-loading"><div class="spin"></div><span>Generating analysis...</span></div>
      </div>

      <!-- Scan table -->
      <div class="card full">
        <div class="card-title">All markets — signal ranking</div>
        <table class="stable"><thead><tr>
          <th>Coin</th><th>Score</th><th>Price</th><th>24h</th>
          <th>OI</th><th>Funding</th><th>RSI</th><th>Trend</th><th>Signal</th>
        </tr></thead><tbody id="scan-tbody"></tbody></table>
      </div>

      <div class="foot full">Data: Binance (live prices, klines, funding, OI) · Alternative.me (Fear & Greed) · TradingView (chart) · Claude AI (pattern recognition). Stops = 1.5× ATR. Not financial advice.</div>
    </div>
  `;

  buildTVChart(coin,activeTF);
  setTimeout(()=>{
    buildCustomChart(klines,setup,dec,activeLev);
    buildLevCard(d.price,setup,activeLev,dec);
    // redraw after lev card updates setup with liq prices
    setTimeout(()=>{
      buildCustomChart(klines,setup,dec,activeLev);
      buildCVDChart(klines,cvdData);
    },50);
  },100);
  renderScanBody();
  loadAI(coin,ta,sc,setup,klines,mtfData,liqZones,cvdData);
  // Phase 2 re-eval
  if(activeMode==='swing' && lockedSig && !lockedSig.isSecondary){
    runPhase2ReEval(lockedSig, klines, cvdData, d.oiNotional||0, dec);
  }
  // Post-sweep Telegram alert — fires immediately on sweep confirmation, no AI needed
  if(liqZones){
    const sweep = detectPostSweepConfirmation(klines, liqZones, dec);
    if(sweep && sweep.confirmed){
      const sweepKey = coin+'_'+activeTF+'_sweep_alert';
      const lastFired = sessionStorage.getItem(sweepKey);
      const candleTime = getCurrentCandleTime(activeTF);
      if(lastFired !== String(candleTime)){
        sessionStorage.setItem(sweepKey, String(candleTime));
        sendSweepAlert(coin, sweep, ta, setup, dec);
        console.log('Sweep alert fired:', coin, sweep.side, sweep.sweepLevel);
      }
    }
  }
}

function renderScanBody(){
  const tbody=document.getElementById('scan-tbody');if(!tbody)return;
  const rows=Object.keys(COINS).map(c=>{
    const kl=klCache[c+'_'+activeTF]||[];const ta=calcTA(kl);
    return{c,sc:scoreSignal(c,ta),d:mktData[c]||{},ta};
  }).sort((a,b)=>b.sc-a.sc);
  const bc=sc=>sc>=7?'var(--green)':sc>=5?'var(--amber)':'var(--red)';
  tbody.innerHTML=rows.map(({c,sc,d,ta})=>{
    const v=verdictOf(sc);const dec=COINS[c].dec;const ch=d.change24h||0;
    let tl='Neutral';
    if(ta.trend==='bullish')tl='Bullish';else if(ta.trend==='mild-bullish')tl='Mild bull';
    else if(ta.trend==='bearish')tl='Bearish';else if(ta.trend==='mild-bearish')tl='Mild bear';
    return`<tr class="${c===activeCoin?'arow':''}" onclick="selectCoin('${c}')">
      <td style="font-weight:500">${c}</td>
      <td><div class="smbar"><div class="smtrack"><div class="smfill" style="width:${sc*10}%;background:${bc(sc)}"></div></div>${sc}/10</div></td>
      <td>$${fn(d.price,dec)}</td>
      <td class="${ch>=0?'pos':'neg'}">${fp(ch)}</td>
      <td>$${(d.oiNotional/1e9).toFixed(1)}B</td>
      <td>${d.funding.toFixed(4)}%</td>
      <td style="color:${ta.rsi<40?'var(--green)':ta.rsi>60?'var(--red)':'var(--text)'}">${ta.rsi.toFixed(1)}</td>
      <td>${tl}</td>
      <td><span class="cbadge ${v.cls}">${v.text}</span></td>
    </tr>`;
  }).join('');
}


async function selectCoin(c){
  activeCoin=c;aiCache={};
  document.getElementById('main-content').innerHTML=`<div class="loading-full"><div class="spin"></div><span>Loading ${c} (${activeMode} mode)...</span></div>`;
  try{
    const klines = await fetchKlines(c, activeTF);
    let mtfData = null;
    try {
      const mtfKlines = await fetchMTFKlines(c);
      mtfData = calcMTFAnalysis(mtfKlines);
    } catch(e) { console.warn('MTF fetch failed:', e); }
    const scores={};Object.keys(COINS).forEach(cc=>{
      const kl=klCache[cc+'_'+activeTF]||[];
      scores[cc]=scoreSignal(cc,calcTA(kl),null);
    });
    renderSidebar(scores);renderAlerts(scores);
    await renderDetail(c,klines,mtfData);
  }catch(e){document.getElementById('main-content').innerHTML=`<div class="loading-full"><span style="color:var(--red)">Error: ${e.message}</span></div>`;}
}
async function selectTF(tf,btn){
  document.querySelectorAll('.tf-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');activeTF=tf;klCache={};aiCache={};
  await selectCoin(activeCoin);
}
async function setEntryMode(mode){
  entryMode=mode;aiCache={};
  const klines=klCache[activeCoin+'_'+activeTF]||[];
  if(klines.length)await renderDetail(activeCoin,klines,null);
}
function seedPlaceholders(){
  const defaults={BTC:78000,ETH:2300,SOL:84,XRP:1.38,SUI:0.92};
  Object.keys(COINS).forEach(c=>{
    if(!mktData[c]||!mktData[c].price){
      mktData[c]={price:defaults[c]||1,change24h:0,high24h:defaults[c]*1.02||1,low24h:defaults[c]*0.98||1,volume24h:1000000000,funding:0.0001,oi:0,oiNotional:0,fgValue:50,fgLabel:'Neutral'};
    }
  });
}
// ── Layer 2: Funding history fetch (throttled to 8h per symbol) ──────────────
async function fetchFundingHistory(bybitSym) {
  const now = Date.now();
  const lastFetch = fundingLastFetch[bybitSym] || 0;
  // Only refetch if >8 hours since last fetch
  if (fundingHistoryCache[bybitSym] && (now - lastFetch) < 28800000) {
    return fundingHistoryCache[bybitSym];
  }
  try {
    const r = await fetchWithTimeout(
      'https://api.bybit.com/v5/market/funding/history?category=linear&symbol='+bybitSym+'&limit=8',
      6000
    );
    const list = r?.result?.list || [];
    const history = list.map(f => ({
      rate:      parseFloat(f.fundingRate) * 100,
      timestamp: parseInt(f.fundingRateTimestamp)
    })).reverse(); // oldest first
    if (history.length > 0) {
      fundingHistoryCache[bybitSym] = history;
      fundingLastFetch[bybitSym] = now;
    }
    return history;
  } catch(e) {
    console.warn('Funding history fetch failed:', bybitSym, e.message);
    return fundingHistoryCache[bybitSym] || [];
  }
}

// Analyse funding momentum from history array
function calcFundingMomentum(history) {
  if (!history || history.length < 3) return { momentum: 'neutral', direction: 'flat', acceleration: 0 };
  const last3 = history.slice(-3);
  const [a, b, c] = last3.map(h => h.rate);
  const trend1 = b - a;  // older change
  const trend2 = c - b;  // recent change
  const acceleration = trend2 - trend1;

  let direction = 'flat';
  if (trend2 > 0.001)  direction = 'rising';
  if (trend2 < -0.001) direction = 'falling';

  // Flip: funding crossed zero direction
  const flipped = (a > 0 && c < 0) || (a < 0 && c > 0);

  let momentum = 'neutral';
  if (flipped)                        momentum = 'flipping';
  else if (direction === 'rising'  && acceleration > 0) momentum = 'accelerating_positive';
  else if (direction === 'falling' && acceleration < 0) momentum = 'accelerating_negative';
  else if (direction === 'rising')    momentum = 'rising';
  else if (direction === 'falling')   momentum = 'falling';

  return { momentum, direction, acceleration: +acceleration.toFixed(5), latest: c, flipped };
}

// Track OI across refreshes (rolling 3-point window per symbol)
function trackOIHistory(bybitSym, currentOI) {
  if (!oiHistoryCache[bybitSym]) oiHistoryCache[bybitSym] = [];
  oiHistoryCache[bybitSym].push(currentOI);
  if (oiHistoryCache[bybitSym].length > 3) oiHistoryCache[bybitSym].shift();
  return oiHistoryCache[bybitSym];
}

function calcOIMomentum(bybitSym) {
  const hist = oiHistoryCache[bybitSym] || [];
  if (hist.length < 2) return { trend: 'unknown', changePct: 0, spike: false };
  const oldest = hist[0];
  const latest = hist[hist.length - 1];
  const changePct = oldest > 0 ? ((latest - oldest) / oldest * 100) : 0;
  // Spike: >3% change in last 3 refreshes = forced liquidations likely
  const spike = Math.abs(changePct) > 3;
  const trend = changePct > 0.5 ? 'rising' : changePct < -0.5 ? 'falling' : 'flat';
  return { trend, changePct: +changePct.toFixed(2), spike };
}

// Phase 3: Bybit WS core
function connectBybitWS(symbols) {
  if (bybitWS && bybitWS.readyState === WebSocket.OPEN) return;
  bybitWS = new WebSocket('wss://stream.bybit.com/v5/public/linear');
  bybitWS.onopen = function() {
    wsReconnectAttempts = 0;
    console.log('Bybit WS connected');
    const args = [];
    symbols.forEach(s => { args.push('allLiquidation.'+s); args.push('tickers.'+s); });
    bybitWS.send(JSON.stringify({ op:'subscribe', args }));
    bybitWS._ping = setInterval(() => {
      if (bybitWS.readyState === WebSocket.OPEN) bybitWS.send(JSON.stringify({op:'ping'}));
    }, 20000);
  };
  bybitWS.onmessage = function(e) {
    try {
      const msg = JSON.parse(e.data);
      if (!msg.data) return;
      const now = Date.now();
      if (msg.topic && msg.topic.startsWith('allLiquidation.')) {
        const liq = msg.data;
        bybitLiqQueue.unshift({ symbol:liq.symbol, price:parseFloat(liq.price), side:liq.side, qty:parseFloat(liq.qty), timestamp:now });
        if (bybitLiqQueue.length > 300) bybitLiqQueue.pop();
      }
      if (msg.topic && msg.topic.startsWith('tickers.')) {
        const t = msg.data;
        if (t.symbol) bybitTickerCache[t.symbol] = { fundingRate:parseFloat(t.fundingRate||0), openInterest:parseFloat(t.openInterest||0), lastPrice:parseFloat(t.lastPrice||0), timestamp:now };
      }
    } catch(e2) {}
  };
  bybitWS.onclose = function() {
    clearInterval(bybitWS._ping);
    if (wsReconnectAttempts < WS_MAX_RECONNECT) {
      wsReconnectAttempts++;
      setTimeout(() => connectBybitWS(symbols), Math.min(1000*Math.pow(2,wsReconnectAttempts),30000));
    }
  };
  bybitWS.onerror = function() { console.warn('Bybit WS error'); };
}

function getWSStatusHTML() {
  const now = Date.now();
  let text = 'WS Connected', col = 'var(--green)';
  if (!bybitWS || bybitWS.readyState !== WebSocket.OPEN) { text='WS Reconnecting'; col='var(--amber)'; }
  else if (!bybitLiqQueue.length || (now-bybitLiqQueue[0].timestamp)>WS_STALE_MS) { text='WS quiet 5min+'; col='var(--amber)'; }
  return '<span style="font-size:9px;font-family:var(--mono);color:'+col+'">'
    +'<span style="display:inline-block;width:6px;height:6px;background:'+col+';border-radius:50%;margin-right:4px;vertical-align:middle"></span>'
    +text+'</span>';
}

function cleanupLiqQueue() {
  const cutoff = Date.now()-3600000;
  while (bybitLiqQueue.length && bybitLiqQueue[bybitLiqQueue.length-1].timestamp<cutoff) bybitLiqQueue.pop();
}

function checkForRealSweep(sig, currentPrice) {
  const bybitSym = (COINS[sig.symbol]||{}).sym||(sig.symbol+'USDT');
  const isLong = sig.lockedSetup.bias !== 'bearish';
  const level = isLong ? sig.lockedSetup.invalidationLevel : (sig.lockedSetup.resistance||currentPrice*1.02);
  const atr = sig.lockedSetup.atr||currentPrice*0.02;
  for (const ev of bybitLiqQueue) {
    if (ev.symbol !== bybitSym) continue;
    const hit = isLong ? ev.price<=level : ev.price>=level;
    if (hit && Math.abs(ev.price-currentPrice)<atr*2) return {hit:true,price:ev.price,side:ev.side,qty:ev.qty,timestamp:ev.timestamp};
  }
  return {hit:false};
}

async function init(){
  const btn=document.getElementById('rbtn');
  btn.disabled=true;btn.textContent='↻ Refreshing...';
  klCache={};aiCache={};
  loadSwingSignals();   // restore persisted swing signals before anything renders
  const trackedSyms = Object.values(COINS).map(c=>c.sym);
  connectBybitWS(trackedSyms);
  seedPlaceholders();
  const scores={};
  Object.keys(COINS).forEach(c=>{scores[c]=5;});
  renderSidebar(scores);
  renderAlerts(scores);
  const fetchTimeout = 8000;
  try{
    document.getElementById('main-content').innerHTML=`<div class="loading-full"><div class="spin"></div><span>Loading market data...</span></div>`;
    const marketPromise = Promise.race([
      (async()=>{
        const syms=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','SUIUSDT'];
        const results=await Promise.all(syms.map(s=>
          fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`,5000)
        ));
        results.forEach((r,i)=>{
          const coin=Object.keys(COINS).find(c=>COINS[c].sym===syms[i]);
          if(!coin)return;
          const t=r?.result?.list?.[0];
          if(!t)return;
          const price=parseFloat(t.lastPrice)||0;
          const open24=parseFloat(t.prevPrice24h)||price;
          const oiVal = parseFloat(t.openInterest)||0;
          const oiNotionalVal = oiVal*price;
          mktData[coin]={price,change24h:open24?((price-open24)/open24*100):0,high24h:parseFloat(t.highPrice24h)||0,low24h:parseFloat(t.lowPrice24h)||0,volume24h:parseFloat(t.turnover24h)||0,funding:parseFloat(t.fundingRate)*100||0,oi:oiVal,oiNotional:oiNotionalVal,fgValue:mktData[coin]?.fgValue||50,fgLabel:mktData[coin]?.fgLabel||'Neutral'};
          trackOIHistory(COINS[coin].sym, oiNotionalVal);
        });
        return 'bybit';
      })(),
      new Promise(resolve=>setTimeout(()=>resolve('timeout'),fetchTimeout))
    ]);
    const source = await marketPromise;
    console.log('Market data source:', source);
    try{
      const fg=await fetchWithTimeout('https://api.alternative.me/fng/?limit=1',4000);
      const val=parseInt(fg.data[0]?.value||50);
      const lbl=fg.data[0]?.value_classification||'Neutral';
      Object.keys(COINS).forEach(c=>{mktData[c].fgValue=val;mktData[c].fgLabel=lbl;});
    }catch(e){}
  }catch(e){
    console.error('Market fetch error:',e);
    seedPlaceholders();
  }
  try{
    // Fetch all coins klines simultaneously for accurate RSI/trend
    const allKlineResults = await Promise.allSettled(
      Object.keys(COINS).map(c => fetchKlines(c, activeTF))
    );
    const klines = klCache[activeCoin+'_'+activeTF] || [];
    let mtfData=null;
    try{
      const mtfKlines=await fetchMTFKlines(activeCoin);
      mtfData=calcMTFAnalysis(mtfKlines);
    }catch(e){console.warn('MTF failed:',e);}
    const newScores={};
    Object.keys(COINS).forEach(c=>{
      const kl=klCache[c+'_'+activeTF]||[];
      newScores[c]=scoreSignal(c,calcTA(kl),null);
    });
    renderSidebar(newScores);renderAlerts(newScores);
    await renderDetail(activeCoin,klines,mtfData);
    cleanupLiqQueue();
    const wsEl=document.getElementById('ws-status');
    if(wsEl) wsEl.innerHTML=getWSStatusHTML();
    document.getElementById('last-upd').textContent='Updated '+new Date().toLocaleTimeString();
  }catch(e){
    document.getElementById('main-content').innerHTML=`<div class="loading-full"><span style="color:var(--red);font-family:var(--mono);font-size:13px">Error: ${e.message}<br><br>Try refreshing</span></div>`;
  }
  btn.disabled=false;btn.textContent='↻ Refresh all data';
}
init();

// ── Post-Sweep Confirmation detection (for 75x-125x entries) ────────────────
// A sweep is confirmed when a candle wicked through a liq zone AND closed back.
// Returns sweep details or null if no confirmed sweep.
function detectPostSweepConfirmation(klines, liqZones, dec) {
  if (!klines || klines.length < 3 || !liqZones) return null;

  // Scan last 3 completed candles (newest first) — return freshest sweep
  for (let offset = 2; offset <= 4; offset++) {
    const prev = klines[klines.length - offset];      // candidate sweep candle
    const curr = klines[klines.length - offset + 1];  // candle after it
    if (!prev || !curr) continue;

    // Long sweep: wick pierced liq zone AND closed back above it
    const longZones = liqZones.longLiqZones || [];
    for (const zone of longZones) {
      if (prev.l <= zone.price && prev.c > zone.price) {
        const isConfirmed = curr.c > prev.c;
        const sweepDepth  = +((prev.c - prev.l) / prev.c * 100).toFixed(3);
        const recovery    = +((curr.c - prev.l) / (prev.c - prev.l) * 100).toFixed(1);
        const candlesAgo  = offset - 1;
        if (candlesAgo > 2) continue;

        // Leverage-aware stop — wick stop if it fits, otherwise cap to max safe
        const mmrP    = activeLev >= 100 ? 0.005 : activeLev >= 25 ? 0.004 : 0.003;
        const maxSD   = (1/activeLev - mmrP) * 0.6;
        const wickStop = +(prev.l * 0.998).toFixed(dec);
        const wickStopPct = (curr.c - wickStop) / curr.c;
        const safeStop = +(curr.c * (1 - maxSD)).toFixed(dec);
        const stopPrice = wickStopPct <= maxSD ? wickStop : safeStop;
        const stopPct   = +((curr.c - stopPrice) / curr.c * 100).toFixed(3);
        const stopNote  = wickStopPct <= maxSD ? 'wick' : 'capped';

        return {
          side: 'long', sweepCandle: prev,
          sweepLow: prev.l, sweepLevel: zone.price, leverage: zone.leverage,
          entryPrice: +curr.c.toFixed(dec),
          stopPrice, stopPct, stopNote,
          tp1: +(curr.c * 1.0045).toFixed(dec),
          tp2: +(curr.c * 1.009).toFixed(dec),
          tp3: +(curr.c * 1.018).toFixed(dec),
          sweepDepth, recovery, confirmed: isConfirmed,
          candlesAgo, freshness: candlesAgo === 1 ? 'just confirmed' : candlesAgo + ' candles ago',
          maxSafePct: +(maxSD * 100).toFixed(3)
        };
      }
    }

    // Short squeeze: wick pierced liq zone AND closed back below it
    const shortZones = liqZones.shortLiqZones || [];
    for (const zone of shortZones) {
      if (prev.h >= zone.price && prev.c < zone.price) {
        const isConfirmed = curr.c < prev.c;
        const sweepDepth  = +((prev.h - prev.c) / prev.c * 100).toFixed(3);
        const recovery    = +((prev.h - curr.c) / (prev.h - prev.c) * 100).toFixed(1);
        const candlesAgo  = offset - 1;
        if (candlesAgo > 2) continue;

        const mmrP    = activeLev >= 100 ? 0.005 : activeLev >= 25 ? 0.004 : 0.003;
        const maxSD   = (1/activeLev - mmrP) * 0.6;
        const wickStop = +(prev.h * 1.002).toFixed(dec);
        const wickStopPct = (wickStop - curr.c) / curr.c;
        const safeStop = +(curr.c * (1 + maxSD)).toFixed(dec);
        const stopPrice = wickStopPct <= maxSD ? wickStop : safeStop;
        const stopPct   = +((stopPrice - curr.c) / curr.c * 100).toFixed(3);
        const stopNote  = wickStopPct <= maxSD ? 'wick' : 'capped';

        return {
          side: 'short', sweepCandle: prev,
          sweepHigh: prev.h, sweepLevel: zone.price, leverage: zone.leverage,
          entryPrice: +curr.c.toFixed(dec),
          stopPrice, stopPct, stopNote,
          tp1: +(curr.c * 0.9955).toFixed(dec),
          tp2: +(curr.c * 0.991).toFixed(dec),
          tp3: +(curr.c * 0.982).toFixed(dec),
          sweepDepth, recovery, confirmed: isConfirmed,
          candlesAgo, freshness: candlesAgo === 1 ? 'just confirmed' : candlesAgo + ' candles ago',
          maxSafePct: +(maxSD * 100).toFixed(3)
        };
      }
    }
  }
  return null;
}

// ── Render Post-Sweep Confirmation card (75x-125x precision entry) ────────────
function renderPostSweepCard(sweep, dec) {
  if (!sweep) return '';
  const fn2 = n => safeFormat(n, dec);
  const isLong = sweep.side === 'long';
  const col    = isLong ? 'var(--green)' : 'var(--red)';
  const bg     = isLong ? 'rgba(0,208,132,0.04)' : 'rgba(255,77,77,0.04)';
  const border = isLong ? 'rgba(0,208,132,0.5)' : 'rgba(255,77,77,0.5)';
  const label  = isLong ? 'Long after sweep' : 'Short after squeeze';
  const conf   = sweep.confirmed ? 'CONFIRMED' : 'WATCH — not confirmed yet';
  const confCol= sweep.confirmed ? 'var(--green)' : 'var(--amber)';

  const isSafe  = sweep.stopPct <= (sweep.maxSafePct || 0.5);
  const stopLabel = sweep.stopNote === 'wick' ? 'wick stop' : 'capped stop';
  const levNote = activeLev >= 75
    ? isSafe
      ? '<div style="background:rgba(0,208,132,0.1);border:1px solid var(--green-b);border-radius:6px;padding:8px 12px;margin-top:10px;font-size:11px;color:var(--green);font-family:var(--mono)">Stop ('
        + sweep.stopPct.toFixed(3) + '%) is within safe range for ' + activeLev + 'x (max safe: ' + (sweep.maxSafePct||'?') + '%). Using ' + stopLabel + '.</div>'
      : '<div style="background:rgba(255,77,77,0.1);border:1px solid var(--red-b);border-radius:6px;padding:8px 12px;margin-top:10px;font-size:11px;color:var(--red);font-family:var(--mono)">Stop capped to '
        + sweep.stopPct.toFixed(3) + '% (max safe for ' + activeLev + 'x). Wick was too wide — reduce size or use 25-50x instead.</div>'
    : '<div style="background:rgba(245,166,35,0.08);border:1px solid rgba(245,166,35,0.3);border-radius:6px;padding:8px 12px;margin-top:10px;font-size:11px;color:var(--amber);font-family:var(--mono)">You are on '+activeLev+'x. This setup works best at 75x-125x for tight entries.</div>';

  return '<div class="card full" style="border-color:'+border+';background:'+bg+';border-width:2px">'
    + '<div class="card-title" style="color:'+col+';display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">'
    + '<span>Post-Sweep Precision Entry <span style="font-size:10px;font-family:var(--mono);margin-left:6px;color:var(--text3)">75x-125x</span></span>'
    + '<span style="font-size:10px;background:'+(sweep.confirmed?'rgba(0,208,132,0.15)':'rgba(245,166,35,0.15)')+';color:'+confCol+';border:1px solid '+confCol+';border-radius:3px;padding:2px 8px;font-family:var(--mono)">'
    + conf + '</span>'
    + '</div>'
    + '<p style="font-size:11px;color:var(--text2);font-family:var(--mono);margin:0 0 12px;line-height:1.6">'
    + (isLong
      ? 'Sweep confirmed: wick pierced '+sweep.leverage+' liq zone at $'+fn2(sweep.sweepLevel)+', closed back above. Enter at candle close, stop below the wick low.'
      : 'Squeeze confirmed: wick pierced '+sweep.leverage+' liq zone at $'+fn2(sweep.sweepLevel)+', closed back below. Enter at candle close, stop above the wick high.')
    + '</p>'

    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:12px">'
    + '<div>'
    + '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);margin-bottom:8px">Sweep stats</div>'
    + '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
    + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Sweep depth</span>'
    + '<span style="font-size:11px;color:var(--amber);font-family:var(--mono)">'+sweep.sweepDepth+'%</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
    + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Recovery</span>'
    + '<span style="font-size:11px;color:'+col+';font-family:var(--mono)">'+sweep.recovery+'%</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:4px 0">'
    + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Zone swept</span>'
    + '<span style="font-size:11px;color:var(--purple);font-family:var(--mono)">'+sweep.leverage+' liq</span></div>'
    + '</div>'
    + '<div>'
    + '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);margin-bottom:8px">Entry levels</div>'
    + '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
    + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Entry (candle close)</span>'
    + '<span style="font-size:14px;font-weight:700;color:var(--blue);font-family:var(--mono)">$'+fn2(sweep.entryPrice)+'</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
    + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Stop ('+(sweep.stopNote==='wick'?'below wick':'capped '+activeLev+'x')+')</span>'
    + '<span style="font-size:12px;color:var(--red);font-family:var(--mono)">$'+fn2(sweep.stopPrice)+' (-'+sweep.stopPct+'%)</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
    + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">TP1 (0.45%)</span>'
    + '<span style="font-size:12px;color:var(--green);font-family:var(--mono)">$'+fn2(sweep.tp1)+'</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
    + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">TP2 (0.9%)</span>'
    + '<span style="font-size:12px;color:var(--green);font-family:var(--mono)">$'+fn2(sweep.tp2)+'</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:4px 0">'
    + '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">TP3 (1.8%)</span>'
    + '<span style="font-size:12px;color:var(--green);font-family:var(--mono)">$'+fn2(sweep.tp3)+'</span></div>'
    + '</div></div>'
    + levNote
    + '</div>';
}

// ── Send Telegram alert for post-sweep setup (fires immediately on detection) ──
async function sendSweepAlert(coin, sweep, ta, setup, dec) {
  try {
    // Sweep alerts also swing-mode only — scalp sweeps fire too often
    if (activeMode !== 'swing') return;
    const d = mktData[coin] || {};
    const isLong = sweep.side === 'long';

    // Calculate leverage-adjusted stops from sweep entry (not ATR-based)
    const mmr     = activeLev >= 100 ? 0.005 : activeLev >= 25 ? 0.004 : 0.003;
    const imr     = 1 / activeLev;
    const fee     = 0.0005;
    const maxSD   = (imr - mmr) * 0.6;

    // Long: entry at sweep close, stop just below wick, liq below entry
    const lEntry  = isLong ? sweep.entryPrice : +(sweep.entryPrice * (1 + maxSD * 2.5)).toFixed(dec);
    const lStop   = isLong ? sweep.stopPrice  : +(sweep.entryPrice * (1 + maxSD * 2.5 + maxSD)).toFixed(dec);
    const lTp1    = isLong ? sweep.tp1        : +(sweep.entryPrice * (1 - 0.0045)).toFixed(dec);
    const lTp2    = isLong ? sweep.tp2        : +(sweep.entryPrice * (1 - 0.009)).toFixed(dec);
    const liqLong = +(lEntry * (1 - imr + mmr + fee)).toFixed(dec);

    // Short: entry at squeeze close, stop just above wick, liq above entry
    const sEntry  = isLong ? +(sweep.entryPrice * (1 + maxSD * 2.5)).toFixed(dec) : sweep.entryPrice;
    const sStop   = isLong ? +(sweep.entryPrice * (1 + maxSD * 2.5 + maxSD)).toFixed(dec) : sweep.stopPrice;
    const sTp1    = isLong ? +(sweep.entryPrice * (1 + 0.0045)).toFixed(dec) : sweep.tp1;
    const sTp2    = isLong ? +(sweep.entryPrice * (1 + 0.009)).toFixed(dec)  : sweep.tp2;
    const liqShort= +(sEntry * (1 + imr - mmr - fee)).toFixed(dec);

    const lStopDist = Math.abs(lEntry - lStop) / lEntry * 100;
    const sStopDist = Math.abs(sEntry - sStop) / sEntry * 100;
    const maxSafePct = maxSD * 100;

    const payload = {
      coin, tf: activeTF,
      price:      d.price || sweep.entryPrice,
      score:      8,
      bias:       isLong ? 'long' : 'short',
      conviction: 'high',
      pattern:    (isLong ? 'LONG SWEEP' : 'SHORT SQUEEZE') + ' CONFIRMED',
      patternStage:      'confirmed',
      patternConfidence: 'high',
      winRate: '',
      // Long setup — real levels
      longEntry: lEntry, longStop: lStop, longTP1: lTp1, longTP2: lTp2,
      // Short setup — real levels
      shortEntry: sEntry, shortStop: sStop, shortTP1: sTp1, shortTP2: sTp2,
      // Real TA data (not placeholders)
      rsi:     (ta.rsi || 50).toFixed(1),
      trend:   ta.trend || 'neutral',
      funding: (d.funding || 0).toFixed(4),
      fgValue: d.fgValue || 50,
      leverage: activeLev,
      // Correct separate liq prices
      liqLong, liqShort,
      stopDistPct:    lStopDist.toFixed(3),
      maxSafeStopPct: maxSafePct.toFixed(3),
      longMaxSafeLev:  125,
      shortMaxSafeLev: 125,
      suggestedAction: (isLong ? 'LONG' : 'SHORT') + ' sweep entry at $'
        + (isLong ? lEntry : sEntry)
        + ' — stop $' + (isLong ? lStop : sStop)
        + ' — TP1 $' + (isLong ? lTp1 : sTp1)
        + ' — TP2 $' + (isLong ? lTp2 : sTp2)
        + ' — sweep depth ' + sweep.sweepDepth + '%',
      watchLevel: sweep.sweepLevel
    };

    const r = await fetch('/api/alert', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const result = await r.json();
    console.log('Sweep alert sent:', result);
  } catch(e) { console.error('Sweep alert error:', e); }
}

async function sendTelegramAlert(coin, ta, sc, setup, ai, d, dec) {
  try {
    const patternConf  = ai?.pattern?.confidence || 'low';
    const patternStage = ai?.pattern?.stage || 'none';

    // Gate 1: score + confidence + stage — LOW conviction never fires, forming never fires
    const patternReady = patternStage === 'confirmed' || patternStage === 'near breakout';
    const confOk       = patternConf === 'high' || (patternConf === 'medium' && sc >= 7);
    if (sc < 7 || !confOk || !patternReady) {
      console.log('Alert skipped:', sc+'/10', patternConf, patternStage);
      return;
    }

    // Gate 2: swing mode only — scalp TF alerts are too noisy for TG
    if (activeMode !== 'swing') {
      console.log('Alert skipped: scalp mode');
      return;
    }

    // Gate 3: deduplication — one alert per coin+TF per candle max
    const alertKey = coin + '_' + activeTF + '_signal_alert';
    const candleTime = getCurrentCandleTime(activeTF);
    if (sessionStorage.getItem(alertKey) === String(candleTime)) {
      console.log('Alert already sent this candle:', alertKey);
      return;
    }
    sessionStorage.setItem(alertKey, String(candleTime));
    const pe = ai?.patternEntry || {};
    const safeNum = (v, fallback) => (v && !isNaN(parseFloat(v))) ? parseFloat(v) : fallback;

    // Use setup levels (already leverage-adjusted) as primary, AI pattern as override only if valid
    const lE   = safeNum(pe.longEntry,  setup.lE);
    const lSL  = setup.lSL;    // always use leverage-adjusted stop — never AI pattern stop
    const lTP1 = safeNum(pe.longTP1,   setup.lTP1);
    const lTP2 = safeNum(pe.longTP2,   setup.lTP2);
    const sE   = safeNum(pe.shortEntry, setup.sE);
    const sSL  = setup.sSL;    // always use leverage-adjusted stop
    const sTP1 = safeNum(pe.shortTP1,  setup.sTP1);
    const sTP2 = safeNum(pe.shortTP2,  setup.sTP2);

    const longLev  = calcLeverage(lE, lSL, d.price, activeLev, true);
    const shortLev = calcLeverage(sE, sSL, d.price, activeLev, false);
    const payload = {
      coin, tf: activeTF,
      price: d.price, score: sc,
      bias: ai?.bias || 'neutral',
      conviction: ai?.conviction || 'medium',
      pattern: ai?.pattern?.name || 'None',
      patternStage: ai?.pattern?.stage || '—',
      patternConfidence: ai?.pattern?.confidence || 'low',
      winRate: ai?.pattern?.historicalWinRate || '',
      longEntry: lE, longStop: lSL, longTP1: lTP1, longTP2: lTP2,
      shortEntry: sE, shortStop: sSL, shortTP1: sTP1, shortTP2: sTP2,
      rsi: ta.rsi.toFixed(1), trend: ta.trend,
      funding: d.funding.toFixed(4), fgValue: d.fgValue,
      leverage: activeLev,
      liqLong: longLev.liqPrice,
      liqShort: shortLev.liqPrice,
      stopDistPct: longLev.stopDist,
      maxSafeStopPct: longLev.maxStopPct,
      longMaxSafeLev: setup.longMaxSafeLev || calcMaxSafeLeverage(lE, lSL),
      shortMaxSafeLev: setup.shortMaxSafeLev || calcMaxSafeLeverage(sE, sSL),
      suggestedAction: ai?.suggestedAction || '',
      watchLevel: ai?.watchLevel || '',
      funding: d.funding.toFixed(4)
    };
    const r = await fetch('/api/alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await r.json();
    console.log('Alert result:', result);
  } catch(e) {
    console.error('Alert error:', e);
  }
}
async function loadAI(coin,ta,sc,setup,klines,mtfData,liqZones,cvdData){
  const ai=await fetchAI(coin,ta,sc,setup,klines,mtfData,liqZones,cvdData);
  // Update locked signal with AI verdict (the one post-lock write allowed)
  if(ai && activeMode==='swing') updateSignalAI(coin,activeTF,ai);
  // Fire standard Telegram alert (score + AI conviction gates)
  if(ai) sendTelegramAlert(coin,ta,sc,setup,ai,mktData[coin]||{},COINS[coin].dec);
  const patternEl=document.getElementById('pattern-section');
  const aiEl=document.getElementById('ai-section');
  const lNote=document.getElementById('pattern-long-note');
  const sNote=document.getElementById('pattern-short-note');
  const dec=COINS[coin].dec;
  if(!ai){
    if(patternEl)patternEl.innerHTML=`<div class="card-title" style="color:var(--purple)">Chart pattern recognition — Claude AI</div><div style="font-size:11px;color:var(--text3);font-family:var(--mono)">Pattern analysis unavailable. Check ANTHROPIC_API_KEY in Vercel.</div>`;
    if(aiEl)aiEl.innerHTML=`<div class="card-title" style="color:var(--blue)">AI analysis — Claude</div><div style="font-size:11px;color:var(--text3);font-family:var(--mono)">AI analysis unavailable. Check ANTHROPIC_API_KEY in Vercel.</div>`;
    if(lNote)lNote.style.display='none';
    if(sNote)sNote.style.display='none';
    return;
  }
  const pat=ai.pattern||{};
  const pe=ai.patternEntry||{};
  const safeN=(v,fb)=>(v&&!isNaN(parseFloat(v)))?parseFloat(v):fb;
  const rPe={
    longEntry:safeN(pe.longEntry,setup.lE), longStop:safeN(pe.longStop,setup.lSL),
    longTP1:safeN(pe.longTP1,setup.lTP1), longTP2:safeN(pe.longTP2,setup.lTP2),
    shortEntry:safeN(pe.shortEntry,setup.sE), shortStop:safeN(pe.shortStop,setup.sSL),
    shortTP1:safeN(pe.shortTP1,setup.sTP1), shortTP2:safeN(pe.shortTP2,setup.sTP2),
    entryRationale:pe.entryRationale||''
  };
  const confCls=pat.confidence==='high'?'pb-high':pat.confidence==='medium'?'pb-medium':'pb-low';
  if(lNote){
    if(pe.longEntry){
      lNote.innerHTML=`Pattern entry: $${fn(rPe.longEntry,dec)} | Pattern stop: $${fn(rPe.longStop,dec)} | ${rPe.entryRationale}`;
    } else {
      lNote.style.display='none';
    }
  }
  if(sNote){
    if(pe.shortEntry){
      sNote.innerHTML=`Pattern entry: $${fn(rPe.shortEntry,dec)} | Pattern stop: $${fn(rPe.shortStop,dec)} | ${rPe.entryRationale}`;
    } else {
      sNote.style.display='none';
    }
  }
  if(patternEl){
    patternEl.innerHTML=`
      <div class="card-title" style="color:var(--purple)">Chart pattern recognition — Claude AI</div>
      <div class="pattern-header">
        <div class="pattern-name">${pat.name||'No clear pattern'}</div>
        <div class="pattern-badges">
          <span class="pbadge ${confCls}">Confidence: ${pat.confidence||'—'}</span>
          <span class="pbadge pb-stage">${pat.stage||'—'}</span>
          ${pat.historicalWinRate?`<span class="pbadge pb-winrate">Win rate: ${pat.historicalWinRate}</span>`:''}
        </div>
      </div>
      <p class="pattern-desc">${pat.description||'—'}</p>
      ${pe.longEntry||pe.shortEntry?`
      <div class="pattern-levels">
        <div class="pl-item"><div class="pl-label">Pattern long entry</div><div class="pl-val vg">$${fn(rPe.longEntry,dec)}</div></div>
        <div class="pl-item"><div class="pl-label">Pattern long stop</div><div class="pl-val vr">$${fn(rPe.longStop,dec)}</div></div>
        <div class="pl-item"><div class="pl-label">Pattern long TP1</div><div class="pl-val vg">$${fn(rPe.longTP1,dec)}</div></div>
        <div class="pl-item"><div class="pl-label">Pattern long TP2</div><div class="pl-val vg">$${fn(rPe.longTP2,dec)}</div></div>
        <div class="pl-item"><div class="pl-label">Pattern short entry</div><div class="pl-val vr">$${fn(rPe.shortEntry,dec)}</div></div>
        <div class="pl-item"><div class="pl-label">Pattern short stop</div><div class="pl-val vr">$${fn(rPe.shortStop,dec)}</div></div>
        <div class="pl-item"><div class="pl-label">Pattern short TP1</div><div class="pl-val vg">$${fn(rPe.shortTP1,dec)}</div></div>
        <div class="pl-item"><div class="pl-label">Pattern short TP2</div><div class="pl-val vg">$${fn(rPe.shortTP2,dec)}</div></div>
        ${pat.patternTarget?`<div class="pl-item"><div class="pl-label">Pattern target</div><div class="pl-val vp">$${fn(pat.patternTarget,dec)}</div></div>`:''}
        ${pat.patternInvalidation?`<div class="pl-item"><div class="pl-label">Invalidation level</div><div class="pl-val vr">$${fn(pat.patternInvalidation,dec)}</div></div>`:''}
      </div>`:''}
      ${ai.watchLevel?`<div class="watch-level">Watch level: ${ai.watchLevel}</div>`:''}
      ${ai.suggestedAction?`<div class="action-level">Action: ${ai.suggestedAction}</div>`:''}
    `;
  }
  const cCol=ai.conviction==='high'?'var(--green)':ai.conviction==='medium'?'var(--amber)':'var(--text3)';
  const bCol=ai.bias==='long'?'var(--green)':ai.bias==='short'?'var(--red)':'var(--text3)';
  if(aiEl){
    const counterWarn = ai.counterTrend && ai.counterTrendWarning
      ? `<div style="background:rgba(255,77,77,.15);border:1px solid var(--red-b);border-radius:7px;padding:10px 14px;margin-bottom:10px;font-size:13px;color:var(--red)">⛔ Counter-trend warning: ${ai.counterTrendWarning}</div>`
      : '';
    const mtfVerdict = ai.mtfVerdict
      ? `<div style="background:rgba(74,158,255,.08);border:1px solid var(--blue-b);border-radius:7px;padding:10px 14px;margin-bottom:10px;font-size:13px;color:var(--blue)">📊 MTF: ${ai.mtfVerdict}</div>`
      : '';
    const posNote = ai.positionSizeNote
      ? `<div style="background:rgba(245,166,35,.08);border:1px solid var(--amber-b);border-radius:7px;padding:10px 14px;margin-bottom:10px;font-size:12px;color:var(--amber);font-family:var(--mono)">💰 Position size: ${ai.positionSizeNote}</div>`
      : '';
    aiEl.innerHTML=`
      <div class="card-title" style="color:var(--blue)">AI analysis — Claude (${activeMode} mode)
        <span style="margin-left:10px;font-size:9px;color:${cCol}">CONVICTION: ${(ai.conviction||'').toUpperCase()}</span>
        <span style="margin-left:8px;font-size:9px;color:${bCol}">BIAS: ${(ai.bias||'').toUpperCase()}</span>
        ${ai.counterTrend ? '<span style="margin-left:8px;font-size:9px;background:rgba(255,77,77,.2);color:var(--red);padding:2px 6px;border-radius:3px">⛔ COUNTER-TREND</span>' : ''}
      </div>
      ${counterWarn}
      ${mtfVerdict}
      <p class="ai-summary">${ai.summary||''}</p>
      <div class="ai-2col">
        <div class="ai-block"><div class="ai-btitle" style="color:var(--green)">Bull case</div><div class="ai-btext">${ai.longCase||'—'}</div></div>
        <div class="ai-block"><div class="ai-btitle" style="color:var(--red)">Bear case</div><div class="ai-btext">${ai.shortCase||'—'}</div></div>
      </div>
      ${posNote}
      <div class="ai-risk">Key risk: ${ai.keyRisk||'—'}</div>
      <div class="ai-action">Suggested action: ${ai.suggestedAction||'—'}</div>
      <div class="ai-pattern-hist">Historical pattern context: ${ai.historicalPattern||'—'}</div>
    `;
  }

}
