
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

