#!/usr/bin/env node
/**
 * ICT + MMXM Session Scanner
 *
 * Runs at London open (02:00 EST) and NY open (07:00 EST).
 * For each pair in rules.json watchlist:
 *   1. Daily: market structure, BSL/SSL, premium/discount zone
 *   2. 4H:    OB detection, FVG detection, structure confirmation
 *   3. SMT:   correlated pair divergence check
 *   4. Score: 0–6 ICT/MMXM checklist
 *
 * Top signals sent via iMessage and saved to ~/.tradingview-mcp/signals/
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import {
  recordSignals, resolveOpenSignals, recomputeWeights, loadJournal,
  edgeScore, factorsFromNotes, computeStats, writeXlsx,
} from './lib/journal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SIGNALS_DIR = join(homedir(), '.tradingview-mcp', 'signals');
const CDP_PORT = 9222;
const PHONE = '+61403644312';

let WATCHLIST = []; // set in main() from rules.json; used by checkOpenTrade()

// ── Single-instance lock ──────────────────────────────────────────────────────
// Cron + multiple launchd timers can fire near the same wall-clock minute; two
// scanners at once would both pkill/relaunch TradingView and fight over the CDP
// port. This guard makes a second concurrent run exit cleanly instead.
const LOCK_FILE = join(homedir(), '.tradingview-mcp', 'scanner.lock');
const LOCK_STALE_MS = 20 * 60 * 1000; // a healthy scan never runs this long

function acquireLock() {
  mkdirSync(join(homedir(), '.tradingview-mcp'), { recursive: true });
  if (existsSync(LOCK_FILE)) {
    try {
      const { pid, ts } = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; }       // signal 0 = existence probe
      catch (e) { if (e.code === 'EPERM') alive = true; } // exists but not ours to signal
      if (alive && ts && (Date.now() - ts) < LOCK_STALE_MS) return false; // genuine concurrent run
    } catch {} // unparseable → treat as stale, take over
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  return true;
}
function releaseLock() {
  try {
    const { pid } = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Session detection ────────────────────────────────────────────────────────
function currentSession() {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const utcMins = h * 60 + m;
  // EDT (UTC-4) applies Mar–Nov: EST times below are EDT
  // London: 02:00–05:00 EST = 06:00–09:00 UTC
  // NY:     07:00–10:00 EST = 11:00–14:00 UTC
  if (utcMins >= 360 && utcMins < 540)  return { name: 'LONDON', emoji: '🇬🇧' };
  if (utcMins >= 660 && utcMins < 840)  return { name: 'NEW YORK', emoji: '🗽' };
  if (utcMins >= 540 && utcMins < 660)  return { name: 'PRE-NY', emoji: '⏳' };
  return { name: 'OFF-SESSION', emoji: '😴' };
}

// ── Launch TradingView ───────────────────────────────────────────────────────
async function ensureTradingView() {
  const up = await new Promise(resolve => {
    http.get(`http://localhost:${CDP_PORT}/json/version`, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(!!d));
    }).on('error', () => resolve(false));
  });
  if (up) return;

  const candidates = [
    '/Applications/TradingView.app/Contents/MacOS/TradingView',
    `${homedir()}/Applications/TradingView.app/Contents/MacOS/TradingView`,
  ];
  const tvPath = candidates.find(p => existsSync(p));
  if (!tvPath) throw new Error('TradingView.app not found');

  try { execSync('pkill -f TradingView', { timeout: 3000 }); } catch {}
  await sleep(1500);

  const child = spawn(tvPath, [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const ready = await new Promise(resolve => {
      http.get(`http://localhost:${CDP_PORT}/json/version`, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(!!d));
      }).on('error', () => resolve(false));
    });
    if (ready) { console.log(`CDP ready after ${i + 1}s`); return; }
  }
  throw new Error('CDP not ready after 30s');
}

// ── Swing detection ─────────────────────────────────────────────────────────
function detectSwings(bars, len = 3) {
  const highs = [], lows = [];
  for (let i = len; i < bars.length - len; i++) {
    const b = bars[i];
    const isH = Array.from({ length: len }, (_, k) => k + 1)
      .every(k => b.high > bars[i - k].high && b.high > bars[i + k].high);
    const isL = Array.from({ length: len }, (_, k) => k + 1)
      .every(k => b.low < bars[i - k].low && b.low < bars[i + k].low);
    if (isH) highs.push({ p: b.high, t: b.time });
    if (isL)  lows.push({ p: b.low,  t: b.time });
  }
  return { highs, lows };
}

// ── Structure ────────────────────────────────────────────────────────────────
function detectStructure(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return 'RANGING';
  const rH = highs.slice(-2), rL = lows.slice(-2);
  const hh = rH[1].p > rH[0].p, hl = rL[1].p > rL[0].p;
  const ll = rL[1].p < rL[0].p, lh = rH[1].p < rH[0].p;
  if (hh && hl) return 'BULLISH';
  if (ll && lh) return 'BEARISH';
  return 'RANGING';
}

// ── OB detection ─────────────────────────────────────────────────────────────
function detectOBs(bars) {
  const obs = [];
  for (let i = 1; i < bars.length - 2; i++) {
    const b = bars[i], n1 = bars[i + 1], n2 = bars[i + 2];
    const minMove = (b.high - b.low) * 0.5;
    if (b.close < b.open && n1.close > n1.open && n2.close > n2.open && (n2.close - b.high) > minMove)
      obs.push({ type: 'BULL', top: b.high, bot: b.low, t: b.time });
    if (b.close > b.open && n1.close < n1.open && n2.close < n2.open && (b.low - n2.close) > minMove)
      obs.push({ type: 'BEAR', top: b.high, bot: b.low, t: b.time });
  }
  return obs;
}

// ── FVG detection ────────────────────────────────────────────────────────────
function detectFVGs(bars) {
  const fvgs = [];
  for (let i = 1; i < bars.length - 1; i++) {
    if (bars[i + 1].low > bars[i - 1].high)
      fvgs.push({ type: 'BULL', top: bars[i + 1].low, bot: bars[i - 1].high, t: bars[i].time });
    if (bars[i + 1].high < bars[i - 1].low)
      fvgs.push({ type: 'BEAR', top: bars[i - 1].low, bot: bars[i + 1].high, t: bars[i].time });
  }
  return fvgs;
}

// ── Premium / discount ───────────────────────────────────────────────────────
function priceZone(price, highs, lows) {
  if (!highs.length || !lows.length) return 'UNKNOWN';
  const hi = Math.max(...highs.map(h => h.p));
  const lo = Math.min(...lows.map(l => l.p));
  const eq = (hi + lo) / 2;
  return { zone: price > eq ? 'PREMIUM' : 'DISCOUNT', eq, hi, lo };
}

// ── SMT divergence ───────────────────────────────────────────────────────────
function checkSMT(mainLows, mainHighs, smtLows, smtHighs) {
  if (mainLows.length < 2 || smtLows.length < 2) return { bullish: false, bearish: false };
  const mL = mainLows.slice(-2), sL = smtLows.slice(-2);
  const mH = mainHighs.slice(-2), sH = smtHighs.slice(-2);
  // Bullish SMT: main makes LL, correlated makes HL
  const bullSMT = mL[1].p < mL[0].p && sL[1].p > sL[0].p;
  // Bearish SMT: main makes HH, correlated makes LH
  const bearSMT = mH[1].p > mH[0].p && sH[1].p < sH[0].p;
  return { bullish: bullSMT, bearish: bearSMT };
}

// ── Score a setup 0–6 ────────────────────────────────────────────────────────
function scoreSetup({ dailyStr, zone, h4Str, nearOB, nearFVG, smt, sweep }) {
  let score = 0;
  const notes = [];
  if (dailyStr !== 'RANGING') { score++; notes.push('Daily structure ' + dailyStr); }
  if ((dailyStr === 'BULLISH' && zone === 'DISCOUNT') ||
      (dailyStr === 'BEARISH' && zone === 'PREMIUM'))  { score++; notes.push('Price in correct zone'); }
  if (h4Str === dailyStr)                               { score++; notes.push('4H confirms Daily'); }
  if (nearOB)                                           { score++; notes.push('Near unmitigated OB'); }
  if (nearFVG)                                          { score++; notes.push('FVG entry zone present'); }
  if (smt)                                              { score++; notes.push('SMT divergence confirmed'); }
  return { score, notes };
}

// ── Entry levels ─────────────────────────────────────────────────────────────
// Note: scan results expose dStr / nearOB / nearFVG (not dailyStr / entryOB /
// entryFVG), so we read those field names directly here.
function buildSignal({ symbol, price, dStr, eq, bsl, ssl, nearOB, nearFVG, score }) {
  const dir = dStr === 'BULLISH' ? 'LONG' : 'SHORT';
  const entryOB = nearOB, entryFVG = nearFVG;
  const dp = price > 100 ? 2 : 5;
  const fmt = n => n.toFixed(dp);

  // Entry: prefer FVG midpoint, fallback to OB midpoint, fallback to current price
  let entryZone, entryLabel;
  if (entryFVG) {
    entryZone = (entryFVG.top + entryFVG.bot) / 2;
    entryLabel = 'FVG ' + fmt(entryFVG.bot) + '–' + fmt(entryFVG.top);
  } else if (entryOB) {
    entryZone = (entryOB.top + entryOB.bot) / 2;
    entryLabel = 'OB ' + fmt(entryOB.bot) + '–' + fmt(entryOB.top);
  } else {
    entryZone = price;
    entryLabel = 'Market ' + fmt(price);
  }

  const atrApprox = Math.abs(price - eq) * 0.3; // rough ATR proxy
  const slDist = Math.max(atrApprox, Math.abs(price - (dir === 'LONG' ? ssl : bsl)) * 0.5);

  const stop = dir === 'LONG' ? entryZone - slDist : entryZone + slDist;
  const tp1  = dir === 'LONG' ? entryZone + slDist * 2 : entryZone - slDist * 2;
  const tp2  = dir === 'LONG' ? eq                      : eq;
  const tp3  = dir === 'LONG' ? bsl                     : ssl;

  const pips = n => Math.round(Math.abs(n - entryZone) * (price > 100 ? 10 : 10000));

  // Has price already pulled into the entry zone? (within ~15 pips / 0.15%)
  const atEntry = Math.abs(price - entryZone) / price <= 0.0015;

  return {
    symbol, dir, score, price: fmt(price),
    entry: fmt(entryZone), entryLabel,
    stop: fmt(stop),  riskPips: pips(stop),
    tp1:  fmt(tp1),   r1: (pips(tp1) / pips(stop)).toFixed(1),
    tp2:  fmt(tp2),   r2: (pips(tp2) / pips(stop)).toFixed(1),
    tp3:  fmt(tp3),   r3: (pips(tp3) / pips(stop)).toFixed(1),
    // numeric values for the journal / learning layer
    priceNum: price, entryNum: entryZone, stopNum: stop,
    tp1Num: tp1, tp2Num: tp2, tp3Num: tp3, atEntry,
  };
}

// ── Previous session recap helpers ───────────────────────────────────────────
function findPreviousSessionFile() {
  if (!existsSync(SIGNALS_DIR)) return null;
  const files = readdirSync(SIGNALS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();

  const nowMs = Date.now();
  for (const file of files) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
    if (!m) continue;
    const fileMs = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`).getTime();
    if (nowMs - fileMs < 10 * 60 * 1000) continue; // skip last 10 min (current run)
    const content = readFileSync(join(SIGNALS_DIR, file), 'utf8');
    if (!content.includes('/6]')) continue; // no signal blocks
    if (content.includes('No qualifying setups')) continue;
    return { file, content, signalTime: new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`) };
  }
  return null;
}

function parseSignalsFromContent(content, signalTime) {
  const signals = [];
  let cur = null;
  for (const line of content.split('\n')) {
    const hm = line.match(/[🟢🔴]\s+(LONG|SHORT)\s+([A-Z0-9.]+)\s+\[(\d+)\/6\]/);
    if (hm) {
      if (cur) signals.push(cur);
      cur = { dir: hm[1], symbol: hm[2], score: +hm[3], signalTime, sl: null, tp1: null, tp2: null, tp3: null };
      continue;
    }
    if (!cur) continue;
    const sl = line.match(/SL:\s+([\d.]+)/);    if (sl)  { cur.sl  = +sl[1];  continue; }
    const t1 = line.match(/TP1:\s+([\d.]+)/);   if (t1)  { cur.tp1 = +t1[1];  continue; }
    const t2 = line.match(/TP2:\s+([\d.]+)/);   if (t2)  { cur.tp2 = +t2[1];  continue; }
    const t3 = line.match(/TP3:\s+([\d.]+)/);   if (t3)  { cur.tp3 = +t3[1];  continue; }
    const why = line.match(/Why:\s+(.+)/);      if (why) { cur.notes = why[1].split('·').map(s => s.trim()); continue; }
  }
  if (cur) signals.push(cur);
  return signals.filter(s => s.sl && s.tp1);
}

// One-time seed: import the latest .md signal file into the journal so tracking
// starts with real history rather than an empty slate.
function bootstrapJournalFromMd(watchlist) {
  if (loadJournal().length > 0) return;
  const prev = findPreviousSessionFile();
  if (!prev) return;
  const sigs = parseSignalsFromContent(prev.content, prev.signalTime);
  if (!sigs.length) return;
  const payload = sigs.map(s => ({
    symbol: s.symbol, dir: s.dir, score: s.score, notes: s.notes ?? [],
    entry: (s.tp1 + 2 * s.sl) / 3, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3,
    smtHit: (s.notes ?? []).some(n => n.includes('SMT')), riskPips: null,
  }));
  const r = recordSignals(payload, 'BOOTSTRAP', prev.signalTime);
  console.log(`  Bootstrapped journal from ${prev.file}: +${r.added} trades`);
}

// Chronological first-touch check for one open journal record.
// Walks 1H bars from signal time forward and records the ORDER in which SL/TPs
// are touched — so a trade that hit TP1 before SL is a win, not a loss.
// Returns { firstHit, levelsHit, currentPrice, currentPips } for journal.resolveOpenSignals.
async function checkOpenTrade(rec, chart, getOhlcv) {
  const fullSymbol = WATCHLIST.find(s => s.endsWith(`:${rec.symbol}`)) ?? `FX:${rec.symbol}`;
  await chart.setSymbol({ symbol: fullSymbol }); await sleep(700);
  await chart.setTimeframe({ timeframe: '60' }); await sleep(700);
  const data = await getOhlcv({ count: 200 });
  if (!data?.bars?.length) throw new Error('no bars');

  const bars = data.bars;
  const currentPrice = bars[bars.length - 1].close;
  const barsAfter = bars.filter(b => b.time > rec.ts);
  const checkBars = barsAfter.length > 0 ? barsAfter : bars.slice(-8);

  const { dir, sl, tp1, tp2, tp3 } = rec;
  let firstHit = null;
  const levelsHit = [];
  const hit = (lvl) => { if (!levelsHit.includes(lvl)) levelsHit.push(lvl); };

  for (const bar of checkBars) {
    const slTouch  = dir === 'LONG' ? bar.low  <= sl  : bar.high >= sl;
    const tp1Touch = dir === 'LONG' ? bar.high >= tp1 : bar.low  <= tp1;
    const tp2Touch = tp2 != null && (dir === 'LONG' ? bar.high >= tp2 : bar.low <= tp2);
    const tp3Touch = tp3 != null && (dir === 'LONG' ? bar.high >= tp3 : bar.low <= tp3);

    // Determine first decisive touch (SL vs TP1) for win/loss attribution.
    if (!firstHit && (slTouch || tp1Touch)) firstHit = (tp1Touch && !slTouch) ? 'TP1' : (slTouch && !tp1Touch) ? 'SL' : 'TP1';
    if (tp1Touch) hit('TP1');
    if (tp2Touch) hit('TP2');
    if (tp3Touch) hit('TP3');
    // Once SL is the decided outcome (no TP reached first), stop counting further TPs.
    if (firstHit === 'SL') break;
  }

  const mult = currentPrice > 100 ? 10 : 10000;
  const currentPips = dir === 'LONG'
    ? Math.round((currentPrice - rec.entry) * mult)
    : Math.round((rec.entry - currentPrice) * mult);

  return { firstHit, levelsHit, currentPrice, currentPips };
}

// ── Analyse one symbol ────────────────────────────────────────────────────────
async function analyseSymbol(symbol, smtSymbol, chart, getOhlcv) {
  try {
    // Daily
    await chart.setSymbol({ symbol }); await sleep(800);
    await chart.setTimeframe({ timeframe: 'D' }); await sleep(800);
    const dData = await getOhlcv({ count: 50 });
    const dBars = dData?.bars ?? [];
    if (dBars.length < 20) return null;

    const dPrice  = dBars[dBars.length - 1].close;
    const dSwings = detectSwings(dBars, 3);
    const dStr    = detectStructure(dSwings.highs, dSwings.lows);
    const dZone   = priceZone(dPrice, dSwings.highs, dSwings.lows);
    const bsl     = dSwings.highs.slice(-1)[0]?.p ?? dPrice * 1.01;
    const ssl     = dSwings.lows.slice(-1)[0]?.p  ?? dPrice * 0.99;

    // 4H
    await chart.setTimeframe({ timeframe: '240' }); await sleep(800);
    const hData = await getOhlcv({ count: 60 });
    const hBars = hData?.bars ?? [];
    const h4Swings = detectSwings(hBars, 3);
    const h4Str    = detectStructure(h4Swings.highs, h4Swings.lows);
    const obs      = detectOBs(hBars);
    const fvgs     = detectFVGs(hBars);

    // Find nearest OB and FVG in the right direction
    const dir      = dStr === 'BULLISH' ? 'LONG' : 'SHORT';
    const bullOBs  = obs.filter(o => o.type === 'BULL').slice(-3);
    const bearOBs  = obs.filter(o => o.type === 'BEAR').slice(-3);
    const bullFVGs = fvgs.filter(f => f.type === 'BULL').slice(-3);
    const bearFVGs = fvgs.filter(f => f.type === 'BEAR').slice(-3);

    const relevantOBs  = dir === 'LONG' ? bullOBs  : bearOBs;
    const relevantFVGs = dir === 'LONG' ? bullFVGs : bearFVGs;

    // For longs: OB/FVG must be BELOW current price (pullback zone)
    const nearOB  = dir === 'LONG'
      ? relevantOBs.find(o  => o.top < dPrice && o.top > dPrice * 0.995)
      : relevantOBs.find(o  => o.bot > dPrice && o.bot < dPrice * 1.005);
    const nearFVG = dir === 'LONG'
      ? relevantFVGs.find(f => f.top < dPrice && f.top > dPrice * 0.994)
      : relevantFVGs.find(f => f.bot > dPrice && f.bot < dPrice * 1.006);

    // SMT check
    let smt = { bullish: false, bearish: false };
    if (smtSymbol) {
      await chart.setSymbol({ symbol: smtSymbol }); await sleep(700);
      await chart.setTimeframe({ timeframe: '240' });   await sleep(700);
      const smtData   = await getOhlcv({ count: 40 });
      const smtBars   = smtData?.bars ?? [];
      const smtSwings = detectSwings(smtBars, 3);
      smt = checkSMT(h4Swings.lows, h4Swings.highs, smtSwings.lows, smtSwings.highs);
      // Restore symbol
      await chart.setSymbol({ symbol }); await sleep(500);
      await chart.setTimeframe({ timeframe: '240' }); await sleep(500);
    }

    const smtHit = dir === 'LONG' ? smt.bullish : smt.bearish;
    const { score, notes } = scoreSetup({
      dailyStr: dStr,
      zone:     dZone.zone ?? 'UNKNOWN',
      h4Str,
      nearOB:   !!nearOB,
      nearFVG:  !!nearFVG,
      smt:      smtHit,
      sweep:    false,
    });

    return {
      symbol, dStr, h4Str,
      zone: dZone.zone ?? 'UNKNOWN',
      eq:   dZone.eq,
      bsl, ssl,
      price: dPrice,
      nearOB, nearFVG,
      smtHit, score, notes,
      dir: dStr === 'BULLISH' ? 'LONG' : dStr === 'BEARISH' ? 'SHORT' : null,
    };
  } catch (e) {
    console.error(`  ✗ ${symbol}: ${e.message}`);
    return null;
  }
}

// ── iMessage ─────────────────────────────────────────────────────────────────
function sendIMessage(phone, text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').split('\n').join('" & return & "');
  const script = `tell application "Messages"\nset s to 1st service whose service type = iMessage\nset b to buddy "${phone}" of s\nsend "${escaped}" to b\nend tell`;
  const tmp = join(homedir(), '.tradingview-mcp', 'imessage.applescript');
  writeFileSync(tmp, script);
  execSync(`osascript "${tmp}"`);
}

// ── Format price ──────────────────────────────────────────────────────────────
function fmt(n, ref) {
  if (!n && n !== 0) return '?';
  if (ref > 100) return Number(n).toFixed(2);
  return Number(n).toFixed(5);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const session = currentSession();
  const nowStr  = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne', dateStyle: 'short', timeStyle: 'short',
  });

  console.log(`\n📡 ICT/MMXM Session Scanner — ${session.emoji} ${session.name}  |  ${nowStr}`);
  console.log('─'.repeat(60));

  await ensureTradingView();
  await sleep(3000);

  const { getOhlcv }  = await import('../src/core/data.js');
  const chart         = await import('../src/core/chart.js');
  const rules         = JSON.parse(readFileSync(join(PROJECT_ROOT, 'rules.json'), 'utf8'));
  const { watchlist, smt_pairs } = rules;
  const smtMap        = smt_pairs?.forex ?? {};
  WATCHLIST = watchlist;

  // ── Resolve open trades from the journal (learning / recap) ────────────────
  // One-time bootstrap: seed the journal from the latest .md signal file so we
  // start tracking immediately instead of from an empty slate.
  bootstrapJournalFromMd(watchlist);

  const recapLines = [];
  console.log('\n📋 Open Trade Recap (journal)');
  console.log('─'.repeat(60));
  recapLines.push('📋 Open Trade Recap', '─'.repeat(60), '');

  const resolved = await resolveOpenSignals(
    rec => { process.stdout.write(`  Checking ${rec.symbol.padEnd(10)}`); return checkOpenTrade(rec, chart, getOhlcv); },
  );

  if (resolved.length === 0) {
    console.log('  (no open trades tracked yet — journal will fill as signals fire)');
    recapLines.push('No open trades tracked yet.', '');
  } else {
    let justWon = 0, justLost = 0, openProfit = 0, openLoss = 0, openFlat = 0;
    for (const r of resolved) {
      const dirIcon = r.dir === 'LONG' ? '🟢' : '🔴';
      const pipsStr = r.currentPips != null ? `${r.currentPips > 0 ? '+' : ''}${r.currentPips} pips` : '';
      let label, icon;
      switch (r.liveStatus) {
        case 'TP3': label = 'WIN 🏆  TP3 — full DOL target'; icon = '🏆'; justWon++; break;
        case 'TP2': label = 'WIN ✅✅ TP2 reached';          icon = '✅'; justWon++; break;
        case 'TP1': label = 'WIN ✅  TP1 — min objective';   icon = '✅'; justWon++; break;
        case 'LOSS':      label = `LOSS ❌  stop hit`;        icon = '❌'; justLost++; break;
        case 'PROFIT':    label = `open — in profit  ${pipsStr}`; icon = '🟢'; openProfit++; break;
        case 'LOSS_OPEN': label = `open — at loss    ${pipsStr}`; icon = '🔴'; openLoss++; break;
        case 'FLAT':      label = `open — flat        ${pipsStr}`; icon = '⚪'; openFlat++; break;
        case 'EXPIRED':   label = `expired (no fill in window)`; icon = '⏱'; break;
        default:          label = r.liveStatus + (r.error ? ` (${r.error})` : ''); icon = '⚠️';
      }
      console.log(`  ${icon} ${r.symbol.padEnd(8)} ${r.dir.padEnd(5)} ${label}`);
      recapLines.push(`${dirIcon} ${r.dir} ${r.symbol} [${r.score}/6] — ${label}`);
      if (r.levelsHit?.length) recapLines.push(`  Levels hit: ${r.levelsHit.join(' ')}  R: ${r.rMultiple ?? '?'}`);
      recapLines.push('');
    }
    const summary = `Resolved this run: ${justWon}W / ${justLost}L  ·  Still open: ${openProfit}🟢 ${openLoss}🔴 ${openFlat}⚪`;
    console.log(`\n  ${summary}`);
    recapLines.push(summary, '─'.repeat(60), '');
  }

  // Recompute adaptive weights from everything resolved so far.
  const { weights, learning, resolved: resolvedCount } = recomputeWeights();
  console.log(`\n🧠 Adaptive scoring: ${learning ? 'ACTIVE' : 'warming up'} (${resolvedCount} resolved trades)`);

  const results = [];

  for (const symbol of watchlist) {
    const ticker    = symbol.includes(':') ? symbol.split(':')[1] : symbol;
    const smtSymbol = smtMap[ticker] ? `FX:${smtMap[ticker]}` : null;
    process.stdout.write(`  Scanning ${ticker.padEnd(10)}`);
    const r = await analyseSymbol(symbol, smtSymbol, chart, getOhlcv);
    if (!r) { console.log('  skip'); continue; }
    r.edge = edgeScore(factorsFromNotes(r.notes), weights);
    const bar = '█'.repeat(r.score) + '░'.repeat(6 - r.score);
    console.log(`  ${r.dStr.padEnd(8)} | ${r.zone.padEnd(9)} | 4H:${r.h4Str.padEnd(8)} | [${bar}] ${r.score}/6  edge ${r.edge.toFixed(1)}  ${r.smtHit ? '⚡SMT' : ''}`);
    results.push(r);
    await sleep(300);
  }

  // Rank by learned edge (falls back to raw score while warming up).
  results.sort((a, b) => b.edge - a.edge || b.score - a.score);
  const signals = results.filter(r => r.score >= 3 && r.dir);

  // Attach built signal details + record to journal.
  const built = signals.map(r => ({ r, sig: buildSignal(r) }));
  const recordPayload = built.map(({ r, sig }) => ({
    symbol: r.symbol.split(':')[1] ?? r.symbol, dir: sig.dir, score: r.score, notes: r.notes,
    entry: sig.entryNum, sl: sig.stopNum, tp1: sig.tp1Num, tp2: sig.tp2Num, tp3: sig.tp3Num,
    smtHit: r.smtHit, riskPips: sig.riskPips,
  }));
  const rec = recordSignals(recordPayload, session.name);

  // Actionable = the "place a trade now" set: score >= 4 OR price already at entry.
  const actionable = built.filter(({ r, sig }) => r.score >= 4 || sig.atEntry);

  console.log(`\n✅ Scan complete — ${signals.length} signal(s) ≥3/6 · ${actionable.length} actionable (≥4 or at entry)`);
  console.log(`   Journal: +${rec.added} new, ${rec.updated} still-open updated\n`);

  // ── Build report ────────────────────────────────────────────────────────────
  const lines = [
    `📡 ICT/MMXM Scanner — ${session.emoji} ${session.name} | ${nowStr}`,
    `Scanned ${watchlist.length} pairs · ${signals.length} signal(s)`,
    '',
    ...recapLines,
  ];

  if (signals.length === 0) {
    lines.push('⚪ No qualifying setups this session.');
    lines.push('All pairs scored < 3/6 — conditions not aligned.');
    lines.push('');
    lines.push('Mark Douglas: Not trading because conditions are not met IS the correct decision.');
  } else {
    if (actionable.length) {
      lines.push(`🔥 ${actionable.length} ACTIONABLE NOW (score ≥4 or price at entry):`, '');
    }
    for (const { r, sig } of built) {
      const icon = sig.dir === 'LONG' ? '🟢' : '🔴';
      const act = (r.score >= 4 || sig.atEntry)
        ? `  🔥 ${sig.atEntry ? 'PRICE AT ENTRY' : 'HIGH CONVICTION'}` : '';
      lines.push(`${icon} ${sig.dir} ${sig.symbol.split(':')[1] ?? sig.symbol}  [${sig.score}/6 · edge ${r.edge.toFixed(1)}]${act}`);
      lines.push(`  Price:  ${sig.price}  |  Entry: ${sig.entryLabel}`);
      lines.push(`  SL:     ${sig.stop}  (${sig.riskPips} pip risk)`);
      lines.push(`  TP1:    ${sig.tp1}  (${sig.r1}:1 R:R)`);
      lines.push(`  TP2:    ${sig.tp2}  (${sig.r2}:1 R:R)`);
      lines.push(`  TP3:    ${sig.tp3}  (${sig.r3}:1 — DOL target)`);
      lines.push(`  Why:    ${r.notes.join(' · ')}`);
      if (r.smtHit) lines.push(`  ⚡ SMT divergence confirmed on correlated pair`);
      lines.push('');
    }
    lines.push('Trigger: Wait for price to reach entry zone + 15m CHoCH before entering.');
    lines.push('Accept full stop risk before clicking. This is 1 of your next 20 trades.');
  }

  const report = lines.join('\n');
  console.log(report);

  // Update the reviewable trade journal (.xlsx)
  try {
    const xlsxPath = writeXlsx();
    const stats = computeStats();
    console.log(`📒 Journal: ${xlsxPath}  (${stats.resolved} resolved · ${stats.resolved ? (stats.winRate * 100).toFixed(0) : 0}% win · ${stats.totalR > 0 ? '+' : ''}${stats.totalR}R)`);
  } catch (e) {
    console.error(`xlsx write failed: ${e.message}`);
  }

  // Save to file
  mkdirSync(SIGNALS_DIR, { recursive: true });
  const dateKey = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const outFile = join(SIGNALS_DIR, `${dateKey}-${session.name.replace(' ', '-')}.md`);
  writeFileSync(outFile, report);
  console.log(`\nSaved: ${outFile}`);

  // macOS notification — loud (with sound) only when there's something to act on.
  try {
    const recapSummary = recapLines.find(l => l.startsWith('Resolved this run:')) || '';
    const notifMsg = actionable.length
      ? `🔥 ${actionable.length} to place: ${actionable.slice(0, 3).map(({ sig }) => sig.symbol.split(':')[1]).join(', ')}`
      : `${signals.length} on radar · ${recapSummary.replace('Resolved this run: ', '') || 'nothing actionable'}`;
    const sound = actionable.length ? ' sound name "Glass"' : '';
    execSync(`osascript -e 'display notification "${notifMsg}" with title "ICT Scanner — ${session.name}" subtitle "${nowStr}"${sound}'`);
  } catch {}

  // iMessage — only text the "place a trade" alert when actionable; otherwise a
  // quiet status line so you're not pinged every 4 hours for nothing.
  try {
    const recapSummary = recapLines.find(l => l.startsWith('Resolved this run:'));
    if (actionable.length === 0) {
      const quiet = [
        `📡 ICT Scanner — ${session.emoji} ${session.name} · ${nowStr}`,
        recapSummary ? `📋 ${recapSummary}` : null,
        `⚪ Nothing actionable (${signals.length} on radar <4/6, none at entry). Sitting on hands.`,
      ].filter(Boolean);
      sendIMessage(PHONE, quiet.join('\n'));
      console.log('📱 iMessage sent (quiet status)');
    } else {
      const msgLines = [
        `🔥 ICT Scanner — PLACE TRADE`,
        `${session.emoji} ${session.name} · ${nowStr}`,
        recapSummary ? `📋 ${recapSummary}` : null,
        '',
      ].filter(Boolean);
      for (const { r, sig } of actionable.slice(0, 4)) {
        const icon = sig.dir === 'LONG' ? '🟢' : '🔴';
        const tag = sig.atEntry ? '🔥 AT ENTRY' : '🔥 ≥4/6';
        msgLines.push(`${icon} ${sig.dir} ${sig.symbol.split(':')[1] ?? sig.symbol} [${sig.score}/6 · edge ${r.edge.toFixed(1)}] ${tag}`);
        msgLines.push(`Entry: ${sig.entry}  SL: ${sig.stop}`);
        msgLines.push(`TP1: ${sig.tp1} (${sig.r1}:1)  TP3: ${sig.tp3} (${sig.r3}:1)`);
        if (r.smtHit) msgLines.push(`⚡ SMT confirmed`);
        msgLines.push('');
      }
      msgLines.push('Wait for 15m CHoCH at entry. Accept full stop risk first.');
      sendIMessage(PHONE, msgLines.join('\n'));
      console.log('📱 iMessage sent (TRADE ALERT)');
    }
  } catch (e) {
    console.error(`iMessage failed: ${e.message}`);
  }
}

if (!acquireLock()) {
  console.log('⏭  Another scan is already running — exiting to avoid TradingView/CDP conflict.');
  process.exit(0);
}
process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

main()
  .then(() => releaseLock())
  .catch(err => {
    releaseLock();
    console.error('Scanner failed:', err.message);
    try {
      execSync(`osascript -e 'display notification "${err.message.slice(0, 80)}" with title "Scanner FAILED" sound name "Basso"'`);
    } catch {}
    process.exit(1);
  });
