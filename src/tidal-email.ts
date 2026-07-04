/**
 * Tidal Fund-Admin Email Module
 *
 * Reads Tidal's (Nicholas Ohm, nohm@tidalfg.com) fund-admin reports and parses
 * their attachments for the Kronos tax ingest endpoints:
 *
 *   - "Position Details Report"  -> "Position Details Tax Lots Confidential - M.D.YYYY.xls"
 *       Excel-2003 SpreadsheetML XML (NOT a zip xlsx). One row per tax lot, plus
 *       fund-level columns (NAV / TNA / shares) repeated on every row.
 *       -> POST /api/tax/ingest-positions  { lots, fund }
 *
 *   - "RGL Report"  -> "Clockwise RGL - M.D.YY.xlsx"  (real xlsx)
 *       The fiscal-year-to-date realized ledger. Parsed by parseRglXlsx (phase 1b;
 *       the in-kind flag needs a confirmed rule before it is wired into the sync).
 *
 * The Position Details snapshot date comes from the attachment FILENAME (the
 * report's official as-of date), never the email received date.
 */

import { XMLParser } from 'fast-xml-parser';
import ExcelJS from 'exceljs';
import { getGmailService } from './google-auth';

const TIDAL_SENDER = 'nohm@tidalfg.com';

// ---- ingest payload shapes (mirror the Kronos route contracts) ----
export type RawLot = {
  snapshot_date: string;
  ticker: string;
  cusip?: string;
  issue_name?: string;
  acquisition_date?: string;
  quantity?: number;
  unit_cost?: number;
  total_cost?: number;
  market_value?: number;
  unrealized_gl?: number;
  lt_st?: string;
  sec_type?: string;
};
export type FundSnapshot = {
  snapshot_date: string;
  nav?: number;
  total_net_assets?: number;
  shares_outstanding?: number;
  total_market_value?: number;
};

const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

function num(v: any): number | undefined {
  if (v == null || v === '') return undefined;
  // ExcelJS returns objects for formula/rich cells; SpreadsheetML returns strings.
  const x = typeof v === 'object' ? (v.result ?? v.value ?? NaN) : v;
  const n = Number(String(x).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** M.D.YYYY or M.D.YY from a filename -> ISO YYYY-MM-DD. */
export function dateFromFilename(filename: string): string | null {
  const m = filename.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return null;
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Fund FYE is Aug 31; fiscal year starts the prior Sep 1. */
export function fiscalStart(isoAsOf: string): string {
  const [y, m] = isoAsOf.split('-').map(Number);
  const startYear = m >= 9 ? y : y - 1;
  return `${startYear}-09-01`;
}

/** Find recent Tidal emails matching a subject phrase; message IDs newest-first. */
async function searchTidal(subjectPhrase: string, daysBack: number): Promise<string[]> {
  const gmail = await getGmailService();
  const query = `from:${TIDAL_SENDER} "${subjectPhrase}" has:attachment newer_than:${daysBack}d`;
  console.log(`Searching Tidal emails: ${query}`);
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 15 });
  return (res.data.messages ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string');
}

export const searchPositionEmails = (daysBack = 10) => searchTidal('Position Details', daysBack);
export const searchRglEmails = (daysBack = 40) => searchTidal('RGL', daysBack);

/** Download the first attachment whose filename matches `pattern`. Returns {buffer, filename}. */
export async function downloadAttachment(
  messageId: string,
  pattern: RegExp,
): Promise<{ buffer: Buffer; filename: string } | null> {
  const gmail = await getGmailService();
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const payload = msg.data.payload;
  if (!payload) return null;

  function find(parts: any[]): any {
    for (const part of parts ?? []) {
      if (pattern.test(part.filename || '') && part.body?.attachmentId) return part;
      if (part.parts) { const n = find(part.parts); if (n) return n; }
    }
    return null;
  }
  const part = find(payload.parts || []);
  if (!part?.body?.attachmentId) { console.warn(`[WARN] no attachment matching ${pattern} in ${messageId}`); return null; }

  const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.body.attachmentId });
  if (!att.data.data) return null;
  const b64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(b64, 'base64');
  console.log(`Downloaded ${part.filename} (${buffer.length} bytes)`);
  return { buffer, filename: part.filename };
}

/**
 * Parse a Position Details SpreadsheetML (.xls) buffer into lots + a fund snapshot.
 * Columns are looked up BY HEADER NAME (row 0), so a column reorder can't misalign
 * fields. Sparse cells (equity rows omit Coupon/Maturity) are honored via ss:Index.
 */
export function parsePositionsXls(buffer: Buffer, snapshotDate: string): { lots: RawLot[]; fund: FundSnapshot | null } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false });
  const doc = parser.parse(buffer.toString('utf-8'));

  const worksheets = asArray(doc?.Workbook?.Worksheet);
  // Pick the worksheet whose Table has the most rows (the lots sheet).
  let rows: any[] = [];
  for (const ws of worksheets) {
    const r = asArray(ws?.Table?.Row);
    if (r.length > rows.length) rows = r;
  }
  if (rows.length < 2) throw new Error('Position Details: no data rows found (format change?)');

  const rowCols = (row: any): (string | null)[] => {
    const out: (string | null)[] = [];
    let col = 0;
    for (const cell of asArray(row?.Cell)) {
      const idx = cell?.['@_Index'];
      if (idx) col = Number(idx) - 1;
      const data = cell?.Data;
      const val = data == null ? null : (typeof data === 'object' ? data['#text'] : data);
      out[col] = val == null ? null : String(val);
      col++;
    }
    return out;
  };

  const header = rowCols(rows[0]);
  const H: Record<string, number> = {};
  header.forEach((name, i) => { if (name) H[name.trim()] = i; });
  const need = ['Ticker', 'Tax Lot Quantity', 'Tax Lot Total Cost (Base)', 'Tax Lot Market Value (Base)', 'Tax Lot Gain/Loss (Base)'];
  for (const col of need) if (!(col in H)) throw new Error(`Position Details: missing expected column "${col}" (format change?)`);
  const at = (v: (string | null)[], name: string): string | null => (name in H ? v[H[name]] ?? null : null);

  const lots: RawLot[] = [];
  let fund: FundSnapshot | null = null;
  for (const row of rows.slice(1)) {
    const v = rowCols(row);
    const ticker = (at(v, 'Ticker') || '').trim();
    if (!ticker) continue;
    if (!fund) {
      fund = {
        snapshot_date: snapshotDate,
        nav: num(at(v, 'NAV')),
        total_net_assets: num(at(v, 'Total Net Assets')),
        shares_outstanding: num(at(v, 'Fund Shares Outstanding')),
        total_market_value: num(at(v, 'Total Market Value')),
      };
    }
    const acq = at(v, 'Acquisition Date');
    lots.push({
      snapshot_date: snapshotDate,
      ticker: ticker.toUpperCase(),
      cusip: at(v, 'Security Identifier') ?? undefined,
      issue_name: at(v, 'Issue Name') ?? undefined,
      acquisition_date: isoDate(acq) ?? undefined,  // normalize M/D/YYYY or ISO, don't blind-slice
      quantity: num(at(v, 'Tax Lot Quantity')),
      unit_cost: num(at(v, 'Tax Lot Unit Cost (Base)')),
      total_cost: num(at(v, 'Tax Lot Total Cost (Base)')),
      market_value: num(at(v, 'Tax Lot Market Value (Base)')),
      unrealized_gl: num(at(v, 'Tax Lot Gain/Loss (Base)')),
      lt_st: at(v, 'LT/ST') ?? undefined,
      sec_type: at(v, 'USB Security Type 3') ?? undefined,
    });
  }
  // Required columns are checked above (fail-loud). A non-empty sheet yielding no lots
  // means the row shape changed under us — surface it rather than POST an empty snapshot.
  if (lots.length === 0) console.warn('[tidal] parsePositionsXls: 0 lots parsed from a non-empty sheet — possible format change');
  return { lots, fund };
}

// ---- RGL (phase 1b) ---------------------------------------------------------
export type RawRealized = {
  fy_start: string; fy_end: string;
  ticker: string; cusip?: string; issue_name?: string;
  trade_date: string; acquisition_date?: string; term: string;
  quantity?: number; proceeds?: number; cost?: number;
  realized_gl: number; in_kind: boolean; lot_relief_method?: string;
};

function cellText(v: any): string {
  if (v == null) return '';
  // ExcelJS: plain string/number, {result} for formulas, or {richText:[{text}]} for styled cells.
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.richText?.map((r: any) => r.text).join('') ?? '').trim();
  return String(v).trim();
}
function isoDate(v: any): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = cellText(v);
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const yr = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/**
 * Parse the RGL xlsx into the FY-to-date realized ledger. `fyEnd` is the report
 * as-of date (from the filename); `fy_start` is the prior Sep 1 (FYE Aug 31).
 *
 * In-kind classification comes straight from the file: Tidal flags redemption
 * deliveries in the "In-Kind RGL" column (value "In-Kind", else blank), and
 * corroborates via Broker = "ETF BASKET REDEMPTION IN KIND". Verified row-for-row
 * against the live tax_realized split (252 in-kind / 1492 cash, 0 mismatches).
 * Columns looked up by header name so a reorder can't misalign fields.
 */
export async function parseRglXlsx(buffer: Buffer, fyEnd: string): Promise<RawRealized[]> {
  const fyStart = fiscalStart(fyEnd);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  // The realized-ledger sheet (has "Total Gain/Loss"); skip the pivot "Summary" sheet.
  let ws = wb.worksheets[0];
  for (const w of wb.worksheets) {
    const hdr = (w.getRow(1).values as any[]).map(cellText);
    if (hdr.some(h => /total gain\/loss/i.test(h))) { ws = w; break; }
  }
  const header = (ws.getRow(1).values as any[]).map(cellText);
  const H: Record<string, number> = {};
  header.forEach((name, i) => { if (name) H[name.trim()] = i; });
  for (const c of ['Ticker', 'Trade Date', 'Gain/Loss Term', 'Total Gain/Loss', 'In-Kind RGL']) {
    if (!(c in H)) throw new Error(`RGL: missing expected column "${c}" (format change?)`);
  }
  const at = (row: any[], name: string): any => (name in H ? row[H[name]] : undefined);

  const out: RawRealized[] = [];
  let dateFails = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r).values as any[];
    const ticker = cellText(at(row, 'Ticker')).toUpperCase();
    const gl = num(at(row, 'Total Gain/Loss'));
    const tradeDate = isoDate(at(row, 'Trade Date'));
    if (!ticker || gl == null || !tradeDate) {
      // A real row (ticker + G/L present) dropped only because the date wouldn't parse is a
      // silent-data-loss signal — understated realized totals. Blank rows don't count.
      if (ticker && gl != null && !tradeDate) dateFails++;
      continue;
    }
    const inKindFlag = cellText(at(row, 'In-Kind RGL')).toUpperCase() === 'IN-KIND'
      || cellText(at(row, 'Broker')).toUpperCase() === 'ETF BASKET REDEMPTION IN KIND';
    out.push({
      fy_start: fyStart, fy_end: fyEnd,
      ticker,
      cusip: cellText(at(row, 'Primary Asset Id')) || undefined,
      issue_name: cellText(at(row, 'Issue Name')) || undefined,
      trade_date: tradeDate,
      acquisition_date: isoDate(at(row, 'Acquisition Date')) ?? undefined,
      term: cellText(at(row, 'Gain/Loss Term')) || 'SHORT TERM',
      quantity: num(at(row, 'Quantity')),
      proceeds: num(at(row, 'Proceeds Base')),
      cost: num(at(row, 'Amortized Cost Base')),
      realized_gl: gl,
      in_kind: inKindFlag,
    });
  }
  if (dateFails > 0) console.warn(`[tidal] parseRglXlsx: ${dateFails} row(s) dropped on unparseable Trade Date — possible date-format change`);
  return out;
}
