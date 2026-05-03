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
      \${mtfData ? renderMTFCard(mtfData, dec) : ''}

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

async function sendTelegramAlert(coin, ta, sc, setup, ai, d, dec) {
  try {
    // Strict check: score >= 7 AND high confidence AND confirmed/near breakout
    const patternHighConf = ai?.pattern?.confidence === 'high';
    const patternReady = ai?.pattern?.stage === 'confirmed' || ai?.pattern?.stage === 'near breakout';
    if (sc < 7 || !patternHighConf || !patternReady) {
      console.log(`Alert skipped: score ${sc}/10, pattern ${ai?.pattern?.confidence}/${ai?.pattern?.stage}`);
      return;
    }

    // Use pattern entries if available (tighter, better for high leverage)
    const pe = ai?.patternEntry || {};
    const lE  = pe.longEntry  || setup.lE;
    const lSL = pe.longStop   || setup.lSL;
    const lTP1= pe.longTP1    || setup.lTP1;
    const lTP2= pe.longTP2    || setup.lTP2;
    const sE  = pe.shortEntry || setup.sE;
    const sSL = pe.shortStop  || setup.sSL;
    const sTP1= pe.shortTP1   || setup.sTP1;
    const sTP2= pe.shortTP2   || setup.sTP2;

    // Blofin leverage calculations
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

  // Update pattern notes in setup cards
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

  // Render pattern card
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

  // Render AI summary
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

// Seed placeholder data so page always renders
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

  // Seed placeholders immediately so page can render
  seedPlaceholders();

  // Render page right away with placeholders
  const scores={};
  Object.keys(COINS).forEach(c=>{scores[c]=5;});
  renderSidebar(scores);
  renderAlerts(scores);

  // Fetch market data with aggressive timeout — don't block render
  const fetchTimeout = 8000;
  try{
    document.getElementById('main-content').innerHTML=`<div class="loading-full"><div class="spin"></div><span>Loading market data...</span></div>`;

    // Try multiple sources in parallel, use first that responds
    const marketPromise = Promise.race([
      // Source 1: Bybit
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
      // Timeout — use placeholders
      new Promise(resolve=>setTimeout(()=>resolve('timeout'),fetchTimeout))
    ]);

    const source = await marketPromise;
    console.log('Market data source:', source);

    // Fear & Greed best effort
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

  // Always fetch klines and render — even with placeholder prices
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
