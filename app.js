const APP_VERSION='phase3-ws-v1';
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const IS_MOBILE = IS_IOS || /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const SKIP_WS = IS_IOS || (IS_MOBILE && IS_SAFARI);
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
let bybitWS = null;
let liqZones = null;
let bybitLiqQueue = [];
let bybitTickerCache = {};
let wsReconnectAttempts = 0;
const WS_MAX_RECONNECT = 5;
const WS_STALE_MS = 300000;
let fundingHistoryCache = {};
let oiHistoryCache = {};
let fundingLastFetch = {};
let pendingAIContext = null;
let tradeLog = [];
let tradeLogView = false;
function calculateSignalWeight(signalType) {
var trades = tradeLog.filter(function(t) {
return t.status !== 'open' && t.signalType === signalType;
});
var n = trades.length;
if (n < 8) return 1.0;
var wins = trades.filter(function(t) {
return t.realizedUSDT != null ? t.realizedUSDT > 0 : (t.pnlPercent || 0) > 0;
}).length;
var postAlpha = 2 + wins;
var postBeta = 3 + (n - wins);
var bayesWR = postAlpha / (postAlpha + postBeta);
return +Math.max(0.60, Math.min(1.40, 0.3 + 0.7 * bayesWR)).toFixed(3);
}
function getLearnedWeights() {
var types = ['swing','scalp','post_sweep','liq_scale','sweep_opp'];
var labels = { swing:'Swing', scalp:'Scalp', post_sweep:'Post-Sweep', liq_scale:'Scale-In', sweep_opp:'Sweep Opp' };
var out = {};
types.forEach(function(t) {
var trades = tradeLog.filter(function(x) { return x.status !== 'open' && x.signalType === t; });
var n = trades.length;
var w = calculateSignalWeight(t);
var wins = n > 0 ? trades.filter(function(x) {
return x.realizedUSDT != null ? x.realizedUSDT > 0 : (x.pnlPercent || 0) > 0;
}).length : 0;
out[t] = { weight:w, tradeCount:n, winRate: n>0 ? +(wins/n*100).toFixed(0) : null, active: n>=8, label: labels[t]||t };
});
return out;
}
function getSessionStats(hoursBack) {
var cutoff = Date.now() - (hoursBack || 24) * 3600000;
var recent = tradeLog.filter(function(t) { return t.status !== 'open' && t.timestamp >= cutoff; });
if (!recent.length) return null;
var isWin = function(t) { return t.realizedUSDT != null ? t.realizedUSDT > 0 : (t.pnlPercent || 0) > 0; };
var wins = recent.filter(isWin).length;
var usdtList = recent.filter(function(t) { return t.realizedUSDT != null; });
var totalUSDT = usdtList.length > 0 ? +usdtList.reduce(function(s,t){ return s+t.realizedUSDT; },0).toFixed(2) : null;
var totalPnl = +recent.reduce(function(s,t){ return s+(t.pnlPercent||0); },0).toFixed(1);
var best = recent.reduce(function(a,b){
return ((b.realizedUSDT!=null?b.realizedUSDT:b.pnlPercent||0) > (a.realizedUSDT!=null?a.realizedUSDT:a.pnlPercent||0)) ? b : a;
}, recent[0]);
return { count:recent.length, wins:wins, losses:recent.length-wins, totalUSDT:totalUSDT, totalPnl:totalPnl, best:best };
}
function renderSessionPnl() {
var el = document.getElementById('session-pnl-panel');
if (!el) return;
var s = getSessionStats(24);
var lw = getLearnedWeights();
var activeW = Object.keys(lw).filter(function(t){ return lw[t].active; });
var learnHtml = '';
if (activeW.length > 0) {
var parts = activeW.map(function(t) {
var pct = ((lw[t].weight - 1) * 100).toFixed(0);
var col = lw[t].weight >= 1 ? 'var(--green)' : 'var(--amber)';
return '<span style="color:'+col+';font-size:9px;font-family:var(--mono)">'
+ lw[t].label + ' ' + (lw[t].weight >= 1 ? '+' : '') + pct + '%</span>';
}).join(' ');
learnHtml = '<div style="margin-top:5px;padding-top:5px;border-top:1px solid var(--border)">'
+ '<div style="font-size:9px;color:var(--purple);font-family:var(--mono);margin-bottom:3px">🧠 Learning active</div>'
+ '<div style="display:flex;flex-wrap:wrap;gap:4px">' + parts + '</div></div>';
}
if (!s) {
el.style.display = activeW.length > 0 ? 'block' : 'none';
if (activeW.length > 0) el.innerHTML = learnHtml;
return;
}
var hasUsdt = s.totalUSDT != null;
var mainVal = hasUsdt ? (s.totalUSDT >= 0 ? '+' : '') + s.totalUSDT + ' USDT'
: (s.totalPnl >= 0 ? '+' : '') + s.totalPnl + '%';
var mainCol = (hasUsdt ? s.totalUSDT : s.totalPnl) >= 0 ? 'var(--green)' : 'var(--red)';
var wrPct = s.count > 0 ? Math.round(s.wins / s.count * 100) : 0;
var wrCol = wrPct >= 60 ? 'var(--green)' : wrPct >= 45 ? 'var(--amber)' : 'var(--red)';
var bestVal = s.best && s.best.realizedUSDT != null
? (s.best.realizedUSDT >= 0 ? '+' : '') + s.best.realizedUSDT + 'U' : '';
el.style.display = 'block';
el.innerHTML = '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--text3);font-family:var(--mono);margin-bottom:5px">Session (24h)</div>'
+ '<div style="font-size:18px;font-weight:700;color:' + mainCol + ';font-family:var(--mono);line-height:1">' + mainVal + '</div>'
+ '<div style="font-size:10px;font-family:var(--mono);color:var(--text3);margin-top:4px;display:flex;gap:8px;align-items:center">'
+ '<span>' + s.count + ' trades</span>'
+ '<span style="color:' + wrCol + ';font-weight:600">' + wrPct + '% WR</span>'
+ (bestVal ? '<span style="color:var(--green)">best ' + bestVal + '</span>' : '')
+ '</div>' + learnHtml;
}
function loadTradeLog() {
try {
const raw = localStorage.getItem('tradeLog_v1');
tradeLog = raw ? JSON.parse(raw) : [];
if (!Array.isArray(tradeLog)) tradeLog = [];
} catch(e) { tradeLog = []; }
}
function saveTradeLog() {
try { localStorage.setItem('tradeLog_v1', JSON.stringify(tradeLog)); }
catch(e) { console.warn('Could not save trade log:', e); }
}
function addTrade(trade) {
trade.id = 'trade_' + Date.now();
trade.timestamp = Date.now();
tradeLog.unshift(trade);
if (tradeLog.length > 500) tradeLog = tradeLog.slice(0, 500);
saveTradeLog();
}
function deleteTrade(id) {
tradeLog = tradeLog.filter(function(t) { return t.id !== id; });
saveTradeLog();
showTradeLog();
}
function updateTrade(id) {
var idx = tradeLog.findIndex(function(t) { return t.id === id; });
if (idx === -1) return;
var t = tradeLog[idx];
var dir = document.getElementById('et-dir') ? document.getElementById('et-dir').value : t.direction;
var entry = parseFloat(document.getElementById('et-entry').value) || t.entryPrice;
var exit = parseFloat(document.getElementById('et-exit').value) || t.exitPrice;
var lev = parseInt(document.getElementById('et-lev').value) || t.leverage;
var sig = document.getElementById('et-sig').value;
var notes = document.getElementById('et-notes').value;
var size = parseFloat(document.getElementById('et-size').value) || t.sizeUSDT || null;
var pnl = (entry && exit) ? calcTradePnl(entry, exit, t.direction, lev) : t.pnlPercent;
var rusdT = (size && pnl != null) ? +(pnl / 100 * size).toFixed(2) : t.realizedUSDT;
var status = exit ? 'closed' : 'open';
tradeLog[idx] = Object.assign({}, t, { direction:dir, entryPrice:entry, exitPrice:exit||null, pnlPercent:pnl, realizedUSDT:rusdT, sizeUSDT:size, leverage:lev, signalType:sig, notes:notes, status:status });
saveTradeLog();
showTradeLog();
}
function startEditTrade(id) {
var t = tradeLog.find(function(x) { return x.id === id; });
if (!t) return;
var row = document.getElementById('row-' + id);
if (!row) return;
var inp = 'background:var(--bg4);border:1px solid var(--border2);border-radius:4px;color:var(--text);font-family:var(--mono);font-size:11px;padding:4px 6px;';
var sigOpts = ['swing','scalp','post_sweep','liq_scale','sweep_opp','manual'].map(function(s) {
return '<option value="' + s + '"' + (t.signalType===s?' selected':'') + '>' + s + '</option>';
}).join('');
var levOpts = [10,25,50,75,100,125].map(function(l) {
return '<option value="' + l + '"' + (t.leverage===l?' selected':'') + '>' + l + 'x</option>';
}).join('');
var dirOpts = ['long','short'].map(function(d) {
return '<option value="' + d + '"' + (t.direction===d?' selected':'') + '>' + d + '</option>';
}).join('');
row.innerHTML = '<td colspan="8" style="padding:10px 8px;background:rgba(74,158,255,0.06)">'
+ '<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">'
+ '<select id="et-dir" style="' + inp + '">' + dirOpts + '</select>'
+ '<input id="et-entry" type="number" step="any" value="' + (t.entryPrice||'') + '" placeholder="Entry" style="' + inp + 'width:90px">'
+ '<input id="et-exit" type="number" step="any" value="' + (t.exitPrice||'') + '" placeholder="Exit (blank=open)" style="' + inp + 'width:110px">'
+ '<input id="et-size" type="number" step="any" value="' + (t.sizeUSDT||'') + '" placeholder="Size USDT" style="' + inp + 'width:90px">'
+ '<select id="et-lev" style="' + inp + '">' + levOpts + '</select>'
+ '<select id="et-sig" style="' + inp + '">' + sigOpts + '</select>'
+ '<input id="et-notes" type="text" value="' + (t.notes||'') + '" placeholder="Notes" style="' + inp + 'width:130px">'
+ '<button onclick="updateTrade(\'' + id + '\')" style="padding:4px 10px;border-radius:4px;border:1px solid var(--green-b);background:rgba(0,208,132,0.1);color:var(--green);font-family:var(--mono);font-size:11px;cursor:pointer">Save</button>'
+ '<button onclick="showTradeLog()" style="padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--text3);font-family:var(--mono);font-size:11px;cursor:pointer">Cancel</button>'
+ '</div></td>';
}
function closeTrade(id) {
var exitStr = prompt('Exit price for this trade?');
if (!exitStr) return;
var exit = parseFloat(exitStr);
if (!exit || exit <= 0) return;
var idx = tradeLog.findIndex(function(t) { return t.id === id; });
if (idx === -1) return;
var t = tradeLog[idx];
var pnl = calcTradePnl(t.entryPrice, exit, t.direction, t.leverage);
var rusdT = t.sizeUSDT ? +(pnl / 100 * t.sizeUSDT).toFixed(2) : null;
tradeLog[idx] = Object.assign({}, t, { exitPrice:exit, pnlPercent:pnl, realizedUSDT:rusdT, status:'closed' });
saveTradeLog();
showTradeLog();
}
function calcTradePnl(entry, exit, direction, leverage) {
if (!entry || !exit || entry <= 0) return 0;
var raw = direction === 'long' ? (exit - entry) / entry : (entry - exit) / entry;
return +(raw * leverage * 100).toFixed(2);
}
function getTradeStats(trades) {
if (!trades || trades.length === 0) return { winRate:0, totalPnl:0, avgPnl:0, best:null, worst:null, byType:{} };
var wins = trades.filter(function(t) { return t.pnlPercent > 0; });
var losses = trades.filter(function(t) { return t.pnlPercent <= 0; });
var totalPnl = trades.reduce(function(s, t) { return s + (t.pnlPercent || 0); }, 0);
var sorted = trades.slice().sort(function(a,b) { return b.pnlPercent - a.pnlPercent; });
var byType = {};
trades.forEach(function(t) {
if (!byType[t.signalType]) byType[t.signalType] = { w:0, l:0 };
if (t.pnlPercent > 0) byType[t.signalType].w++;
else byType[t.signalType].l++;
});
return {
winRate: +(wins.length / trades.length * 100).toFixed(1),
totalPnl: +totalPnl.toFixed(2),
avgPnl: +(totalPnl / trades.length).toFixed(2),
best: sorted[0] || null,
worst: sorted[sorted.length - 1] || null,
wins: wins.length,
losses: losses.length,
byType: byType
};
}
function showTradeLog() {
tradeLogView = true;
var tlBtn = document.getElementById('trade-log-btn');
if (tlBtn) { tlBtn.style.background = 'var(--bg3)'; tlBtn.style.color = 'var(--text)'; tlBtn.style.borderColor = 'var(--border2)'; }
var filterType = document.getElementById('tl-filter-type') ? document.getElementById('tl-filter-type').value : 'all';
var filterSymbol = document.getElementById('tl-filter-symbol') ? document.getElementById('tl-filter-symbol').value : 'all';
var filterDate = document.getElementById('tl-filter-date') ? document.getElementById('tl-filter-date').value : 'all';
var filtered = tradeLog.filter(function(t) {
if (filterType !== 'all' && t.signalType !== filterType) return false;
if (filterSymbol !== 'all' && t.symbol !== filterSymbol) return false;
if (filterDate === '7d' && t.timestamp < Date.now() - 604800000) return false;
if (filterDate === '30d' && t.timestamp < Date.now() - 2592000000) return false;
return true;
});
var stats = getTradeStats(filtered);
var allStats = getTradeStats(tradeLog);
var wrCol = stats.winRate >= 60 ? 'var(--green)' : stats.winRate >= 45 ? 'var(--amber)' : 'var(--red)';
var pnlCol = stats.totalPnl >= 0 ? 'var(--green)' : 'var(--red)';
var avgCol = stats.avgPnl >= 0 ? 'var(--green)' : 'var(--red)';
var sigLabels = { swing:'Swing', scalp:'Scalp', post_sweep:'Post-Sweep', liq_scale:'Scale-In', sweep_opp:'Sweep Opp', manual:'Manual' };
var sigColors = { swing:'var(--blue)', scalp:'var(--amber)', post_sweep:'var(--purple)', liq_scale:'var(--amber)', sweep_opp:'var(--green)', manual:'var(--text2)' };
function sigBadge(type) {
var lbl = sigLabels[type] || type;
var col = sigColors[type] || 'var(--text2)';
return '<span style="font-size:9px;padding:2px 7px;border-radius:3px;background:rgba(255,255,255,0.06);color:' + col + ';font-family:var(--mono);white-space:nowrap">' + lbl + '</span>';
}
function dirBadge(dir) {
return dir === 'long'
? '<span style="font-size:10px;padding:2px 8px;border-radius:3px;background:rgba(0,208,132,0.12);color:var(--green);font-family:var(--mono)">▲ L</span>'
: '<span style="font-size:10px;padding:2px 8px;border-radius:3px;background:rgba(255,77,77,0.12);color:var(--red);font-family:var(--mono)">▼ S</span>';
}
function relTime(ts) {
var d = Date.now() - ts;
if (d < 3600000) return Math.round(d/60000) + 'm ago';
if (d < 86400000) return Math.round(d/3600000) + 'h ago';
return Math.round(d/86400000) + 'd ago';
}
var typeBreakdown = Object.entries(allStats.byType).map(function(e) {
var type = e[0]; var data = e[1];
var total = data.w + data.l;
var wr = total > 0 ? Math.round(data.w/total*100) : 0;
var col = wr >= 60 ? 'var(--green)' : wr >= 45 ? 'var(--amber)' : 'var(--red)';
return '<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)">'
+ sigBadge(type)
+ '<span style="font-size:10px;color:var(--text2);font-family:var(--mono)">' + data.w + 'W / ' + data.l + 'L</span>'
+ '<span style="font-size:10px;color:' + col + ';font-family:var(--mono);font-weight:600">' + wr + '%</span>'
+ '</div>';
}).join('');
var openTrades = tradeLog.filter(function(t) { return t.status === 'open'; });
var openHtml = '';
if (openTrades.length > 0) {
openHtml = '<div style="padding:14px 26px;border-bottom:1px solid var(--border);background:rgba(245,166,35,0.04)">'
+ '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--amber);font-family:var(--mono);margin-bottom:10px">⚡ Open Positions (' + openTrades.length + ')</div>';
openTrades.forEach(function(t) {
var livePrice = (mktData[t.symbol] || {}).price || 0;
var dec = COINS[t.symbol] ? COINS[t.symbol].dec : 2;
var floatPct = livePrice > 0 ? calcTradePnl(t.entryPrice, livePrice, t.direction, t.leverage) : null;
var floatUSDT = (floatPct != null && t.sizeUSDT) ? +(floatPct / 100 * t.sizeUSDT).toFixed(2) : null;
var fCol = floatPct == null ? 'var(--text3)' : floatPct >= 0 ? 'var(--green)' : 'var(--red)';
var pctStr = floatPct != null ? (floatPct >= 0 ? '+' : '') + floatPct.toFixed(2) + '%' : 'loading...';
var usdtStr = floatUSDT != null ? ' / ' + (floatUSDT >= 0 ? '+' : '') + floatUSDT + 'U' : '';
openHtml += '<div id="row-' + t.id + '" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:10px 14px;background:rgba(245,166,35,0.07);border:1px solid rgba(245,166,35,0.25);border-radius:8px;margin-bottom:8px">'
+ '<div style="display:flex;align-items:center;gap:10px">'
+ '<span style="font-size:12px;font-weight:700;font-family:var(--mono)">' + t.symbol + '</span>'
+ (t.direction==='long' ? '<span style="font-size:10px;padding:2px 8px;border-radius:3px;background:rgba(0,208,132,0.12);color:var(--green);font-family:var(--mono)">▲ LONG</span>' : '<span style="font-size:10px;padding:2px 8px;border-radius:3px;background:rgba(255,77,77,0.12);color:var(--red);font-family:var(--mono)">▼ SHORT</span>')
+ '<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">' + t.leverage + 'x</span>'
+ '<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">in @ $' + fn(t.entryPrice,dec) + '</span>'
+ (livePrice > 0 ? '<span style="font-size:10px;color:var(--text2);font-family:var(--mono)">now $' + fn(livePrice,dec) + '</span>' : '')
+ '</div>'
+ '<div style="display:flex;align-items:center;gap:8px">'
+ '<span style="font-size:15px;font-weight:700;font-family:var(--mono);color:' + fCol + '">' + pctStr + '<span style="font-size:11px;font-weight:400;color:var(--text3)">' + usdtStr + '</span></span>'
+ '<button onclick="closeTrade(\'' + t.id + '\')" style="font-size:11px;padding:4px 12px;border-radius:4px;border:1px solid var(--green-b);background:rgba(0,208,132,0.1);color:var(--green);cursor:pointer;font-family:var(--mono);font-weight:600">✓ Close</button>'
+ '<button onclick="startEditTrade(\'' + t.id + '\')" style="font-size:11px;padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--text2);cursor:pointer;font-family:var(--mono)">✎</button>'
+ '<button onclick="deleteTrade(\'' + t.id + '\')" style="font-size:11px;padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--text3);cursor:pointer;font-family:var(--mono)">✕</button>'
+ '</div></div>';
});
openHtml += '</div>';
}
var closedFiltered = filtered.filter(function(t) { return t.status !== 'open'; });
var rows = closedFiltered.length === 0
? '<tr><td colspan="8" style="text-align:center;color:var(--text3);font-family:var(--mono);font-size:12px;padding:20px">No closed trades yet</td></tr>'
: closedFiltered.map(function(t) {
var pCol = t.pnlPercent > 0 ? 'var(--green)' : 'var(--red)';
var pSign = t.pnlPercent > 0 ? '+' : '';
var dec = COINS[t.symbol] ? COINS[t.symbol].dec : 2;
var usdtCell = t.realizedUSDT != null
? '<span style="font-size:11px;font-family:var(--mono);color:' + (t.realizedUSDT>=0?'var(--green)':'var(--red)') + ';font-weight:600">' + (t.realizedUSDT>=0?'+':'') + t.realizedUSDT + 'U</span>'
: '<span style="color:var(--text3);font-size:10px;font-family:var(--mono)">—</span>';
return '<tr id="row-' + t.id + '" style="border-bottom:1px solid var(--border)">'
+ '<td style="font-size:11px;color:var(--text3);font-family:var(--mono);padding:8px 6px;white-space:nowrap">' + relTime(t.timestamp) + '</td>'
+ '<td style="padding:8px 6px"><span style="font-size:11px;font-weight:600;margin-right:5px">' + t.symbol + '</span>' + dirBadge(t.direction) + '</td>'
+ '<td style="font-size:11px;font-family:var(--mono);color:var(--text2);padding:8px 6px">' + fn(t.entryPrice,dec) + '<br><span style="color:var(--text3)">' + fn(t.exitPrice,dec) + '</span></td>'
+ '<td style="font-family:var(--mono);font-size:13px;font-weight:700;color:' + pCol + ';padding:8px 6px">' + pSign + t.pnlPercent + '%</td>'
+ '<td style="padding:8px 6px">' + usdtCell + '</td>'
+ '<td style="font-size:11px;font-family:var(--mono);color:var(--text2);padding:8px 6px">' + t.leverage + 'x</td>'
+ '<td style="padding:8px 6px">' + sigBadge(t.signalType) + '</td>'
+ '<td style="padding:8px 6px;white-space:nowrap">'
+ '<button onclick="startEditTrade(\'' + t.id + '\')" style="font-size:9px;background:transparent;border:1px solid var(--border);color:var(--text2);border-radius:3px;padding:2px 6px;cursor:pointer;font-family:var(--mono);margin-right:3px">✎</button>'
+ '<button onclick="deleteTrade(\'' + t.id + '\')" style="font-size:9px;background:transparent;border:1px solid var(--border);color:var(--text3);border-radius:3px;padding:2px 6px;cursor:pointer;font-family:var(--mono)">✕</button>'
+ '</td></tr>';
}).join('');
var formHtml = '<div id="new-trade-form" style="background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:16px;margin-top:16px">'
+ '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--text2);font-family:var(--mono);margin-bottom:12px">Log New Trade</div>'
+ '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Symbol</div>'
+ '<select id="nt-symbol" style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px">'
+ '<option value="BTC">BTC</option><option value="ETH">ETH</option><option value="SOL">SOL</option><option value="XRP">XRP</option><option value="SUI">SUI</option>'
+ '</select></div>'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Direction</div>'
+ '<select id="nt-dir" style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px">'
+ '<option value="long">Long</option><option value="short">Short</option>'
+ '</select></div>'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Leverage</div>'
+ '<select id="nt-lev" style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px">'
+ '<option value="10">10x</option><option value="25">25x</option><option value="50">50x</option><option value="75" selected>75x</option><option value="100">100x</option><option value="125">125x</option>'
+ '</select></div></div>'
+ '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Entry price</div>'
+ '<input id="nt-entry" type="number" step="any" placeholder="0.00" style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px;box-sizing:border-box"></div>'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Exit price <span style="color:var(--text3);font-size:9px">(blank = open)</span></div>'
+ '<input id="nt-exit" type="number" step="any" placeholder="blank = open trade" style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px;box-sizing:border-box"></div>'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Signal type</div>'
+ '<select id="nt-sig" style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px">'
+ '<option value="swing">Swing Lock</option><option value="scalp">Scalp</option><option value="post_sweep">Post-Sweep</option><option value="liq_scale">Liq Scale-In</option><option value="sweep_opp">Sweep Opp</option><option value="manual">Manual</option>'
+ '</select></div></div>'
+ '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Size USDT <span style="color:var(--text3);font-size:9px">(optional)</span></div>'
+ '<input id="nt-size" type="number" step="any" placeholder="e.g. 500" style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px;box-sizing:border-box"></div>'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Notes (optional)</div>'
+ '<input id="nt-notes" type="text" placeholder="e.g. W pattern, TP1 hit..." style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px;box-sizing:border-box"></div>'
+ '</div>'
+ '<div style="display:flex;align-items:center;gap:8px">'
+ '<button onclick="submitNewTrade()" style="flex:1;padding:9px;border-radius:6px;border:1px solid var(--green-b);background:rgba(0,208,132,0.1);color:var(--green);font-family:var(--mono);font-size:12px;cursor:pointer;font-weight:500">+ Log Trade</button>'
+ '<div id="nt-pnl-preview" style="font-size:12px;font-family:var(--mono);color:var(--text3);min-width:80px;text-align:right"></div>'
+ '</div></div>';
document.getElementById('main-content').innerHTML = ''
+ '<div style="padding:22px 26px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:0">'
+ '<div>'
+ '<div style="font-size:11px;color:var(--text2);font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Trade Outcome Tracker</div>'
+ '<div style="font-size:22px;font-weight:700">' + tradeLog.length + ' trades logged</div>'
+ '</div>'
+ '<button onclick="exitTradeLog()" style="padding:9px 18px;border-radius:7px;border:1px solid var(--border);background:transparent;color:var(--text2);font-family:var(--mono);font-size:12px;cursor:pointer">← Back to Scanner</button>'
+ '</div>'
+ '<div style="padding:20px 26px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px;border-bottom:1px solid var(--border)">'
+ '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px">'
+ '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--text2);font-family:var(--mono);margin-bottom:6px">Win Rate</div>'
+ '<div style="font-size:24px;font-weight:700;color:' + wrCol + ';font-family:var(--mono)">' + stats.winRate + '%</div>'
+ '<div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-top:3px">' + stats.wins + 'W / ' + stats.losses + 'L</div>'
+ '</div>'
+ '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px">'
+ '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--text2);font-family:var(--mono);margin-bottom:6px">Total PnL</div>'
+ '<div style="font-size:24px;font-weight:700;color:' + pnlCol + ';font-family:var(--mono)">' + (stats.totalPnl >= 0 ? '+' : '') + stats.totalPnl + '%</div>'
+ '<div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-top:3px">' + filtered.length + ' trades</div>'
+ '</div>'
+ '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px">'
+ '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--text2);font-family:var(--mono);margin-bottom:6px">Avg PnL</div>'
+ '<div style="font-size:24px;font-weight:700;color:' + avgCol + ';font-family:var(--mono)">' + (stats.avgPnl >= 0 ? '+' : '') + stats.avgPnl + '%</div>'
+ '<div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-top:3px">per trade</div>'
+ '</div>'
+ '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px">'
+ '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--text2);font-family:var(--mono);margin-bottom:6px">Best / Worst</div>'
+ (stats.best ? '<div style="font-size:12px;font-family:var(--mono);color:var(--green);font-weight:600">+' + stats.best.pnlPercent + '% ' + stats.best.symbol + '</div>' : '<div style="color:var(--text3);font-size:12px;font-family:var(--mono)">—</div>')
+ (stats.worst ? '<div style="font-size:12px;font-family:var(--mono);color:var(--red);font-weight:600;margin-top:3px">' + stats.worst.pnlPercent + '% ' + stats.worst.symbol + '</div>' : '')
+ '</div>'
+ '</div>'
+ openHtml
+ '<div style="padding:20px 26px;display:grid;grid-template-columns:1fr 280px;gap:20px">'
+ '<div>'
+ '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">'
+ '<select id="tl-filter-type" onchange="showTradeLog()" style="background:var(--bg3);border:1px solid var(--border);border-radius:5px;color:var(--text2);font-family:var(--mono);font-size:11px;padding:5px 8px">'
+ '<option value="all">All signals</option><option value="swing">Swing</option><option value="scalp">Scalp</option><option value="post_sweep">Post-Sweep</option><option value="liq_scale">Scale-In</option><option value="sweep_opp">Sweep Opp</option><option value="manual">Manual</option>'
+ '</select>'
+ '<select id="tl-filter-symbol" onchange="showTradeLog()" style="background:var(--bg3);border:1px solid var(--border);border-radius:5px;color:var(--text2);font-family:var(--mono);font-size:11px;padding:5px 8px">'
+ '<option value="all">All coins</option><option value="BTC">BTC</option><option value="ETH">ETH</option><option value="SOL">SOL</option><option value="XRP">XRP</option><option value="SUI">SUI</option>'
+ '</select>'
+ '<select id="tl-filter-date" onchange="showTradeLog()" style="background:var(--bg3);border:1px solid var(--border);border-radius:5px;color:var(--text2);font-family:var(--mono);font-size:11px;padding:5px 8px">'
+ '<option value="all">All time</option><option value="7d">Last 7d</option><option value="30d">Last 30d</option>'
+ '</select>'
+ '<div style="margin-left:auto;display:flex;gap:6px">'
+ '<button onclick="exportTradeLog()" style="padding:5px 12px;border-radius:5px;border:1px solid var(--border);background:transparent;color:var(--text2);font-family:var(--mono);font-size:11px;cursor:pointer">↓ Export</button>'
+ '<button onclick="clearTradeLog()" style="padding:5px 12px;border-radius:5px;border:1px solid var(--red-b);background:transparent;color:var(--red);font-family:var(--mono);font-size:11px;cursor:pointer">Clear All</button>'
+ '</div></div>'
+ '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:hidden">'
+ '<table style="width:100%;border-collapse:collapse">'
+ '<thead><tr style="background:var(--bg3)">'
+ '<th style="text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);padding:10px 6px;font-weight:500">Time</th>'
+ '<th style="text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);padding:10px 6px;font-weight:500">Coin</th>'
+ '<th style="text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);padding:10px 6px;font-weight:500">Entry/Exit</th>'
+ '<th style="text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);padding:10px 6px;font-weight:500">PnL</th>'
+ '<th style="text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);padding:10px 6px;font-weight:500">Lev</th>'
+ '<th style="text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);padding:10px 6px;font-weight:500">Signal</th>'
+ '<th style="padding:10px 6px"></th>'
+ '</tr></thead>'
+ '<tbody>' + rows + '</tbody>'
+ '</table></div>'
+ formHtml
+ '</div>'
+ '<div>'
+ '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px">'
+ '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--text2);font-family:var(--mono);margin-bottom:10px">Win rate by signal</div>'
+ (typeBreakdown || '<div style="font-size:11px;color:var(--text3);font-family:var(--mono)">No data yet</div>')
+ '</div>'
+ '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px">'
+ '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--text2);font-family:var(--mono);margin-bottom:10px">Leverage breakdown</div>'
+ buildLevBreakdown(filtered)
+ '</div>'
+ '</div>'
+ '</div>';
if (document.getElementById('tl-filter-type')) document.getElementById('tl-filter-type').value = filterType;
if (document.getElementById('tl-filter-symbol')) document.getElementById('tl-filter-symbol').value = filterSymbol;
if (document.getElementById('tl-filter-date')) document.getElementById('tl-filter-date').value = filterDate;
var ntSym = document.getElementById('nt-symbol');
var ntLev = document.getElementById('nt-lev');
if (ntSym) ntSym.value = activeCoin;
if (ntLev) ntLev.value = String(activeLev);
['nt-entry','nt-exit','nt-dir','nt-lev'].forEach(function(id) {
var el = document.getElementById(id);
if (el) el.addEventListener('input', updatePnlPreview);
});
}
function buildLevBreakdown(trades) {
var levGroups = {};
trades.forEach(function(t) {
var k = t.leverage + 'x';
if (!levGroups[k]) levGroups[k] = { w:0, l:0, pnl:0 };
if (t.pnlPercent > 0) levGroups[k].w++; else levGroups[k].l++;
levGroups[k].pnl += t.pnlPercent;
});
if (Object.keys(levGroups).length === 0) return '<div style="font-size:11px;color:var(--text3);font-family:var(--mono)">No data yet</div>';
return Object.entries(levGroups).sort(function(a,b) { return parseInt(a[0]) - parseInt(b[0]); }).map(function(e) {
var lev = e[0]; var d = e[1];
var total = d.w + d.l;
var wr = total > 0 ? Math.round(d.w/total*100) : 0;
var col = wr >= 60 ? 'var(--green)' : wr >= 45 ? 'var(--amber)' : 'var(--red)';
var pSign = d.pnl >= 0 ? '+' : '';
return '<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-size:11px;font-family:var(--mono);color:var(--text2)">' + lev + '</span>'
+ '<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">' + d.w + 'W/' + d.l + 'L</span>'
+ '<span style="font-size:11px;color:' + col + ';font-family:var(--mono);font-weight:600">' + wr + '%</span>'
+ '</div>';
}).join('');
}
function updatePnlPreview() {
var entry = parseFloat(document.getElementById('nt-entry') && document.getElementById('nt-entry').value);
var exit = parseFloat(document.getElementById('nt-exit') && document.getElementById('nt-exit').value);
var dir = document.getElementById('nt-dir') ? document.getElementById('nt-dir').value : 'long';
var lev = parseInt(document.getElementById('nt-lev') ? document.getElementById('nt-lev').value : '50');
var el = document.getElementById('nt-pnl-preview');
if (!el) return;
if (!entry || !exit || isNaN(entry) || isNaN(exit)) { el.textContent = ''; return; }
var pnl = calcTradePnl(entry, exit, dir, lev);
el.textContent = (pnl >= 0 ? '+' : '') + pnl + '%';
el.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
}
function submitNewTrade() {
var sym = document.getElementById('nt-symbol') ? document.getElementById('nt-symbol').value : activeCoin;
var dir = document.getElementById('nt-dir') ? document.getElementById('nt-dir').value : 'long';
var lev = parseInt(document.getElementById('nt-lev') ? document.getElementById('nt-lev').value : '50');
var entry = parseFloat(document.getElementById('nt-entry') ? document.getElementById('nt-entry').value : '');
var exit = parseFloat(document.getElementById('nt-exit') ? document.getElementById('nt-exit').value : '') || null;
var sig = document.getElementById('nt-sig') ? document.getElementById('nt-sig').value : 'manual';
var notes = document.getElementById('nt-notes') ? document.getElementById('nt-notes').value : '';
var size = parseFloat(document.getElementById('nt-size') ? document.getElementById('nt-size').value : '') || null;
if (!entry || isNaN(entry)) { alert('Entry price is required'); return; }
var pnl = (exit && !isNaN(exit)) ? calcTradePnl(entry, exit, dir, lev) : null;
var rusdT = (pnl != null && size) ? +(pnl / 100 * size).toFixed(2) : null;
var status = exit ? 'closed' : 'open';
addTrade({ symbol:sym, direction:dir, entryPrice:entry, exitPrice:exit, pnlPercent:pnl, realizedUSDT:rusdT, sizeUSDT:size, leverage:lev, signalType:sig, notes:notes, status:status });
showTradeLog();
}
function exportTradeLog() {
var date = new Date().toISOString().slice(0,10);
var blob = new Blob([JSON.stringify(tradeLog, null, 2)], { type:'application/json' });
var a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'trade-log-' + date + '.json';
a.click();
}
function clearTradeLog() {
if (!confirm('Delete all ' + tradeLog.length + ' trades? This cannot be undone.')) return;
tradeLog = [];
saveTradeLog();
showTradeLog();
}
function exitTradeLog() {
tradeLogView = false;
var tlBtn = document.getElementById('trade-log-btn');
if (tlBtn) { tlBtn.style.background = ''; tlBtn.style.color = ''; tlBtn.style.borderColor = ''; }
selectCoin(activeCoin);
}
let swingSignals = {};
const TF_MS = { '1d':86400000, '4h':14400000, '1h':3600000, '15m':900000, '5m':300000, '1w':604800000 };
function getTfMs(tf){ return TF_MS[tf] || 3600000; }
function getCurrentCandleTime(tf){ const ms=getTfMs(tf); return Math.floor(Date.now()/ms)*ms; }
function isCandleConfirmed(klines, tf){
if(!klines||klines.length===0) return true;
var last = klines[klines.length-1];
var ms = getTfMs(tf);
return (last.t + ms) <= Date.now();
}
function getConfirmedKlines(klines, tf){
if(!klines||klines.length===0) return klines;
if(isCandleConfirmed(klines, tf)) return klines;
return klines.length > 20 ? klines.slice(0,-1) : klines;
}
function candleProgress(klines, tf){
if(!klines||klines.length===0) return 100;
var last = klines[klines.length-1];
var ms = getTfMs(tf);
var elapsed = Date.now() - last.t;
return Math.min(100, Math.round(elapsed / ms * 100));
}
function loadSwingSignals(){
try{
const raw=localStorage.getItem('swingSignals_v1');
if(!raw) return;
const parsed=JSON.parse(raw);
Object.entries(parsed).forEach(([k,sig])=>{
if(sig && sig.lockedSetup && sig.lockedAt && sig.symbol && sig.tf &&
typeof sig.lockedSetup.entry==='number' && sig.lockedSetup.entry>0){
swingSignals[k]=sig;
}
});
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
bias: null,
support: ta.support,
resistance: ta.resistance,
entry: setup.lE,
stopLoss: setup.lSL,
takeProfits:[setup.lTP1, setup.lTP2],
shortEntry: setup.sE,
shortStop: setup.sSL,
shortTPs: [setup.sTP1, setup.sTP2],
liqLong: setup.liqLong,
liqShort: setup.liqShort,
atr: ta.atr,
invalidationLevel: ta.support
},
lockedPivots: pivots ? { highs:[...pivots.highs], lows:[...pivots.lows] } : { highs:[], lows:[] },
snapshot: {
score: sc,
rsi: ta.rsi,
trend: ta.trend,
lockedPrice: price,
oiAtLock: (typeof mktData[coin]!=='undefined') ? mktData[coin].oiNotional : 0,
fundingAtLock: (typeof mktData[coin]!=='undefined') ? mktData[coin].funding : 0,
aiSummary: null,
aiInterestZone:null,
aiConviction: null,
aiBias: null
},
dynamic: {
status: 'active',
candlesElapsed:0,
lastCheckedCandle: candleTime,
consecutiveLowScore: 0
},
reEval: {
lastChecked: Date.now(),
structureBreaks: 0,
lastLiqSweepDetected: null,
aiInterestZoneMatch: true,
needsReview: false
}
};
saveSwingSignals();
}
function updateSignalAI(coin, tf, ai){
const key = coin+'_'+tf;
const sig = swingSignals[key];
if(!sig) return;
sig.lockedSetup.bias = ai.bias || null;
sig.snapshot.aiSummary = ai.summary || null;
sig.snapshot.aiConviction = ai.conviction || null;
sig.snapshot.aiBias = ai.bias || null;
sig.snapshot.aiInterestZone = ai.watchLevel || null;
saveSwingSignals();
}
function invalidateSignal(coin, tf, reason){
const key = coin+'_'+tf;
if(!swingSignals[key]) return;
delete swingSignals[key];
saveSwingSignals();
}
function applyLearningWeight(rawScore, signalType) {
var w = calculateSignalWeight(signalType || 'swing');
return +Math.min(10, Math.max(0, rawScore * w)).toFixed(1);
}
function detectWickSweep(sig, klines) {
if (!klines || klines.length < 2) return false;
const c = klines[klines.length - 1];
const inv = sig.lockedSetup.invalidationLevel;
const bias = sig.lockedSetup.bias;
if (bias === 'short') return c.h >= inv && c.c < inv;
return c.l <= inv && c.c > inv;
}
function checkCVDFlip(sig, cvdData) {
if (!cvdData || !cvdData.trend) return false;
const prev = sig.reEval.prevCVDTrend;
const curr = cvdData.trend;
const bias = sig.lockedSetup.bias;
if (bias === 'short') return prev === 'bullish' && curr === 'bearish';
return prev === 'bearish' && curr === 'bullish';
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
function getVolumeMultiple(klines) {
if (!klines || klines.length < 21) return 1;
const last20 = klines.slice(-21, -1).map(k => k.v).sort((a,b) => a - b);
const median = last20[Math.floor(last20.length / 2)] || 1;
const current = klines[klines.length - 1].v;
return current / median;
}
function checkSignalValidity(coin, tf, currentPrice, currentScore){
const key = coin+'_'+tf;
const sig = swingSignals[key];
if(!sig) return null;
if(sig.mode !== 'swing') return null;
const candleTime = getCurrentCandleTime(tf);
if(candleTime > sig.dynamic.lastCheckedCandle){
const tfMs = getTfMs(tf);
const elapsed = Math.round((candleTime - sig.lockedCandleTime) / tfMs);
sig.dynamic.candlesElapsed = elapsed;
sig.dynamic.lastCheckedCandle = candleTime;
saveSwingSignals();
}
if(sig.dynamic.candlesElapsed >= 5){
invalidateSignal(coin, tf, 'expired after 5 candles');
return null;
}
const inv = sig.lockedSetup.invalidationLevel;
if(sig.lockedSetup.bias !== 'short' && currentPrice < inv * 0.998){
invalidateSignal(coin, tf, `price ${currentPrice} broke invalidation ${inv}`);
return null;
}
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
const ls = sig.lockedSetup;
if(currentPrice <= ls.entry * 1.002 && currentPrice >= ls.entry * 0.998)
sig.dynamic.status = 'triggered';
if(currentPrice >= ls.takeProfits[0])
sig.dynamic.status = 'tp1Hit';
return sig;
}
const fn=(n,d)=>n==null?'—':Number(n).toLocaleString('en-US',{minimumFractionDigits:d??0,maximumFractionDigits:d??0});
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
const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','SUIUSDT'];
const cgIds = {BTCUSDT:'bitcoin',ETHUSDT:'ethereum',SOLUSDT:'solana',XRPUSDT:'ripple',SUIUSDT:'sui'};
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
const intervalMap={'1w':'W','1d':'D','4h':'240','1h':'60','15m':'15','5m':'5'};
const bybitInterval=intervalMap[tf]||'D';
try{
const controller = new AbortController();
const timer = setTimeout(function(){ controller.abort(); }, IS_MOBILE ? 6000 : 8000);
const r=await fetch('https://api.bybit.com/v5/market/kline?category=linear&symbol='+COINS[coin].sym+'&interval='+bybitInterval+'&limit=100',{signal:controller.signal});
clearTimeout(timer);
const j=await r.json();
const list=j?.result?.list;
if(Array.isArray(list)&&list.length>0){
const klines=list.reverse().map(k=>({t:parseInt(k[0]),o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
klCache[key]=klines;return klines;
}
}catch(e){console.warn('Bybit klines failed, using fallback',e);}
const price=mktData[coin]?.price||1;
const klines=Array.from({length:60},(_,i)=>{
const base=price*(1+(Math.random()-0.5)*0.02);
const h=base*(1+Math.random()*0.01),l=base*(1-Math.random()*0.01);
return{t:Date.now()-(60-i)*86400000,o:base,h,l,c:base*(1+(Math.random()-0.5)*0.005),v:1000000};
});
klCache[key]=klines;return klines;
}
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
if(isL) lows.push(klines[i].l);
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
const pivots=findPivotLevels(klines.slice(-60),3);
const pivotsBelow=pivots.lows.filter(p=>p<curr);
const pivotsAbove=pivots.highs.filter(p=>p>curr);
const rec=klines.slice(-20);
const support =pivotsBelow.length>0?Math.max(...pivotsBelow):Math.min(...rec.map(k=>k.l));
const resistance=pivotsAbove.length>0?Math.min(...pivotsAbove):Math.max(...rec.map(k=>k.h));
const minP=Math.min(...lo),maxP=Math.max(...hi),range=maxP-minP,buckets=8;
const volProfile=Array.from({length:buckets},(_,i)=>({price:minP+range*(i+0.5)/buckets,vol:0,pct:0}));
klines.forEach(k=>{const mid=(k.h+k.l)/2;const idx=Math.min(buckets-1,Math.floor((mid-minP)/range*buckets));if(volProfile[idx])volProfile[idx].vol+=k.v;});
const maxVol=Math.max(...volProfile.map(b=>b.vol));
volProfile.forEach(b=>{b.pct=maxVol>0?b.vol/maxVol:0;});
const poc=volProfile.reduce((a,b)=>b.vol>a.vol?b:a,volProfile[0]).price;
var vols20 = klines.slice(-21,-1).map(function(k){return k.v;}).sort(function(a,b){return a-b;});
var medVol = vols20[Math.floor(vols20.length/2)] || 1;
var volumeSpike = +(klines[klines.length-1].v / medVol).toFixed(2);
var cvdSnap = window._lastCvdData;
var takerBuyPct = cvdSnap && cvdSnap.buyPct ? parseFloat(cvdSnap.buyPct) : 50;
return{rsi,ema20,ema50,atr,trend,support,resistance,volProfile,poc,volumeSpike,takerBuyPct};
}
function calcEntries(price,ta,dec){
const atr=ta.atr||price*0.02;
const supportEntry=+(ta.support+atr*0.3).toFixed(dec);
const pullbackEntry=+(price-atr*0.75).toFixed(dec);
const optimalLong=Math.min(Math.max(supportEntry,pullbackEntry), price);
const resistEntry=+(ta.resistance-atr*0.3).toFixed(dec);
const rallyEntry=+(price+atr*0.75).toFixed(dec);
const optimalShort=resistEntry>price ? Math.min(resistEntry,rallyEntry) : rallyEntry;
const isOpt=entryMode==='optimal';
return{long:isOpt?optimalLong:price,short:isOpt?optimalShort:price,atr,pullbackPct:((price-(isOpt?optimalLong:price))/price*100),rallyPct:(((isOpt?optimalShort:price)-price)/price*100)};
}
function calcSetups(entries,dec,ta,lz){
const{long:lE,short:sE,atr}=entries;
const mmr=activeLev>=100?0.005:activeLev>=25?0.004:0.003;
const imr=1/activeLev;
const liqDist=(imr-mmr);
const maxStopDec=liqDist*0.6;
const atrStopLong=atr*1.5/lE;
const atrStopShort=atr*1.5/sE;
const longStopDec=activeLev>1?Math.min(atrStopLong,maxStopDec):atrStopLong;
const shortStopDec=activeLev>1?Math.min(atrStopShort,maxStopDec):atrStopShort;
const lSL=+(lE*(1-longStopDec)).toFixed(dec);
const lRisk=longStopDec*100;
const lEma20 = ta&&ta.ema20 ? ta.ema20 : 0;
const lResist = ta&&ta.resistance ? ta.resistance : 0;
const lLiqAbove = lz&&lz.topShortLiq
? (lz.topShortLiq.filter(function(z){return z.price>lE;}).sort(function(a,b){return a.price-b.price;})[0]||{}).price||0
: 0;
const lTP1raw = lEma20>lE ? lEma20 : lE*1.05;
const lTP1 = +lTP1raw.toFixed(dec);
const lTP2raw = lLiqAbove>lTP1 ? lLiqAbove : lResist>lTP1 ? lE+(lResist-lE)*0.5 : lE*1.10;
const lTP2 = +lTP2raw.toFixed(dec);
const lTP3raw = lResist>lTP2 ? lResist : lE*1.20;
const lTP3 = +lTP3raw.toFixed(dec);
const lRew=(lTP1-lE)/lE*100;
const lRR=lRew/lRisk;
const sSL=+(sE*(1+shortStopDec)).toFixed(dec);
const sRisk=shortStopDec*100;
const sEma20 = ta&&ta.ema20 ? ta.ema20 : 0;
const sSupport = ta&&ta.support ? ta.support : 0;
const sLiqBelow = lz&&lz.topLongLiq
? (lz.topLongLiq.filter(function(z){return z.price<sE;}).sort(function(a,b){return b.price-a.price;})[0]||{}).price||0
: 0;
const sTP1raw = sEma20>0&&sEma20<sE ? sEma20 : sE*0.95;
const sTP1 = +sTP1raw.toFixed(dec);
const sTP2raw = sLiqBelow>0&&sLiqBelow<sTP1 ? sLiqBelow : sSupport>0&&sSupport<sTP1 ? sE-(sE-sSupport)*0.5 : sE*0.90;
const sTP2 = +sTP2raw.toFixed(dec);
const sTP3raw = sSupport>0&&sSupport<sTP2 ? sSupport : sE*0.80;
const sTP3 = +sTP3raw.toFixed(dec);
const sRew=(sE-sTP1)/sE*100;
const sRR=sRew/sRisk;
const levAdjustedLong=activeLev>1&&atrStopLong>maxStopDec;
const levAdjustedShort=activeLev>1&&atrStopShort>maxStopDec;
const takerFee=0.0005;
const liqLong = +(lE*(1-imr+mmr+takerFee)).toFixed(dec);
const liqShort = +(sE*(1+imr-mmr-takerFee)).toFixed(dec);
const liqDistPct = (imr-mmr)*100;
return{lE,lSL,lTP1,lTP2,lTP3,lRisk,lRew,lRR,sE,sSL,sTP1,sTP2,sTP3,sRisk,sRew,sRR,
levAdjustedLong,levAdjustedShort,
maxStopPct:maxStopDec*100,
atrStopLongPct:atrStopLong*100,
atrStopShortPct:atrStopShort*100,
liqLong,liqShort,liqDistPct};
}
function calcLiqZones(price, atr, oi, funding, oiNotional, klines, dec) {
dec = dec || 2;
const fundingBias = funding > 0.01 ? 'long-heavy' : funding < -0.01 ? 'short-heavy' : 'neutral';
const oiB = oiNotional || (oi * price) || 0;
const leverageTiers = [
{ lev: 10, stopPct: 0.09, label: '10x' },
{ lev: 25, stopPct: 0.038, label: '25x' },
{ lev: 50, stopPct: 0.018, label: '50x' },
{ lev: 100, stopPct: 0.009, label: '100x' },
{ lev: 125, stopPct: 0.007, label: '125x' },
];
const atrMult = atr / price;
const longLiqZones = leverageTiers.map(t => {
const liqPrice = +(price * (1 - t.stopPct)).toFixed(dec);
const fundingWeight = fundingBias === 'long-heavy' ? 1.5 : fundingBias === 'neutral' ? 1.0 : 0.6;
const sig = t.lev >= 100 ? 'high' : t.lev >= 50 ? 'medium' : 'low';
const significance = fundingBias === 'long-heavy' && t.lev >= 50 ? 'high' : sig;
return {
price: liqPrice,
leverage: t.label,
distance: (t.stopPct * 100).toFixed(2) + '%',
significance
};
});
const shortLiqZones = leverageTiers.map(t => {
const liqPrice = +(price * (1 + t.stopPct)).toFixed(dec);
const fundingWeight = fundingBias === 'short-heavy' ? 1.5 : fundingBias === 'neutral' ? 1.0 : 0.6;
const sig = t.lev >= 100 ? 'high' : t.lev >= 50 ? 'medium' : 'low';
const significance = fundingBias === 'short-heavy' && t.lev >= 50 ? 'high' : sig;
return {
price: liqPrice,
leverage: t.label,
distance: (t.stopPct * 100).toFixed(2) + '%',
significance
};
});
const topLongLiq = longLiqZones.filter(z => z.significance !== 'low');
const topShortLiq = shortLiqZones.filter(z => z.significance !== 'low');
const nearestLongSweep = longLiqZones[longLiqZones.length - 1];
const nearestShortSweep = shortLiqZones[shortLiqZones.length - 1];
const majorLongCluster = {
priceRange: '$' + longLiqZones[2].price.toLocaleString() + ' - $' + longLiqZones[0].price.toLocaleString(),
low: longLiqZones[0].price, high: longLiqZones[2].price,
label: 'Major long liq zone (10x-50x)'
};
const majorShortCluster = {
priceRange: '$' + shortLiqZones[2].price.toLocaleString() + ' - $' + shortLiqZones[0].price.toLocaleString(),
low: shortLiqZones[2].price, high: shortLiqZones[0].price,
label: 'Major short liq zone (10x-50x)'
};
const longSweepEntry = {
entry: +(price * (1 - 0.018)).toFixed(dec),
stop: +(price * (1 - 0.095)).toFixed(dec),
tp1: +(price * (1 + 0.018)).toFixed(dec),
tp2: +(price * (1 + 0.038)).toFixed(dec),
tp3: +(price * (1 + 0.095)).toFixed(dec),
rr: +((0.018 + 0.038) / (0.018 - 0 + 0.095 - 0.018)).toFixed(2),
type: 'Long after long liq sweep',
logic: 'Enter long inside long liq zone after sweep, target short liq above'
};
const shortSweepEntry = {
entry: +(price * (1 + 0.018)).toFixed(dec),
stop: +(price * (1 + 0.095)).toFixed(dec),
tp1: +(price * (1 - 0.018)).toFixed(dec),
tp2: +(price * (1 - 0.038)).toFixed(dec),
tp3: +(price * (1 - 0.095)).toFixed(dec),
rr: +((0.018 + 0.038) / (0.095 - 0.018)).toFixed(2),
type: 'Short after short liq squeeze',
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
function safeFormat(n, dec) {
const v = parseFloat(n);
if (!isFinite(v) || v === 0) return '\u2014';
try {
return v.toLocaleString('en-US', { minimumFractionDigits: Math.min(dec,4), maximumFractionDigits: Math.min(dec,4) });
} catch(e) {
return v.toFixed(Math.min(dec,4));
}
}
function safeFormatATR(atr, price) {
if (!atr || !isFinite(atr) || atr <= 0) return '—';
var decimals;
if (price >= 1000) decimals = 2;
else if (price >= 100) decimals = 2;
else if (price >= 10) decimals = 3;
else if (price >= 1) decimals = 4;
else decimals = 6;
return '$' + atr.toFixed(decimals);
}
function renderLiqCard(liq, price, dec) {
if (!liq) return '';
try {
const fn2 = n => safeFormat(n, dec);
const biasColor = liq.fundingBias === 'long-heavy' ? 'var(--green)' : liq.fundingBias === 'short-heavy' ? 'var(--red)' : 'var(--amber)';
const longRows = liq.longLiqZones.slice().reverse().map(z => {
const sigBg = z.significance==='high' ? 'rgba(255,77,77,.25)' : z.significance==='medium' ? 'rgba(255,77,77,.12)' : 'rgba(255,77,77,.05)';
const sigCol = z.significance==='high' ? 'var(--red)' : z.significance==='medium' ? 'rgba(255,120,120,0.9)' : 'var(--text3)';
return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-family:var(--mono);font-size:11px;color:var(--text2)">' + z.leverage + ' longs</span>'
+ '<span style="font-family:var(--mono);font-size:12px;color:var(--red)">$' + fn2(z.price) + '</span>'
+ '<span style="font-size:10px;color:var(--text3)">' + z.distance + ' below</span>'
+ '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:' + sigBg + ';color:' + sigCol + '">' + z.significance + '</span>'
+ '</div>';
}).join('');
const shortRows = liq.shortLiqZones.slice().reverse().map(z => {
const sigBg = z.significance==='high' ? 'rgba(0,208,132,.25)' : z.significance==='medium' ? 'rgba(0,208,132,.12)' : 'rgba(0,208,132,.05)';
const sigCol = z.significance==='high' ? 'var(--green)' : z.significance==='medium' ? 'rgba(80,200,150,0.9)' : 'var(--text3)';
return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-family:var(--mono);font-size:11px;color:var(--text2)">' + z.leverage + ' shorts</span>'
+ '<span style="font-family:var(--mono);font-size:12px;color:var(--green)">$' + fn2(z.price) + '</span>'
+ '<span style="font-size:10px;color:var(--text3)">' + z.distance + ' above</span>'
+ '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:' + sigBg + ';color:' + sigCol + '">' + z.significance + '</span>'
+ '</div>';
}).join('');
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
function renderLiqScaleInCard(coin, tf, price, ta, klines, cvdData, dec, liqZones) {
try {
if (!klines || klines.length < 20 || !ta || !ta.atr) return '';
const atr = ta.atr;
const fn2 = n => safeFormat(n, dec);
const d = mktData[coin] || {};
function buildCard(side, zones) {
if (!zones || zones.length < 3) return '';
const isLong = side === 'long';
const z125 = zones.find(z => z.leverage === '125x') || zones[0];
const z50 = zones.find(z => z.leverage === '50x') || zones[1];
const z25 = zones.find(z => z.leverage === '25x') || zones[2];
const z10 = zones.find(z => z.leverage === '10x') || zones[zones.length-1];
const clusterTop = isLong ? z125.price : z125.price;
const clusterMid = z50.price;
const clusterBottom = isLong ? z25.price : z25.price;
const zoneRange = Math.abs(clusterTop - clusterBottom).toFixed(dec);
const mmrS = activeLev >= 100 ? 0.005 : activeLev >= 25 ? 0.004 : 0.003;
const imrS = 1 / activeLev;
const maxSDpct = (imrS - mmrS) * 0.6;
const useATRStop = activeLev <= 25;
const stopLoss = isLong
? useATRStop
? +(z10.price - atr * 0.5).toFixed(dec)
: +(clusterBottom * (1 - maxSDpct)).toFixed(dec)
: useATRStop
? +(z10.price + atr * 0.5).toFixed(dec)
: +(clusterTop * (1 + maxSDpct)).toFixed(dec);
const stopPctDisplay = Math.abs(stopLoss - (isLong ? clusterTop : clusterTop)) / clusterTop * 100;
const rawResist = (ta.resistance && ta.resistance > price && ta.resistance < price * 1.04)
? ta.resistance : +(price * 1.018).toFixed(dec);
const longTP1 = +rawResist.toFixed(dec);
const longTP2 = +(Math.max(price * 1.04, longTP1 * 1.012)).toFixed(dec);
const shortTP1 = +(price * 0.982).toFixed(dec);
const shortTP2 = +(Math.min(price * 0.962, shortTP1 * 0.988)).toFixed(dec);
const tp1 = isLong ? longTP1 : shortTP1;
const tp2 = isLong ? longTP2 : shortTP2;
const nearest = clusterTop;
if (Math.abs(price - nearest) > atr * 1.5) return '';
const volMult = getVolumeMultiple(klines);
const isVolumeQuiet = volMult < 1.8;
const isCVDAligned = cvdData && (isLong
? (cvdData.trend === 'bearish' || cvdData.trend === 'neutral')
: (cvdData.trend === 'bullish' || cvdData.trend === 'neutral'));
const isFundingAligned = isLong
? (d.funding || 0) > 0
: (d.funding || 0) < 0;
const isEMAAligned = isLong
? (ta.ema50 ? price > ta.ema50 : price > ta.ema20)
: (ta.ema50 ? price < ta.ema50 : price < ta.ema20);
const isNearCluster = Math.abs(price - nearest) < atr;
let confScore = 0;
if (isVolumeQuiet) confScore++;
if (isCVDAligned) confScore++;
if (isFundingAligned)confScore++;
if (isEMAAligned) confScore++;
if (isNearCluster) confScore++;
const confLabel = confScore >= 4 ? 'HIGH' : confScore >= 3 ? 'MEDIUM' : 'LOW';
const confColor = confScore >= 4 ? 'var(--green)' : confScore >= 3 ? 'var(--amber)' : 'var(--red)';
const confBg = confScore >= 4 ? 'rgba(0,208,132,0.15)' : confScore >= 3 ? 'rgba(245,166,35,0.15)' : 'rgba(255,77,77,0.15)';
const borderCol = isLong ? 'rgba(0,208,132,0.4)' : 'rgba(255,77,77,0.4)';
const headCol = isLong ? 'var(--green)' : 'var(--red)';
const sideLabel = isLong ? 'Long' : 'Short';
const distPct = ((Math.abs(price - nearest)) / price * 100).toFixed(2);
const filterRows = [
{ label: 'Volume quiet (no spike)', pass: isVolumeQuiet, val: volMult.toFixed(1)+'x' },
{ label: 'CVD '+(isLong?'neutral/bearish':'neutral/bullish'), pass: isCVDAligned, val: cvdData ? cvdData.trend : '--' },
{ label: 'Funding '+(isLong?'positive (longs heavy)':'negative (shorts heavy)'), pass: isFundingAligned, val: d.funding ? d.funding.toFixed(4)+'%' : '--' },
{ label: 'Price '+(isLong?'above':'below')+' 50 EMA (structure)', pass: isEMAAligned, val: isEMAAligned ? 'yes' : 'no' },
{ label: 'Within 1 ATR of cluster', pass: isNearCluster, val: distPct+'% away' }
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
+ '<div style="background:var(--bg3);border-radius:7px;padding:8px">'
+ '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);margin-bottom:5px">Confidence filters</div>'
+ filterRows + '</div>'
+ levWarn + alreadyHtml
+ '</div>';
}
const longCard = liqZones ? buildCard('long', liqZones.longLiqZones) : '';
const shortCard = liqZones ? buildCard('short', liqZones.shortLiqZones) : '';
if (!longCard && !shortCard) return '';
return '<div class="card full" style="border-color:rgba(245,166,35,0.4);background:rgba(245,166,35,0.02)">'
+ '<div class="card-title" style="color:var(--amber)">Liq Zone Scale-In Setup'
+ '<span style="margin-left:10px;font-size:10px;color:var(--text3);font-family:var(--mono)">Only shows when price is near a cluster</span></div>'
+ '<p style="font-size:11px;color:var(--text2);font-family:var(--mono);margin:0 0 12px;line-height:1.6">Counter-trend entry inside the liq cluster as price sweeps through. Scale in as it moves. Stop below the full zone. Use 25-50x max.</p>'
+ '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">'
+ (longCard || '<div style="background:var(--bg3);border-radius:10px;padding:14px;display:flex;align-items:center;justify-content:center"><span style="font-size:11px;color:var(--text3);font-family:var(--mono)">Long cluster not in range</span></div>')
+ (shortCard || '<div style="background:var(--bg3);border-radius:10px;padding:14px;display:flex;align-items:center;justify-content:center"><span style="font-size:11px;color:var(--text3);font-family:var(--mono)">Short cluster not in range</span></div>')
+ '</div></div>';
} catch(e) {
console.warn('renderLiqScaleInCard error:', e);
return '';
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
const priceOld = klines[klines.length - 1 - lookback].c;
const priceCurr = klines[klines.length - 1].c;
const cvdChange = cvd[cvd.length-1] - cvd[cvd.length-1-lookback];
const priceChgPct = priceOld !== 0 ? (priceCurr - priceOld) / priceOld : 0;
const cvdRange = (Math.max(...cvd) - Math.min(...cvd)) || 1;
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
const sorted = [...trades].sort((a, b) => parseInt(a.time) - parseInt(b.time));
const bmap = {};
let totalBuy = 0, totalSell = 0;
sorted.forEach(t => {
const ts = parseInt(t.time);
const bk = Math.floor(ts / bucketMs) * bucketMs;
if (!bmap[bk]) bmap[bk] = { t:bk, buyVol:0, sellVol:0, count:0 };
const vol = parseFloat(t.size) || 0;
if (t.side === 'Buy') { bmap[bk].buyVol += vol; totalBuy += vol; }
else { bmap[bk].sellVol += vol; totalSell += vol; }
bmap[bk].count++;
});
const buckets = Object.values(bmap).sort((a, b) => a.t - b.t);
if (buckets.length < 2) return calcCVDFromKlines(klCache[coin+'_'+tf]||[]);
const deltas = buckets.map(b => b.buyVol - b.sellVol);
let cum = 0;
const cvd = deltas.map(d => { cum += d; return cum; });
const firstPrice = parseFloat(sorted[0].price) || 0;
const lastPrice = parseFloat(sorted[sorted.length-1].price) || firstPrice;
const priceChgPct = firstPrice > 0 ? (lastPrice - firstPrice) / firstPrice : 0;
const cvdRange = (Math.max(...cvd) - Math.min(...cvd)) || 1;
const cvdChange = cvd[cvd.length-1] - cvd[0];
const cvdChgPct = cvdChange / cvdRange;
let divergence = null;
if (Math.abs(priceChgPct) > 0.001) {
if (priceChgPct > 0 && cvdChgPct < -0.08)
divergence = { type:'bearish', label:'Bearish CVD div',
desc:'Price moving up but real sellers are more aggressive - distribution, high reversal risk' };
else if (priceChgPct < 0 && cvdChgPct > 0.08)
divergence = { type:'bullish', label:'Bullish CVD div',
desc:'Price falling but real buyers absorbing - accumulation, watch for reversal' };
}
const totalVol = totalBuy + totalSell || 1;
const buyPct = (totalBuy / totalVol * 100).toFixed(1);
const sellPct = (totalSell / totalVol * 100).toFixed(1);
const trend = cvdChange > 0 ? 'bullish' : cvdChange < 0 ? 'bearish' : 'neutral';
const spanMs = buckets[buckets.length-1].t - buckets[0].t + bucketMs;
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
async function fetchOrderBook(sym, clusterPrice) {
try {
var r = await fetchWithTimeout(
'https://api.bybit.com/v5/market/orderbook?category=linear&symbol=' + sym + '&limit=50', 4000
);
var bids = r?.result?.b || [];
var asks = r?.result?.a || [];
var range = clusterPrice * 0.008;
var bidVol = 0, askVol = 0;
bids.forEach(function(b) { if (Math.abs(parseFloat(b[0]) - clusterPrice) <= range) bidVol += parseFloat(b[1]); });
asks.forEach(function(a) { if (Math.abs(parseFloat(a[0]) - clusterPrice) <= range) askVol += parseFloat(a[1]); });
var total = bidVol + askVol || 1;
return { bidVol:bidVol, askVol:askVol, imbalance:+((bidVol-askVol)/total*100).toFixed(1) };
} catch(e) { return null; }
}
function calcBBSqueeze(klines,trend){
try{
var period=20,mult=2;
var cl=klines.map(function(k){return k.c;});
if(cl.length<period+2)return{squeeze:false,breakoutAligned:false};
function getBandWidth(slice){
var mean=slice.reduce(function(a,b){return a+b;},0)/slice.length;
var sd=Math.sqrt(slice.reduce(function(a,b){return a+Math.pow(b-mean,2);},0)/slice.length);
return sd*mult*2/mean;
}
var currSlice=cl.slice(-period);
var currWidth=getBandWidth(currSlice);
var isSqueeze=true;
for(var i=1;i<=20;i++){
if(cl.length<period+i)break;
var prevWidth=getBandWidth(cl.slice(-period-i,-i));
if(prevWidth<=currWidth){isSqueeze=false;break;}
}
var mean=currSlice.reduce(function(a,b){return a+b;},0)/period;
var sd=Math.sqrt(currSlice.reduce(function(a,b){return a+Math.pow(b-mean,2);},0)/period);
var upperBand=mean+mult*sd;
var lowerBand=mean-mult*sd;
var lastClose=cl[cl.length-1];
var isBullish=trend==='bullish'||trend==='mild-bullish';
var breakoutAligned=(isBullish&&lastClose>upperBand)||(!isBullish&&lastClose<lowerBand);
return{squeeze:isSqueeze,breakoutAligned:breakoutAligned,upperBand:+upperBand.toFixed(4),lowerBand:+lowerBand.toFixed(4),bandwidth:+currWidth.toFixed(6)};
}catch(e){return{squeeze:false,breakoutAligned:false};}
}
function calcRSIDivergence(klines){
try{
if(klines.length<20)return{divergence:null};
var recent=klines.slice(-14);
var cl=recent.map(function(k){return k.c;});
function rsiAt(closes){
var g=0,l=0;
for(var i=1;i<closes.length;i++){var d=closes[i]-closes[i-1];if(d>0)g+=d;else l+=Math.abs(d);}
var n=closes.length-1||1;
return 100-(100/(1+(l===0?999:g/l)));
}
var firstHalfRsi=rsiAt(cl.slice(0,7));
var secondHalfRsi=rsiAt(cl.slice(7));
var firstHalfHigh=Math.max.apply(null,recent.slice(0,7).map(function(k){return k.h;}));
var secondHalfHigh=Math.max.apply(null,recent.slice(7).map(function(k){return k.h;}));
var firstHalfLow=Math.min.apply(null,recent.slice(0,7).map(function(k){return k.l;}));
var secondHalfLow=Math.min.apply(null,recent.slice(7).map(function(k){return k.l;}));
var bearDiv=secondHalfHigh>firstHalfHigh&&secondHalfRsi<firstHalfRsi-2;
var bullDiv=secondHalfLow<firstHalfLow&&secondHalfRsi>firstHalfRsi+2;
if(bearDiv)return{divergence:'bearish',label:'Bearish RSI div',desc:'Price new high, RSI lower — momentum fading'};
if(bullDiv)return{divergence:'bullish',label:'Bullish RSI div',desc:'Price new low, RSI higher — selling exhausted'};
return{divergence:null};
}catch(e){return{divergence:null};}
}
function calcBOS(klines,trend){
try{
if(klines.length<20)return{bos:false,type:null};
var lookback=klines.slice(-20,-1);
var lastCandle=klines[klines.length-1];
var swingHigh=Math.max.apply(null,lookback.map(function(k){return k.h;}));
var swingLow=Math.min.apply(null,lookback.map(function(k){return k.l;}));
var isBullish=trend==='bullish'||trend==='mild-bullish';
var bullBOS=lastCandle.c>swingHigh&&isBullish;
var bearBOS=lastCandle.c<swingLow&&!isBullish;
if(bullBOS)return{bos:true,type:'bullish',level:+swingHigh.toFixed(4)};
if(bearBOS)return{bos:true,type:'bearish',level:+swingLow.toFixed(4)};
return{bos:false,type:null,swingHigh:+swingHigh.toFixed(4),swingLow:+swingLow.toFixed(4)};
}catch(e){return{bos:false,type:null};}
}
function calcVWAPReclaim(klines,trend){
try{
if(klines.length<10)return{reclaim:false,vwap:null};
var window50=klines.slice(-50);
var cumTPV=0,cumVol=0;
window50.forEach(function(k){
var tp=(k.h+k.l+k.c)/3;
cumTPV+=tp*k.v;
cumVol+=k.v;
});
var vwap=cumVol>0?cumTPV/cumVol:null;
if(!vwap)return{reclaim:false,vwap:null};
var recent3=klines.slice(-3);
var closes=recent3.map(function(k){return k.c;});
var isBullish=trend==='bullish'||trend==='mild-bullish';
var bullReclaim=closes[0]<vwap&&closes[closes.length-1]>vwap&&isBullish;
var bearReclaim=closes[0]>vwap&&closes[closes.length-1]<vwap&&!isBullish;
return{reclaim:bullReclaim||bearReclaim,type:bullReclaim?'bullish':'bearish',vwap:+vwap.toFixed(4)};
}catch(e){return{reclaim:false,vwap:null};}
}
function scoreSignal(coin,ta,mtf,klines,forceDir){
const d=mktData[coin];if(!d)return 0;
var breakdown = {};
var s=0;
var sym=(COINS[coin]||{}).sym||coin+'USDT';
var liqEvents=bybitLiqQueue.filter(function(ev){
return ev.symbol===sym && ev.timestamp>Date.now()-14400000;
});
var liqPts = liqEvents.length>=10?3:liqEvents.length>=5?2:liqEvents.length>=2?1:0;
s+=liqPts; breakdown.liq=liqPts;
var cvd=window._lastCvdData;
var cvdPts=0;
var signalDir = ta.trend==='bullish'||ta.trend==='mild-bullish' ? 'long' : 'short';
if(cvd){
var buyPct = parseFloat(cvd.buyPct) || 50;
var sellPct = parseFloat(cvd.sellPct) || 50;
var priceBullish = ta.trend==='bullish'||ta.trend==='mild-bullish';
var priceBearish = ta.trend==='bearish'||ta.trend==='mild-bearish';
var strongBearishDiv = priceBullish && sellPct >= 53;
var strongBullishDiv = priceBearish && buyPct >= 53;
if(strongBearishDiv){ cvdPts=3; signalDir='short'; }
else if(strongBullishDiv){ cvdPts=3; signalDir='long'; }
else if(cvd.divergence){ cvdPts=2; }
else if(cvd.trend==='bullish'&&priceBullish){ cvdPts=1; signalDir='long'; }
else if(cvd.trend==='bearish'&&priceBearish){ cvdPts=1; signalDir='short'; }
}
s+=cvdPts; breakdown.cvd=cvdPts;
if(forceDir) signalDir = forceDir;
window._lastSignalDir = signalDir;
var mtfPts=0;
if(mtf){
mtfPts=mtf.confluenceScore||0;
if(mtf.positionSizeMultiplier<0.5)s=Math.max(0,s-3);
else if(mtf.positionSizeMultiplier<1)s=Math.max(0,s-1);
}
s+=mtfPts; breakdown.mtf=mtfPts;
var volPts = ta.volumeSpike>=2.8?2:ta.volumeSpike>=1.8?1:0;
s+=volPts; breakdown.vol=volPts;
var takerPts=0;
if(ta.takerBuyPct){
if(ta.takerBuyPct>62)takerPts=1;
else if(ta.takerBuyPct<38)takerPts=1;
}
s+=takerPts; breakdown.taker=takerPts;
var utcHour=new Date().getUTCHours();
var sessionPts=0;
var inLondon=utcHour>=8&&utcHour<16;
var inNY=utcHour>=13&&utcHour<21;
var inAsia=utcHour>=0&&utcHour<8;
if(inLondon&&inNY)sessionPts=2;
else if(inLondon||inNY)sessionPts=1;
else if(inAsia&&ta.volumeSpike<1.5)sessionPts=-1;
s+=sessionPts; breakdown.session=sessionPts;
var rsiPts=ta.rsi<30||ta.rsi>70?1:0;
s+=rsiPts; breakdown.rsi=rsiPts;
var ob=window._lastOB;
var obPts=0;
if(ob&&Math.abs(ob.imbalance)>20)obPts=1;
s+=obPts; breakdown.ob=obPts;
var confirmedKlines = klines ? getConfirmedKlines(klines, activeTF) : klines;
var candleConfirmed = klines ? isCandleConfirmed(klines, activeTF) : true;
window._lastCandleConfirmed = candleConfirmed;
var pocPts=0;
if(ta.poc&&d.price){
var pocDist=Math.abs(d.price-ta.poc)/d.price*100;
if(pocDist<=0.3)pocPts=1;
}
breakdown.poc=pocPts;
var bbPts=0;
if(confirmedKlines&&confirmedKlines.length>=22){
var bbResult=calcBBSqueeze(confirmedKlines,ta.trend);
if(bbResult.squeeze&&bbResult.breakoutAligned)bbPts=1;
window._lastBBResult=bbResult;
}
breakdown.bb=bbPts;
var rsiDivPts=0;
if(confirmedKlines&&confirmedKlines.length>=20){
var rsiDivResult=calcRSIDivergence(confirmedKlines);
if(rsiDivResult.divergence)rsiDivPts=1;
window._lastRSIDiv=rsiDivResult;
}
breakdown.rsiDiv=rsiDivPts;
var bosPts=0;
if(confirmedKlines&&confirmedKlines.length>=20){
var bosResult=calcBOS(confirmedKlines,ta.trend);
if(bosResult.bos)bosPts=1;
window._lastBOS=bosResult;
}
breakdown.bos=bosPts;
var vwapPts=0;
if(confirmedKlines&&confirmedKlines.length>=10){
var vwapResult=calcVWAPReclaim(confirmedKlines,ta.trend);
if(vwapResult.reclaim)vwapPts=1;
window._lastVWAP=vwapResult;
}
breakdown.vwap=vwapPts;
var oiDeltaPts = 0;
var sigIsLong = signalDir === 'long';
var sigIsShort = signalDir === 'short';
if (confirmedKlines) {
var _oiHist = window._lastOIHistory;
var _oidResult = calcOIDelta(_oiHist, ta.trend);
window._lastOIDelta = _oidResult;
if ((_oidResult.bullishConfirm && sigIsLong) || (_oidResult.bearishConfirm && sigIsShort)) oiDeltaPts = 1;
}
breakdown.oiDelta = oiDeltaPts;
var fundingDeltaPts = 0;
var _fd = window._lastFundingDelta;
if (_fd) {
var sigIsLong7 = sigIsLong;
var sigIsShort7 = sigIsShort;
var extremeOpposite = _fd.extreme && (
(sigIsLong7 && _fd.direction === 'bearish') ||
(sigIsShort7 && _fd.direction === 'bullish')
);
if (!extremeOpposite) {
if (_fd.flipping && _fd.direction === 'bullish' && sigIsLong7) fundingDeltaPts = 1;
if (_fd.flipping && _fd.direction === 'bearish' && sigIsShort7) fundingDeltaPts = 1;
if (_fd.accelerating && _fd.direction === 'bullish' && sigIsLong7) fundingDeltaPts = 1;
if (_fd.accelerating && _fd.direction === 'bearish' && sigIsShort7) fundingDeltaPts = 1;
}
}
breakdown.fundingDelta = fundingDeltaPts;
var bonusRaw = pocPts+bbPts+rsiDivPts+bosPts+vwapPts+oiDeltaPts+fundingDeltaPts;
var bonusCapped = Math.min(bonusRaw, 3);
s += bonusCapped; breakdown.bonusTotal = bonusRaw; breakdown.bonusCapped = bonusCapped;
var oiM=sym?calcOIMomentum(sym):null;
if(oiM&&oiM.spike){ s=Math.max(0,s-1); breakdown.oiPenalty=-1; }
window._lastBonusCount=[pocPts,bbPts,rsiDivPts,bosPts,vwapPts,oiDeltaPts,fundingDeltaPts].filter(function(x){return x>0;}).length;
var final=Math.min(10,Math.max(0,Math.round(s)));
window._lastScoreBreakdown=breakdown;
return final;
}
function verdictOf(sc, ta, cvd){
var sigDir = window._lastSignalDir || (ta && (ta.trend==='bullish'||ta.trend==='mild-bullish') ? 'long' : 'short');
var isLong = sigDir === 'long';
var cvdTrend = cvd ? cvd.trend : null;
var trendDir = ta && (ta.trend==='bullish'||ta.trend==='mild-bullish') ? 'long' : 'short';
var isCounterTrend = sigDir !== trendDir;
var bonusCount = window._lastBonusCount || 0;
var isPrime = sc >= 8 && bonusCount >= 4;
if(isPrime){
if(isLong) return{text:'🔥 Prime long',cls:'cbp'};
return{text:'🔥 Prime short',cls:'cbp'};
}
if(sc>=7){
if(isLong) return isCounterTrend
? {text:'⚠ Counter Long', cls:'cbw'}
: {text:'⚡ Long setup', cls:'cbl'};
return isCounterTrend
? {text:'⚠ Counter Short', cls:'cbw'}
: {text:'⚡ Short setup', cls:'cbs'};
}
if(sc>=5){
if(isLong) return isCounterTrend
? {text:'👁 Watch Short (div)', cls:'cbw'}
: {text:'👁 Watch Long', cls:'cbw'};
return isCounterTrend
? {text:'👁 Watch Long (div)', cls:'cbw'}
: {text:'👁 Watch Short', cls:'cbw'};
}
return{text:'Neutral', cls:'cbn'};
}
async function setLev(lev,btn){
activeLev=lev;
aiCache={};
document.querySelectorAll('.lev-btn').forEach(b=>b.classList.remove('active'));
if(btn)btn.classList.add('active');
const klines=klCache[activeCoin+'_'+activeTF]||[];
if(klines.length&&mktData[activeCoin]?.price){
let mtf=null;
try{const mk=await fetchMTFKlines(activeCoin);mtf=calcMTFAnalysis(mk);}catch(e){}
await renderDetail(activeCoin,klines,mtf);
}
}
function calcLeverage(entry,stop,price,lev,isLong){
const stopDist=Math.abs(entry-stop)/entry*100;
const imr = 1 / lev;
const mmr = lev >= 100 ? 0.005 : lev >= 50 ? 0.004 : 0.003;
const takerFee = 0.0005;
const liqLong = +(entry * (1 - imr + mmr + takerFee)).toFixed(2);
const liqShort = +(entry * (1 + imr - mmr - takerFee)).toFixed(2);
const liqPrice = isLong ? liqLong : liqShort;
const liqDist = Math.abs(entry - liqPrice) / entry * 100;
const maxStopForLev = liqDist * 0.6;
const positionSizeUSDT = stopDist > 0 ? (1 / stopDist * 100) : 0;
const warningLevel = lev >= 75 ? 'extreme' : lev >= 50 ? 'high' : lev >= 25 ? 'medium' : 'low';
return { stopDist, liqDist, liqPrice, liqLong, liqShort, maxStopPct: maxStopForLev, positionSizeUSDT, warningLevel, imr, mmr };
}
function calcMaxSafeLeverage(entry, stop) {
const stopDist = Math.abs(entry - stop) / entry;
const leverages = [1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125];
let maxSafe = 1;
for (const lev of leverages) {
const mmr = lev >= 100 ? 0.005 : lev >= 25 ? 0.004 : 0.003;
const imr = 1 / lev;
const liqDist = (imr - mmr);
const maxStop = liqDist * 0.6;
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
function buildCVDChart(klines, cvdData) {
const canvas = document.getElementById('cvd-chart');
if (!canvas || !cvdData || cvdData.cvd.length < 2) return;
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;
const wrap = canvas.parentElement;
canvas.width = wrap.clientWidth * dpr;
canvas.height = wrap.clientHeight * dpr;
canvas.style.width = wrap.clientWidth + 'px';
canvas.style.height = wrap.clientHeight + 'px';
ctx.scale(dpr, dpr);
const W = wrap.clientWidth, H = wrap.clientHeight;
const PAD = { t:28, r:72, b:18, l:8 };
const cW = W - PAD.l - PAD.r;
const totalH = H - PAD.t - PAD.b;
const cvdH = totalH * 0.52, gapH = totalH * 0.06, barH = totalH * 0.42;
const cvdTop = PAD.t, barTop = PAD.t + cvdH + gapH;
const deltas = cvdData.deltas.slice(-60);
const cvdVals = cvdData.cvd.slice(-60);
const n = Math.max(deltas.length, 1);
ctx.fillStyle = '#181818';
ctx.fillRect(0, 0, W, H);
const isLive = cvdData.source === 'live';
const srcLabel = isLive
? (cvdData.timeSpanMin > 0 ? `LIVE ${cvdData.tradeCount} trades ${cvdData.timeSpanMin}min` : `LIVE ${cvdData.tradeCount} trades`)
: 'ESTIMATED (kline)';
ctx.font = 'bold 8px DM Mono, monospace';
ctx.textAlign = 'left';
ctx.fillStyle = isLive ? '#00d084' : '#888';
ctx.fillText(srcLabel, PAD.l, 10);
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
ctx.strokeStyle = 'rgba(255,255,255,0.06)';
ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(PAD.l, barTop-gapH/2); ctx.lineTo(W-PAD.r, barTop-gapH/2); ctx.stroke();
ctx.fillStyle = '#444';
ctx.font = 'bold 7px DM Mono, monospace';
ctx.textAlign = 'left';
ctx.fillText('CVD', PAD.l, cvdTop - 4);
ctx.fillText('DELTA', PAD.l, barTop - 3);
ctx.strokeStyle = 'rgba(255,255,255,0.04)';
for (let i=0; i<=3; i++) {
const y = cvdTop + (i/3)*cvdH;
ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W-PAD.r, y); ctx.stroke();
}
const xScale = i => PAD.l + (i / Math.max(n-1, 1)) * cW;
const barW = Math.max(2, (cW/n) * 0.72);
const maxD = Math.max(...deltas.map(Math.abs)) || 1;
const zeroY = barTop + barH/2;
ctx.strokeStyle = 'rgba(255,255,255,0.1)';
ctx.lineWidth = 1; ctx.setLineDash([3,4]);
ctx.beginPath(); ctx.moveTo(PAD.l, zeroY); ctx.lineTo(W-PAD.r, zeroY); ctx.stroke();
ctx.setLineDash([]);
deltas.forEach((d, i) => {
const x = xScale(i);
const bh = Math.abs(d) / maxD * (barH/2);
ctx.fillStyle = d >= 0 ? 'rgba(0,208,132,0.8)' : 'rgba(255,77,77,0.8)';
ctx.fillRect(x - barW/2, d >= 0 ? zeroY-bh : zeroY, barW, bh || 1);
});
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
const fmt = v => { const a=Math.abs(v); return a>=1e9?(v/1e9).toFixed(1)+'B':a>=1e6?(v/1e6).toFixed(1)+'M':a>=1e3?(v/1e3).toFixed(1)+'K':v.toFixed(0); };
ctx.font = '9px DM Mono, monospace'; ctx.textAlign = 'left';
ctx.fillStyle = lineCol;
ctx.fillText(fmt(cvdVals[n-1]), W-PAD.r+4, cvdY(cvdVals[n-1])+3);
ctx.fillStyle = '#555';
ctx.fillText(fmt(maxC), W-PAD.r+4, cvdTop+9);
ctx.fillText(fmt(minC), W-PAD.r+4, cvdTop+cvdH-2);
if (cvdData.divergence) {
const divCol = cvdData.divergence.type==='bearish'?'#ff4d4d':'#00d084';
ctx.font = 'bold 9px DM Mono, monospace'; ctx.textAlign = 'right';
ctx.fillStyle = divCol;
ctx.fillText(cvdData.divergence.label, W-PAD.r-6, cvdTop+14);
}
}
function buildLevCard(price, setup, lev, dec) {
const longLev = calcLeverage(setup.lE, setup.lSL, price, lev, true);
const shortLev = calcLeverage(setup.sE, setup.sSL, price, lev, false);
const longSuit = getLeverageSuitability(setup.lE, setup.lSL, lev);
const shortSuit = getLeverageSuitability(setup.sE, setup.sSL, lev);
setup.lLiq = longLev.liqPrice;
setup.sLiq = shortLev.liqPrice;
setup.longMaxSafeLev = longSuit.maxSafe;
setup.shortMaxSafeLev = shortSuit.maxSafe;
const grid = document.getElementById('lev-grid');
const warn = document.getElementById('lev-warning-text');
const badge = document.getElementById('lev-warning-badge');
const title = document.getElementById('lev-suit-title');
if (!grid) return;
if (badge) {
badge.textContent = `${longSuit.emoji} ${longSuit.rating} for ${lev}x`;
badge.style.background = longSuit.isOk ? 'rgba(245,166,35,.15)' : 'rgba(255,77,77,.25)';
badge.style.color = longSuit.color;
}
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
if(IS_MOBILE){
var dateRange = tf==='15m'?'1D':tf==='1h'?'5D':tf==='4h'?'1M':'3M';
var s=document.createElement('script');
s.src='https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js';
s.async=true;
s.innerHTML=JSON.stringify({
symbol: COINS[coin].tv,
width: '100%',
height: 220,
locale: 'en',
dateRange: dateRange,
colorTheme: 'dark',
trendLineColor: 'rgba(41,98,255,1)',
underLineColor: 'rgba(41,98,255,0.15)',
underLineBottomColor: 'rgba(41,98,255,0)',
isTransparent: true,
autosize: false,
largeChartUrl: 'https://www.tradingview.com/chart/?symbol='+COINS[coin].tv
});
c.appendChild(s);
return;
}
const sDesktop=document.createElement('script');
sDesktop.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
sDesktop.async=true;
sDesktop.innerHTML=JSON.stringify({autosize:true,symbol:COINS[coin].tv,interval:TF_TV[tf],timezone:'Etc/UTC',theme:'dark',style:'1',locale:'en',enable_publishing:false,backgroundColor:'rgba(17,17,17,1)',gridColor:'rgba(255,255,255,0.04)',hide_top_toolbar:false,hide_legend:false,save_image:false,hide_volume:false,support_host:'https://www.tradingview.com'});
c.appendChild(sDesktop);
}
async function fetchAI(coin,ta,sc,setup,klines,mtfData,liqZones,cvdData){
const key=coin+'_'+activeTF+'_'+entryMode;
if(aiCache[key])return aiCache[key];
const d=mktData[coin];
const dec=COINS[coin].dec;
const bd=window._lastScoreBreakdown||{};
const sum=window._lastSummaryData||{};
try{
const safeStringify = (obj) => JSON.stringify(obj, (k,v) => {
if(v !== v) return null;
if(v === undefined) return null;
if(typeof v === 'number' && !isFinite(v)) return null;
return v;
});
const res=await fetch('/api/analyze',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:safeStringify({
coin, tf:activeTF, price:d.price, change24h:d.change24h,
high24h:d.high24h, low24h:d.low24h, volume24h:d.volume24h,
rsi:ta.rsi.toFixed(1), trend:ta.trend,
funding:d.funding.toFixed(4), fgValue:d.fgValue,
atr:ta.atr.toFixed(dec>2?2:dec),
oi:(d.oiNotional/1e9).toFixed(2),
support:ta.support, resistance:ta.resistance,
poc:ta.poc, ema20:ta.ema20,
optimalLongEntry:setup.lE, optimalShortEntry:setup.sE,
entryMode, mode:activeMode,
leverage: activeLev,
liqLong: setup.liqLong || +(setup.lE*(1 - 1/activeLev + (activeLev>=100?0.005:0.004) + 0.0005)).toFixed(dec),
liqShort: setup.liqShort || +(setup.sE*(1 + 1/activeLev - (activeLev>=100?0.005:0.004) - 0.0005)).toFixed(dec),
maxSafeStopPct: setup.maxStopPct || +((1/activeLev - (activeLev>=100?0.005:0.004))*0.6*100).toFixed(3),
longStopPct: setup.atrStopLongPct||setup.lRisk,
shortStopPct: setup.atrStopShortPct||setup.sRisk,
signalDir: window._lastSignalDir||'neutral',
score: sc,
scoreLong: window._scLong,
scoreShort: window._scShort,
scoreBreakdown: {
liq:bd.liq||0, cvd:bd.cvd||0, mtf:bd.mtf||0,
vol:bd.vol||0, taker:bd.taker||0, session:bd.session||0,
rsi:bd.rsi||0, ob:bd.ob||0,
bonusRaw:bd.bonusTotal||0, bonusCapped:bd.bonusCapped||0
},
bonusCount: window._lastBonusCount||0,
bonusSignals: {
bbSqueeze: !!(window._lastBBResult?.squeeze&&window._lastBBResult?.breakoutAligned),
vwapReclaim:!!(window._lastVWAP?.reclaim),
bos: !!(window._lastBOS?.bos),
bosType: window._lastBOS?.type||null,
rsiDiv: !!(window._lastRSIDiv?.divergence),
rsiDivLabel:window._lastRSIDiv?.label||null,
poc: (bd.poc||0)>0,
oiDelta: !!(window._lastOIDelta?.aligned),
fundingFlip:!!(window._lastFundingDelta?.flipping||window._lastFundingDelta?.accelerating)
},
oiDelta: window._lastOIDelta||null,
fundingDelta: window._lastFundingDelta||null,
oiMomentum: {
trend:(window._oiMomCache||{}).trend||'unknown',
changePct:(window._oiMomCache||{}).changePct||0,
spike:(window._oiMomCache||{}).spike||false
},
summaryCard: {
status: sum.action||'Unknown',
direction: sum.dirLabel||'NEUTRAL',
working: sum.working||[],
missing: sum.missing||[],
waitLevel: sum.waitLevel||null,
atKeyLevel: sum.atKeyLevel||null
},
liqZones: liqZones ? (() => {
try {
const lse = liqZones.longSweepEntry||{};
const sse = liqZones.shortSweepEntry||{};
return {
fundingBias: liqZones.fundingBias||'neutral',
majorLongCluster: liqZones.majorLongCluster?.priceRange||'',
majorShortCluster: liqZones.majorShortCluster?.priceRange||'',
nearestLongSweep: liqZones.nearestLongSweep?.price||null,
nearestShortSweep: liqZones.nearestShortSweep?.price||null,
topLongLiq: (liqZones.topLongLiq||[]).map(z=>+(z.price||0)).join(', '),
topShortLiq: (liqZones.topShortLiq||[]).map(z=>+(z.price||0)).join(', '),
longSweepEntry: { entry:lse.entry||null, stop:lse.stop||null, tp1:lse.tp1||null, tp2:lse.tp2||null, logic:lse.logic||'' },
shortSweepEntry: { entry:sse.entry||null, stop:sse.stop||null, tp1:sse.tp1||null, tp2:sse.tp2||null, logic:sse.logic||'' }
};
} catch(e) { return null; }
})() : null,
mtfSummary: mtfData ? {
confluenceLabel:mtfData.confluenceLabel,
confluenceScore:mtfData.confluenceScore,
filterStatus:mtfData.filterStatus,
filterMsg:mtfData.filterMsg,
positionSizeMultiplier:mtfData.positionSizeMultiplier,
trendByTF:mtfData.trendSummary,
labels:mtfData.stack.labels
} : null,
cvdSummary: cvdData ? {
trend:cvdData.trend,
divergence:cvdData.divergence?cvdData.divergence.label:null,
divergenceDesc:cvdData.divergence?cvdData.divergence.desc:null,
divergenceType:cvdData.divergence?cvdData.divergence.type:null,
cvdDirection:cvdData.cvdChange>0?'rising':'falling',
recentBias:cvdData.cvdChange>0?'net buying pressure':'net selling pressure'
} : null,
candles:klines.slice(-50).map(k=>({
o:+k.o.toFixed(dec),h:+k.h.toFixed(dec),
l:+k.l.toFixed(dec),c:+k.c.toFixed(dec),v:Math.round(k.v)
}))
})
});
if(!res.ok)throw new Error('API '+res.status);
const json=await res.json();
if(json.error)throw new Error(json.error);
aiCache[key]=json;return json;
}catch(e){console.error('AI:',e);return null;}
}
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
aiCache = {};
klCache = {};
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
let bullCount = 0, bearCount = 0, neutralCount = 0;
const trendSummary = {};
stack.tfs.forEach(tf => {
const t = analyses[tf].trend;
trendSummary[tf] = t;
if (t === 'bullish' || t === 'mild-bullish') bullCount++;
else if (t === 'bearish' || t === 'mild-bearish') bearCount++;
else neutralCount++;
});
const filterTF = stack.tfs[0];
const filterTA = analyses[filterTF];
const filterBull = filterTA.trend === 'bullish' || filterTA.trend === 'mild-bullish';
const filterBear = filterTA.trend === 'bearish' || filterTA.trend === 'mild-bearish';
const total = stack.tfs.length;
let confluenceScore, confluenceLabel, confluenceClass;
const maxAgree = Math.max(bullCount, bearCount);
if (maxAgree === total) { confluenceScore = 3; confluenceLabel = `Strong ${bullCount > bearCount ? 'Bull' : 'Bear'} (${total}/${total})`; confluenceClass = bullCount > bearCount ? 'mtf-strong' : 'mtf-weak'; }
else if (maxAgree >= total - 1) { confluenceScore = 2; confluenceLabel = `Good ${bullCount > bearCount ? 'Bull' : 'Bear'} (${maxAgree}/${total})`; confluenceClass = bullCount > bearCount ? 'mtf-good' : 'mtf-mixed'; }
else if (maxAgree >= Math.ceil(total / 2)) { confluenceScore = 1; confluenceLabel = `Partial (${maxAgree}/${total})`; confluenceClass = 'mtf-mixed'; }
else { confluenceScore = -1; confluenceLabel = `Conflicted (${maxAgree}/${total})`; confluenceClass = 'mtf-weak'; }
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
renderSessionPnl();
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
el.innerHTML='<div class="alerts-bar"><span class="alert-lbl">High conviction</span>'+fired.map(function(e){return '<span class="alert-item">'+e[0]+' — '+e[1]+'/10 Long setup</span>';}).join('')+'</div>';
}
function renderSummaryCard(sc, ta, d, dec, isPrime, signalDir, scLong, scShort, setup, lockedSig) {
var bd = window._lastScoreBreakdown || {};
var isLong = signalDir === 'long';
var fn2 = function(n){ return n?Number(n).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec}):'—'; };
var levels = [
{label:'support', val:ta.support},
{label:'resistance', val:ta.resistance},
{label:'POC', val:ta.poc},
{label:'EMA 20', val:ta.ema20},
].filter(function(l){return l.val>0;});
var atKeyLevel = null;
var waitLevel = null;
levels.forEach(function(lv){
if(Math.abs(d.price-lv.val)/d.price*100 <= 0.5 && !atKeyLevel) atKeyLevel = lv;
});
if(!atKeyLevel){
var candidates = isLong
? levels.filter(function(l){return l.val<d.price;}).sort(function(a,b){return b.val-a.val;})
: levels.filter(function(l){return l.val>d.price;}).sort(function(a,b){return a.val-b.val;});
waitLevel = candidates[0] || null;
}
var bos=window._lastBOS||{}, vw=window._lastVWAP||{}, oid=window._lastOIDelta||{};
var fd=window._lastFundingDelta||{}, rd=window._lastRSIDiv||{}, bb=window._lastBBResult||{};
var working=[];
if((bd.cvd||0)>=2) working.push('Order flow confirms direction');
if((bd.mtf||0)>=2) working.push('Higher timeframes aligned');
if((bd.liq||0)>=2) working.push('Near liquidation cluster');
if((bd.vol||0)>=2) working.push('Strong volume spike');
if(bos.bos) working.push('Price broke key structure');
if(vw.reclaim) working.push('VWAP reclaimed');
if(oid.aligned) working.push('New money entering market');
if(fd.flipping||fd.accelerating) working.push('Funding momentum aligned');
if(rd.divergence) working.push('RSI divergence present');
if(bb.squeeze&&bb.breakoutAligned) working.push('Squeeze breakout aligned');
if(atKeyLevel) working.push('At key level — $'+fn2(atKeyLevel.val)+' ('+atKeyLevel.label+')');
var missing=[];
if(!atKeyLevel) missing.push('Price not at ideal entry yet');
if((bd.cvd||0)<1) missing.push('Order flow not confirming');
if(!bos.bos) missing.push('No structure break yet');
if((bd.vol||0)<1) missing.push('Volume not confirmed');
if((bd.mtf||0)<1) missing.push('Higher timeframes conflicted');
var action, actionCol, actionBg;
if(sc>=8&&isPrime&&atKeyLevel){
action='🔥 Prime entry — all conditions met';
actionCol='#a78bfa'; actionBg='rgba(167,139,250,0.10)';
} else if(sc>=7&&atKeyLevel){
action='⚡ Enter on next closed candle';
actionCol='var(--green)'; actionBg='rgba(0,208,132,0.07)';
} else if(sc>=7&&waitLevel){
var _aiE=window._lastAISetup?(isLong?window._lastAISetup.longEntry:window._lastAISetup.shortEntry):null;
var _wv=_aiE?fn2(_aiE):fn2(waitLevel.val);
var _wl=_aiE?'AI pattern entry':waitLevel.label;
action='👁 Good setup — wait for $'+_wv+' ('+_wl+')';
actionCol='var(--amber)'; actionBg='rgba(245,166,35,0.07)';
} else if(sc>=5&&waitLevel){
action='⌛ Setup forming — watch $'+fn2(waitLevel.val)+' ('+waitLevel.label+')';
actionCol='var(--amber)'; actionBg='rgba(245,166,35,0.05)';
} else if(sc>=5){
action='⌛ Setup forming — no clean entry yet';
actionCol='var(--amber)'; actionBg='rgba(245,166,35,0.05)';
} else {
action='❌ No setup — stay out';
actionCol='var(--red)'; actionBg='rgba(255,77,77,0.05)';
}
var dirLabel = sc<5?'NEUTRAL':isLong?'LONG':'SHORT';
var dirCol = sc<5?'var(--text3)':isLong?'var(--green)':'var(--red)';
var bothScores = (scLong!==undefined&&scShort!==undefined)
? ' <span style="font-size:10px;color:var(--text3);font-family:var(--mono);font-weight:400">(L:'+scLong+' S:'+scShort+')</span>'
: '';
window._lastSummaryData = {
action, dirLabel, signalDir,
working: working.slice(0,4),
missing: missing.slice(0,3),
waitLevel: waitLevel ? {label: waitLevel.label, val: waitLevel.val} : null,
atKeyLevel: atKeyLevel ? {label: atKeyLevel.label, val: atKeyLevel.val} : null
};
return '<div class="card full" style="background:'+actionBg+';border-left:3px solid '+actionCol+';margin-bottom:4px">'
+'<div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">'
+'<div><div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);margin-bottom:3px">Trade summary</div>'
+'<div style="font-size:15px;font-weight:700;color:'+dirCol+';font-family:var(--mono)">'+dirLabel+' <span style="color:var(--text2);font-weight:400;font-size:12px">'+sc+'/10</span>'+bothScores+'</div></div>'
+'<div style="font-size:11px;font-family:var(--mono);color:'+actionCol+';text-align:right;max-width:58%;line-height:1.5">'+action+'</div>'
+'</div>'
+'<div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 20px">'
+(function(){
var rows='';
var w=working.slice(0,4), m=missing.slice(0,3);
var total=Math.max(w.length,m.length);
for(var i=0;i<total;i++){
rows+=w[i]?'<div style="font-size:10px;color:var(--green);font-family:var(--mono);padding:1px 0">✅ '+w[i]+'</div>':'<div></div>';
rows+=m[i]?'<div style="font-size:10px;color:var(--text3);font-family:var(--mono);padding:1px 0">❌ '+m[i]+'</div>':'<div></div>';
}
return rows;
})()
+'</div>'
+(function(){
if(!setup||sc<5) return '';
var ls = lockedSig ? lockedSig.lockedSetup : null;
var ais = window._lastAISetup || null;
var _sum = window._lastSummaryData || {};
var wv = (_sum && _sum.waitLevel) ? _sum.waitLevel.val : null;
var e = isLong
? (ais && ais.longEntry ? ais.longEntry : wv ? wv : ls ? ls.entry : setup.lE)
: (ais && ais.shortEntry ? ais.shortEntry : wv ? wv : ls ? ls.shortEntry||setup.sE : setup.sE);
var maxSD = setup.maxStopPct ? setup.maxStopPct/100 : 0.0096;
var sl = isLong
? (ais && ais.longStop ? ais.longStop : +(e*(1-maxSD)).toFixed(dec))
: (ais && ais.shortStop ? ais.shortStop : +(e*(1+maxSD)).toFixed(dec));
var t1 = isLong
? (ais && ais.longTP1 ? ais.longTP1 : setup.lTP1||null)
: (ais && ais.shortTP1 ? ais.shortTP1 : setup.sTP1||null);
var t2 = isLong
? (ais && ais.longTP2 ? ais.longTP2 : setup.lTP2||null)
: (ais && ais.shortTP2 ? ais.shortTP2 : setup.sTP2||null);
var t3 = isLong ? (setup.lTP3||null) : (setup.sTP3||null);
var rr = (e&&sl&&t1) ? (Math.abs(t1-e)/Math.abs(e-sl)).toFixed(1)+'R' : '—';
var px = function(n){ return n?'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec}):'—'; };
return '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);display:flex;gap:20px;flex-wrap:wrap">'
+'<div style="font-size:10px;font-family:var(--mono)"><span style="color:var(--text3)">Entry </span><span style="color:var(--text1);font-weight:600">'+px(e)+'</span></div>'
+'<div style="font-size:10px;font-family:var(--mono)"><span style="color:var(--text3)">Stop </span><span style="color:var(--red);font-weight:600">'+px(sl)+'</span></div>'
+'<div style="font-size:10px;font-family:var(--mono)"><span style="color:var(--text3)">TP1 </span><span style="color:var(--green);font-weight:600">'+px(t1)+'</span></div>'
+(t2?'<div style="font-size:10px;font-family:var(--mono)"><span style="color:var(--text3)">TP2 </span><span style="color:var(--green);font-weight:600">'+px(t2)+'</span></div>':'')
+(t3?'<div style="font-size:10px;font-family:var(--mono)"><span style="color:var(--text3)">TP3 </span><span style="color:rgba(0,208,132,0.6);font-weight:600">'+px(t3)+'</span></div>':'')
+'<div style="font-size:10px;font-family:var(--mono)"><span style="color:var(--text3)">R:R </span><span style="color:var(--text2)">'+rr+'</span></div>'
+'</div>';
})()
+'</div>';
}
function renderBonusRow(ta, dec, klines){
var bb = window._lastBBResult || {};
var bos = window._lastBOS || {};
var vw = window._lastVWAP || {};
var rd = window._lastRSIDiv || {};
var bd = window._lastScoreBreakdown || {};
var oid = window._lastOIDelta || {};
var _fd2= window._lastFundingDelta || {};
var bonuses = [
{ label:'BB squeeze',
on: !!(bb.squeeze && bb.breakoutAligned),
sub: bb.squeeze ? (bb.breakoutAligned ? 'Breakout aligned' : 'Squeeze, no breakout yet') : 'No squeeze',
detail: bb.bandwidth ? 'BW '+bb.bandwidth.toFixed(4) : '' },
{ label:'VWAP reclaim',
on: !!vw.reclaim,
sub: vw.reclaim ? 'Reclaimed ('+vw.type+')' : (vw.vwap ? 'VWAP $'+fn(vw.vwap,dec) : 'No data'),
detail: '' },
{ label:'Struct break',
on: !!bos.bos,
sub: bos.bos ? 'BOS '+bos.type+' @ $'+fn(bos.level,dec) : 'No break yet',
detail: bos.swingHigh ? 'H:$'+fn(bos.swingHigh,dec)+' L:$'+fn(bos.swingLow,dec) : '' },
{ label:'RSI divergence',
on: !!rd.divergence,
sub: rd.divergence ? rd.label : 'No divergence',
detail: rd.divergence ? rd.desc : '' },
{ label:'POC proximity',
on: (bd.poc||0)>0,
sub: (bd.poc||0)>0 ? 'At POC $'+fn(ta.poc,dec) : 'Away from POC',
detail: ta.poc ? '$'+fn(ta.poc,dec) : '' },
{ label:'OI expanding',
on: !!(oid.aligned),
sub: oid.bullishConfirm ? 'New longs entering — bull confirmed'
: oid.bearishConfirm ? 'New shorts entering — bear confirmed'
: oid.expanding ? 'Expanding (direction unclear)'
: oid.changePct < 0 ? 'OI contracting' : 'OI flat',
detail: oid.changePct !== undefined ? (oid.changePct >= 0 ? '+' : '')+oid.changePct+'% over 5 periods' : '' },
{ label:'Funding flip',
on: !!(_fd2.flipping || _fd2.accelerating),
sub: _fd2.flipping ? (_fd2.direction==='bullish' ? 'Flipped bullish ⚡' : 'Flipped bearish ⚡')
: _fd2.accelerating ? (_fd2.direction==='bullish' ? 'Accelerating bullish' : 'Accelerating bearish')
: (_fd2.direction==='bullish' ? 'Positive — stable' : _fd2.direction==='bearish' ? 'Negative — stable' : 'Neutral'),
detail: _fd2.latest !== undefined ? 'Latest: '+(_fd2.latest >= 0 ? '+' : '')+(_fd2.latest*1).toFixed(4)+'%' : '' }
];
var active = bonuses.filter(function(b){return b.on;}).length;
var hdrCol = active>=4?'var(--purple)':active>=1?'var(--green)':'var(--text3)';
var items = bonuses.map(function(b){
var col = b.on ? 'var(--green)' : 'var(--text3)';
var dot = b.on ? '\u25cf' : '\u25cb';
return '<div style="padding:6px 0;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:8px">'
+'<span style="color:'+col+';font-size:12px;flex-shrink:0;margin-top:1px">'+dot+'</span>'
+'<div style="flex:1;min-width:0">'
+'<div style="font-size:11px;font-family:var(--mono);color:'+col+';font-weight:'+(b.on?600:400)+'">'+b.label+'</div>'
+'<div style="font-size:10px;color:var(--text3);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+b.sub+'</div>'
+(b.detail&&!b.on ? '<div style="font-size:9px;color:rgba(255,255,255,.25);font-family:var(--mono)">'+b.detail+'</div>' : '')
+(b.detail&&b.on ? '<div style="font-size:9px;color:rgba(0,208,132,.5);font-family:var(--mono)">'+b.detail+'</div>' : '')
+'</div>'
+'</div>';
}).join('');
var confirmed = window._lastCandleConfirmed !== false;
var progress = klines ? candleProgress(klines, activeTF) : 100;
var candleNote = !confirmed
? '<span style="background:rgba(245,166,35,0.15);color:var(--amber);border:1px solid rgba(245,166,35,0.35);border-radius:3px;padding:1px 7px;font-size:9px">'
+'⚠ Candle forming — '+progress+'% complete — signals update on close</span>'
: '<span style="font-size:9px;color:var(--text3);font-family:var(--mono)">✓ Closed candle</span>';
return '<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border)">'
+'<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:'+hdrCol+';font-family:var(--mono);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
+'<span>Bonus confluence — '+active+'/7 active</span>'
+candleNote
+(active>=4 ? '<span style="background:rgba(167,139,250,0.15);color:#a78bfa;border:1px solid rgba(167,139,250,0.35);border-radius:3px;padding:1px 7px;font-size:9px">🔥 Prime threshold met</span>' : '')
+'</div>'
+'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0 20px">'+items+'</div>'
+'</div>';
}
async function renderDetail(coin,klines,mtfData){
const d=mktData[coin];
const dec=COINS[coin].dec;
const ta=calcTA(klines);
const cvdData = IS_MOBILE ? {trend:'neutral',buyPct:50,sellPct:50,source:'est'} : await fetchCVDData(coin,activeTF);
const bybitSym = COINS[coin].sym;
const fundingHist = IS_MOBILE ? [] : await fetchFundingHistory(bybitSym);
const fundingMom = calcFundingMomentum(fundingHist);
window._lastFundingDelta = calcFundingDelta(fundingHist);
const oiHistory = IS_MOBILE ? [] : await fetchOIHistory(bybitSym);
window._lastOIHistory = oiHistory;
window._lastOIDelta = calcOIDelta(oiHistory, ta.trend);
const oiMom = calcOIMomentum(bybitSym);
const scLong = scoreSignal(coin,ta,mtfData,klines,'long');
const scShort = scoreSignal(coin,ta,mtfData,klines,'short');
window._scLong = scLong; window._scShort = scShort;
const primaryDir = scShort > scLong ? 'short' : 'long';
const sc = scoreSignal(coin,ta,mtfData,klines,primaryDir);
window._lastSignalDir = primaryDir;
const isPrime = sc>=8 && (window._lastBonusCount||0)>=4;
liqZones=null;
try{ liqZones=calcLiqZones(d.price,ta.atr||d.price*0.02,d.oi,d.funding,d.oiNotional,klines,dec); }
catch(e){ console.warn('LiqZones failed:',e); }
const v=verdictOf(sc,ta,window._lastCvdData);
const entries=calcEntries(d.price,ta,dec);
const freshSetup=calcSetups(entries,dec,ta,liqZones);
let setup=freshSetup;
let lockedSig=null;
if(activeMode==='swing'){
const pivots=findPivotLevels(klines.slice(-60),3);
lockedSig=checkSignalValidity(coin,activeTF,d.price,sc);
if(lockedSig){
const ls=lockedSig.lockedSetup;
const mmrL = activeLev>=100?0.005:activeLev>=25?0.004:0.003;
const imrL = 1/activeLev;
const feeL = 0.0005;
const maxSD = (imrL-mmrL)*0.6;
const liqLongLive = +(ls.entry*(1-imrL+mmrL+feeL)).toFixed(dec);
const liqShortLive = +((ls.shortEntry||ls.entry)*(1+imrL-mmrL-feeL)).toFixed(dec);
const lSLlive = +(ls.entry*(1-maxSD)).toFixed(dec);
const sSLlive = +((ls.shortEntry||ls.entry)*(1+maxSD)).toFixed(dec);
const liqDistPct = (imrL-mmrL)*100;
const lRisk = maxSD*100;
const sRisk = maxSD*100;
setup={...freshSetup,
lE:ls.entry,
lSL:lSLlive, lRisk,
lTP1:freshSetup.lTP1, lTP2:freshSetup.lTP2, lTP3:freshSetup.lTP3,
sE:ls.shortEntry||freshSetup.sE,
sSL:sSLlive, sRisk,
sTP1:freshSetup.sTP1, sTP2:freshSetup.sTP2, sTP3:freshSetup.sTP3,
liqLong:liqLongLive, liqShort:liqShortLive,
liqDistPct,
levAdjustedLong:true, levAdjustedShort:true,
atrStopLongPct:freshSetup.atrStopLongPct||0,
atrStopShortPct:freshSetup.atrStopShortPct||0,
maxStopPct:maxSD*100
};
} else if(sc>=7){
lockSignal(coin,activeTF,ta,freshSetup,sc,d.price,pivots,liqZones);
lockedSig=swingSignals[coin+'_'+activeTF];
if(lockedSig) lockedSig.lockedSetup.bias = primaryDir;
}
}
const isLocked=!!lockedSig;
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
<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
<div class="score-box">
<div class="score-num" style="color:${scColor}">${sc}<span style="font-size:15px;color:var(--text3)">/10</span></div>
<div class="score-lbl">Signal score</div>
</div>
<button onclick="copySignalSnapshot()" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--text2);font-family:var(--mono);cursor:pointer">📋 Copy snapshot</button>
</div>
</div>
${(function(){
var bd=window._lastScoreBreakdown||{};
var labels={liq:'Liq zones',cvd:'CVD',mtf:'MTF',vol:'Volume',taker:'Taker',session:'Session',rsi:'RSI',ob:'OB',oiPenalty:'OI',poc:'POC',bb:'BB squeeze',rsiDiv:'RSI div',bos:'BOS',vwap:'VWAP'};
var items=Object.keys(bd).filter(function(k){return bd[k]!==0;}).map(function(k){
var pts=bd[k];var col=pts>0?'var(--green)':pts<0?'var(--red)':'var(--text3)';
return '<span style="font-size:9px;font-family:var(--mono);color:'+col+';background:rgba(255,255,255,0.05);padding:2px 5px;border-radius:3px">'+(labels[k]||k)+' '+(pts>0?'+':'')+pts+'</span>';
}).join('');
return items?'<div style="padding:8px 20px;display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--border)">'+items+'</div>':'';
})()}
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
<!-- Phase 3 Layer 3: Liq Heatmap (populated after render via JS) -->
<!-- Risk Calculator -->
<div class="full" id="risk-calc-section">
${renderRiskCalculator(setup, d.price, dec)}
</div>
<!-- Phase 2: sweep opportunity + review banner (pre-computed above) -->
${sweepCardHtml}
${needsReviewHtml}
<!-- Trade Summary Card -->
${renderSummaryCard(sc, ta, d, dec, isPrime, primaryDir, scLong, scShort, setup, lockedSig)}
<!-- Long setup -->
<div class="card" style="${isPrime?'border-left:3px solid #a78bfa':'border-left:3px solid var(--green)'}${isLocked?';border-top:1px solid rgba(245,166,35,0.4)':''}">
${isPrime?'<div style="background:rgba(167,139,250,0.08);border-bottom:1px solid rgba(167,139,250,0.2);margin:-12px -16px 12px;padding:7px 16px;display:flex;align-items:center;gap:8px"><span style="font-size:11px;color:#a78bfa;font-family:var(--mono);font-weight:600">&#x1F525; Prime setup</span><span style="font-size:10px;color:rgba(167,139,250,0.7);font-family:var(--mono)">'+(window._lastBonusCount||0)+'/7 bonuses stacked</span></div>':''}
<div class="card-title" style="${isPrime?'color:#a78bfa':'color:var(--green)'};display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
<span>Long setup ${isLocked?'<span style="font-size:9px;background:rgba(245,166,35,0.15);color:var(--amber);border:1px solid rgba(245,166,35,0.4);border-radius:3px;padding:2px 7px;margin-left:6px;font-family:var(--mono);letter-spacing:.06em">LOCKED</span>':''}
${isLocked&&lockedSig?'<span style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-left:6px">'+lockedSig.dynamic.candlesElapsed+' candle'+(lockedSig.dynamic.candlesElapsed!==1?'s':'')+' ago</span>':''}
</span>
${isLocked?'<button onclick="invalidateSignal(\''+coin+'\',\''+activeTF+'\',\'dismissed\');selectCoin(\''+coin+'\')" style="font-size:9px;background:rgba(255,77,77,0.1);color:var(--red);border:1px solid var(--red-b);border-radius:3px;padding:2px 8px;cursor:pointer;font-family:var(--mono)">✕ Dismiss</button>':''}
</div>
<div class="srow"><span class="skey">${entryMode==='optimal'?'Optimal entry':'Entry (market)'}</span><span class="sval vb" id="l-entry">$${fn(setup.lE,dec)}</span></div>
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
<div class="srow"><span class="skey">Take profit 1</span><span class="sval vg" id="l-tp1">$${fn(setup.lTP1,dec)} <span style="font-size:11px;color:var(--text2)">+${setup.lRew.toFixed(3)}%</span></span></div>
<div class="srow"><span class="skey">Take profit 2</span><span class="sval vg" id="l-tp2">$${fn(setup.lTP2,dec)}</span></div>
${setup.lTP3?`<div class="srow"><span class="skey">TP3 (swing)</span><span class="sval vg" id="l-tp3" style="color:rgba(0,208,132,0.6)">$${fn(setup.lTP3,dec)}</span></div>`:''}
<div class="srow"><span class="skey">R:R ratio</span><span class="sval">${setup.lRR.toFixed(2)}:1 <span class="rrtag ${setup.lRR>=1.5?'rrg':'rrr'}">${setup.lRR>=1.5?'good':'weak'}</span></span></div>
<div class="srow"><span class="skey">ATR volatility</span><span class="sval">${safeFormatATR(ta.atr, d.price)}</span></div>
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
<div class="card" style="${isPrime?'border-left:3px solid #a78bfa':'border-left:3px solid var(--red)'}${isLocked?';border-top:1px solid rgba(245,166,35,0.4)':''}">
${isPrime?'<div style="background:rgba(167,139,250,0.08);border-bottom:1px solid rgba(167,139,250,0.2);margin:-12px -16px 12px;padding:7px 16px;display:flex;align-items:center;gap:8px"><span style="font-size:11px;color:#a78bfa;font-family:var(--mono);font-weight:600">&#x1F525; Prime setup</span><span style="font-size:10px;color:rgba(167,139,250,0.7);font-family:var(--mono)">'+(window._lastBonusCount||0)+'/7 bonuses stacked</span></div>':''}
<div class="card-title" style="${isPrime?'color:#a78bfa':'color:var(--red)'};display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
<span>Short setup ${isLocked?'<span style="font-size:9px;background:rgba(245,166,35,0.15);color:var(--amber);border:1px solid rgba(245,166,35,0.4);border-radius:3px;padding:2px 7px;margin-left:6px;font-family:var(--mono);letter-spacing:.06em">LOCKED</span>':''}
${isLocked&&lockedSig?'<span style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-left:6px">'+lockedSig.dynamic.candlesElapsed+' candle'+(lockedSig.dynamic.candlesElapsed!==1?'s':'')+' ago</span>':''}
</span>
</div>
<div class="srow"><span class="skey">${entryMode==='optimal'?'Optimal entry':'Entry (market)'}</span><span class="sval vb" id="s-entry">$${fn(setup.sE,dec)}</span></div>
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
<div class="srow"><span class="skey">Take profit 1</span><span class="sval vg" id="s-tp1">$${fn(setup.sTP1,dec)} <span style="font-size:11px;color:var(--text2)">-${setup.sRew.toFixed(3)}%</span></span></div>
<div class="srow"><span class="skey">Take profit 2</span><span class="sval vg" id="s-tp2">$${fn(setup.sTP2,dec)}</span></div>
${setup.sTP3?`<div class="srow"><span class="skey">TP3 (swing)</span><span class="sval vg" id="s-tp3" style="color:rgba(0,208,132,0.6)">$${fn(setup.sTP3,dec)}</span></div>`:''}
<div class="srow"><span class="skey">R:R ratio</span><span class="sval">${setup.sRR.toFixed(2)}:1 <span class="rrtag ${setup.sRR>=1.5?'rrg':'rrr'}">${setup.sRR>=1.5?'good':'weak'}</span></span></div>
<div class="srow"><span class="skey">ATR volatility</span><span class="sval">${safeFormatATR(ta.atr, d.price)}</span></div>
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
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:6px 0">
<span style="font-size:12px;color:var(--text3);font-family:var(--mono)">Pattern analysis ready — click to run (uses API credit)</span>
<button id="ai-run-btn" onclick="triggerManualAI()" style="padding:9px 22px;border-radius:7px;border:1px solid var(--purple-b);background:rgba(167,139,250,0.1);color:var(--purple);font-family:var(--mono);font-size:13px;cursor:pointer;font-weight:500;transition:all .15s">Run AI Analysis</button>
</div>
</div>
<!-- Technical indicators -->
<div class="card full">
<div class="card-title">Technical indicators</div>
<div class="metrics-grid">
<div class="metric"><div class="mlbl">RSI 14</div><div class="mval" style="color:${rsiCol}">${ta.rsi.toFixed(1)}</div><div class="msub">${ta.rsi<30?'Oversold':ta.rsi>70?'Overbought':ta.rsi<45?'Neutral low':'Neutral high'}</div></div>
<div class="metric"><div class="mlbl">EMA 20</div><div class="mval">$${fn(ta.ema20,dec>2?2:dec)}</div><div class="msub" style="color:${d.price>ta.ema20?'var(--green)':'var(--red)'}">${d.price>ta.ema20?'Above':'Below'}</div></div>
<div class="metric"><div class="mlbl">ATR 14</div><div class="mval">${safeFormatATR(ta.atr, d.price)}</div><div class="msub">Volatility range</div></div>
<div class="metric"><div class="mlbl">Trend</div><div class="mval" style="color:${tCol};font-size:11px">${tLbl}</div><div class="msub">EMA structure</div></div>
<div class="metric"><div class="mlbl">Fear & Greed</div><div class="mval">${d.fgValue}</div><div class="msub">${d.fgLabel}</div></div>
<div class="metric"><div class="mlbl">Funding rate</div>
<div class="mval" style="color:${fCol}">${d.funding.toFixed(4)}%</div>
<div class="msub" style="color:${fundingMom.momentum==='flipping'?'var(--amber)':fundingMom.momentum.includes('accelerating')?'var(--red)':'var(--text3)'}">
${fundingMom.momentum==='flipping'?'Flipping direction':fundingMom.direction==='rising'?'Rising (longs paying more)':fundingMom.direction==='falling'?'Falling (shorts paying more)':'Stable'} ${fundingMom.flipped?'— just flipped':''}
</div>
</div>
</div>
<div class="metrics-grid" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
<div class="metric"><div class="mlbl">Key support</div><div class="mval vb">$${fn(ta.support,dec)}</div><div class="msub">Pivot low</div></div>
<div class="metric"><div class="mlbl">Resistance</div><div class="mval va">$${fn(ta.resistance,dec)}</div><div class="msub">Pivot high</div></div>
<div class="metric"><div class="mlbl">Volume POC</div><div class="mval vb">$${fn(ta.poc,dec>2?2:dec)}</div><div class="msub">Highest volume</div></div>
</div>
${renderBonusRow(ta, dec, klines)}
<!-- CVD chart inside Technical Indicators -->
<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border)">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:6px">
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
<div class="oic"><div class="oil">OI signal</div><div class="oiv" style="font-size:10px;color:var(--text2)">${d.funding<0.005?'Longs underfunded':d.funding>0.04?'Overleveraged long':'Balanced'}</div></div>
</div>
</div>
<!-- Volume profile -->
<div class="card">
<div class="card-title">Volume profile — ${activeTF}</div>
${volHTML||'<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">Insufficient data</span>'}
</div>
<!-- AI Analysis summary -->
<div class="ai-card full" id="ai-section">
<div class="card-title" style="color:var(--blue)">AI analysis — Claude (${activeMode} mode)</div>
<div style="font-size:12px;color:var(--text3);font-family:var(--mono);padding:6px 0">Click "Run AI Analysis" above to generate bull/bear case, conviction, and key risk.</div>
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
buildLevCard(d.price,setup,activeLev,dec);
setTimeout(function(){
if(!IS_MOBILE) buildCVDChart(klines,cvdData);
},50);
},100);
renderScanBody();
pendingAIContext = {coin, ta, sc, setup, klines, mtfData, liqZones, cvdData};
window._lastCvdData = cvdData;
window._lastTA = ta;
if(liqZones){
var obCluster = (liqZones.longLiqZones||[])[0]||{price:d.price};
fetchOrderBook(bybitSym, obCluster.price).then(function(ob){ window._lastOB=ob; }).catch(function(){});
}
if(activeMode==='swing' && lockedSig && !lockedSig.isSecondary){
}
if(liqZones){
const sweep = detectPostSweepConfirmation(klines, liqZones, dec);
if(sweep && sweep.confirmed){
const sweepKey = coin+'_'+activeTF+'_sweep_alert';
const lastFired = sessionStorage.getItem(sweepKey);
const candleTime = getCurrentCandleTime(activeTF);
if(lastFired !== String(candleTime)){
sessionStorage.setItem(sweepKey, String(candleTime));
sendSweepAlert(coin, sweep, ta, setup, dec);
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
const v=verdictOf(sc,ta,null);const dec=COINS[c].dec;const ch=d.change24h||0;
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
window._lastAISetup = null;
tradeLogView = false;
activeCoin=c;aiCache={};
document.getElementById('main-content').innerHTML=`<div class="loading-full"><div class="spin"></div><span>Loading ${c} (${activeMode} mode)...</span></div>`;
try{
const klines = await fetchKlines(c, activeTF);
let mtfData = null;
if(!IS_MOBILE){
try {
const mtfKlines = await fetchMTFKlines(c);
mtfData = calcMTFAnalysis(mtfKlines);
} catch(e) { console.warn('MTF fetch failed:', e); }
}
const scores={};Object.keys(COINS).forEach(cc=>{
const kl=klCache[cc+'_'+activeTF]||[];
scores[cc]=scoreSignal(cc,calcTA(kl),null);
});
renderSidebar(scores);renderAlerts(scores);
await renderDetail(c,klines,mtfData);
const others = Object.keys(COINS).filter(cc => cc !== c);
Promise.allSettled(others.map(cc => fetchKlines(cc, activeTF))).then(function() {
const updated={};
Object.keys(COINS).forEach(cc=>{
const kl=klCache[cc+'_'+activeTF]||[];
updated[cc]=scoreSignal(cc,calcTA(kl),null);
});
renderSidebar(updated);
renderAlerts(updated);
renderScanBody();
});
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
async function fetchFundingHistory(bybitSym) {
const now = Date.now();
const lastFetch = fundingLastFetch[bybitSym] || 0;
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
rate: parseFloat(f.fundingRate) * 100,
timestamp: parseInt(f.fundingRateTimestamp)
})).reverse();
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
function calcFundingMomentum(history) {
if (!history || history.length < 3) return { momentum: 'neutral', direction: 'flat', acceleration: 0 };
const last3 = history.slice(-3);
const [a, b, c] = last3.map(h => h.rate);
const trend1 = b - a;
const trend2 = c - b;
const acceleration = trend2 - trend1;
let direction = 'flat';
if (trend2 > 0.001) direction = 'rising';
if (trend2 < -0.001) direction = 'falling';
const flipped = (a > 0 && c < 0) || (a < 0 && c > 0);
let momentum = 'neutral';
if (flipped) momentum = 'flipping';
else if (direction === 'rising' && acceleration > 0) momentum = 'accelerating_positive';
else if (direction === 'falling' && acceleration < 0) momentum = 'accelerating_negative';
else if (direction === 'rising') momentum = 'rising';
else if (direction === 'falling') momentum = 'falling';
return { momentum, direction, acceleration: +acceleration.toFixed(5), latest: c, flipped };
}
function calcFundingDelta(fundingHistory) {
if (!fundingHistory || fundingHistory.length < 3) {
return { flipping: false, direction: 'neutral', accelerating: false, extreme: false, latest: 0 };
}
const rates = fundingHistory.map(function(h) { return h.rate; });
const len = rates.length;
const latest = rates[len - 1];
const prev = rates[len - 2];
const older = rates[len - 3];
const flipping = (prev < 0 && latest > 0) || (prev > 0 && latest < 0);
var direction = 'neutral';
if (latest > 0.001) direction = 'bullish';
if (latest < -0.001) direction = 'bearish';
const trend1 = prev - older;
const trend2 = latest - prev;
const accelerating = !flipping &&
Math.sign(trend2) === Math.sign(trend1) &&
Math.abs(trend2) > 0.003;
const extreme = Math.abs(latest) > 0.05;
return { flipping, direction, accelerating, extreme, latest: +latest.toFixed(5) };
}
async function fetchOIHistory(bybitSym) {
try {
const r = await fetchWithTimeout(
'https://api.bybit.com/v5/market/open-interest?category=linear&symbol='+bybitSym+'&intervalTime=1h&limit=5',
6000
);
const list = r?.result?.list || [];
return list.map(function(item) {
return { oi: parseFloat(item.openInterest), timestamp: parseInt(item.timestamp) };
}).reverse();
} catch(e) {
console.warn('fetchOIHistory failed:', bybitSym, e.message);
return [];
}
}
function calcOIDelta(oiHistory, priceTrend) {
if (!oiHistory || oiHistory.length < 2) {
return { expanding: false, bullishConfirm: false, bearishConfirm: false, aligned: false, changePct: 0 };
}
const oldest = oiHistory[0].oi;
const latest = oiHistory[oiHistory.length - 1].oi;
const changePct = oldest > 0 ? ((latest - oldest) / oldest * 100) : 0;
const expanding = changePct > 0.3;
const priceUp = priceTrend === 'bullish' || priceTrend === 'mild-bullish';
const priceDown = priceTrend === 'bearish' || priceTrend === 'mild-bearish';
const bullishConfirm = expanding && priceUp;
const bearishConfirm = expanding && priceDown;
const aligned = bullishConfirm || bearishConfirm;
return { expanding, bullishConfirm, bearishConfirm, aligned, changePct: +changePct.toFixed(2) };
}
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
const spike = Math.abs(changePct) > 3;
const trend = changePct > 0.5 ? 'rising' : changePct < -0.5 ? 'falling' : 'flat';
return { trend, changePct: +changePct.toFixed(2), spike };
}
function connectBybitWS(symbols) {
if (bybitWS && bybitWS.readyState === WebSocket.OPEN) return;
bybitWS = new WebSocket('wss://stream.bybit.com/v5/public/linear');
bybitWS.onopen = function() {
wsReconnectAttempts = 0;
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
if (SKIP_WS) {
return '<span style="font-size:9px;font-family:var(--mono);color:var(--blue)">'
+ '<span style="display:inline-block;width:6px;height:6px;background:var(--blue);border-radius:50%;margin-right:4px;vertical-align:middle"></span>'
+ 'Mobile mode (polling)</span>';
}
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
function copySignalSnapshot() {
var ctx = pendingAIContext || {};
var coin = ctx.coin || activeCoin;
var ta = ctx.ta || window._lastTA || {};
var sc = ctx.sc || 0;
var setup= ctx.setup|| {};
var cvd = window._lastCvdData || {};
var bd = window._lastScoreBreakdown || {};
var d = mktData[coin] || {};
var dec = (COINS[coin]||{}).dec || 4;
var liqZ = ctx.liqZones || {};
var mtf = ctx.mtfData || {};
var ob = window._lastOB || null;
var bdLabels = {liq:'Liq',cvd:'CVD',mtf:'MTF',vol:'Vol',taker:'Taker',session:'Session',rsi:'RSI',ob:'OB',oiPenalty:'OI',poc:'POC',bb:'BB sqz',rsiDiv:'RSI div',bos:'BOS',vwap:'VWAP'};
var bdLine = Object.keys(bd).filter(function(k){return bd[k]!==0;}).map(function(k){
return (bdLabels[k]||k)+' '+(bd[k]>0?'+':'')+bd[k];
}).join(' | ');
var nearLong = (liqZ.longLiqZones ||[])[0] || {};
var nearShort = (liqZ.shortLiqZones ||[])[0] || {};
var openPos = tradeLog.filter(function(t){return t.status==='open';}).map(function(t){
var live = (mktData[t.symbol]||{}).price||0;
var pnl = live>0 ? calcTradePnl(t.entryPrice,live,t.direction,t.leverage) : null;
return t.symbol+' '+t.direction.toUpperCase()+' '+t.leverage+'x @ $'+t.entryPrice+(pnl!==null?' → '+(pnl>=0?'+':'')+pnl.toFixed(2)+'%':'');
}).join('\n');
var now = new Date().toUTCString();
var utcH = new Date().getUTCHours();
var session = (utcH>=13&&utcH<16)?'London+NY overlap':(utcH>=8&&utcH<16)?'London':(utcH>=16&&utcH<21)?'NY':'Asia';
var snap = [
'━━━ SIGNAL SNAPSHOT ━━━',
now,
'',
coin+'/USDT '+activeTF+' '+activeMode.toUpperCase()+' mode',
'Price: $'+fn(d.price,dec)+' ('+fp(d.change24h||0)+')',
'Score: '+sc+'/10 — '+(bdLine||'no breakdown'),
'Verdict: '+(verdictOf(sc,ta,cvd).text||'—'),
'Signal dir: '+(window._lastSignalDir||'—')+(window._lastSignalDir!=(ta.trend==='bullish'||ta.trend==='mild-bullish'?'long':'short')?' ⚠ CVD divergence overrides trend':''),
'',
'— INDICATORS —',
'RSI: '+((ta.rsi||0).toFixed(1))+(ta.rsi>70?' ⚠ overbought':ta.rsi<30?' ⚠ oversold':''),
'Trend: '+(ta.trend||'—'),
'VolSpike: '+(ta.volumeSpike||'—')+'x',
'Funding: '+(d.funding!=null?d.funding.toFixed(4)+'%':'—'),
'CVD: '+(cvd.trend||'—')+' buy '+(cvd.buyPct||'?')+'% / sell '+(cvd.sellPct||'?')+'%'+(cvd.divergence?' ⚠ DIVERGENCE':''),
'MTF: '+(mtf.confluenceLabel||'—')+' (score '+(mtf.confluenceScore||0)+')',
'Session: '+session,
ob?'OB imbal: '+ob.imbalance+'% (bid '+ob.bidVol.toFixed(0)+' vs ask '+ob.askVol.toFixed(0)+')':'OB: not loaded',
'',
'— SETUPS —',
'Long: entry $'+fn(setup.lE,dec)+' stop $'+fn(setup.lSL,dec)+' TP1 $'+fn(setup.lTP1,dec)+' TP2 $'+fn(setup.lTP2,dec),
'Short: entry $'+fn(setup.sE,dec)+' stop $'+fn(setup.sSL,dec)+' TP1 $'+fn(setup.sTP1,dec)+' TP2 $'+fn(setup.sTP2,dec),
'',
'— LIQ ZONES —',
'Nearest long liq: $'+(nearLong.price||'—')+' ('+( nearLong.leverage||'—')+')',
'Nearest short liq: $'+(nearShort.price||'—')+' ('+(nearShort.leverage||'—')+')',
'',
openPos?('— OPEN POSITIONS —\n'+openPos):'No open positions',
'━━━━━━━━━━━━━━━━━━━━━━'
].join('\n');
navigator.clipboard.writeText(snap).then(function(){
var btn = document.querySelector('button[onclick="copySignalSnapshot()"]');
if(btn){ btn.textContent='✓ Copied!'; setTimeout(function(){ btn.textContent='📋 Copy snapshot'; },2000); }
}).catch(function(){
prompt('Copy this snapshot:', snap);
});
}
async function init(){
const btn=document.getElementById('rbtn');
btn.disabled=true;btn.textContent='↻ Refreshing...';
klCache={};aiCache={};
loadSwingSignals();
loadTradeLog();
seedPlaceholders();
const scores={};Object.keys(COINS).forEach(c=>{scores[c]=5;});
renderSidebar(scores);
renderAlerts(scores);
const trackedSyms = Object.values(COINS).map(c=>c.sym);
if (!SKIP_WS) {
connectBybitWS(trackedSyms);
} else {
const wsEl = document.getElementById('ws-status');
if(wsEl) wsEl.innerHTML = getWSStatusHTML();
}
const fetchTimeout = IS_MOBILE ? 5000 : 8000;
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
const coinsToFetch = IS_MOBILE ? [activeCoin] : Object.keys(COINS);
const allKlineResults = await Promise.allSettled(
coinsToFetch.map(c => fetchKlines(c, activeTF))
);
const klines = klCache[activeCoin+'_'+activeTF] || [];
let mtfData=null;
if(!IS_MOBILE){
try{
const mtfKlines=await fetchMTFKlines(activeCoin);
mtfData=calcMTFAnalysis(mtfKlines);
}catch(e){console.warn('MTF failed:',e);}
}
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
function calculateSweepStrength(sweep, cvdData, ta, d) {
if (!sweep) return 0;
var score = 0;
var sym = (COINS[activeCoin] || {}).sym || activeCoin + 'USDT';
var cutoff = Date.now() - 14400000;
var zonePrice = sweep.sweepLevel || sweep.sweepLow || sweep.sweepHigh || 0;
var zoneTolerance = zonePrice * 0.005;
var liqEvents = bybitLiqQueue.filter(function(ev) {
return ev.symbol === sym && ev.timestamp >= cutoff
&& Math.abs(ev.price - zonePrice) <= zoneTolerance;
});
var liqCount = liqEvents.length;
score += Math.min(4, liqCount >= 10 ? 4 : liqCount >= 5 ? 3 : liqCount >= 2 ? 2 : liqCount >= 1 ? 1 : 0);
if (sweep.side === 'long' && cvdData && cvdData.trend === 'bullish') score += 2;
else if (sweep.side === 'short' && cvdData && cvdData.trend === 'bearish') score += 2;
else if (cvdData && cvdData.trend === 'neutral') score += 1;
if (d && sweep.side === 'long' && d.funding > 0) score += 1;
if (d && sweep.side === 'long' && d.funding > 0.005) score += 1;
if (d && sweep.side === 'short' && d.funding < 0) score += 1;
if (d && sweep.side === 'short' && d.funding < -0.005) score += 1;
var depth = sweep.sweepDepth || 0;
if (depth >= 1.5) score += 2;
else if (depth >= 0.8) score += 1;
return Math.min(10, score);
}
function getRecentLiqEventsForZone(sym, zonePrice, minutesBack) {
if (!bybitLiqQueue || !bybitLiqQueue.length) return [];
var cutoff = Date.now() - (minutesBack || 240) * 60000;
var tolerance = zonePrice * 0.008;
return bybitLiqQueue
.filter(function(ev) {
return ev.symbol === sym && ev.timestamp >= cutoff
&& Math.abs(ev.price - zonePrice) <= tolerance;
})
.sort(function(a, b) { return b.timestamp - a.timestamp; })
.slice(0, 5);
}
function detectPostSweepConfirmation(klines, liqZones, dec) {
if (!klines || klines.length < 3 || !liqZones) return null;
var recent20 = klines.slice(-20).map(function(k){ return k.v; }).sort(function(a,b){return a-b;});
var medianVol = recent20[Math.floor(recent20.length/2)] || 1;
for (var offset = 2; offset <= 4; offset++) {
var prev = klines[klines.length - offset];
var curr = klines[klines.length - offset + 1];
if (!prev || !curr) continue;
var candlesAgo = offset - 1;
if (candlesAgo > 2) continue;
var longZones = liqZones.longLiqZones || [];
for (var li = 0; li < longZones.length; li++) {
var zone = longZones[li];
if (!(prev.l <= zone.price && prev.c > zone.price)) continue;
var req1 = prev.c > zone.price;
var cvd = window._lastCvdData;
var req2 = cvd && (cvd.trend === 'bullish' || cvd.recentBias === 'buying');
var req3 = prev.v >= medianVol * 2.8;
var atr = (function(){
var sum=0; var n=Math.min(14,klines.length-1);
for(var i=klines.length-n;i<klines.length;i++){
sum+=klines[i].h-klines[i].l;
}
return sum/n;
})();
var req4 = Math.abs(curr.c - zone.price) <= atr * 1.2;
var allReqs = req1 && req2 && req3 && req4;
var watchOnly = req1 && !allReqs;
if (!req1) continue;
var mmrP = activeLev>=100?0.005:activeLev>=25?0.004:0.003;
var maxSD = (1/activeLev - mmrP) * 0.6;
var wickStop = +(prev.l * 0.998).toFixed(dec);
var wickStopPct = (curr.c - wickStop) / curr.c;
var safeStop = +(curr.c * (1 - maxSD)).toFixed(dec);
var stopPrice = wickStopPct <= maxSD ? wickStop : safeStop;
var stopPct = +((curr.c - stopPrice) / curr.c * 100).toFixed(3);
var symL = (COINS[activeCoin]||{}).sym||activeCoin+'USDT';
var realLiqEvents = getRecentLiqEventsForZone(symL, zone.price, 240);
var recLev = realLiqEvents.length >= 3 ? 75 : activeLev > 75 ? 75 : activeLev;
var volMult = +(prev.v / medianVol).toFixed(1);
return {
side:'long', confirmed:allReqs, watchOnly:watchOnly,
missingReqs: (!req2?'CVD not flipped ':'') + (!req3?'Vol '+volMult+'x (need 2.8x) ':'') + (!req4?'Price too far from zone':''),
sweepCandle:prev, sweepLow:prev.l, sweepLevel:zone.price, leverage:zone.leverage,
entryPrice:+curr.c.toFixed(dec), stopPrice, stopPct,
stopNote: wickStopPct<=maxSD?'wick':'capped',
tp1:+(curr.c*1.0045).toFixed(dec), tp2:+(curr.c*1.009).toFixed(dec), tp3:+(curr.c*1.018).toFixed(dec),
sweepDepth:+((prev.c-prev.l)/prev.c*100).toFixed(3),
recovery:+((curr.c-prev.l)/(prev.c-prev.l)*100).toFixed(1),
candlesAgo, freshness: candlesAgo===1?'just confirmed':candlesAgo+' candles ago',
maxSafePct:+(maxSD*100).toFixed(3), volumeMultiple:volMult,
realLiqEvents, recommendedLeverage:recLev
};
}
var shortZones = liqZones.shortLiqZones || [];
for (var si = 0; si < shortZones.length; si++) {
var zoneS = shortZones[si];
if (!(prev.h >= zoneS.price && prev.c < zoneS.price)) continue;
var req1S = prev.c < zoneS.price;
var cvdS = window._lastCvdData;
var req2S = cvdS && (cvdS.trend === 'bearish' || cvdS.recentBias === 'selling');
var req3S = prev.v >= medianVol * 2.8;
var atrS = (function(){
var sum=0; var n=Math.min(14,klines.length-1);
for(var i=klines.length-n;i<klines.length;i++){ sum+=klines[i].h-klines[i].l; }
return sum/n;
})();
var req4S = Math.abs(curr.c - zoneS.price) <= atrS * 1.2;
var allReqsS = req1S && req2S && req3S && req4S;
var watchOnlyS = req1S && !allReqsS;
if (!req1S) continue;
var mmrPS = activeLev>=100?0.005:activeLev>=25?0.004:0.003;
var maxSDS = (1/activeLev - mmrPS) * 0.6;
var wickStopS = +(prev.h * 1.002).toFixed(dec);
var wickStopPctS = (wickStopS - curr.c) / curr.c;
var safeStopS = +(curr.c * (1 + maxSDS)).toFixed(dec);
var stopPriceS = wickStopPctS <= maxSDS ? wickStopS : safeStopS;
var stopPctS = +((stopPriceS - curr.c) / curr.c * 100).toFixed(3);
var symS = (COINS[activeCoin]||{}).sym||activeCoin+'USDT';
var realLiqEventsS = getRecentLiqEventsForZone(symS, zoneS.price, 240);
var recLevS = realLiqEventsS.length >= 3 ? 75 : activeLev > 75 ? 75 : activeLev;
var volMultS = +(prev.v / medianVol).toFixed(1);
return {
side:'short', confirmed:allReqsS, watchOnly:watchOnlyS,
missingReqs: (!req2S?'CVD not flipped ':'') + (!req3S?'Vol '+volMultS+'x (need 2.8x) ':'') + (!req4S?'Price too far from zone':''),
sweepCandle:prev, sweepHigh:prev.h, sweepLevel:zoneS.price, leverage:zoneS.leverage,
entryPrice:+curr.c.toFixed(dec), stopPrice:stopPriceS, stopPct:stopPctS,
stopNote: wickStopPctS<=maxSDS?'wick':'capped',
tp1:+(curr.c*0.9955).toFixed(dec), tp2:+(curr.c*0.991).toFixed(dec), tp3:+(curr.c*0.982).toFixed(dec),
sweepDepth:+((prev.h-prev.c)/prev.c*100).toFixed(3),
recovery:+((prev.h-curr.c)/(prev.h-prev.c)*100).toFixed(1),
candlesAgo, freshness: candlesAgo===1?'just confirmed':candlesAgo+' candles ago',
maxSafePct:+(maxSDS*100).toFixed(3), volumeMultiple:volMultS,
realLiqEvents:realLiqEventsS, recommendedLeverage:recLevS
};
}
}
return null;
}
function renderPostSweepCard(sweep, dec) {
if (!sweep) return '';
var fn2 = function(n) { return safeFormat(n, dec); };
var isLong = sweep.side === 'long';
var col = isLong ? 'var(--green)' : 'var(--red)';
var bg = isLong ? 'rgba(0,208,132,0.04)' : 'rgba(255,77,77,0.04)';
var border = isLong ? 'rgba(0,208,132,0.5)' : 'rgba(255,77,77,0.5)';
var conf, confCol, borderFinal, bgFinal;
if (sweep.confirmed) {
conf='⚡ SIGNAL — all criteria met'; confCol='var(--green)';
borderFinal=border; bgFinal=bg;
} else {
conf='👁 WATCH — ' + (sweep.missingReqs||'criteria not met'); confCol='var(--amber)';
borderFinal='rgba(245,166,35,0.4)'; bgFinal='rgba(245,166,35,0.03)';
}
var d = mktData[activeCoin] || {};
var cvdD = window._lastCvdData || {};
var ta = window._lastTA || {};
var strength = calculateSweepStrength(sweep, cvdD, ta, d);
var strengthCol = strength >= 7 ? 'var(--green)' : strength >= 4 ? 'var(--amber)' : 'var(--red)';
var strengthLabel = strength >= 8 ? 'STRONG' : strength >= 6 ? 'GOOD' : strength >= 4 ? 'MODERATE' : 'WEAK';
var liqEvents = sweep.realLiqEvents || [];
var liqEventsHtml = '';
if (liqEvents.length > 0) {
liqEventsHtml = '<div style="margin:8px 0;padding:8px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);border-radius:6px">'
+ '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--purple);font-family:var(--mono);margin-bottom:6px">Real liq events in zone (' + liqEvents.length + ')</div>';
liqEvents.slice(0, 3).forEach(function(ev) {
var ago = Math.round((Date.now() - ev.timestamp) / 60000);
var sideCol = ev.side === 'Buy' ? 'var(--red)' : 'var(--green)';
var sideLbl = ev.side === 'Buy' ? 'Short liq' : 'Long liq';
liqEventsHtml += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-size:10px;color:' + sideCol + ';font-family:var(--mono)">' + sideLbl + '</span>'
+ '<span style="font-size:10px;color:var(--text2);font-family:var(--mono)">$' + ev.price.toFixed(dec) + '</span>'
+ '<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">' + ago + 'm ago</span>'
+ '</div>';
});
liqEventsHtml += '</div>';
} else {
liqEventsHtml = '<div style="font-size:10px;color:var(--text3);font-family:var(--mono);padding:4px 0">No WS liq events in zone — using calculated levels</div>';
}
var recLev = sweep.recommendedLeverage || 75;
var levWarn = '';
if (activeLev > recLev) {
levWarn = '<div style="background:rgba(255,77,77,0.1);border:1px solid var(--red-b);border-radius:6px;padding:8px 12px;margin-top:10px;font-size:11px;color:var(--red);font-family:var(--mono)">'
+ '⚠️ Recommended max leverage: ' + recLev + 'x — you are on ' + activeLev + 'x. Reduce size or lower leverage for this setup.</div>';
} else if (activeLev < 50) {
levWarn = '<div style="background:rgba(245,166,35,0.08);border:1px solid rgba(245,166,35,0.3);border-radius:6px;padding:8px 12px;margin-top:10px;font-size:11px;color:var(--amber);font-family:var(--mono)">'
+ 'You are on ' + activeLev + 'x. This setup works best at 50x-75x for tight entries.</div>';
} else {
var isSafe = sweep.stopPct <= (sweep.maxSafePct || 0.5);
var stopLabel = sweep.stopNote === 'wick' ? 'wick stop' : 'capped stop';
if (isSafe) {
levWarn = '<div style="background:rgba(0,208,132,0.1);border:1px solid var(--green-b);border-radius:6px;padding:8px 12px;margin-top:10px;font-size:11px;color:var(--green);font-family:var(--mono)">Stop ('
+ sweep.stopPct.toFixed(3) + '%) within safe range for ' + activeLev + 'x (max safe: ' + (sweep.maxSafePct||'?') + '%). Using ' + stopLabel + '.</div>';
} else {
levWarn = '<div style="background:rgba(255,77,77,0.1);border:1px solid var(--red-b);border-radius:6px;padding:8px 12px;margin-top:10px;font-size:11px;color:var(--red);font-family:var(--mono)">Stop capped to '
+ sweep.stopPct.toFixed(3) + '% (max safe for ' + activeLev + 'x). Wick was too wide — reduce size or use 25-50x instead.</div>';
}
}
return '<div class="card full" style="border-color:' + border + ';background:' + bg + ';border-width:2px">'
+ '<div class="card-title" style="color:' + col + ';display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">'
+ '<span>Post-Sweep Precision Entry <span style="font-size:10px;font-family:var(--mono);margin-left:6px;color:var(--text3)">75x rec.</span></span>'
+ '<div style="display:flex;gap:8px;align-items:center">'
+ '<span style="font-size:10px;background:rgba(167,139,250,0.12);color:' + strengthCol + ';border:1px solid ' + strengthCol + ';border-radius:3px;padding:2px 8px;font-family:var(--mono)">Strength ' + strength + '/10 ' + strengthLabel + '</span>'
+ '<span style="font-size:10px;background:' + (sweep.confirmed?'rgba(0,208,132,0.15)':'rgba(245,166,35,0.15)') + ';color:' + confCol + ';border:1px solid ' + confCol + ';border-radius:3px;padding:2px 8px;font-family:var(--mono)">' + conf + '</span>'
+ '</div></div>'
+ '<p style="font-size:11px;color:var(--text2);font-family:var(--mono);margin:0 0 8px;line-height:1.6">'
+ (isLong
? 'Sweep confirmed: wick pierced ' + sweep.leverage + ' liq zone at $' + fn2(sweep.sweepLevel) + ', closed back above. Enter at candle close, stop below the wick low.'
: 'Squeeze confirmed: wick pierced ' + sweep.leverage + ' liq zone at $' + fn2(sweep.sweepLevel) + ', closed back below. Enter at candle close, stop above the wick high.')
+ '</p>'
+ liqEventsHtml
+ '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px">'
+ '<div>'
+ '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);margin-bottom:8px">Sweep stats</div>'
+ '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Sweep depth</span>'
+ '<span style="font-size:11px;color:var(--amber);font-family:var(--mono)">' + sweep.sweepDepth + '%</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Recovery</span>'
+ '<span style="font-size:11px;color:' + col + ';font-family:var(--mono)">' + sweep.recovery + '%</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Zone swept</span>'
+ '<span style="font-size:11px;color:var(--purple);font-family:var(--mono)">' + sweep.leverage + ' liq</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:4px 0">'
+ '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Rec. leverage</span>'
+ '<span style="font-size:11px;color:' + (activeLev > recLev ? 'var(--red)' : 'var(--green)') + ';font-family:var(--mono);font-weight:600">max ' + recLev + 'x</span></div>'
+ '</div>'
+ '<div>'
+ '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);margin-bottom:8px">Entry levels</div>'
+ '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Entry (candle close)</span>'
+ '<span style="font-size:14px;font-weight:700;color:var(--blue);font-family:var(--mono)">$' + fn2(sweep.entryPrice) + '</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Stop (' + (sweep.stopNote==='wick'?'below wick':'capped ' + activeLev + 'x') + ')</span>'
+ '<span style="font-size:12px;color:var(--red);font-family:var(--mono)">$' + fn2(sweep.stopPrice) + ' (-' + sweep.stopPct + '%)</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">TP1 (0.45%)</span>'
+ '<span style="font-size:12px;color:var(--green);font-family:var(--mono)">$' + fn2(sweep.tp1) + '</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
+ '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">TP2 (0.9%)</span>'
+ '<span style="font-size:12px;color:var(--green);font-family:var(--mono)">$' + fn2(sweep.tp2) + '</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:4px 0">'
+ '<span style="font-size:11px;color:var(--text2);font-family:var(--mono)">TP3 (1.8%)</span>'
+ '<span style="font-size:12px;color:var(--green);font-family:var(--mono)">$' + fn2(sweep.tp3) + '</span></div>'
+ '</div></div>'
+ levWarn
+ '</div>';
}
async function sendSweepAlert(coin, sweep, ta, setup, dec) {
try {
if (activeMode !== 'swing') return;
const d = mktData[coin] || {};
const isLong = sweep.side === 'long';
const mmr = activeLev >= 100 ? 0.005 : activeLev >= 25 ? 0.004 : 0.003;
const imr = 1 / activeLev;
const fee = 0.0005;
const maxSD = (imr - mmr) * 0.6;
const entry = sweep.entryPrice;
const stop = sweep.stopPrice;
const tp1 = sweep.tp1;
const tp2 = sweep.tp2;
const stopDist= sweep.stopPct;
const liqPrice= isLong
? +(entry * (1 - imr + mmr + fee)).toFixed(dec)
: +(entry * (1 + imr - mmr - fee)).toFixed(dec);
const safeLTP1 = isLong ? tp1 : +(entry * 0.9955).toFixed(dec);
const safeLTP2 = isLong ? tp2 : +(entry * 0.991).toFixed(dec);
const safeSTP1raw = isLong ? +(entry * 0.9955).toFixed(dec) : tp1;
const safeSTP2raw = isLong ? +(entry * 0.991).toFixed(dec) : tp2;
const safeSTP1 = safeSTP1raw < entry ? safeSTP1raw : +(entry * 0.9955).toFixed(dec);
const safeSTP2 = safeSTP2raw < safeSTP1 ? safeSTP2raw : +(entry * 0.991).toFixed(dec);
const safeLTP1f = safeLTP1 > entry ? safeLTP1 : +(entry * 1.0045).toFixed(dec);
const safeLTP2f = safeLTP2 > safeLTP1f ? safeLTP2 : +(entry * 1.009).toFixed(dec);
const payload = {
coin, tf: activeTF,
price: d.price || entry,
score: 8,
bias: isLong ? 'long' : 'short',
conviction: 'high',
pattern: (isLong ? 'LONG SWEEP' : 'SHORT SQUEEZE') + ' CONFIRMED',
patternStage: 'confirmed',
patternConfidence: 'high',
winRate: '',
longEntry: entry,
longStop: isLong ? stop : +(entry * (1 - maxSD)).toFixed(dec),
longTP1: safeLTP1f,
longTP2: safeLTP2f,
shortEntry: isLong ? +(entry * (1 + maxSD)).toFixed(dec) : entry,
shortStop: isLong ? +(entry * (1 + maxSD * 1.6)).toFixed(dec) : stop,
shortTP1: safeSTP1,
shortTP2: safeSTP2,
rsi: (ta.rsi || 50).toFixed(1),
trend: ta.trend || 'neutral',
funding: (d.funding || 0).toFixed(4),
fgValue: d.fgValue || 50,
leverage: activeLev,
liqLong: isLong ? liqPrice : +(entry * (1 - imr + mmr + fee)).toFixed(dec),
liqShort: isLong ? +(entry * (1 + imr - mmr - fee)).toFixed(dec) : liqPrice,
stopDistPct: stopDist.toString(),
maxSafeStopPct: (maxSD * 100).toFixed(3),
longMaxSafeLev: 125,
shortMaxSafeLev: 125,
suggestedAction: (isLong ? 'LONG' : 'SHORT') + ' sweep entry at $' + entry
+ ' — stop $' + stop + ' (-' + sweep.stopPct + '%)'
+ ' — TP1 $' + tp1 + ' — TP2 $' + tp2
+ ' — sweep depth ' + sweep.sweepDepth + '%'
+ (sweep.stopNote === 'capped' ? ' — stop capped for '+activeLev+'x' : ''),
watchLevel: sweep.sweepLevel
};
const r = await fetch('/api/alert', {
method: 'POST', headers: {'Content-Type':'application/json'},
body: JSON.stringify(payload)
});
const result = await r.json();
} catch(e) { console.error('Sweep alert error:', e); }
}
async function sendTelegramAlert(coin, ta, sc, setup, ai, d, dec) {
try {
const patternConf = ai?.pattern?.confidence || 'low';
const patternStage = ai?.pattern?.stage || 'none';
const patternReady = patternStage === 'confirmed' || patternStage === 'near breakout';
const confOk = patternConf === 'high' || (patternConf === 'medium' && sc >= 7);
if (sc < 7 || !confOk || !patternReady) {
return;
}
if (activeMode !== 'swing') {
return;
}
const alertKey = coin + '_signal_alert';
const candleTime = getCurrentCandleTime('1d');
if (sessionStorage.getItem(alertKey) === String(candleTime)) {
return;
}
sessionStorage.setItem(alertKey, String(candleTime));
const pe = ai?.patternEntry || {};
const safeNum = (v, fallback) => (v && !isNaN(parseFloat(v))) ? parseFloat(v) : fallback;
const lE = safeNum(pe.longEntry, setup.lE);
const lSL = setup.lSL;
const sE = safeNum(pe.shortEntry, setup.sE);
const sSL = setup.sSL;
const lTP1raw = safeNum(pe.longTP1, setup.lTP1);
const lTP2raw = safeNum(pe.longTP2, setup.lTP2);
const lTP1 = lTP1raw > lE ? lTP1raw : setup.lTP1;
const lTP2 = lTP2raw > lTP1 ? lTP2raw : setup.lTP2;
const sTP1raw = safeNum(pe.shortTP1, setup.sTP1);
const sTP2raw = safeNum(pe.shortTP2, setup.sTP2);
const sTP1 = sTP1raw < sE ? sTP1raw : setup.sTP1;
const sTP2 = sTP2raw < sTP1 ? sTP2raw : setup.sTP2;
const longLev = calcLeverage(lE, lSL, d.price, activeLev, true);
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
funding: d.funding.toFixed(4),
bonusPOC: (window._lastScoreBreakdown?.poc || 0) > 0,
bonusBB: (window._lastScoreBreakdown?.bb || 0) > 0,
bonusRSIDiv: (window._lastScoreBreakdown?.rsiDiv || 0) > 0,
bonusBOS: (window._lastScoreBreakdown?.bos || 0) > 0,
bonusVWAP: (window._lastScoreBreakdown?.vwap || 0) > 0
};
const r = await fetch('/api/alert', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(payload)
});
const result = await r.json();
} catch(e) {
console.error('Alert error:', e);
}
}
function triggerManualAI() {
if (!pendingAIContext) return;
const btn = document.getElementById('ai-run-btn');
if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
const patEl = document.getElementById('pattern-section');
const aiEl = document.getElementById('ai-section');
if (patEl) patEl.innerHTML = '<div class="card-title" style="color:var(--purple)">Chart pattern recognition — Claude AI</div>'
+ '<div class="ai-loading"><div class="spin"></div><span>Analyzing chart structure...</span></div>';
if (aiEl) aiEl.innerHTML = '<div class="card-title" style="color:var(--blue)">AI analysis — Claude</div>'
+ '<div class="ai-loading"><div class="spin"></div><span>Generating analysis...</span></div>';
const ctx = pendingAIContext;
loadAI(ctx.coin, ctx.ta, ctx.sc, ctx.setup, ctx.klines, ctx.mtfData, ctx.liqZones, ctx.cvdData);
}
function loadRiskSettings() {
try { return JSON.parse(localStorage.getItem('riskSettings_v1')) || { balance: 0, maxRiskPct: 1.0 }; }
catch(e) { return { balance: 0, maxRiskPct: 1.0 }; }
}
function saveRiskSettings(s) {
try { localStorage.setItem('riskSettings_v1', JSON.stringify(s)); } catch(e) {}
}
function calcPositionSize(entryPrice, stopPrice, balance, maxRiskPct, leverage) {
if (!entryPrice || !stopPrice || !balance || balance <= 0) return null;
var riskAmount = balance * (maxRiskPct / 100);
var stopDist = Math.abs(entryPrice - stopPrice) / entryPrice;
if (stopDist <= 0) return null;
var positionUSD = riskAmount / stopDist;
var positionUSDLev = positionUSD;
var marginNeeded = positionUSD / leverage;
var contracts = positionUSD / entryPrice;
return {
positionUSD: +positionUSD.toFixed(2),
marginNeeded: +marginNeeded.toFixed(2),
contracts: +contracts.toFixed(4),
riskAmount: +riskAmount.toFixed(2),
stopPct: +(stopDist * 100).toFixed(3)
};
}
function renderRiskCalculator(setup, price, dec) {
var s = loadRiskSettings();
var lCalc = s.balance > 0 && setup && setup.lE && setup.lSL
? calcPositionSize(setup.lE, setup.lSL, s.balance, s.maxRiskPct, activeLev)
: null;
var sCalc = s.balance > 0 && setup && setup.sE && setup.sSL
? calcPositionSize(setup.sE, setup.sSL, s.balance, s.maxRiskPct, activeLev)
: null;
return '<div class="card full" style="border-color:rgba(74,158,255,0.2)">'
+ '<div class="card-title" style="color:var(--blue)">Risk Calculator'
+ '<span style="font-size:9px;color:var(--text3);font-family:var(--mono);margin-left:8px">Position size based on account + max loss</span></div>'
+ '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Account Balance (USDT)</div>'
+ '<input id="rc-balance" type="number" step="any" placeholder="e.g. 60" value="' + (s.balance || '') + '" onchange="updateRiskCalc()" style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px;box-sizing:border-box"></div>'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Max Risk Per Trade (%)</div>'
+ '<input id="rc-risk" type="number" step="0.1" min="0.1" max="10" placeholder="1.0" value="' + (s.maxRiskPct || '1.0') + '" onchange="updateRiskCalc()" style="width:100%;background:var(--bg4);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px;box-sizing:border-box"></div>'
+ '<div><div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">Leverage</div>'
+ '<div style="font-size:14px;font-weight:700;color:var(--amber);font-family:var(--mono);padding:6px 0">' + activeLev + 'x (active)</div></div>'
+ '</div>'
+ '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
+ '<div style="background:rgba(0,208,132,0.05);border:1px solid rgba(0,208,132,0.2);border-radius:8px;padding:12px">'
+ '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--green);font-family:var(--mono);margin-bottom:8px">Long position size</div>'
+ (lCalc
? '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)"><span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Position size</span><span style="font-size:12px;color:var(--green);font-family:var(--mono);font-weight:600">$' + lCalc.positionUSD + '</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)"><span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Margin needed</span><span style="font-size:12px;color:var(--blue);font-family:var(--mono)">$' + lCalc.marginNeeded + '</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)"><span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Max loss</span><span style="font-size:12px;color:var(--red);font-family:var(--mono)">$' + lCalc.riskAmount + '</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Contracts</span><span style="font-size:12px;color:var(--text);font-family:var(--mono)">' + lCalc.contracts + '</span></div>'
: '<div style="font-size:11px;color:var(--text3);font-family:var(--mono)">Enter balance above to calculate</div>')
+ '</div>'
+ '<div style="background:rgba(255,77,77,0.05);border:1px solid rgba(255,77,77,0.2);border-radius:8px;padding:12px">'
+ '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--red);font-family:var(--mono);margin-bottom:8px">Short position size</div>'
+ (sCalc
? '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)"><span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Position size</span><span style="font-size:12px;color:var(--green);font-family:var(--mono);font-weight:600">$' + sCalc.positionUSD + '</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)"><span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Margin needed</span><span style="font-size:12px;color:var(--blue);font-family:var(--mono)">$' + sCalc.marginNeeded + '</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)"><span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Max loss</span><span style="font-size:12px;color:var(--red);font-family:var(--mono)">$' + sCalc.riskAmount + '</span></div>'
+ '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="font-size:11px;color:var(--text2);font-family:var(--mono)">Contracts</span><span style="font-size:12px;color:var(--text);font-family:var(--mono)">' + sCalc.contracts + '</span></div>'
: '<div style="font-size:11px;color:var(--text3);font-family:var(--mono)">Enter balance above to calculate</div>')
+ '</div>'
+ '</div>'
+ '<div style="margin-top:10px;font-size:10px;color:var(--text3);font-family:var(--mono)">Formula: Position size = (Balance × Risk%) ÷ Stop distance. Margin = Position ÷ Leverage.</div>'
+ '</div>';
}
function updateRiskCalc() {
var bal = parseFloat(document.getElementById('rc-balance') && document.getElementById('rc-balance').value);
var risk = parseFloat(document.getElementById('rc-risk') && document.getElementById('rc-risk').value);
if (!isNaN(bal) && !isNaN(risk)) {
saveRiskSettings({ balance: bal, maxRiskPct: risk });
var el = document.getElementById('risk-calc-section');
if (el && pendingAIContext) {
var ctx = pendingAIContext;
var price = (mktData[ctx.coin] || {}).price || 0;
el.innerHTML = renderRiskCalculator(ctx.setup, price, COINS[ctx.coin].dec);
}
}
}
async function loadAI(coin,ta,sc,setup,klines,mtfData,liqZones,cvdData){
const ai=await fetchAI(coin,ta,sc,setup,klines,mtfData,liqZones,cvdData);
if(ai && activeMode==='swing') updateSignalAI(coin,activeTF,ai);
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
const rLE = safeN(pe.longEntry, setup.lE);
const rSE = safeN(pe.shortEntry, setup.sE);
const rLTP1raw = safeN(pe.longTP1, setup.lTP1);
const rLTP2raw = safeN(pe.longTP2, setup.lTP2);
const rSTP1raw = safeN(pe.shortTP1, setup.sTP1);
const rSTP2raw = safeN(pe.shortTP2, setup.sTP2);
const rPe={
longEntry: rLE,
longStop: safeN(pe.longStop, setup.lSL),
longTP1: rLTP1raw > rLE ? rLTP1raw : setup.lTP1,
longTP2: rLTP2raw > rLTP1raw ? rLTP2raw : setup.lTP2,
shortEntry: rSE,
shortStop: safeN(pe.shortStop, setup.sSL),
shortTP1: rSTP1raw < rSE ? rSTP1raw : setup.sTP1,
shortTP2: rSTP2raw < rSTP1raw ? rSTP2raw : setup.sTP2,
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
function setAIVal(id, val, fmt2) {
var el = document.getElementById(id);
if(!el || !val) return;
el.innerHTML = '$' + fmt2(val)
+ '<span style="font-size:9px;background:rgba(167,139,250,0.15);color:#a78bfa;border:1px solid rgba(167,139,250,0.3);border-radius:3px;padding:1px 5px;margin-left:6px;font-family:var(--mono)">AI</span>';
}
var fmt2 = function(v){ return fn(v, dec); };
var curPrice = (mktData[coin]||{}).price || 0;
var validLongEntry = rPe.longEntry && rPe.longEntry < curPrice * 1.02;
var validShortEntry = rPe.shortEntry && rPe.shortEntry > curPrice * 0.98;
if(validLongEntry) setAIVal('l-entry', rPe.longEntry, fmt2);
if(validShortEntry) setAIVal('s-entry', rPe.shortEntry, fmt2);
window._lastAISetup = {
longEntry: validLongEntry ? rPe.longEntry : null,
shortEntry: validShortEntry ? rPe.shortEntry : null,
longStop: null, shortStop: null,
longTP1: null, longTP2: null,
shortTP1: null, shortTP2: null
};
if(patternEl){
var patternLevelsHtml = '';
if(pe.longEntry||pe.shortEntry){
patternLevelsHtml = '<div class="pattern-levels">'
+ '<div class="pl-item"><div class="pl-label">Pattern long entry</div><div class="pl-val vg">$'+fn(rPe.longEntry,dec)+'</div></div>'
+ '<div class="pl-item"><div class="pl-label">Pattern long stop</div><div class="pl-val vr">$'+fn(rPe.longStop,dec)+'</div></div>'
+ '<div class="pl-item"><div class="pl-label">Pattern long TP1</div><div class="pl-val vg">$'+fn(rPe.longTP1,dec)+'</div></div>'
+ '<div class="pl-item"><div class="pl-label">Pattern long TP2</div><div class="pl-val vg">$'+fn(rPe.longTP2,dec)+'</div></div>'
+ '<div class="pl-item"><div class="pl-label">Pattern short entry</div><div class="pl-val vr">$'+fn(rPe.shortEntry,dec)+'</div></div>'
+ '<div class="pl-item"><div class="pl-label">Pattern short stop</div><div class="pl-val vr">$'+fn(rPe.shortStop,dec)+'</div></div>'
+ '<div class="pl-item"><div class="pl-label">Pattern short TP1</div><div class="pl-val vg">$'+fn(rPe.shortTP1,dec)+'</div></div>'
+ '<div class="pl-item"><div class="pl-label">Pattern short TP2</div><div class="pl-val vg">$'+fn(rPe.shortTP2,dec)+'</div></div>'
+ (pat.patternTarget?'<div class="pl-item"><div class="pl-label">Pattern target</div><div class="pl-val vp">$'+fn(pat.patternTarget,dec)+'</div></div>':'')
+ (pat.patternInvalidation?'<div class="pl-item"><div class="pl-label">Invalidation level</div><div class="pl-val vr">$'+fn(pat.patternInvalidation,dec)+'</div></div>':'')
+ '</div>';
}
patternEl.innerHTML=`
<div class="card-title" style="color:var(--purple)">Chart pattern recognition — Claude AI</div>
<div class="pattern-header">
<div class="pattern-name">${pat.name||'No clear pattern'}</div>
<div class="pattern-badges">
<span class="pbadge ${confCls}">Confidence: ${pat.confidence||'—'}</span>
<span class="pbadge pb-stage">${pat.stage||'—'}</span>
${pat.historicalWinRate?'<span class="pbadge pb-winrate">Win rate: '+pat.historicalWinRate+'</span>':''}
</div>
</div>
<p class="pattern-desc">${pat.description||'—'}</p>
${patternLevelsHtml}
${ai.watchLevel?'<div class="watch-level">Watch level: '+ai.watchLevel+'</div>':''}
${ai.suggestedAction?'<div class="action-level">Action: '+ai.suggestedAction+'</div>':''}
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
const ed = ai.entryDecision || {};
const edCol = ed.action==='ENTER_NOW'?'var(--green)':ed.action==='AVOID'?'var(--red)':'var(--amber)';
const edBg = ed.action==='ENTER_NOW'?'rgba(0,208,132,0.07)':ed.action==='AVOID'?'rgba(255,77,77,0.07)':'rgba(245,166,35,0.07)';
const edIcon = ed.action==='ENTER_NOW'?'⚡':ed.action==='AVOID'?'❌':'👁';
const decCard = ed.action ? `
<div style="background:${edBg};border:1px solid ${edCol};border-radius:8px;padding:12px 16px;margin-bottom:12px">
<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);font-family:var(--mono);margin-bottom:6px">AI Entry Decision</div>
<div style="font-size:13px;font-weight:700;color:${edCol};font-family:var(--mono);margin-bottom:8px">${edIcon} ${ed.action.replace('_',' ')} — ${(ed.direction||'').toUpperCase()}</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;font-size:10px;font-family:var(--mono)">
<div><span style="color:var(--text3)">Entry </span><span style="color:var(--text1);font-weight:600">$${ed.entryPrice||'—'}</span></div>
<div><span style="color:var(--text3)">Stop </span><span style="color:var(--red);font-weight:600">$${ed.stopLoss||'—'}</span></div>
<div><span style="color:var(--text3)">TP1 </span><span style="color:var(--green);font-weight:600">$${ed.tp1||'—'}</span></div>
<div><span style="color:var(--text3)">TP2 </span><span style="color:var(--green);font-weight:600">$${ed.tp2||'—'}</span></div>
<div><span style="color:var(--text3)">R:R </span><span style="color:var(--text1)">${ed.riskReward||'—'}</span></div>
<div><span style="color:var(--text3)">Leverage </span><span style="color:var(--amber)">${ed.leverageNote||'—'}</span></div>
</div>
${ed.entryTrigger?`<div style="margin-top:8px;font-size:10px;color:var(--text2);font-family:var(--mono);border-top:1px solid rgba(255,255,255,.08);padding-top:8px">⏳ ${ed.entryTrigger}</div>`:''}
${ed.stopRationale?`<div style="margin-top:4px;font-size:10px;color:var(--text3);font-family:var(--mono)">🛡 ${ed.stopRationale}</div>`:''}
</div>` : '';
aiEl.innerHTML=`
<div class="card-title" style="color:var(--blue)">AI analysis — Claude (${activeMode} mode)
<span style="margin-left:10px;font-size:9px;color:${cCol}">CONVICTION: ${(ai.conviction||'').toUpperCase()}</span>
<span style="margin-left:8px;font-size:9px;color:${bCol}">BIAS: ${(ai.bias||'').toUpperCase()}</span>
${ai.counterTrend ? '<span style="margin-left:8px;font-size:9px;background:rgba(255,77,77,.2);color:var(--red);padding:2px 6px;border-radius:3px">⛔ COUNTER-TREND</span>' : ''}
</div>
${decCard}
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
<div class="ai-pattern-hist">Historical context: ${ai.historicalPattern||'—'}</div>
`;
}
}
