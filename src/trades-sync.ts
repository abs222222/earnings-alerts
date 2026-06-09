/**
 * Clockwise Trades Sync
 *
 * Pulls James's recent "Clockwise Trades" emails, parses each xlsx blotter,
 * and POSTs the fills to the Kronos ingest endpoint (which dedups + runs the
 * episode netting). Idempotent: re-running is safe (server dedups by fill_hash).
 *
 *   npm run trades-sync            # fetch + parse + POST
 *   npm run trades-sync -- --dry-run   # fetch + parse + print, no POST
 *
 * Env:
 *   INGEST_URL    (default: prod Kronos /api/ideas/ingest-trades)
 *   INGEST_SECRET (required unless --dry-run)
 *   Gmail OAuth via google_token.json (same as holdings-sync)
 */

import { searchTradesEmails, downloadXlsxAttachment, parseTradesXlsx } from './trades-email';

const INGEST_URL = process.env.INGEST_URL
  || 'https://kronos-internal-dashboard.vercel.app/api/ideas/ingest-trades';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`\n=== Clockwise Trades Sync ${dryRun ? '(dry run)' : ''} ===`);

  const messageIds = await searchTradesEmails(3);
  if (messageIds.length === 0) {
    console.log('No trades emails found in the last 3 days.');
    return;
  }
  console.log(`Found ${messageIds.length} trades email(s).`);

  const secret = process.env.INGEST_SECRET;
  if (!dryRun && !secret) {
    console.error('[ERROR] INGEST_SECRET not set. Aborting (use --dry-run to parse without posting).');
    process.exit(1);
  }

  let totalFills = 0;
  for (const messageId of messageIds) {
    const buf = await downloadXlsxAttachment(messageId);
    if (!buf) { console.log(`  ${messageId}: no xlsx, skipping`); continue; }
    const fills = await parseTradesXlsx(buf);
    console.log(`  ${messageId}: parsed ${fills.length} fills`);
    if (fills.length === 0) {
      console.warn(`  ${messageId}: downloaded a workbook but parsed 0 fills — possible blotter format change (check parser error above)`);
      continue;
    }
    totalFills += fills.length;

    if (dryRun) {
      for (const f of fills) {
        console.log(`    ${f.trade_date} ${f.side} ${f.qty} ${f.ticker} @ ${f.exec_price}` +
          `${f.comments ? ` [${f.comments}]` : ''}`);
      }
      continue;
    }

    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret as string },
      body: JSON.stringify({ fills, source_email_id: messageId }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      console.error(`  ${messageId}: ingest failed (HTTP ${res.status}): ${JSON.stringify(json)}`);
    } else {
      console.log(`  ${messageId}: ingested ->`, JSON.stringify({
        new_fills: json.new_fills, created: json.created, reconciled: json.reconciled,
        scaled: json.scaled, closed: json.closed, skipped: json.skipped?.length ?? 0,
      }));
      if (json.skipped?.length) console.warn(`  ${messageId}: ${json.skipped.length} fill(s) skipped:`, json.skipped);
      if (json.sheet_mirror_ok === false) console.warn(`  ${messageId}: WARNING sheet mirror failed:`, JSON.stringify(json.sheet_mirror));
    }
  }

  console.log(`Done. ${totalFills} fills across ${messageIds.length} email(s).`);
}

main().catch(err => { console.error('trades-sync failed:', err); process.exit(1); });
