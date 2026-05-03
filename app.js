
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
  const rec=klines.slice(-20);
  const support=Math.min(...rec.map(k=>k.l));
  const resistance=Math.max(...rec.map(k=>k.h));
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
  const optimalLong=Math.max(supportEntry,pullbackEntry);
  const resistEntry=+(ta.resistance-atr*0.3).toFixed(dec);
  const rallyEntry=+(price+atr*0.75).toFixed(dec);
  const optimalShort=Math.min(resistEntry,rallyEntry);
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

  return{lE,lSL,lTP1,lTP2,lRisk,lRew,lRR,sE,sSL,sTP1,sTP2,sRisk,sRew,sRR,levAdjustedLong,levAdjustedShort,maxStopPct:maxStopDec*100};
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
  return Math.min(10,Math.max(0,base));
}

function verdictOf(sc){
  if(sc>=7)return{text:'Long setup',cls:'cbl'};
  if(sc>=5)return{text:'Watch',cls:'cbw'};
  if(sc>=3)return{text:'Neutral',cls:'cbn'};
  return{text:'Short bias',cls:'cbs'};
}

function setLev(lev,btn){
  activeLev=lev;
  document.querySelectorAll('.lev-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  // Re-render detail if data loaded
  const klines=klCache[activeCoin+'_'+activeTF]||[];
  if(klines.length&&mktData[activeCoin]?.price){
    renderDetail(activeCoin,klines);
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

async function fetchAI(coin,ta,sc,setup,klines,mtfData){
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
        mtfSummary: mtfData ? {
          confluenceLabel: mtfData.confluenceLabel,
          confluenceScore: mtfData.confluenceScore,
          filterStatus: mtfData.filterStatus,
          filterMsg: mtfData.filterMsg,
          positionSizeMultiplier: mtfData.positionSizeMultiplier,
          trendByTF: mtfData.trendSummary,
          labels: mtfData.stack.labels
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
  const sc=scoreSignal(coin,ta,mtfData);
  const v=verdictOf(sc);
  const entries=calcEntries(d.price,ta,dec);
  const setup=calcSetups(entries,dec);

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

      <!-- Long setup -->
      <div class="card" style="border-left:3px solid var(--green)">
        <div class="card-title" style="color:var(--green)">Long setup</div>
        <div class="srow"><span class="skey">${entryMode==='optimal'?'Optimal entry':'Entry (market)'}</span><span class="sval vb">$${fn(setup.lE,dec)}</span></div>
        <div class="srow"><span class="skey">Stop loss</span><span class="sval vr">$${fn(setup.lSL,dec)} <span style="font-size:11px;color:var(--text2)">-${setup.lRisk.toFixed(3)}%</span>${setup.levAdjustedLong?'<span style="font-size:10px;background:rgba(74,158,255,.15);color:var(--blue);border:1px solid rgba(74,158,255,.3);border-radius:3px;padding:1px 5px;margin-left:5px">⚡ lev-adjusted</span>':''}</span></div>
        <div class="srow"><span class="skey">Take profit 1</span><span class="sval vg">$${fn(setup.lTP1,dec)} <span style="font-size:11px;color:var(--text2)">+${setup.lRew.toFixed(3)}%</span></span></div>
        <div class="srow"><span class="skey">Take profit 2</span><span class="sval vg">$${fn(setup.lTP2,dec)}</span></div>
        <div class="srow"><span class="skey">R:R ratio</span><span class="sval">${setup.lRR.toFixed(2)}:1 <span class="rrtag ${setup.lRR>=1.5?'rrg':'rrr'}">${setup.lRR>=1.5?'good':'weak'}</span></span></div>
        <div class="srow"><span class="skey">ATR volatility</span><span class="sval">$${fn(ta.atr,dec>2?2:dec)}</span></div>
        <div class="srow"><span class="skey">Max stop @ ${activeLev}x</span><span class="sval" style="color:${setup.levAdjustedLong?'var(--blue)':'var(--text2)'}">${setup.maxStopPct?setup.maxStopPct.toFixed(3)+'%':'—'}</span></div>
        ${lNote}
        <div class="pattern-note" id="pattern-long-note">Analyzing chart pattern for refined entry...</div>
      </div>

      <!-- Short setup -->
      <div class="card" style="border-left:3px solid var(--red)">
        <div class="card-title" style="color:var(--red)">Short setup</div>
        <div class="srow"><span class="skey">${entryMode==='optimal'?'Optimal entry':'Entry (market)'}</span><span class="sval vb">$${fn(setup.sE,dec)}</span></div>
        <div class="srow"><span class="skey">Stop loss</span><span class="sval vr">$${fn(setup.sSL,dec)} <span style="font-size:11px;color:var(--text2)">+${setup.sRisk.toFixed(3)}%</span>${setup.levAdjustedShort?'<span style="font-size:10px;background:rgba(74,158,255,.15);color:var(--blue);border:1px solid rgba(74,158,255,.3);border-radius:3px;padding:1px 5px;margin-left:5px">⚡ lev-adjusted</span>':''}</span></div>
        <div class="srow"><span class="skey">Take profit 1</span><span class="sval vg">$${fn(setup.sTP1,dec)} <span style="font-size:11px;color:var(--text2)">-${setup.sRew.toFixed(3)}%</span></span></div>
        <div class="srow"><span class="skey">Take profit 2</span><span class="sval vg">$${fn(setup.sTP2,dec)}</span></div>
        <div class="srow"><span class="skey">R:R ratio</span><span class="sval">${setup.sRR.toFixed(2)}:1 <span class="rrtag ${setup.sRR>=1.5?'rrg':'rrr'}">${setup.sRR>=1.5?'good':'weak'}</span></span></div>
        <div class="srow"><span class="skey">ATR volatility</span><span class="sval">$${fn(ta.atr,dec>2?2:dec)}</span></div>
        <div class="srow"><span class="skey">Max stop @ ${activeLev}x</span><span class="sval" style="color:${setup.levAdjustedShort?'var(--blue)':'var(--text2)'}">${setup.maxStopPct?setup.maxStopPct.toFixed(3)+'%':'—'}</span></div>
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
          <div class="metric"><div class="mlbl">Funding rate</div><div class="mval" style="color:${fCol}">${d.funding.toFixed(4)}%</div><div class="msub">8h rolling</div></div>
        </div>
      </div>

      <!-- OI -->
      <div class="card">
        <div class="card-title">Open interest</div>
        <div class="oi-grid">
          <div class="oic"><div class="oil">OI notional</div><div class="oiv">$${(d.oiNotional/1e9).toFixed(1)}B</div><div class="ois">Contracts × price</div></div>
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
    // redraw custom chart after lev card updates setup with liq prices
    setTimeout(()=>buildCustomChart(klines,setup,dec,activeLev),50);
  },100);
  renderScanBody();
  loadAI(coin,ta,sc,setup,klines,mtfData);
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
  if(klines.length)await renderDetail(activeCoin,klines);
}
function seedPlaceholders(){
  const defaults={BTC:78000,ETH:2300,SOL:84,XRP:1.38,SUI:0.92};
  Object.keys(COINS).forEach(c=>{
    if(!mktData[c]||!mktData[c].price){
      mktData[c]={price:defaults[c]||1,change24h:0,high24h:defaults[c]*1.02||1,low24h:defaults[c]*0.98||1,volume24h:1000000000,funding:0.0001,oi:0,oiNotional:0,fgValue:50,fgLabel:'Neutral'};
    }
  });
}
async function init(){
  const btn=document.getElementById('rbtn');
  btn.disabled=true;btn.textContent='↻ Refreshing...';
  klCache={};aiCache={};
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
          mktData[coin]={price,change24h:open24?((price-open24)/open24*100):0,high24h:parseFloat(t.highPrice24h)||0,low24h:parseFloat(t.lowPrice24h)||0,volume24h:parseFloat(t.turnover24h)||0,funding:parseFloat(t.fundingRate)*100||0,oi:parseFloat(t.openInterest)||0,oiNotional:(parseFloat(t.openInterest)||0)*price,fgValue:mktData[coin]?.fgValue||50,fgLabel:mktData[coin]?.fgLabel||'Neutral'};
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
    // Fetch klines for ALL coins in parallel so RSI/trend is accurate for all
    await Promise.allSettled(
      Object.keys(COINS).map(c => fetchKlines(c, activeTF))
    );
    const klines=klCache[activeCoin+'_'+activeTF]||await fetchKlines(activeCoin,activeTF);
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
    document.getElementById('last-upd').textContent='Updated '+new Date().toLocaleTimeString();
  }catch(e){
    document.getElementById('main-content').innerHTML=`<div class="loading-full"><span style="color:var(--red);font-family:var(--mono);font-size:13px">Error: ${e.message}<br><br>Try refreshing</span></div>`;
  }
  btn.disabled=false;btn.textContent='↻ Refresh all data';
}
init();

async function sendTelegramAlert(coin, ta, sc, setup, ai, d, dec) {
  try {
    const patternHighConf = ai?.pattern?.confidence === 'high';
    const patternReady = ai?.pattern?.stage === 'confirmed' || ai?.pattern?.stage === 'near breakout';
    if (sc < 7 || !patternHighConf || !patternReady) {
      console.log(`Alert skipped: score ${sc}/10, pattern ${ai?.pattern?.confidence}/${ai?.pattern?.stage}`);
      return;
    }
    const pe = ai?.patternEntry || {};
    const lE  = pe.longEntry  || setup.lE;
    const lSL = pe.longStop   || setup.lSL;
    const lTP1= pe.longTP1    || setup.lTP1;
    const lTP2= pe.longTP2    || setup.lTP2;
    const sE  = pe.shortEntry || setup.sE;
    const sSL = pe.shortStop  || setup.sSL;
    const sTP1= pe.shortTP1   || setup.sTP1;
    const sTP2= pe.shortTP2   || setup.sTP2;
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
async function loadAI(coin,ta,sc,setup,klines,mtfData){
  const ai=await fetchAI(coin,ta,sc,setup,klines,mtfData);
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
  const confCls=pat.confidence==='high'?'pb-high':pat.confidence==='medium'?'pb-medium':'pb-low';
  if(lNote){
    if(pe.longEntry){
      lNote.innerHTML=`Pattern entry: $${fn(pe.longEntry,dec)} | Pattern stop: $${fn(pe.longStop,dec)} | ${pe.entryRationale||''}`;
    } else {
      lNote.style.display='none';
    }
  }
  if(sNote){
    if(pe.shortEntry){
      sNote.innerHTML=`Pattern entry: $${fn(pe.shortEntry,dec)} | Pattern stop: $${fn(pe.shortStop,dec)} | ${pe.entryRationale||''}`;
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
        ${pe.longEntry?`<div class="pl-item"><div class="pl-label">Pattern long entry</div><div class="pl-val vg">$${fn(pe.longEntry,dec)}</div></div>`:''}
        ${pe.longStop?`<div class="pl-item"><div class="pl-label">Pattern long stop</div><div class="pl-val vr">$${fn(pe.longStop,dec)}</div></div>`:''}
        ${pe.longTP1?`<div class="pl-item"><div class="pl-label">Pattern long TP1</div><div class="pl-val vg">$${fn(pe.longTP1,dec)}</div></div>`:''}
        ${pe.longTP2?`<div class="pl-item"><div class="pl-label">Pattern long TP2</div><div class="pl-val vg">$${fn(pe.longTP2,dec)}</div></div>`:''}
        ${pe.shortEntry?`<div class="pl-item"><div class="pl-label">Pattern short entry</div><div class="pl-val vr">$${fn(pe.shortEntry,dec)}</div></div>`:''}
        ${pe.shortStop?`<div class="pl-item"><div class="pl-label">Pattern short stop</div><div class="pl-val vr">$${fn(pe.shortStop,dec)}</div></div>`:''}
        ${pe.shortTP1?`<div class="pl-item"><div class="pl-label">Pattern short TP1</div><div class="pl-val vg">$${fn(pe.shortTP1,dec)}</div></div>`:''}
        ${pe.shortTP2?`<div class="pl-item"><div class="pl-label">Pattern short TP2</div><div class="pl-val vg">$${fn(pe.shortTP2,dec)}</div></div>`:''}
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
