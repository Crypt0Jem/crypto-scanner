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
    const klines=await fetchKlines(activeCoin,activeTF);
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
}
