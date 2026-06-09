/**
 * Clockwise Trades Email Module
 *
 * Reads James's daily "Clockwise Trades M/D/YY" email (from
 * james@clockwisecapital.com), downloads the .xlsx trade-blotter attachment,
 * and parses it into fills for the Kronos ingest endpoint.
 *
 * Blotter columns (Tidal/USBank "Trade Template"): Account #, CUSIP, ISIN,
 * SEDOL, TRADE DATE, SETTLE DATE, QTY/PAR VALUE, ..., EXEC PRICE, COMMISSION
 * AMT, OTHER/EXCHANGE/SEC FEES, NET SETTLEMENT AMOUNT, ..., TRAN CODE (B/S),
 * ..., COMMENTS. James puts the ticker in the ISIN column and the recommender
 * initial in COMMENTS.
 */

import ExcelJS from 'exceljs';
import { getGmailService } from './google-auth';

const TRADES_EMAIL_SUBJECT = 'Clockwise Trades';
const TRADES_EMAIL_SENDER = 'james@clockwisecapital.com';

export type RawFill = {
  account?: string;
  trade_date: string;
  settle_date?: string;
  ticker: string;
  side: 'B' | 'S';
  qty: number;
  exec_price: number;
  commission?: number;
  fees?: number;
  net_amount?: number;
  comments?: string;
};

/** Find recent trades emails; returns message IDs newest-first. */
export async function searchTradesEmails(daysBack = 3): Promise<string[]> {
  const gmail = await getGmailService();
  const query = `from:${TRADES_EMAIL_SENDER} subject:"${TRADES_EMAIL_SUBJECT}" has:attachment newer_than:${daysBack}d`;
  console.log(`Searching trades emails: ${query}`);
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 10 });
  return (res.data.messages ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string');
}

/** Download the .xlsx attachment from a message as a Buffer. */
export async function downloadXlsxAttachment(messageId: string): Promise<Buffer | null> {
  const gmail = await getGmailService();
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const payload = msg.data.payload;
  if (!payload) return null;

  function findXlsx(parts: any[]): any {
    for (const part of parts ?? []) {
      const fn = (part.filename || '').toLowerCase();
      if (fn.endsWith('.xlsx') && part.body?.attachmentId) return part;
      if (part.parts) { const n = findXlsx(part.parts); if (n) return n; }
    }
    return null;
  }
  const part = findXlsx(payload.parts || []);
  if (!part?.body?.attachmentId) { console.warn(`[WARN] No .xlsx attachment in ${messageId}`); return null; }

  const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.body.attachmentId });
  if (!att.data.data) return null;
  const b64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64, 'base64');
  console.log(`Downloaded ${part.filename} (${buf.length} bytes)`);
  return buf;
}

function isoDate(v: any): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const m = v.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);  // m/d/yy or m/d/yyyy
    if (m) {
      const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return null;
}

function num(v: any): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(typeof v === 'object' && 'result' in v ? v.result : v);
  return Number.isFinite(n) ? n : undefined;
}

function cellText(v: any): string {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.richText?.map((r: any) => r.text).join('') ?? '').trim();
  return String(v).trim();
}

/** Parse the trade blotter xlsx into fills. */
export async function parseTradesXlsx(buffer: Buffer): Promise<RawFill[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  const fills: RawFill[] = [];
  for (const ws of wb.worksheets) {
    // Header row = the first row containing TRAN CODE + EXEC PRICE
    let headerRowIdx = -1;
    const colOf: Record<string, number> = {};
    for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
      const vals = (ws.getRow(r).values as any[]).map(cellText).map(s => s.toUpperCase());
      if (vals.some(v => v.includes('TRAN CODE')) && vals.some(v => v.includes('EXEC PRICE'))) {
        headerRowIdx = r;
        vals.forEach((v, i) => { if (v) colOf[v] = i; });
        break;
      }
    }
    if (headerRowIdx === -1) continue;

    const find = (...needles: string[]): number => {
      for (const [name, idx] of Object.entries(colOf)) {
        if (needles.some(n => name.includes(n))) return idx;
      }
      return -1;
    };
    const iTicker = find('ISIN');
    const iSide = find('TRAN CODE');
    const iQty = find('QTY/PAR', 'QTY');
    const iPx = find('EXEC PRICE');
    const iAcct = find('ACCOUNT');
    const iTrade = find('TRADE DATE');
    const iSettle = find('SETTLE DATE');
    const iComm = find('COMMISSION');
    const iOther = find('OTHER FEES');
    const iExch = find('EXCHANGE FEES');
    const iSec = find('SEC FEES');
    const iNet = find('NET SETTLEMENT');
    const iComments = find('COMMENTS');

    for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r).values as any[];
      const side = cellText(row[iSide]).toUpperCase();
      const ticker = cellText(row[iTicker]).toUpperCase();
      const qty = num(row[iQty]);
      const px = num(row[iPx]);
      if ((side !== 'B' && side !== 'S') || !ticker || qty == null || px == null) continue;  // skip non-data rows
      const tradeDate = isoDate(row[iTrade]);
      if (!tradeDate) continue;
      const fees = [iOther, iExch, iSec].reduce((s, i) => s + (i > -1 ? (num(row[i]) ?? 0) : 0), 0);
      fills.push({
        account: iAcct > -1 ? cellText(row[iAcct]) : undefined,
        trade_date: tradeDate,
        settle_date: iSettle > -1 ? (isoDate(row[iSettle]) ?? undefined) : undefined,
        ticker, side: side as 'B' | 'S', qty, exec_price: px,
        commission: iComm > -1 ? num(row[iComm]) : undefined,
        fees: fees || undefined,
        net_amount: iNet > -1 ? num(row[iNet]) : undefined,
        comments: iComments > -1 ? cellText(row[iComments]) : undefined,
      });
    }
  }
  return fills;
}
