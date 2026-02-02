#!/usr/bin/env node
/**
 * Holdings Sync - Sync holdings from email to Google Sheets
 *
 * Reads holdings CSV from Gmail attachment and writes to Google Sheets
 * for Supabase integration.
 *
 * Only creates a new tab if there's a holdings email from today.
 *
 * Usage:
 *   npx ts-node src/holdings-sync.ts [--dry-run]
 */

import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { format, differenceInHours } from 'date-fns';

dotenv.config();

import { getGmailService } from './google-auth';
import { writeHoldingsToSheet, overwriteKronosHoldings } from './sheets';

// Configuration
const HOLDINGS_EMAIL_SUBJECT = 'Clockwise Capital LLC ETF Holdings Report';

// CLI setup
const program = new Command();
program
  .name('holdings-sync')
  .description('Sync holdings from email to Google Sheets')
  .option('--dry-run', 'Show what would be done without writing', false)
  .parse();

const options = program.opts();

// How many hours back to look for holdings emails
// Covers 5pm-11pm EST window with buffer (workflow runs at 11pm EST)
const MAX_EMAIL_AGE_HOURS = 8;

/**
 * Search Gmail for recent holdings emails (within last 8 hours)
 */
async function searchRecentHoldingsEmail(): Promise<{ messageId: string; date: Date } | null> {
  const gmail = await getGmailService();

  // Search by subject (works with both direct and forwarded emails)
  const query = `subject:"${HOLDINGS_EMAIL_SUBJECT}" has:attachment newer_than:1d`;
  console.log(`Searching for holdings emails: ${query}`);

  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 5,
  });

  const messages = response.data.messages;
  if (!messages || messages.length === 0) {
    console.log('No holdings emails found in the last day');
    return null;
  }

  const now = new Date();

  // Check each message to find one within the last N hours
  for (const msg of messages) {
    if (!msg.id) continue;

    const msgDetail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['Date'],
    });

    const internalDate = msgDetail.data.internalDate;
    if (internalDate) {
      const emailDate = new Date(parseInt(internalDate, 10));
      const hoursAgo = differenceInHours(now, emailDate);

      if (hoursAgo <= MAX_EMAIL_AGE_HOURS) {
        console.log(`Found recent holdings email: ${format(emailDate, 'yyyy-MM-dd HH:mm')} (${hoursAgo}h ago)`);
        return { messageId: msg.id, date: emailDate };
      }
    }
  }

  console.log(`No holdings email found within the last ${MAX_EMAIL_AGE_HOURS} hours`);
  return null;
}

/**
 * Download holdings CSV attachment from email
 */
async function downloadHoldingsCSV(messageId: string): Promise<string | null> {
  const gmail = await getGmailService();

  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const payload = msg.data.payload;
  if (!payload) {
    console.warn('Message has no payload');
    return null;
  }

  // Find CSV attachment (recurse into nested parts for forwarded emails)
  function findCsvPart(parts: any[]): any {
    for (const part of parts) {
      const filename = (part.filename || '').toLowerCase();
      if (filename.includes('holdings') && filename.endsWith('.csv')) {
        return part;
      }
      if (part.body?.attachmentId && part.mimeType === 'text/csv') {
        return part;
      }
      if (part.parts) {
        const nested = findCsvPart(part.parts);
        if (nested) return nested;
      }
    }
    return null;
  }

  const attachmentPart = findCsvPart(payload.parts || []);

  if (!attachmentPart || !attachmentPart.body?.attachmentId) {
    console.warn('No holdings CSV attachment found');
    return null;
  }

  // Download attachment
  const attachment = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId: messageId,
    id: attachmentPart.body.attachmentId,
  });

  if (!attachment.data.data) {
    console.warn('Attachment data is empty');
    return null;
  }

  // Decode base64 (Gmail uses URL-safe base64)
  const base64Data = attachment.data.data.replace(/-/g, '+').replace(/_/g, '/');
  const csvContent = Buffer.from(base64Data, 'base64').toString('utf-8');

  const filename = attachmentPart.filename || 'Holdings Report.csv';
  console.log(`Downloaded attachment: ${filename} (${csvContent.length} bytes)`);

  return csvContent;
}

/**
 * Parse CSV content into 2D array
 */
function parseCSV(csvContent: string): string[][] {
  const lines = csvContent.trim().split(/\r?\n/);
  const rows: string[][] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    // Simple CSV parsing with quote handling
    const row: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        row.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    row.push(current.trim());
    rows.push(row);
  }

  // Remove trailing empty rows
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === '')) {
    rows.pop();
  }

  return rows;
}

/**
 * Main function
 */
async function main(): Promise<void> {
  console.log('========================================');
  console.log('Holdings Sync - Email to Google Sheets');
  console.log('========================================');
  console.log(`Date: ${format(new Date(), 'EEEE, MMMM d, yyyy')}`);

  if (options.dryRun) {
    console.log('\n*** DRY RUN MODE ***\n');
  }

  // Step 1: Find recent holdings email (within last 8 hours)
  console.log('\n[Step 1] Searching for recent holdings email...');
  const emailInfo = await searchRecentHoldingsEmail();

  if (!emailInfo) {
    console.log('\nNo recent holdings email found. Nothing to sync.');
    return;
  }

  // Step 2: Download CSV attachment
  console.log('\n[Step 2] Downloading CSV attachment...');
  const csvContent = await downloadHoldingsCSV(emailInfo.messageId);

  if (!csvContent) {
    console.error('Failed to download CSV attachment');
    process.exit(1);
  }

  // Step 3: Parse CSV
  console.log('\n[Step 3] Parsing CSV...');
  const rows = parseCSV(csvContent);
  console.log(`Parsed ${rows.length} rows (including header)`);

  if (rows.length === 0) {
    console.error('No data in CSV');
    process.exit(1);
  }

  // Step 4: Write to Google Sheet
  const tabDate = format(emailInfo.date, 'yyyy-MM-dd');

  if (options.dryRun) {
    console.log(`\n[Step 4] Would write ${rows.length} rows to tab "${tabDate}"`);
    console.log(`[Step 5] Would overwrite Kronos Dashboard holdings tab`);
    console.log('\nDry run complete. No data written.');
    return;
  }

  console.log(`\n[Step 4] Writing to Google Sheet...`);
  const tabName = await writeHoldingsToSheet(rows, tabDate);

  // Step 5: Overwrite Kronos Dashboard holdings tab
  console.log(`\n[Step 5] Overwriting Kronos Dashboard holdings...`);
  await overwriteKronosHoldings(rows);

  console.log('\n========================================');
  console.log(`SUCCESS: Holdings written to tab "${tabName}"`);
  console.log(`SUCCESS: Kronos Dashboard holdings overwritten`);
  console.log('========================================');
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
