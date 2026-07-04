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
 * Also syncs the monthly RGL (realized gain/loss) report -> /api/tax/ingest-rgl.
 * In-kind lots are flagged straight from the file (In-Kind RGL column / Broker),
 * and the ingest replaces by fiscal year, so re-running is safe.
 *
 * Env:
 *   INGEST_URL_POSITIONS (default: prod Kronos /api/tax/ingest-positions)
 *   INGEST_URL_RGL       (default: prod Kronos /api/tax/ingest-rgl)
 *   INGEST_SECRET        (required unless --dry-run)
 *   DAYS_BACK            (default 10 — covers the weekly cadence + delivery lag)
 *   RGL_DAYS_BACK        (default 40 — the RGL is monthly)
 *   MESSAGE_IDS          (comma-separated; position backfill override; skips RGL)
 *   Gmail OAuth via google_token.json (same as trades-sync / holdings-sync)
 */

import {
  searchPositionEmails, searchRglEmails, downloadAttachment,
  parsePositionsXls, parseRglXlsx, dateFromFilename,
} from './tidal-email';

const POSITIONS_URL = process.env.INGEST_URL_POSITIONS
  || 'https://kronos-internal-dashboard.vercel.app/api/tax/ingest-positions';
const RGL_URL = process.env.INGEST_URL_RGL
  || 'https://kronos-internal-dashboard.vercel.app/api/tax/ingest-rgl';

const POSITION_FILE = /Position Details.*\.xls$/i;
const RGL_FILE = /RGL.*\.xlsx$/i;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`\n=== Tidal Sync ${dryRun ? '(dry run)' : ''} ===`);
  // GHA/Task Scheduler key off the exit code; a POST or parse failure must NOT exit 0
  // (a green run on a failed ingest is the exact silent-staleness this pipeline prevents).
  let failures = 0;

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
    if (!snapshot) { console.error(`  ${messageId}: cannot parse snapshot date from "${dl.filename}", skipping`); failures++; continue; }

    let lots, fund;
    try {
      ({ lots, fund } = parsePositionsXls(dl.buffer, snapshot));
    } catch (e) {
      console.error(`  ${messageId}: parse failed for ${dl.filename}:`, e instanceof Error ? e.message : e);
      failures++; continue;
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
      failures++;
    } else {
      console.log(`  ${messageId}: ingested -> snapshot ${json.snapshot_date}, ${json.lots_inserted} lots`);
    }
  }

  // ---------- RGL (monthly realized ledger) ----------
  // Skipped on an explicit MESSAGE_IDS position backfill (those ids are position emails).
  if (!explicit) {
    const rglDays = Number(process.env.RGL_DAYS_BACK || 40);
    const rglIds = (await searchRglEmails(rglDays)).reverse();
    if (rglIds.length === 0) {
      console.log('No RGL emails found.');
    } else {
      console.log(`Processing ${rglIds.length} RGL email(s).`);
    }
    for (const messageId of rglIds) {
      const dl = await downloadAttachment(messageId, RGL_FILE);
      if (!dl) { console.log(`  ${messageId}: no RGL .xlsx, skipping`); continue; }
      const fyEnd = dateFromFilename(dl.filename);
      if (!fyEnd) { console.error(`  ${messageId}: cannot parse date from "${dl.filename}", skipping`); failures++; continue; }

      let realized;
      try {
        realized = await parseRglXlsx(dl.buffer, fyEnd);
      } catch (e) {
        console.error(`  ${messageId}: RGL parse failed for ${dl.filename}:`, e instanceof Error ? e.message : e);
        failures++; continue;
      }
      const ikSum = realized.filter(r => r.in_kind).reduce((s, r) => s + r.realized_gl, 0);
      const total = realized.reduce((s, r) => s + r.realized_gl, 0);
      console.log(`  ${messageId}: ${dl.filename} -> fy_end ${fyEnd}, ${realized.length} rows, ${realized.filter(r => r.in_kind).length} in-kind`);

      if (dryRun) {
        console.log(`    total realized ${total.toFixed(0)} | in-kind ${ikSum.toFixed(0)} | distributable ${(total - ikSum).toFixed(0)}`);
        continue;
      }

      const res = await fetch(RGL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret as string },
        body: JSON.stringify({ realized }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (json.skipped) {
        console.log(`  ${messageId}: RGL skipped (stale): ${json.message}`);
      } else if (!res.ok || !json.success) {
        console.error(`  ${messageId}: RGL ingest failed (HTTP ${res.status}): ${JSON.stringify(json)}`);
        failures++;
      } else {
        console.log(`  ${messageId}: RGL ingested -> fy ${json.fy_start}..${json.fy_end}, ${json.rows_inserted} rows`);
      }
    }
  }

  console.log(`Done.${failures ? ` ${failures} failure(s).` : ''}`);
  if (failures > 0) process.exit(1);  // fail the job so a broken ingest doesn't show green
}

main().catch(err => { console.error('tidal-sync failed:', err); process.exit(1); });
