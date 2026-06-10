/**
 * Trade journal + adaptive learning for the ICT/MMXM scanner.
 *
 * Persists every signal the scanner ever emits, auto-resolves each one's
 * outcome (win/loss via first-touch of SL vs TP), learns which confluence
 * factors actually win over time, and exports a reviewable .xlsx.
 *
 * Storage (under ~/.tradingview-mcp/journal/):
 *   signals.json        — cumulative array of all signal records
 *   weights.json        — learned per-factor weights (adaptive scoring)
 *   trade-journal.xlsx  — human-reviewable sheet (Signals + Stats)
 *
 * No third-party deps: the .xlsx writer builds the ZIP container by hand.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

export const JOURNAL_DIR = join(homedir(), '.tradingview-mcp', 'journal');
const SIGNALS_FILE = join(JOURNAL_DIR, 'signals.json');
const WEIGHTS_FILE = join(JOURNAL_DIR, 'weights.json');
const XLSX_FILE    = join(JOURNAL_DIR, 'trade-journal.xlsx');

// Canonical confluence factors, keyed; label = how it appears in `notes`.
export const FACTORS = [
  { key: 'daily_structure', match: 'Daily structure',          label: 'Daily Struct' },
  { key: 'correct_zone',    match: 'Price in correct zone',     label: 'Zone' },
  { key: 'h4_confirms',     match: '4H confirms Daily',         label: '4H Confirm' },
  { key: 'near_ob',         match: 'Near unmitigated OB',       label: 'OB' },
  { key: 'fvg',             match: 'FVG entry zone present',    label: 'FVG' },
  { key: 'smt',             match: 'SMT divergence confirmed',  label: 'SMT' },
];

const MIN_SAMPLES   = 5;            // min resolved trades w/ a factor before its win-rate is trusted
const MIN_RESOLVED  = 8;            // min total resolved trades before weights deviate from 1.0
const EXPIRE_DAYS   = 10;           // open trades older than this with no SL/TP touch → EXPIRED
const DEDUP_PCT     = 0.003;        // same symbol+dir within 0.3% entry = same trade, not a new one

// ── IO ────────────────────────────────────────────────────────────────────────
function ensureDir() { mkdirSync(JOURNAL_DIR, { recursive: true }); }

export function loadJournal() {
  if (!existsSync(SIGNALS_FILE)) return [];
  try { return JSON.parse(readFileSync(SIGNALS_FILE, 'utf8')); } catch { return []; }
}
export function saveJournal(records) {
  ensureDir();
  writeFileSync(SIGNALS_FILE, JSON.stringify(records, null, 2));
}
export function loadWeights() {
  if (!existsSync(WEIGHTS_FILE)) return Object.fromEntries(FACTORS.map(f => [f.key, 1.0]));
  try { return JSON.parse(readFileSync(WEIGHTS_FILE, 'utf8')); }
  catch { return Object.fromEntries(FACTORS.map(f => [f.key, 1.0])); }
}
function saveWeights(w) { ensureDir(); writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2)); }

// ── Target validation ───────────────────────────────────────────────────────
// Ensures TP1<TP2<TP3 all sit on the profit side of entry (beyond the prior one
// in the trade's direction). The DOL targets (equilibrium / liquidity) are only
// valid if they're actually beyond the previous target; otherwise — e.g. price
// already swept past equilibrium — fall back to clean 3R / 4R multiples. SL sits
// at 1R, so risk distance r = |entry - sl|. Fixes "wins" that were really just
// price drifting the wrong way into a mis-placed target.
export function validatedTargets({ dir, entry, sl, tp1, tp2, tp3 }) {
  const r = Math.abs(entry - sl) || (entry * 0.001);
  const sign = dir === 'LONG' ? 1 : -1;
  const beyond = (lvl, prev) => lvl != null && Number.isFinite(lvl) && sign * (lvl - prev) > 0;
  const t1 = beyond(tp1, entry) ? tp1 : entry + sign * 2 * r;
  const t2 = beyond(tp2, t1)    ? tp2 : entry + sign * 3 * r;
  const t3 = beyond(tp3, t2)    ? tp3 : entry + sign * 4 * r;
  return { tp1: t1, tp2: t2, tp3: t3 };
}

// ── Factor extraction ───────────────────────────────────────────────────────
export function factorsFromNotes(notes = []) {
  const text = notes.join(' · ');
  const out = {};
  for (const f of FACTORS) out[f.key] = text.includes(f.match);
  return out;
}

// ── Recording new signals ──────────────────────────────────────────────────
// scanResults: array of { symbol, dir, score, notes, entry, sl, tp1, tp2, tp3, smtHit, riskPips }
// Returns { added, updated }.
export function recordSignals(scanResults, session, when = new Date()) {
  const records = loadJournal();
  const isoTime = when.toISOString();
  const ts = Math.floor(when.getTime() / 1000);
  let added = 0, updated = 0;

  for (const s of scanResults) {
    if (!s.dir || s.entry == null || s.sl == null || s.tp1 == null) continue;
    const existing = records.find(r =>
      r.status === 'OPEN' && r.symbol === s.symbol && r.dir === s.dir &&
      Math.abs(r.entry - s.entry) / s.entry < DEDUP_PCT
    );
    if (existing) {
      existing.lastSeen = isoTime;
      existing.lastScore = s.score;
      if (s.pinged) existing.pinged = true; // once pinged, stays flagged
      updated++;
      continue;
    }
    records.push({
      id: `${s.symbol}-${s.dir}-${isoTime}`,
      ts, isoTime, session,
      symbol: s.symbol, dir: s.dir,
      score: s.score,
      factors: factorsFromNotes(s.notes),
      notes: s.notes ?? [],
      entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2 ?? null, tp3: s.tp3 ?? null,
      riskPips: s.riskPips ?? null,
      smtHit: !!s.smtHit,
      pinged: !!s.pinged, // was this signal texted to the phone (actionable)?
      status: 'OPEN',
      levelsHit: [],
      resultPips: null,
      rMultiple: null,
      exitLevel: null,
      currentPips: null,
      resolvedAt: null,
      lastSeen: isoTime,
      lastChecked: null,
    });
    added++;
  }
  saveJournal(records);
  return { added, updated };
}

// ── Resolving open trades ───────────────────────────────────────────────────
// checkFn(record) must return:
//   { firstHit: 'SL'|'TP1'|null, levelsHit: ['TP1','TP2',...], currentPrice, currentPips }
//   firstHit = the first of {SL, TP1} touched chronologically (TP1 = first profit target).
// Returns the open records (post-update) for recap display.
export async function resolveOpenSignals(checkFn, now = new Date()) {
  const records = loadJournal();
  const open = records.filter(r => r.status === 'OPEN');
  const recap = [];

  for (const r of open) {
    let res;
    try { res = await checkFn(r); } catch (e) { res = { error: e.message }; }
    r.lastChecked = now.toISOString();

    if (!res || res.error) { recap.push({ ...r, liveStatus: 'ERR', error: res?.error }); continue; }

    r.currentPips = res.currentPips ?? null;
    const ageDays = (now.getTime() / 1000 - r.ts) / 86400;

    if (res.firstHit === 'SL') {
      r.status = 'LOSS';
      r.exitLevel = r.sl;
      r.levelsHit = res.levelsHit?.filter(l => l !== 'SL') ?? [];
      r.resultPips = pipsBetween(r.dir, r.entry, r.sl, r.entry);
      r.rMultiple = -1;
      r.resolvedAt = now.toISOString();
      recap.push({ ...r, liveStatus: 'LOSS' });
    } else if (res.levelsHit && res.levelsHit.length) {
      // At least one TP hit before SL → WIN. Best TP reached = exit for journaling.
      const best = ['TP3', 'TP2', 'TP1'].find(l => res.levelsHit.includes(l));
      const exit = best === 'TP3' ? r.tp3 : best === 'TP2' ? r.tp2 : r.tp1;
      r.status = 'WIN';
      r.exitLevel = exit;
      r.levelsHit = res.levelsHit;
      r.resultPips = pipsBetween(r.dir, r.entry, exit, r.entry);
      const risk = Math.abs(pipsBetween(r.dir, r.entry, r.sl, r.entry)) || 1;
      r.rMultiple = +(r.resultPips / risk).toFixed(2);
      r.resolvedAt = now.toISOString();
      recap.push({ ...r, liveStatus: best });
    } else if (ageDays > EXPIRE_DAYS) {
      r.status = 'EXPIRED';
      r.resolvedAt = now.toISOString();
      recap.push({ ...r, liveStatus: 'EXPIRED' });
    } else {
      const live = (r.currentPips ?? 0) > 5 ? 'PROFIT' : (r.currentPips ?? 0) < -5 ? 'LOSS_OPEN' : 'FLAT';
      recap.push({ ...r, liveStatus: live });
    }
  }
  saveJournal(records);
  return recap;
}

function pipsBetween(dir, from, to, ref) {
  const mult = ref > 100 ? 10 : 10000;
  return Math.round((dir === 'LONG' ? (to - from) : (from - to)) * mult);
}

// ── Adaptive weights ────────────────────────────────────────────────────────
// Learn per-factor weights from resolved (WIN/LOSS) trades. Weight = win-rate of
// trades carrying that factor, normalised so the 6 weights average 1.0 (keeping the
// 0–6 scale meaningful). Falls back to flat 1.0 until enough data accumulates.
export function recomputeWeights() {
  const records = loadJournal();
  const resolved = records.filter(r => r.status === 'WIN' || r.status === 'LOSS');
  const flat = Object.fromEntries(FACTORS.map(f => [f.key, 1.0]));

  if (resolved.length < MIN_RESOLVED) { saveWeights(flat); return { weights: flat, learning: false, resolved: resolved.length }; }

  const raw = {};
  for (const f of FACTORS) {
    const withF = resolved.filter(r => r.factors?.[f.key]);
    if (withF.length < MIN_SAMPLES) { raw[f.key] = 0.5; continue; }
    const wins = withF.filter(r => r.status === 'WIN').length;
    raw[f.key] = wins / withF.length; // win-rate 0..1
  }
  const mean = Object.values(raw).reduce((a, b) => a + b, 0) / FACTORS.length || 0.5;
  const weights = {};
  for (const f of FACTORS) weights[f.key] = +(raw[f.key] / (mean || 0.5)).toFixed(3); // avg → 1.0
  saveWeights(weights);
  return { weights, learning: true, resolved: resolved.length };
}

// Weighted "edge" for a set of present factors (booleans). Avg weight = 1, so edge ≈ rawScore.
export function edgeScore(factorsBool, weights) {
  let e = 0;
  for (const f of FACTORS) if (factorsBool[f.key]) e += weights[f.key] ?? 1.0;
  return +e.toFixed(2);
}

// ── Stats ───────────────────────────────────────────────────────────────────
export function computeStats() {
  const records = loadJournal();
  const resolved = records.filter(r => r.status === 'WIN' || r.status === 'LOSS');
  const wins = resolved.filter(r => r.status === 'WIN').length;
  const losses = resolved.length - wins;
  const open = records.filter(r => r.status === 'OPEN').length;
  const winRate = resolved.length ? wins / resolved.length : 0;
  const totalR = resolved.reduce((a, r) => a + (r.rMultiple ?? 0), 0);

  const byFactor = FACTORS.map(f => {
    const withF = resolved.filter(r => r.factors?.[f.key]);
    const w = withF.filter(r => r.status === 'WIN').length;
    return { label: f.label, key: f.key, n: withF.length, wins: w, winRate: withF.length ? w / withF.length : null };
  });

  const groupRate = (keyFn) => {
    const map = {};
    for (const r of resolved) {
      const k = keyFn(r);
      (map[k] ??= { n: 0, w: 0 });
      map[k].n++; if (r.status === 'WIN') map[k].w++;
    }
    return Object.entries(map).map(([k, v]) => ({ key: k, n: v.n, wins: v.w, winRate: v.w / v.n }))
      .sort((a, b) => b.n - a.n);
  };

  return {
    total: records.length, resolved: resolved.length, open, wins, losses,
    winRate, totalR: +totalR.toFixed(2),
    byFactor,
    bySymbol: groupRate(r => r.symbol),
    byScore:  groupRate(r => `${r.score}/6`),
    bySession: groupRate(r => r.session),
  };
}

// ── Account simulation ───────────────────────────────────────────────────────
// Simulates trading the signals: start balance, risk a % of CURRENT equity per
// trade (compounding), P/L = risk × the trade's R-multiple.
// Realism guards (on by default):
//   • dedupe   — the same level re-detected across scans (same symbol+dir, entry
//                within 0.3%) is ONE trade, not many. Kills the ×7 EURJPY overcount.
//   • frictionR— spread + slippage charged on every trade (default 0.1R), so a
//                +10R gross win nets +9.9R and a tight-stop trade isn't free.
//   • capR     — clip any single trade's |R| (default 20) so one toy-stop outlier
//                can't dominate the curve.
export function computeAccount({ start = 100000, riskPct = 0.01, pingedOnly = true,
                                 dedupe = true, frictionR = 0.1, capR = 20 } = {}) {
  let records = loadJournal()
    .filter(r => r.status === 'WIN' || r.status === 'LOSS')
    .filter(r => pingedOnly ? r.pinged : true)
    .sort((a, b) => (new Date(a.resolvedAt || 0) - new Date(b.resolvedAt || 0)) || (a.ts - b.ts));

  let collapsed = 0;
  if (dedupe) {
    const kept = [];
    for (const r of records) {
      const dup = kept.find(k => k.symbol === r.symbol && k.dir === r.dir &&
        Math.abs(k.entry - r.entry) / r.entry < 0.003);
      if (dup) { collapsed++; continue; }
      kept.push(r);
    }
    records = kept;
  }

  let bal = start, peak = start, maxDD = 0, wins = 0;
  const rows = [];
  for (const r of records) {
    const risk = bal * riskPct;
    let grossR = Math.max(-capR, Math.min(capR, r.rMultiple ?? 0));
    const netR = grossR - frictionR;            // friction always costs
    const pl = risk * netR;
    bal += pl;
    if (netR > 0) wins++;
    peak = Math.max(peak, bal);
    maxDD = Math.max(maxDD, (peak - bal) / peak);
    rows.push({ date: r.resolvedAt || r.isoTime, symbol: r.symbol, dir: r.dir, score: r.score,
      grossR, netR: +netR.toFixed(2), risk, pl, balance: bal });
  }
  return {
    start, riskPct, pingedOnly, dedupe, frictionR, capR, collapsed,
    end: bal, returnPct: bal / start - 1,
    trades: records.length, wins, losses: records.length - wins,
    winRate: records.length ? wins / records.length : 0, maxDD, rows,
  };
}

// ── XLSX export (dependency-free) ────────────────────────────────────────────
const COL = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - m - 1) / 26; } return s; };
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// rowStyles[i] = cell-style index for every cell in row i (0/undefined = default).
// styled empty cells are still emitted so the whole row gets the fill.
function sheetXml(rows, rowStyles = []) {
  const body = rows.map((row, ri) => {
    const s = rowStyles[ri] || 0;
    const sAttr = s ? ` s="${s}"` : '';
    const cells = row.map((val, ci) => {
      const ref = `${COL(ci)}${ri + 1}`;
      if (val == null || val === '') return s ? `<c r="${ref}"${sAttr}/>` : '';
      if (typeof val === 'number' && Number.isFinite(val)) return `<c r="${ref}"${sAttr}><v>${val}</v></c>`;
      return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

// styles: 0 = default, 1 = green fill (pinged rows), 2 = bold (header)
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// minimal CRC32
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zip(files) {
  // files: [{ name, data:Buffer }]
  const locals = [], central = []; let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // method=deflate, time/date
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(locals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, end]);
}

// sheets: [{ name, rows: [[...], ...], rowStyles?: [int] }]
function buildXlsx(sheets) {
  const stylesRid = `rId${sheets.length + 1}`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels',          data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml',      data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(wbRels, 'utf8') },
    { name: 'xl/styles.xml',        data: Buffer.from(STYLES_XML, 'utf8') },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows, s.rowStyles), 'utf8') })),
  ];
  return zip(files);
}

export function writeXlsx(when = new Date()) {
  const records = loadJournal().slice().sort((a, b) => b.ts - a.ts);
  const stats = computeStats();
  const fmtPx = n => n == null ? '' : (n > 100 ? +Number(n).toFixed(2) : +Number(n).toFixed(5));
  const localTime = iso => iso ? new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', dateStyle: 'short', timeStyle: 'short' }) : '';

  const sigHeader = ['Pinged', 'Date (Melb)', 'Session', 'Symbol', 'Dir', 'Score', 'DailyStruct', 'Zone', '4HConfirm', 'OB', 'FVG', 'SMT',
    'Entry', 'SL', 'TP1', 'TP2', 'TP3', 'RiskPips', 'Status', 'LevelsHit', 'ResultPips', 'R', 'CurrentPips'];
  const yn = b => b ? 'Y' : '';
  const sigRows = [sigHeader, ...records.map(r => [
    r.pinged ? '📱 Y' : '', localTime(r.isoTime), r.session, r.symbol, r.dir, `${r.score}/6`,
    yn(r.factors?.daily_structure), yn(r.factors?.correct_zone), yn(r.factors?.h4_confirms),
    yn(r.factors?.near_ob), yn(r.factors?.fvg), yn(r.factors?.smt),
    fmtPx(r.entry), fmtPx(r.sl), fmtPx(r.tp1), fmtPx(r.tp2), fmtPx(r.tp3),
    r.riskPips ?? '', r.status, (r.levelsHit || []).join('+'),
    r.resultPips ?? '', r.rMultiple ?? '', r.currentPips ?? '',
  ])];
  // Header bold (style 2); pinged rows green (style 1); rest default.
  const sigStyles = [2, ...records.map(r => r.pinged ? 1 : 0)];

  const statsRows = [
    ['ICT/MMXM Trade Journal — Stats', '', '', ''],
    ['Generated', localTime(when.toISOString()), '', ''],
    ['', '', '', ''],
    ['Overall', '', '', ''],
    ['Total signals', stats.total, '', ''],
    ['Resolved', stats.resolved, '', ''],
    ['Open', stats.open, '', ''],
    ['Wins', stats.wins, '', ''],
    ['Losses', stats.losses, '', ''],
    ['Win rate', stats.resolved ? +(stats.winRate * 100).toFixed(1) : '', '%', ''],
    ['Total R', stats.totalR, '', ''],
    ['', '', '', ''],
    ['Win rate by confluence factor', 'N', 'Wins', 'WinRate%'],
    ...stats.byFactor.map(f => [f.label, f.n, f.wins, f.winRate == null ? '' : +(f.winRate * 100).toFixed(1)]),
    ['', '', '', ''],
    ['Win rate by score', 'N', 'Wins', 'WinRate%'],
    ...stats.byScore.map(g => [g.key, g.n, g.wins, +(g.winRate * 100).toFixed(1)]),
    ['', '', '', ''],
    ['Win rate by symbol', 'N', 'Wins', 'WinRate%'],
    ...stats.bySymbol.map(g => [g.key, g.n, g.wins, +(g.winRate * 100).toFixed(1)]),
    ['', '', '', ''],
    ['Win rate by session', 'N', 'Wins', 'WinRate%'],
    ...stats.bySession.map(g => [g.key, g.n, g.wins, +(g.winRate * 100).toFixed(1)]),
  ];

  // ── Account sheet — simulated $100k @ 1% risk, trading pinged signals ──────
  const acct = computeAccount({ start: 100000, riskPct: 0.01, pingedOnly: true });
  const money = n => +Number(n).toFixed(2);
  const acctRows = [
    ['Account Simulation — trade the pinged signals (realistic)', '', '', '', '', '', '', ''],
    ['Starting balance', 100000, '', '', '', '', '', ''],
    ['Risk per trade', '1% of current equity (compounding)', '', '', '', '', '', ''],
    ['Assumptions', `dedupe same setup · friction ${acct.frictionR}R/trade · cap ${acct.capR}R`, '', '', '', '', '', ''],
    ['Trades taken', `${acct.trades} distinct (collapsed ${acct.collapsed} repeat detections)`, '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['Final balance', money(acct.end), '', '', '', '', '', ''],
    ['Net P/L', money(acct.end - acct.start), '', '', '', '', '', ''],
    ['Return', +(acct.returnPct * 100).toFixed(1), '%', '', '', '', '', ''],
    ['Win rate', acct.trades ? +(acct.winRate * 100).toFixed(1) : '', '%', '', '', '', '', ''],
    ['Record (W/L)', `${acct.wins} / ${acct.losses}`, '', '', '', '', '', ''],
    ['Max drawdown', +(acct.maxDD * 100).toFixed(1), '%', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['#', 'Date (Melb)', 'Symbol', 'Dir', 'Gross R', 'Net R', 'Risk $', 'P/L $', 'Balance $'],
    ...acct.rows.map((t, i) => [
      i + 1, localTime(t.date), t.symbol, t.dir, +Number(t.grossR).toFixed(2), +Number(t.netR).toFixed(2),
      money(t.risk), money(t.pl), money(t.balance),
    ]),
  ];
  // bold the two header rows; green winning trades, plain losers (table header at index 13)
  const acctStyles = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
    ...acct.rows.map(t => (t.pl > 0 ? 1 : 0))];

  ensureDir();
  writeFileSync(XLSX_FILE, buildXlsx([
    { name: 'Signals', rows: sigRows, rowStyles: sigStyles },
    { name: 'Account', rows: acctRows, rowStyles: acctStyles },
    { name: 'Stats', rows: statsRows, rowStyles: [2] },
  ]));
  return XLSX_FILE;
}

export { XLSX_FILE };
