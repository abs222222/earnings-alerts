/**
 * Positions Sync — pulls the latest Tidal "Position Details" email, parses the
 * tax-lot .xls, and POSTs to Kronos /api/tax/ingest-positions (replace-by-snapshot).
 *
 *   npm run positions-sync            # fetch + parse + POST
 *   npm run positions-sync -- --dry-run
 *
 * Env: INGEST_URL (default prod), INGEST_SECRET (required unless --dry-run),
 *      DAYS_BACK (default 10), MESSAGE_IDS (override search). Gmail OAuth via
 *      google_token.json (same as holdings/trades sync).
 */

import { searchPositionsEmails, downloadXlsAttachment, parsePositionsXls } from './positions-email'

const INGEST_URL = process.env.INGEST_URL
  || 'https://kronos-internal-dashboard.vercel.app/api/tax/ingest-positions'

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\n=== Positions Sync ${dryRun ? '(dry run)' : ''} ===`)

  const explicit = process.env.MESSAGE_IDS?.trim()
  let messageIds: string[]
  if (explicit) {
    messageIds = explicit.split(',').map(s => s.trim()).filter(Boolean)
  } else {
    const daysBack = Number(process.env.DAYS_BACK || 10)
    messageIds = await searchPositionsEmails(daysBack)
  }
  if (messageIds.length === 0) { console.log('No positions emails found.'); return }

  // Position Details is a full snapshot — use the most recent email only.
  const messageId = messageIds[0]
  console.log(`Using latest positions email ${messageId}`)

  const secret = process.env.INGEST_SECRET
  if (!dryRun && !secret) {
    console.error('[ERROR] INGEST_SECRET not set. Aborting (use --dry-run to parse without posting).')
    process.exit(1)
  }

  const buf = await downloadXlsAttachment(messageId)
  if (!buf) { console.log('No .xls attachment; aborting.'); return }
  const { lots, fund } = parsePositionsXls(buf)
  console.log(`Parsed ${lots.length} lots, fund snapshot ${fund?.snapshot_date}`)
  if (lots.length === 0) { console.warn('Parsed 0 lots — possible format change; aborting.'); return }

  if (dryRun) {
    console.log('fund:', JSON.stringify(fund))
    console.log('sample lot:', JSON.stringify(lots[0]))
    return
  }

  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret as string },
    body: JSON.stringify({ lots, fund }),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok || !json.success) console.error(`Ingest failed (HTTP ${res.status}):`, JSON.stringify(json))
  else console.log('Ingested ->', JSON.stringify(json))
}

main().catch(err => { console.error('positions-sync failed:', err); process.exit(1) })
