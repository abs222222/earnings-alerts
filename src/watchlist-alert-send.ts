#!/usr/bin/env node
/**
 * Watchlist Alert Send
 *
 * One-shot CLI invoked by the watchlist-alert.yml GHA workflow when Kronos
 * fires a repository_dispatch event. Builds and sends a single buy-zone alert
 * email via the existing Gmail OAuth credentials configured on this repo.
 *
 * The dispatch payload is forwarded as CLI args (the workflow translates the
 * client_payload JSON into individual flags). All five args are required.
 *
 * Usage:
 *   npx ts-node src/watchlist-alert-send.ts \
 *     --ticker AAPL \
 *     --price 285.30 \
 *     --alert 290.00 \
 *     --proximity-pct -1.6 \
 *     --link https://kronos-internal-dashboard.vercel.app/watchlist \
 *     --recipients adam@example.com,james@clockwise.com \
 *     [--dry-run]
 */

import { Command } from 'commander';
import * as dotenv from 'dotenv';

dotenv.config();

import { sendEmail } from './email';

const program = new Command();
program
  .name('watchlist-alert-send')
  .description('Send a single watchlist buy-zone alert email')
  .requiredOption('--ticker <ticker>', 'Ticker symbol (e.g. AAPL)')
  .requiredOption('--price <price>', 'Current market price', parseFloat)
  .requiredOption('--alert <alert>', 'Alert price set in /stock-input', parseFloat)
  .requiredOption('--proximity-pct <pct>', 'Current price vs alert as a percent', parseFloat)
  .requiredOption('--link <url>', 'Watchlist link to embed in the email')
  .requiredOption('--recipients <emails>', 'Comma-separated email addresses')
  .option('--dry-run', 'Build the email but do not send', false)
  .parse();

const opts = program.opts();
const recipients: string[] = String(opts.recipients).split(',').map(s => s.trim()).filter(Boolean);

if (recipients.length === 0) {
  console.error('No recipients parsed from --recipients flag.');
  process.exit(1);
}

const ticker: string = String(opts.ticker).toUpperCase();
const price = Number(opts.price);
const alert = Number(opts.alert);
const proximityPct = Number(opts.proximityPct);
const link = String(opts.link);

if (!Number.isFinite(price) || !Number.isFinite(alert) || !Number.isFinite(proximityPct)) {
  console.error('price, alert, and proximity-pct must be finite numbers.');
  process.exit(1);
}

const subject = `[Watchlist] ${ticker} hit alert: $${price.toFixed(2)} (alert $${alert.toFixed(2)}, ${proximityPct >= 0 ? '+' : ''}${proximityPct.toFixed(1)}%)`;

const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #1f2937; max-width: 560px; margin: 0 auto; padding: 16px;">
  <div style="border-left: 4px solid #10b981; padding: 12px 16px; background: #ecfdf5; border-radius: 4px;">
    <h2 style="margin: 0 0 8px 0; color: #047857; font-size: 18px;">${ticker} hit alert</h2>
    <p style="margin: 4px 0;"><strong>Current price:</strong> $${price.toFixed(2)}</p>
    <p style="margin: 4px 0;"><strong>Alert price:</strong> $${alert.toFixed(2)}</p>
    <p style="margin: 4px 0;"><strong>Distance from alert:</strong> ${proximityPct >= 0 ? '+' : ''}${proximityPct.toFixed(2)}%</p>
  </div>
  <p style="margin-top: 16px;">
    <a href="${link}" style="background: #2563eb; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; display: inline-block;">Open watchlist</a>
  </p>
  <p style="margin-top: 16px; font-size: 12px; color: #6b7280;">
    Sent by Kronos watchlist alerts. Edit the alert price on /stock-input.
  </p>
</body>
</html>
`.trim();

(async () => {
  const ok = await sendEmail(recipients, subject, html, Boolean(opts.dryRun));
  if (!ok) {
    console.error('sendEmail returned false');
    process.exit(1);
  }
  console.log(`Sent watchlist alert for ${ticker} to ${recipients.length} recipient(s).`);
})().catch(err => {
  console.error('Watchlist alert send threw:', err);
  process.exit(1);
});
