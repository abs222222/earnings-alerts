/**
 * RGL Sync — pulls the latest Tidal "RGL" email, parses the realized-ledger
 * .xlsx, and POSTs to Kronos /api/tax/ingest-rgl (replace-by-fiscal-year).
 *
 *   npm run rgl-sync            # fetch + parse + POST
 *   npm run rgl-sync -- --dry-run
 *
 * Env: INGEST_URL (default prod), INGEST_SECRET (required unless --dry-run),
 *      DAYS_BACK (default 40), MESSAGE_IDS (override). Gmail OAuth via google_token.json.
 */

import { searchRglEmails, downloadXlsxAttachment, parseRglXlsx } from './rgl-email'

const INGEST_URL = process.env.INGEST_URL
  || 'https://kronos-internal-dashboard.vercel.app/api/tax/ingest-rgl'

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\n=== RGL Sync ${dryRun ? '(dry run)' : ''} ===`)

  const explicit = process.env.MESSAGE_IDS?.trim()
  let messageIds: string[]
  if (explicit) {
    messageIds = explicit.split(',').map(s => s.trim()).filter(Boolean)
  } else {
    const daysBack = Number(process.env.DAYS_BACK || 40)
    messageIds = await searchRglEmails(daysBack)
  }
  if (messageIds.length === 0) { console.log('No RGL emails found.'); return }

  // RGL is the full FY-to-date ledger — use the most recent email only.
  const messageId = messageIds[0]
  console.log(`Using latest RGL email ${messageId}`)

  const secret = process.env.INGEST_SECRET
  if (!dryRun && !secret) {
    console.error('[ERROR] INGEST_SECRET not set. Aborting (use --dry-run to parse without posting).')
    process.exit(1)
  }

  const buf = await downloadXlsxAttachment(messageId)
  if (!buf) { console.log('No .xlsx attachment; aborting.'); return }
  const realized = await parseRglXlsx(buf)
  console.log(`Parsed ${realized.length} realized rows, FY ${realized[0]?.fy_start} -> ${realized[0]?.fy_end}`)
  if (realized.length === 0) { console.warn('Parsed 0 rows — possible format change; aborting.'); return }

  if (dryRun) {
    const inkind = realized.filter(r => r.in_kind).reduce((s, r) => s + r.realized_gl, 0)
    const dist = realized.filter(r => !r.in_kind).reduce((s, r) => s + r.realized_gl, 0)
    console.log(`in-kind: ${inkind.toFixed(2)}  distributable: ${dist.toFixed(2)}`)
    console.log('sample:', JSON.stringify(realized[0]))
    return
  }

  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret as string },
    body: JSON.stringify({ realized }),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok || !json.success) console.error(`Ingest failed (HTTP ${res.status}):`, JSON.stringify(json))
  else console.log('Ingested ->', JSON.stringify(json))
}

main().catch(err => { console.error('rgl-sync failed:', err); process.exit(1) })
