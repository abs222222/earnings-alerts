/**
 * Tidal Position Details (Tax Lots) Email Module
 *
 * Reads the weekly "Clockwise Position Details Report" email from
 * nohm@tidalfg.com, downloads the .xls attachment, and parses it into per-lot
 * unrealized tax positions for the Kronos tax tab.
 *
 * The attachment is SpreadsheetML 2003 (XML saved as .xls) — ExcelJS/xlrd can't
 * read it, so we parse the XML with fast-xml-parser. One worksheet
 * ("Position Details Tax Lots Confi..."); row 0 = headers; row 1.. = one lot each.
 * Fund-level totals (NAV, net assets, shares, MV, effective date) repeat on
 * every row — we read them off the first data row.
 */

import { XMLParser } from 'fast-xml-parser'
import { getGmailService } from './google-auth'

const POSITIONS_SENDER = 'nohm@tidalfg.com'
const POSITIONS_SUBJECT = 'Position Details'

export type RawLot = {
  snapshot_date: string
  ticker: string
  cusip?: string
  issue_name?: string
  acquisition_date?: string
  quantity: number
  unit_cost?: number
  total_cost?: number
  market_value?: number
  unrealized_gl?: number
  lt_st?: string
  sec_type?: string
}

export type FundSnapshot = {
  snapshot_date: string
  nav?: number
  total_net_assets?: number
  shares_outstanding?: number
  total_market_value?: number
}

/** Find recent Position Details emails; returns message IDs newest-first. */
export async function searchPositionsEmails(daysBack = 10): Promise<string[]> {
  const gmail = await getGmailService()
  const query = `from:${POSITIONS_SENDER} subject:"${POSITIONS_SUBJECT}" has:attachment newer_than:${daysBack}d`
  console.log(`Searching positions emails: ${query}`)
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 10 })
  return (res.data.messages ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string')
}

/** Download the .xls attachment from a message as a Buffer. */
export async function downloadXlsAttachment(messageId: string): Promise<Buffer | null> {
  const gmail = await getGmailService()
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
  const payload = msg.data.payload
  if (!payload) return null

  function findXls(parts: any[]): any {
    for (const part of parts ?? []) {
      const fn = (part.filename || '').toLowerCase()
      if ((fn.endsWith('.xls') || fn.endsWith('.xml')) && part.body?.attachmentId) return part
      if (part.parts) { const n = findXls(part.parts); if (n) return n }
    }
    return null
  }
  const part = findXls(payload.parts || [])
  if (!part?.body?.attachmentId) { console.warn(`[WARN] No .xls attachment in ${messageId}`); return null }

  const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.body.attachmentId })
  if (!att.data.data) return null
  const b64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/')
  const buf = Buffer.from(b64, 'base64')
  console.log(`Downloaded ${part.filename} (${buf.length} bytes)`)
  return buf
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,    // ss:Worksheet -> Worksheet, ss:Index -> @_Index
  parseTagValue: false,    // keep cell text as strings (dates, ids) — we coerce numbers ourselves
  trimValues: true,
})

function asArray<T>(x: T | T[] | undefined | null): T[] {
  return x == null ? [] : Array.isArray(x) ? x : [x]
}

/** Expand a SpreadsheetML <Row> into a 0-indexed array of cell strings, honoring ss:Index gaps. */
function rowCells(row: any): string[] {
  const out: string[] = []
  let col = 0
  for (const cell of asArray(row?.Cell)) {
    const idx = cell?.['@_Index']
    if (idx) col = parseInt(idx, 10) - 1
    const data = cell?.Data
    let val = ''
    if (data != null) {
      val = typeof data === 'object' ? String(data['#text'] ?? '') : String(data)
    }
    out[col] = val
    col++
  }
  return out
}

function num(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** ISO datetime like "2026-06-12T00:00:00" -> "2026-06-12". */
function isoDate(v: string | undefined): string | undefined {
  if (!v) return undefined
  const m = v.match(/(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

export function parsePositionsXls(buffer: Buffer): { lots: RawLot[]; fund: FundSnapshot | null } {
  const parsed = xml.parse(buffer.toString('utf8'))
  const worksheets = asArray(parsed?.Workbook?.Worksheet)
  const ws =
    worksheets.find((w: any) => String(w?.['@_Name'] || '').toLowerCase().includes('position details')) ||
    worksheets[0]
  const rows = asArray(ws?.Table?.Row)
  if (rows.length < 2) {
    console.error('[ERROR] Position Details: <2 rows parsed — format may have changed.')
    return { lots: [], fund: null }
  }

  const header = rowCells(rows[0])
  const H: Record<string, number> = {}
  header.forEach((name, i) => { if (name) H[name] = i })
  const col = (name: string): number => (name in H ? H[name] : -1)
  const get = (cells: string[], name: string): string | undefined => {
    const i = col(name); return i >= 0 ? cells[i] : undefined
  }

  // Required columns — fail loud if the layout drifts.
  const required = ['Ticker', 'Tax Lot Quantity', 'Acquisition Date', 'LT/ST', 'Tax Lot Gain/Loss (Base)']
  const missing = required.filter(c => col(c) === -1)
  if (missing.length) {
    console.error(`[ERROR] Position Details missing columns: ${missing.join(', ')} — format changed.`)
    return { lots: [], fund: null }
  }

  const dataRows = rows.slice(1).map(rowCells).filter(c => (get(c, 'Ticker') || '').trim() !== '')

  let fund: FundSnapshot | null = null
  if (dataRows.length) {
    const f = dataRows[0]
    fund = {
      snapshot_date: isoDate(get(f, 'Tax Lot Effective Date')) || '',
      nav: num(get(f, 'NAV')),
      total_net_assets: num(get(f, 'Total Net Assets')),
      shares_outstanding: num(get(f, 'Fund Shares Outstanding')),
      total_market_value: num(get(f, 'Total Market Value')),
    }
  }

  const lots: RawLot[] = dataRows.map(c => ({
    snapshot_date: fund?.snapshot_date || '',
    ticker: (get(c, 'Ticker') || '').trim().toUpperCase(),
    cusip: get(c, 'Security Identifier'),
    issue_name: get(c, 'Issue Name'),
    acquisition_date: isoDate(get(c, 'Acquisition Date')),
    quantity: num(get(c, 'Tax Lot Quantity')) ?? 0,
    unit_cost: num(get(c, 'Tax Lot Unit Cost (Base)')),
    total_cost: num(get(c, 'Tax Lot Total Cost (Base)')),
    market_value: num(get(c, 'Tax Lot Market Value (Base)')),
    unrealized_gl: num(get(c, 'Tax Lot Gain/Loss (Base)')),
    lt_st: get(c, 'LT/ST'),
    sec_type: get(c, 'USB Security Type 3'),
  }))

  return { lots, fund }
}
