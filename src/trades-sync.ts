/**
 * Clockwise Trades Sync
 *
 * Pulls James's recent "Clockwise Trades" emails, parses each xlsx blotter,
 * and POSTs the fills to the Kronos ingest endpoint (which dedups them into
 * trade_fills). Idempotent: re-running is safe (server dedups by fill_hash).
 *
 *   npm run trades-sync            # fetch + parse + POST
 *   npm run trades-sync -- --dry-run   # fetch + parse + print, no POST
 *
 * Env:
 *   INGEST_URL     (default: prod Kronos /api/ideas/ingest-trades)
 *   INGEST_SECRET  (required unless --dry-run)
 *   DAYS_BACK      (default 7) how far back to search for blotter emails
 *   ALERT_ON_EMPTY ('true' on the day's last scheduled run) fail instead of
 *                  exiting 0 when no blotter email was found at all
 *   Gmail OAuth via google_token.json (same as holdings-sync)
 */

import { searchTradesEmails, downloadXlsxAttachment, parseTradesXlsx } from './trades-email';

const INGEST_URL = process.env.INGEST_URL
  || 'https://kronos-internal-dashboard.vercel.app/api/ideas/ingest-trades';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`\n=== Clockwise Trades Sync ${dryRun ? '(dry run)' : ''} ===`);

  // Explicit MESSAGE_IDS (comma-separated, in chronological order) override the
  // search — used for backfills. Otherwise search the last DAYS_BACK days and
  // process oldest-first so a multi-day run nets in trade-date order.
  const explicit = process.env.MESSAGE_IDS?.trim();
  let messageIds: string[];
  if (explicit) {
    messageIds = explicit.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`Using ${messageIds.length} explicit message id(s).`);
  } else {
    // 7 days rather than 3: ingest dedups on fill content, not message id, so
    // re-reading an already-processed email is a no-op. The wider window means a
    // multi-day outage (the 2026-08-06 GHA incident ran 10h42m) still self-heals
    // on the next run instead of dropping those fills for good.
    const daysBack = Number(process.env.DAYS_BACK || 7);
    messageIds = (await searchTradesEmails(daysBack)).reverse();
  }
  if (messageIds.length === 0) {
    // Nothing found on the day's LAST scheduled run means no blotter arrived at
    // all, which is a data gap rather than a clean run. Fail the job so it can't
    // report green, same reason tidal-sync exits 1 on ingest failures. The 6 PM
    // run stays quiet because James sometimes sends after it.
    if (process.env.ALERT_ON_EMPTY === 'true') {
      console.error('No trades emails found on the last run of the day. No blotter arrived; trade_fills has a gap for this session.');
      process.exit(1);
    }
    console.log('No trades emails found.');
    return;
  }
  console.log(`Processing ${messageIds.length} trades email(s).`);

  const secret = process.env.INGEST_SECRET;
  if (!dryRun && !secret) {
    console.error('[ERROR] INGEST_SECRET not set. Aborting (use --dry-run to parse without posting).');
    process.exit(1);
  }

  let totalFills = 0;
  let failures = 0;
  for (const messageId of messageIds) {
    const buf = await downloadXlsxAttachment(messageId);
    if (!buf) { console.error(`  ${messageId}: no xlsx, skipping`); failures++; continue; }
    const fills = await parseTradesXlsx(buf);
    console.log(`  ${messageId}: parsed ${fills.length} fills`);
    if (fills.length === 0) {
      console.error(`  ${messageId}: downloaded a workbook but parsed 0 fills — possible blotter format change (check parser error above)`);
      failures++;
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
      failures++;
    } else {
      console.log(`  ${messageId}: ingested ->`, JSON.stringify({
        received: json.received, new_fills: json.new_fills, skipped: json.skipped?.length ?? 0,
      }));
      if (json.skipped?.length) console.warn(`  ${messageId}: ${json.skipped.length} fill(s) skipped:`, json.skipped);
      if (json.sheet_mirror_ok === false) console.warn(`  ${messageId}: WARNING sheet mirror failed:`, JSON.stringify(json.sheet_mirror));
    }
  }

  console.log(`Done. ${totalFills} fills parsed across ${messageIds.length} email(s).` +
    `${failures ? ` ${failures} FAILED to ingest.` : ''}`);
  // Parsing is not ingesting. Five 401s from the Kronos endpoint on 2026-08-11
  // still printed "Done. 36 fills" and exited 0, so the workflow was green while
  // trade_fills received nothing. Fail the job like tidal-sync does.
  if (failures > 0) process.exit(1);
}

main().catch(err => { console.error('trades-sync failed:', err); process.exit(1); });
