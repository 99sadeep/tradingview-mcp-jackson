#!/usr/bin/env node
/**
 * ICT/MMXM backtester.
 *
 * Replays the exact scanner logic bar-by-bar over ~80 days of 4H history for
 * every watchlist pair, using the CORRECTED rules:
 *   • a signal becomes a trade only once price trades INTO the entry zone (fill)
 *   • exit at TP1 (2R) or SL, first touch; if a 4H bar spans both → count SL (conservative)
 *   • one trade per symbol at a time (no overlap), pending entries expire unfilled
 *
 * Then it reports win-rate / expectancy broken down by score, confluence factor,
 * pair, session and direction — so we can see which signals actually win and
 * tighten the filter accordingly.
 *
 * Pure analysis fns are copied from session-scanner.js (kept in sync by hand) so
 * importing this never boots the live scanner.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatedTargets, pipSize } from './lib/journal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MIN_SCORE_RECORD = 3;   // record every signal >=3, filter in analysis
const FILL_EXPIRY = 6;        // 4H bars a pending entry waits to fill (~1 day) before cancel
const DAILY_LOOKBACK = 50, H4_LOOKBACK = 60;

// ── Pure ICT fns (mirror of session-scanner.js) ──────────────────────────────
function detectSwings(bars, len = 3) {
  const highs = [], lows = [];
  for (let i = len; i < bars.length - len; i++) {
    const b = bars[i];
    const isH = Array.from({ length: len }, (_, k) => k + 1).every(k => b.high > bars[i - k].high && b.high > bars[i + k].high);
    const isL = Array.from({ length: len }, (_, k) => k + 1).every(k => b.low < bars[i - k].low && b.low < bars[i + k].low);
    if (isH) highs.push({ p: b.high, t: b.time });
    if (isL) lows.push({ p: b.low, t: b.time });
  }
  return { highs, lows };
}
function detectStructure(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return 'RANGING';
  const rH = highs.slice(-2), rL = lows.slice(-2);
  if (rH[1].p > rH[0].p && rL[1].p > rL[0].p) return 'BULLISH';
  if (rL[1].p < rL[0].p && rH[1].p < rH[0].p) return 'BEARISH';
  return 'RANGING';
}
function detectOBs(bars) {
  const obs = [];
  for (let i = 1; i < bars.length - 2; i++) {
    const b = bars[i], n1 = bars[i + 1], n2 = bars[i + 2];
    const minMove = (b.high - b.low) * 0.5;
    if (b.close < b.open && n1.close > n1.open && n2.close > n2.open && (n2.close - b.high) > minMove) obs.push({ type: 'BULL', top: b.high, bot: b.low, t: b.time });
    if (b.close > b.open && n1.close < n1.open && n2.close < n2.open && (b.low - n2.close) > minMove) obs.push({ type: 'BEAR', top: b.high, bot: b.low, t: b.time });
  }
  return obs;
}
function detectFVGs(bars) {
  const fvgs = [];
  for (let i = 1; i < bars.length - 1; i++) {
    if (bars[i + 1].low > bars[i - 1].high) fvgs.push({ type: 'BULL', top: bars[i + 1].low, bot: bars[i - 1].high, t: bars[i].time });
    if (bars[i + 1].high < bars[i - 1].low) fvgs.push({ type: 'BEAR', top: bars[i - 1].low, bot: bars[i + 1].high, t: bars[i].time });
  }
  return fvgs;
}
function priceZone(price, highs, lows) {
  if (!highs.length || !lows.length) return { zone: 'UNKNOWN' };
  const hi = Math.max(...highs.map(h => h.p)), lo = Math.min(...lows.map(l => l.p));
  const eq = (hi + lo) / 2;
  return { zone: price > eq ? 'PREMIUM' : 'DISCOUNT', eq, hi, lo };
}
function checkSMT(mainLows, mainHighs, smtLows, smtHighs) {
  if (mainLows.length < 2 || smtLows.length < 2 || mainHighs.length < 2 || smtHighs.length < 2) return { bullish: false, bearish: false };
  const mL = mainLows.slice(-2), sL = smtLows.slice(-2), mH = mainHighs.slice(-2), sH = smtHighs.slice(-2);
  return { bullish: mL[1].p < mL[0].p && sL[1].p > sL[0].p, bearish: mH[1].p > mH[0].p && sH[1].p < sH[0].p };
}
function scoreSetup({ dailyStr, zone, h4Str, nearOB, nearFVG, smt }) {
  let score = 0; const f = {};
  if (dailyStr !== 'RANGING') { score++; f.daily_structure = true; }
  if ((dailyStr === 'BULLISH' && zone === 'DISCOUNT') || (dailyStr === 'BEARISH' && zone === 'PREMIUM')) { score++; f.correct_zone = true; }
  if (h4Str === dailyStr) { score++; f.h4_confirms = true; }
  if (nearOB) { score++; f.near_ob = true; }
  if (nearFVG) { score++; f.fvg = true; }
  if (smt) { score++; f.smt = true; }
  return { score, factors: f };
}
function sessionAt(ts) {
  const d = new Date(ts * 1000), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (m >= 360 && m < 540) return 'LONDON';
  if (m >= 660 && m < 840) return 'NEW_YORK';
  if (m >= 540 && m < 660) return 'PRE_NY';
  return 'OFF';
}

// ── Signal at a 4H bar index j (uses only data up to j) ───────────────────────
function analyzeAt(symbol, j, dailyBars, h4, smtH4) {
  const t = h4[j].time;
  const dBars = dailyBars.filter(b => b.time <= t).slice(-DAILY_LOOKBACK);
  if (dBars.length < 20) return null;
  const hBars = h4.slice(Math.max(0, j - H4_LOOKBACK + 1), j + 1);
  const price = h4[j].close;

  const dSw = detectSwings(dBars, 3);
  const dStr = detectStructure(dSw.highs, dSw.lows);
  if (dStr === 'RANGING') return null;            // need a directional bias
  const dZone = priceZone(price, dSw.highs, dSw.lows);
  const bsl = dSw.highs.slice(-1)[0]?.p ?? price * 1.01;
  const ssl = dSw.lows.slice(-1)[0]?.p ?? price * 0.99;

  const hSw = detectSwings(hBars, 3);
  const h4Str = detectStructure(hSw.highs, hSw.lows);
  const obs = detectOBs(hBars), fvgs = detectFVGs(hBars);
  const dir = dStr === 'BULLISH' ? 'LONG' : 'SHORT';
  const relOB = (dir === 'LONG' ? obs.filter(o => o.type === 'BULL') : obs.filter(o => o.type === 'BEAR')).slice(-3);
  const relFVG = (dir === 'LONG' ? fvgs.filter(f => f.type === 'BULL') : fvgs.filter(f => f.type === 'BEAR')).slice(-3);
  const nearOB = dir === 'LONG' ? relOB.find(o => o.top < price && o.top > price * 0.995) : relOB.find(o => o.bot > price && o.bot < price * 1.005);
  const nearFVG = dir === 'LONG' ? relFVG.find(f => f.top < price && f.top > price * 0.994) : relFVG.find(f => f.bot > price && f.bot < price * 1.006);

  let smtHit = false;
  if (smtH4) {
    const sBars = smtH4.filter(b => b.time <= t).slice(-40);
    const sSw = detectSwings(sBars, 3);
    const smt = checkSMT(hSw.lows, hSw.highs, sSw.lows, sSw.highs);
    smtHit = dir === 'LONG' ? smt.bullish : smt.bearish;
  }

  const { score, factors } = scoreSetup({ dailyStr: dStr, zone: dZone.zone, h4Str, nearOB: !!nearOB, nearFVG: !!nearFVG, smt: smtHit });
  if (score < MIN_SCORE_RECORD) return null;

  // build levels
  let entry = nearFVG ? (nearFVG.top + nearFVG.bot) / 2 : nearOB ? (nearOB.top + nearOB.bot) / 2 : price;
  const atr = Math.abs(price - dZone.eq) * 0.3;
  const slDist = Math.max(atr, Math.abs(price - (dir === 'LONG' ? ssl : bsl)) * 0.5);
  if (!(slDist > 0)) return null;
  const sl = dir === 'LONG' ? entry - slDist : entry + slDist;
  const { tp1 } = validatedTargets({ dir, entry, sl, tp2: dZone.eq, tp3: dir === 'LONG' ? bsl : ssl });
  return { dir, score, factors, entry, sl, tp1, signalTime: t, session: sessionAt(t) };
}

const MAX_HOLD = 60; // 4H bars (~10 days) before a still-open trade is timed out

// ── Replay one symbol → trades ───────────────────────────────────────────────
// Each filled trade records maxR (best favourable excursion in R, SL-bar excluded
// = conservative) and hitSL. That lets outcomeR() grade the SAME trades at ANY
// target R — so we can sweep targets without re-running.
function backtestSymbol(symbol, dailyBars, h4, smtH4) {
  const trades = [];
  let pending = null, open = null;
  for (let j = DAILY_LOOKBACK; j < h4.length; j++) {
    const bar = h4[j];
    if (open) {
      const risk = Math.abs(open.entry - open.sl) || 1e-9;
      const slHit = open.dir === 'LONG' ? bar.low <= open.sl : bar.high >= open.sl;
      if (slHit) { trades.push({ ...open, maxR: open.maxR, hitSL: true }); open = null; continue; }
      const favR = (open.dir === 'LONG' ? bar.high - open.entry : open.entry - bar.low) / risk;
      open.maxR = Math.max(open.maxR, favR);
      if (j - open.fillIdx > MAX_HOLD) { trades.push({ ...open, hitSL: false, timeout: true }); open = null; }
      continue;
    }
    if (pending) {
      const fill = pending.dir === 'LONG' ? bar.low <= pending.entry : bar.high >= pending.entry;
      if (fill) { open = { ...pending, fillIdx: j, maxR: 0 }; pending = null; }
      else if (++pending.age > FILL_EXPIRY) pending = null;        // expired unfilled → no trade
      continue;
    }
    let sig = null;
    try { sig = analyzeAt(symbol, j, dailyBars, h4, smtH4); } catch { sig = null; }
    if (sig) pending = { ...sig, symbol, age: 0 };
  }
  if (open) trades.push({ ...open, hitSL: false });
  return trades;
}

// Grade a recorded trade at a given target R. null = unresolved (didn't reach
// target and never hit SL by data end → still open, excluded from stats).
function outcomeR(t, target) {
  if (t.maxR >= target) return target;
  if (t.hitSL) return -1;
  return null;
}

// ── Aggregation helpers ──────────────────────────────────────────────────────
const TARGET = 2; // default exit target (R) for the breakdowns
function summarize(trades, target = TARGET) {
  let n = 0, wins = 0, R = 0;
  for (const t of trades) {
    const o = outcomeR(t, target);
    if (o === null) continue;             // unresolved → excluded
    n++; if (o > 0) wins++; R += o;
  }
  return { n, wins, losses: n - wins, winRate: n ? wins / n : 0, totalR: R, expR: n ? R / n : 0 };
}
function groupBy(trades, keyFn, target = TARGET) {
  const m = {};
  for (const t of trades) { const k = keyFn(t); (m[k] ??= []).push(t); }
  return Object.entries(m).map(([k, ts]) => ({ key: k, ...summarize(ts, target) })).sort((a, b) => b.expR - a.expR);
}
const pct = x => (x * 100).toFixed(0) + '%';
function printGroup(title, rows, minN = 1) {
  console.log(`\n${title}`);
  console.log('  key'.padEnd(16) + 'N'.padStart(5) + 'Win%'.padStart(7) + 'TotR'.padStart(8) + 'Exp/t'.padStart(9));
  for (const r of rows.filter(r => r.n >= minN))
    console.log('  ' + String(r.key).padEnd(14) + String(r.n).padStart(5) + pct(r.winRate).padStart(7) + r.totalR.toFixed(1).padStart(8) + r.expR.toFixed(2).padStart(9) + 'R');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { getOhlcv } = await import('../src/core/data.js');
  const chart = await import('../src/core/chart.js');
  const rules = JSON.parse(readFileSync(join(ROOT, 'rules.json'), 'utf8'));
  const watchlist = rules.watchlist;
  const smtMap = rules.smt_pairs?.forex ?? {};

  async function fetchTF(symbol, tf, count) {
    await chart.setSymbol({ symbol }); await sleep(700);
    await chart.setTimeframe({ timeframe: tf }); await sleep(800);
    const d = await getOhlcv({ count }); return d?.bars ?? [];
  }

  console.log('📥 Fetching history (Daily + 4H per pair)…');
  const data = {};
  for (const symbol of watchlist) {
    const ticker = symbol.includes(':') ? symbol.split(':')[1] : symbol;
    try {
      const daily = await fetchTF(symbol, 'D', 500);
      const h4 = await fetchTF(symbol, '240', 500);
      const smtTicker = smtMap[ticker];
      let smtH4 = null;
      if (smtTicker) smtH4 = await fetchTF(`FX:${smtTicker}`, '240', 500);
      data[symbol] = { ticker, daily, h4, smtH4 };
      const span = h4.length ? ((h4.at(-1).time - h4[0].time) / 86400).toFixed(0) : 0;
      console.log(`  ${ticker.padEnd(9)} D=${daily.length} 4H=${h4.length} (${span}d)`);
    } catch (e) { console.log(`  ${ticker.padEnd(9)} ✗ ${e.message}`); }
  }

  console.log('\n⚙️  Replaying strategy…');
  let all = [];
  for (const symbol of watchlist) {
    const d = data[symbol]; if (!d || d.h4.length < 100) continue;
    const trades = backtestSymbol(d.ticker, d.daily, d.h4, d.smtH4).map(t => ({ ...t, symbol: d.ticker }));
    all = all.concat(trades);
    const s = summarize(trades);
    console.log(`  ${d.ticker.padEnd(9)} ${String(s.n).padStart(3)} trades  ${pct(s.winRate).padStart(5)} win  ${s.totalR.toFixed(1).padStart(6)}R  (${s.expR.toFixed(2)}R/trade)`);
  }

  const overall = summarize(all);
  console.log('\n' + '═'.repeat(58));
  console.log(`OVERALL: ${overall.n} trades · ${pct(overall.winRate)} win · ${overall.totalR.toFixed(1)}R · expectancy ${overall.expR.toFixed(2)}R/trade`);
  console.log('═'.repeat(58));

  printGroup('By SCORE:', groupBy(all, t => `${t.score}/6`));
  printGroup('By DIRECTION:', groupBy(all, t => t.dir));
  printGroup('By SESSION:', groupBy(all, t => t.session), 3);
  printGroup('By PAIR:', groupBy(all, t => t.symbol), 3);
  // factor lift: trades WITH each factor
  const FK = { daily_structure: 'DailyStruct', correct_zone: 'Zone', h4_confirms: '4HConfirm', near_ob: 'OB', fvg: 'FVG', smt: 'SMT' };
  console.log('\nBy FACTOR present:');
  console.log('  key'.padEnd(16) + 'N'.padStart(5) + 'Win%'.padStart(7) + 'Exp/t'.padStart(9));
  for (const [k, label] of Object.entries(FK)) {
    const s = summarize(all.filter(t => t.factors[k]));
    if (s.n) console.log('  ' + label.padEnd(14) + String(s.n).padStart(5) + pct(s.winRate).padStart(7) + s.expR.toFixed(2).padStart(9) + 'R');
  }

  // ── Target sweep: same entries, different exit R ──────────────────────────
  console.log('\nTARGET SWEEP (same entries, vary the take-profit):');
  console.log('  target'.padEnd(10) + 'N'.padStart(5) + 'Win%'.padStart(7) + 'TotR'.padStart(8) + 'Exp/t'.padStart(9));
  let best = { expR: -Infinity };
  for (const T of [1, 1.5, 2, 2.5, 3]) {
    const s = summarize(all, T);
    if (s.expR > best.expR) best = { T, ...s };
    console.log(`  ${T}R`.padEnd(10) + String(s.n).padStart(5) + pct(s.winRate).padStart(7) + s.totalR.toFixed(1).padStart(8) + s.expR.toFixed(2).padStart(8) + 'R');
  }

  console.log('\n' + '─'.repeat(58));
  console.log(`💡 Best exit target: ${best.T}R → ${pct(best.winRate)} win, ${best.expR.toFixed(2)}R/trade (${best.expR > 0 ? 'PROFITABLE' : 'still negative'})`);
  // best SHORT-only @ best target (direction was the strongest split)
  const shorts = summarize(all.filter(t => t.dir === 'SHORT'), best.T);
  console.log(`   SHORT-only @ ${best.T}R: ${pct(shorts.winRate)} win, ${shorts.expR.toFixed(2)}R/trade over ${shorts.n} trades`);
  console.log('Note: entry-fill required; SL wins 4H ties (conservative); ~70d of history, small samples.');
}

main().then(() => process.exit(0)).catch(e => { console.error('Backtest failed:', e.message); process.exit(1); });
