/**
 * Tidal Sync
 *
 * Pulls Tidal's weekly "Position Details Report" emails (nohm@tidalfg.com),
 * parses each Tax-Lots .xls, and POSTs the lots + fund snapshot to the Kronos
 * tax ingest endpoint. Idempotent: the endpoint replaces by snapshot_date, and
 * a re-sent OLDER snapshot only touches its own date, never the live view.
 *
 *   npm run tidal-sync                # fetch + parse + POST the latest report(s)
 *   npm run tidal-sync -- --dry-run   # fetch + parse + print, no POST
 *
 * Env:
 *   INGEST_URL_POSITIONS (default: prod Kronos /api/tax/ingest-positions)
 *   INGEST_SECRET        (required unless --dry-run)
 *   DAYS_BACK            (default 10 — covers the weekly cadence + delivery lag)
 *   MESSAGE_IDS          (comma-separated; backfill override, processed as given)
 *   Gmail OAuth via google_token.json (same as trades-sync / holdings-sync)
 *
 * RGL (monthly realized ledger) is intentionally NOT synced here yet — the
 * in-kind rule needs confirmation first (see parseRglXlsx). Phase 1b.
 */

import {
  searchPositionEmails, downloadAttachment, parsePositionsXls, dateFromFilename,
} from './tidal-email';

const POSITIONS_URL = process.env.INGEST_URL_POSITIONS
  || 'https://kronos-internal-dashboard.vercel.app/api/tax/ingest-positions';

const POSITION_FILE = /Position Details.*\.xls$/i;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`\n=== Tidal Sync ${dryRun ? '(dry run)' : ''} ===`);

  const explicit = process.env.MESSAGE_IDS?.trim();
  let messageIds: string[];
  if (explicit) {
    messageIds = explicit.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`Using ${messageIds.length} explicit message id(s).`);
  } else {
    const daysBack = Number(process.env.DAYS_BACK || 10);
    // Oldest-first so a multi-report run lands newest snapshot last.
    messageIds = (await searchPositionEmails(daysBack)).reverse();
  }
  if (messageIds.length === 0) { console.log('No Position Details emails found.'); return; }
  console.log(`Processing ${messageIds.length} Position Details email(s).`);

  const secret = process.env.INGEST_SECRET;
  if (!dryRun && !secret) {
    console.error('[ERROR] INGEST_SECRET not set. Aborting (use --dry-run to parse without posting).');
    process.exit(1);
  }

  for (const messageId of messageIds) {
    const dl = await downloadAttachment(messageId, POSITION_FILE);
    if (!dl) { console.log(`  ${messageId}: no Position Details .xls, skipping`); continue; }

    const snapshot = dateFromFilename(dl.filename);
    if (!snapshot) { console.error(`  ${messageId}: cannot parse snapshot date from "${dl.filename}", skipping`); continue; }

    let lots, fund;
    try {
      ({ lots, fund } = parsePositionsXls(dl.buffer, snapshot));
    } catch (e) {
      console.error(`  ${messageId}: parse failed for ${dl.filename}:`, e instanceof Error ? e.message : e);
      continue;
    }
    const totalMv = lots.reduce((s, l) => s + (l.market_value ?? 0), 0);
    const names = new Set(lots.map(l => l.ticker)).size;
    console.log(`  ${messageId}: ${dl.filename} -> snapshot ${snapshot}, ${lots.length} lots, ${names} names, MV ${totalMv.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

    if (dryRun) {
      console.log(`    fund: NAV ${fund?.nav} · TNA ${fund?.total_net_assets} · shares ${fund?.shares_outstanding}`);
      const byName = new Map<string, number>();
      for (const l of lots) byName.set(l.ticker, (byName.get(l.ticker) ?? 0) + (l.unrealized_gl ?? 0));
      const losers = [...byName.entries()].filter(([, gl]) => gl < 0).sort((a, b) => a[1] - b[1]).slice(0, 8);
      console.log(`    top unrealized losses: ${losers.map(([t, gl]) => `${t} ${Math.round(gl).toLocaleString()}`).join(', ')}`);
      continue;
    }

    const res = await fetch(POSITIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret as string },
      body: JSON.stringify({ lots, fund }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      console.error(`  ${messageId}: ingest failed (HTTP ${res.status}): ${JSON.stringify(json)}`);
    } else {
      console.log(`  ${messageId}: ingested -> snapshot ${json.snapshot_date}, ${json.lots_inserted} lots`);
    }
  }
  console.log('Done.');
}

main().catch(err => { console.error('tidal-sync failed:', err); process.exit(1); });
