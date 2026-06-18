/**
 * Tidal RGL (Realized Gain/Loss) Email Module
 *
 * Reads the monthly "Clockwise RGL" email from nohm@tidalfg.com, downloads the
 * .xlsx, and parses the realized-sale ledger (one row per closed tax lot for the
 * fiscal year) for the Kronos tax tab.
 *
 * IN-KIND vs DISTRIBUTABLE (validated against the report's own Summary pivot,
 * 5/31/26 file): the `In-Kind RGL` column = 'In-Kind' marks ETF basket-redemption
 * lots delivered to APs (tax-free flush) = $1,167,768.44. Blank = regular market
 * sales (Schwab/RBC), taxable/distributable = $522,670.78. Total $1,690,439.22.
 * (Broker == 'ETF BASKET REDEMPTION IN KIND' and Broker Code 99915 agree exactly.)
 */

import ExcelJS from 'exceljs'
import { getGmailService } from './google-auth'

const RGL_SENDER = 'nohm@tidalfg.com'
const RGL_SUBJECT = 'RGL'

export type RawRealized = {
  fy_start?: string
  fy_end?: string
  event_id?: string
  ticker: string
  cusip?: string
  issue_name?: string
  trade_date: string
  acquisition_date?: string
  term: string                 // 'LONG TERM' | 'SHORT TERM'
  quantity: number
  proceeds?: number
  cost?: number
  realized_gl: number
  in_kind: boolean
  lot_relief_method?: string
}

/** Find recent RGL emails; returns message IDs newest-first. */
export async function searchRglEmails(daysBack = 40): Promise<string[]> {
  const gmail = await getGmailService()
  const query = `from:${RGL_SENDER} subject:${RGL_SUBJECT} has:attachment newer_than:${daysBack}d`
  console.log(`Searching RGL emails: ${query}`)
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 10 })
  return (res.data.messages ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string')
}

/** Download the .xlsx attachment from a message as a Buffer. */
export async function downloadXlsxAttachment(messageId: string): Promise<Buffer | null> {
  const gmail = await getGmailService()
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
  const payload = msg.data.payload
  if (!payload) return null

  const collect = (parts: any[], acc: any[] = []): any[] => {
    for (const p of parts ?? []) { if (p.body?.attachmentId) acc.push(p); if (p.parts) collect(p.parts, acc) }
    return acc
  }
  // Prefer the RGL-named .xlsx (recursively), else any .xlsx — so a nested RGL file isn't
  // missed and an unrelated top-level .xlsx isn't grabbed by mistake.
  const xlsx = collect(payload.parts || []).filter(p => (p.filename || '').toLowerCase().endsWith('.xlsx'))
  const part = xlsx.find(p => /rgl/.test((p.filename || '').toLowerCase())) || xlsx[0] || null
  if (!part?.body?.attachmentId) { console.warn(`[WARN] No .xlsx attachment in ${messageId}`); return null }

  const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.body.attachmentId })
  if (!att.data.data) return null
  const b64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/')
  const buf = Buffer.from(b64, 'base64')
  console.log(`Downloaded ${part.filename} (${buf.length} bytes)`)
  return buf
}

function cellText(v: any): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.richText?.map((r: any) => r.text).join('') ?? '').trim()
  return String(v).trim()
}

function num(v: any): number | undefined {
  if (v == null || v === '') return undefined
  const raw = typeof v === 'object' && v !== null && 'result' in v ? (v as any).result : v
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function isoDate(v: any): string | undefined {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = cellText(v)
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const us = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (us) { const yr = us[3].length === 2 ? `20${us[3]}` : us[3]; return `${yr}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` }
  return undefined
}

export async function parseRglXlsx(buffer: Buffer): Promise<RawRealized[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as any)
  // The ledger is the first worksheet (Tidal_All_...); the Summary pivot is separate.
  const ws = wb.worksheets[0]
  if (!ws || ws.rowCount < 2) {
    console.error('[ERROR] RGL: first worksheet missing or empty.')
    return []
  }

  // Header row = row 1. Map header text -> column number.
  const colOf: Record<string, number> = {}
  const headerRow = ws.getRow(1)
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const name = cellText(cell.value)
    if (name) colOf[name] = colNumber
  })
  const find = (...names: string[]): number => {
    for (const n of names) if (n in colOf) return colOf[n]
    return -1
  }

  const iTicker = find('Ticker')
  const iName = find('Issue Name')
  const iCusip = find('Primary Asset Id')
  const iTrade = find('Trade Date')
  const iAcq = find('Acquisition Date')
  const iTerm = find('Gain/Loss Term')
  const iQty = find('Quantity')
  const iProceeds = find('Proceeds Base')
  const iCost = find('Amortized Cost Base')
  const iGL = find('Total Gain/Loss')
  const iEvent = find('Event ID')
  const iRelief = find('Lot Relief Method')
  const iInKind = find('In-Kind RGL')
  const iFyStart = find('Report Start Date')
  const iFyEnd = find('Report End Date')

  if (iTicker === -1 || iGL === -1 || iTerm === -1) {
    console.error('[ERROR] RGL missing required columns (Ticker / Total Gain/Loss / Gain/Loss Term) — format changed.')
    return []
  }

  const out: RawRealized[] = []
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const ticker = cellText(row.getCell(iTicker).value).toUpperCase()
    const gl = num(row.getCell(iGL).value)
    if (!ticker || gl == null) continue
    const tradeDate = isoDate(row.getCell(iTrade).value)
    if (!tradeDate) continue
    out.push({
      fy_start: iFyStart > -1 ? isoDate(row.getCell(iFyStart).value) : undefined,
      fy_end: iFyEnd > -1 ? isoDate(row.getCell(iFyEnd).value) : undefined,
      event_id: iEvent > -1 ? cellText(row.getCell(iEvent).value) : undefined,
      ticker,
      cusip: iCusip > -1 ? cellText(row.getCell(iCusip).value) : undefined,
      issue_name: iName > -1 ? cellText(row.getCell(iName).value) : undefined,
      trade_date: tradeDate,
      acquisition_date: iAcq > -1 ? isoDate(row.getCell(iAcq).value) : undefined,
      term: cellText(row.getCell(iTerm).value).toUpperCase(),
      quantity: num(row.getCell(iQty).value) ?? 0,
      proceeds: iProceeds > -1 ? num(row.getCell(iProceeds).value) : undefined,
      cost: iCost > -1 ? num(row.getCell(iCost).value) : undefined,
      realized_gl: gl,
      in_kind: iInKind > -1 ? cellText(row.getCell(iInKind).value).toUpperCase() === 'IN-KIND' : false,
      lot_relief_method: iRelief > -1 ? cellText(row.getCell(iRelief).value) : undefined,
    })
  }
  return out
}
