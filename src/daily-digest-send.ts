#!/usr/bin/env node
/**
 * Daily Digest Send
 *
 * One-shot CLI invoked by the daily-digest.yml GHA workflow when Kronos fires a
 * repository_dispatch event. Decodes the base64 HTML body built by Kronos and
 * sends it via the existing Gmail OAuth credentials configured on this repo.
 *
 * Usage:
 *   npx ts-node src/daily-digest-send.ts \
 *     --subject "Kronos AM: ..." \
 *     --html-b64 <base64> \
 *     --recipients adam@example.com,james@clockwise.com \
 *     [--dry-run]
 */

import { Command } from 'commander';
import * as dotenv from 'dotenv';

dotenv.config();

import { sendEmail } from './email';

const program = new Command();
program
  .name('daily-digest-send')
  .description('Send the Kronos daily report digest email')
  .requiredOption('--subject <subject>', 'Email subject line')
  .requiredOption('--html-b64 <b64>', 'Base64-encoded HTML body')
  .requiredOption('--recipients <emails>', 'Comma-separated email addresses')
  .option('--dry-run', 'Build the email but do not send', false)
  .parse();

const opts = program.opts();
const recipients: string[] = String(opts.recipients).split(',').map((s) => s.trim()).filter(Boolean);

if (recipients.length === 0) {
  console.error('No recipients parsed from --recipients flag.');
  process.exit(1);
}

const subject = String(opts.subject);
let html: string;
try {
  html = Buffer.from(String(opts.htmlB64), 'base64').toString('utf-8');
} catch {
  console.error('Failed to decode --html-b64.');
  process.exit(1);
}
if (!html.trim()) {
  console.error('Decoded HTML body is empty.');
  process.exit(1);
}

(async () => {
  const ok = await sendEmail(recipients, subject, html, Boolean(opts.dryRun));
  if (!ok) {
    console.error('sendEmail returned false');
    process.exit(1);
  }
  console.log(`Sent daily digest to ${recipients.length} recipient(s).`);
})().catch((err) => {
  console.error('Daily digest send threw:', err);
  process.exit(1);
});
