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

import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SIGNALS_DIR = join(homedir(), '.tradingview-mcp', 'signals');
const CDP_PORT = 9222;
const PHONE = '+61403644312';

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
function buildSignal({ symbol, price, dailyStr, eq, bsl, ssl, entryOB, entryFVG, score }) {
  const dir = dailyStr === 'BULLISH' ? 'LONG' : 'SHORT';
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

  return {
    symbol, dir, score, price: fmt(price),
    entry: fmt(entryZone), entryLabel,
    stop: fmt(stop),  riskPips: pips(stop),
    tp1:  fmt(tp1),   r1: (pips(tp1) / pips(stop)).toFixed(1),
    tp2:  fmt(tp2),   r2: (pips(tp2) / pips(stop)).toFixed(1),
    tp3:  fmt(tp3),   r3: (pips(tp3) / pips(stop)).toFixed(1),
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
  }
  if (cur) signals.push(cur);
  return signals.filter(s => s.sl && s.tp1);
}

async function checkSignalStatus(sig, fullSymbol, chart, getOhlcv) {
  try {
    await chart.setSymbol({ symbol: fullSymbol }); await sleep(700);
    await chart.setTimeframe({ timeframe: '60' }); await sleep(700);
    const data = await getOhlcv({ count: 48 });
    if (!data?.bars?.length) return { ...sig, status: 'NO_DATA', entry: null, currentPrice: null, currentPips: 0 };

    const bars = data.bars;
    const currentPrice = bars[bars.length - 1].close;
    // Reconstruct entry: for both LONG and SHORT, entry = (tp1 + 2*sl) / 3
    const entry = (sig.tp1 + 2 * sig.sl) / 3;

    const signalTs = sig.signalTime.getTime() / 1000;
    const barsAfter = bars.filter(b => b.time > signalTs);
    const checkBars = barsAfter.length > 0 ? barsAfter : bars.slice(-8);

    const { dir, sl, tp1, tp2, tp3 } = sig;
    let slHit = false, tp1Hit = false, tp2Hit = false, tp3Hit = false;
    for (const bar of checkBars) {
      if (dir === 'LONG') {
        if (bar.low  <= sl)        slHit  = true;
        if (bar.high >= tp1)       tp1Hit = true;
        if (tp2 && bar.high >= tp2) tp2Hit = true;
        if (tp3 && bar.high >= tp3) tp3Hit = true;
      } else {
        if (bar.high >= sl)        slHit  = true;
        if (bar.low  <= tp1)       tp1Hit = true;
        if (tp2 && bar.low  <= tp2) tp2Hit = true;
        if (tp3 && bar.low  <= tp3) tp3Hit = true;
      }
    }

    const mult = currentPrice > 100 ? 10 : 10000;
    const currentPips = dir === 'LONG'
      ? Math.round((currentPrice - entry) * mult)
      : Math.round((entry - currentPrice) * mult);

    let status;
    if      (tp3Hit) status = 'TP3';
    else if (tp2Hit) status = 'TP2';
    else if (tp1Hit) status = 'TP1';
    else if (slHit)  status = 'SL';
    else if (currentPips >  5) status = 'PROFIT';
    else if (currentPips < -5) status = 'LOSS';
    else                       status = 'FLAT';

    return { ...sig, status, entry, currentPrice, currentPips, slHit, tp1Hit, tp2Hit, tp3Hit };
  } catch (e) {
    return { ...sig, status: 'ERR', error: e.message, entry: null, currentPrice: null, currentPips: 0 };
  }
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

  // ── Previous session signal recap ─────────────────────────────────────────
  const prevSession = findPreviousSessionFile();
  const recapLines = [];

  if (prevSession) {
    const prevSigs = parseSignalsFromContent(prevSession.content, prevSession.signalTime);
    const prevTimeStr = prevSession.signalTime.toLocaleString('en-AU', {
      timeZone: 'Australia/Melbourne', dateStyle: 'short', timeStyle: 'short',
    });
    const recapHeader = `📋 Previous Session Recap — ${prevTimeStr} (${prevSigs.length} signal(s))`;
    console.log(`\n${recapHeader}`);
    console.log('─'.repeat(60));
    recapLines.push(recapHeader, '─'.repeat(60), '');

    const recapResults = [];
    for (const sig of prevSigs) {
      const fullSymbol = watchlist.find(s => s.endsWith(`:${sig.symbol}`)) ?? `FX:${sig.symbol}`;
      process.stdout.write(`  Checking ${sig.symbol.padEnd(10)}`);
      const checked = await checkSignalStatus(sig, fullSymbol, chart, getOhlcv);
      recapResults.push(checked);

      const statusIcon = { TP3:'🏆', TP2:'✅✅', TP1:'✅', SL:'❌', PROFIT:'🟢', LOSS:'🔴', FLAT:'⚪', NO_DATA:'❓', ERR:'⚠️' }[checked.status] ?? '?';
      const dirIcon    = sig.dir === 'LONG' ? '🟢' : '🔴';
      const entryStr   = checked.entry    != null ? fmt(checked.entry,    checked.entry)    : '?';
      const currStr    = checked.currentPrice != null ? fmt(checked.currentPrice, checked.currentPrice) : '?';
      const pipsSign   = checked.currentPips > 0 ? '+' : '';
      const pipsStr    = checked.currentPips != null ? `${pipsSign}${checked.currentPips} pips` : '';

      let statusLabel;
      if      (checked.status === 'TP3')    statusLabel = `TP3 HIT 🏆  Full DOL target reached`;
      else if (checked.status === 'TP2')    statusLabel = `TP2 HIT ✅✅ Strong runner`;
      else if (checked.status === 'TP1')    statusLabel = `TP1 HIT ✅  Minimum objective met`;
      else if (checked.status === 'SL')     statusLabel = `SL HIT ❌  (now ${pipsStr})`;
      else if (checked.status === 'PROFIT') statusLabel = `Still open — IN PROFIT  ${pipsStr}`;
      else if (checked.status === 'LOSS')   statusLabel = `Still open — AT LOSS    ${pipsStr}`;
      else if (checked.status === 'FLAT')   statusLabel = `Still open — FLAT       ${pipsStr}`;
      else                                  statusLabel = checked.status;

      console.log(`  ${statusIcon} ${checked.status.padEnd(6)} ${statusLabel}`);

      recapLines.push(`${dirIcon} ${sig.dir} ${sig.symbol} [${sig.score}/6] — ${statusLabel}`);
      recapLines.push(`  Entry: ${entryStr}  Now: ${currStr}  SL: ${fmt(sig.sl, sig.sl)}  TP1: ${fmt(sig.tp1, sig.tp1)}`);
      if (checked.tp1Hit || checked.tp2Hit || checked.tp3Hit) {
        const hit = [checked.tp1Hit && 'TP1', checked.tp2Hit && 'TP2', checked.tp3Hit && 'TP3'].filter(Boolean).join(' ');
        recapLines.push(`  Levels hit: ${hit}`);
      }
      recapLines.push('');
      await sleep(200);
    }

    const wins   = recapResults.filter(r => ['TP3','TP2','TP1','PROFIT'].includes(r.status)).length;
    const losses = recapResults.filter(r => r.status === 'SL' || r.status === 'LOSS').length;
    const flat   = recapResults.length - wins - losses;
    const summary = `Score: ${wins}W / ${losses}L / ${flat} flat  (${recapResults.length} signals checked)`;
    console.log(`\n  ${summary}`);
    recapLines.push(summary, '─'.repeat(60), '');
  }

  const results = [];

  for (const symbol of watchlist) {
    const ticker    = symbol.includes(':') ? symbol.split(':')[1] : symbol;
    const smtSymbol = smtMap[ticker] ? `FX:${smtMap[ticker]}` : null;
    process.stdout.write(`  Scanning ${ticker.padEnd(10)}`);
    const r = await analyseSymbol(symbol, smtSymbol, chart, getOhlcv);
    if (!r) { console.log('  skip'); continue; }
    const bar = '█'.repeat(r.score) + '░'.repeat(6 - r.score);
    console.log(`  ${r.dStr.padEnd(8)} | ${r.zone.padEnd(9)} | 4H:${r.h4Str.padEnd(8)} | [${bar}] ${r.score}/6  ${r.smtHit ? '⚡SMT' : ''}`);
    results.push(r);
    await sleep(300);
  }

  // Sort by score desc
  results.sort((a, b) => b.score - a.score);
  const signals = results.filter(r => r.score >= 3 && r.dir);

  console.log(`\n✅ Scan complete — ${signals.length} signal(s) found (score ≥ 3)\n`);

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
    for (const r of signals) {
      const sig = buildSignal(r);
      const icon = sig.dir === 'LONG' ? '🟢' : '🔴';
      lines.push(`${icon} ${sig.dir} ${sig.symbol.split(':')[1] ?? sig.symbol}  [${sig.score}/6]`);
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

  // Save to file
  mkdirSync(SIGNALS_DIR, { recursive: true });
  const dateKey = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const outFile = join(SIGNALS_DIR, `${dateKey}-${session.name.replace(' ', '-')}.md`);
  writeFileSync(outFile, report);
  console.log(`\nSaved: ${outFile}`);

  // macOS notification
  try {
    const notifMsg = signals.length
      ? `${signals.length} signal(s): ${signals.slice(0, 3).map(r => r.symbol.split(':')[1]).join(', ')}`
      : 'No signals this session';
    execSync(`osascript -e 'display notification "${notifMsg}" with title "ICT Scanner — ${session.name}" subtitle "${nowStr}"'`);
  } catch {}

  // iMessage
  try {
    const msgLines = [
      `📡 ICT Scanner — ${session.emoji} ${session.name}`,
      `${nowStr}`,
      `${signals.length} signal(s) from ${watchlist.length} pairs`,
      '',
    ];
    // Prepend previous session recap summary if available
    if (recapLines.length > 0) {
      const summaryLine = recapLines.find(l => l.startsWith('Score:'));
      if (summaryLine) {
        msgLines.push(`📋 Prev session: ${summaryLine}`);
        msgLines.push('');
      }
    }
    if (signals.length === 0) {
      msgLines.push('⚪ No setups — sit on hands.');
    } else {
      for (const r of signals.slice(0, 4)) {
        const sig = buildSignal(r);
        const icon = sig.dir === 'LONG' ? '🟢' : '🔴';
        msgLines.push(`${icon} ${sig.dir} ${sig.symbol.split(':')[1] ?? sig.symbol} [${sig.score}/6]`);
        msgLines.push(`Entry: ${sig.entry}  SL: ${sig.stop}`);
        msgLines.push(`TP1: ${sig.tp1} (${sig.r1}:1)  TP3: ${sig.tp3} (${sig.r3}:1)`);
        if (r.smtHit) msgLines.push(`⚡ SMT confirmed`);
        msgLines.push('');
      }
    }
    sendIMessage(PHONE, msgLines.join('\n'));
    console.log('📱 iMessage sent');
  } catch (e) {
    console.error(`iMessage failed: ${e.message}`);
  }
}

main().catch(err => {
  console.error('Scanner failed:', err.message);
  try {
    execSync(`osascript -e 'display notification "${err.message.slice(0, 80)}" with title "Scanner FAILED" sound name "Basso"'`);
  } catch {}
  process.exit(1);
});
