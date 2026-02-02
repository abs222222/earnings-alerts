/**
 * Holdings Email Module
 *
 * Read portfolio holdings from Gmail email attachment.
 * Email sender: USBFS.EOS@usbank.com
 * Attachment: Holdings Report.csv
 * Arrives ~7pm each evening with closing positions
 *
 * CSV columns: Date, Account, StockTicker, CUSIP, SecurityName
 */

import { getGmailService } from './google-auth';

// Email search parameters
const HOLDINGS_EMAIL_SUBJECT = 'Clockwise Capital LLC ETF Holdings Report';
const HOLDINGS_ATTACHMENT_NAME = 'Holdings Report.csv';

/**
 * Search Gmail for recent holdings emails
 *
 * @param daysBack - How many days back to search (default: 3)
 * @returns Array of message IDs, sorted by date (most recent first)
 */
export async function searchHoldingsEmail(daysBack = 3): Promise<string[]> {
  const gmail = await getGmailService();

  // Build search query
  // Search for emails from the sender with an attachment
  const query = `subject:"${HOLDINGS_EMAIL_SUBJECT}" has:attachment newer_than:${daysBack}d`;

  console.log(`Searching for holdings emails: ${query}`);

  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 10,
    });

    const messages = response.data.messages;
    if (!messages || messages.length === 0) {
      console.log('No holdings emails found');
      return [];
    }

    // Return message IDs
    const messageIds = messages
      .map((msg) => msg.id)
      .filter((id): id is string => typeof id === 'string');

    console.log(`Found ${messageIds.length} holdings email(s)`);
    return messageIds;
  } catch (error: any) {
    if (error.code === 401) {
      console.error('[ERROR] Gmail authentication failed. Check credentials.');
    } else if (error.code === 403) {
      console.error('[ERROR] Gmail API access denied. Check scopes/permissions.');
    } else {
      console.error('[ERROR] Failed to search emails:', error.message || error);
    }
    return [];
  }
}

/**
 * Download holdings CSV attachment from a specific email
 *
 * @param messageId - Gmail message ID
 * @returns CSV content as string, or null if attachment not found
 */
export async function downloadHoldingsAttachment(
  messageId: string
): Promise<string | null> {
  const gmail = await getGmailService();

  try {
    // Get message with full format to access attachments
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const payload = msg.data.payload;
    if (!payload) {
      console.warn(`[WARN] Message ${messageId} has no payload`);
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
      console.warn(
        `[WARN] No holdings CSV attachment found in message ${messageId}`
      );
      // Log available parts for debugging
      const partInfo = (payload.parts || []).map((p: any) => ({
        filename: p.filename,
        mimeType: p.mimeType,
      }));
      console.log('Available parts:', JSON.stringify(partInfo));
      return null;
    }

    // Download the attachment data
    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: messageId,
      id: attachmentPart.body.attachmentId,
    });

    if (!attachment.data.data) {
      console.warn(`[WARN] Attachment data is empty`);
      return null;
    }

    // Decode base64 attachment data
    // Gmail uses URL-safe base64, need to convert back
    const base64Data = attachment.data.data
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const csvContent = Buffer.from(base64Data, 'base64').toString('utf-8');

    const filename = attachmentPart.filename || 'Holdings Report.csv';
    console.log(`Downloaded attachment: ${filename} (${csvContent.length} bytes)`);

    return csvContent;
  } catch (error: any) {
    console.error(
      `[ERROR] Failed to download attachment from message ${messageId}:`,
      error.message || error
    );
    return null;
  }
}

/**
 * Get email date from message metadata
 *
 * @param messageId - Gmail message ID
 * @returns Date of the email, or null if not found
 */
async function getEmailDate(messageId: string): Promise<Date | null> {
  const gmail = await getGmailService();

  try {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['Date'],
    });

    // internalDate is milliseconds since epoch
    const internalDate = msg.data.internalDate;
    if (internalDate) {
      return new Date(parseInt(internalDate, 10));
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Parse holdings CSV content and extract unique tickers
 *
 * Expected CSV format:
 * Date,Account,StockTicker,CUSIP,SecurityName
 * 2026-01-24,ABC123,AAPL,037833100,Apple Inc
 *
 * @param csvContent - Raw CSV string
 * @returns Array of unique ticker symbols
 */
export function parseHoldingsCSV(csvContent: string): string[] {
  const lines = csvContent.trim().split(/\r?\n/);

  if (lines.length < 2) {
    console.warn('[WARN] Holdings CSV has no data rows');
    return [];
  }

  // Find the StockTicker column index from header
  const header = lines[0].split(',').map((col) => col.trim().toLowerCase());
  const tickerIndex = header.findIndex(
    (col) => col === 'stockticker' || col === 'stock_ticker' || col === 'ticker'
  );

  if (tickerIndex === -1) {
    console.error(
      '[ERROR] Could not find StockTicker column in CSV. Headers:',
      header
    );
    return [];
  }

  console.log(`Found StockTicker column at index ${tickerIndex}`);

  // Extract tickers from data rows
  const tickers = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV parsing (handles basic cases)
    // For complex CSVs with quoted fields, would need a proper parser
    const columns = parseCSVLine(line);
    const ticker = columns[tickerIndex]?.trim().toUpperCase();

    if (ticker && ticker.length > 0 && ticker !== 'STOCKTICKER') {
      // Filter out non-stock items (e.g., cash, bonds)
      // Valid stock tickers are typically 1-5 uppercase letters
      if (/^[A-Z]{1,5}$/.test(ticker)) {
        tickers.add(ticker);
      }
    }
  }

  const uniqueTickers = Array.from(tickers).sort();
  console.log(`Parsed ${uniqueTickers.length} unique tickers from holdings CSV`);

  return uniqueTickers;
}

/**
 * Parse a single CSV line, handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Don't forget the last field
  result.push(current.trim());

  return result;
}

/**
 * Get holdings from email - main entry point
 *
 * Searches for the most recent holdings email, downloads the attachment,
 * and parses it to extract the list of tickers.
 *
 * @returns Array of unique ticker symbols from holdings, or empty array if not found
 */
export async function getHoldingsFromEmail(): Promise<string[]> {
  console.log('\n--- Getting holdings from email ---');

  // Search for recent holdings emails
  const messageIds = await searchHoldingsEmail(3);

  if (messageIds.length === 0) {
    console.warn('[WARN] No holdings emails found in the last 3 days');
    console.warn('[WARN] Holdings will not be used for filtering');
    return [];
  }

  // Try each message until we find one with a valid attachment
  for (const messageId of messageIds) {
    // Get email date for logging
    const emailDate = await getEmailDate(messageId);
    if (emailDate) {
      console.log(
        `Processing holdings email from: ${emailDate.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}`
      );
    }

    // Download attachment
    const csvContent = await downloadHoldingsAttachment(messageId);
    if (!csvContent) {
      console.log('Trying next email...');
      continue;
    }

    // Parse CSV and extract tickers
    const tickers = parseHoldingsCSV(csvContent);
    if (tickers.length === 0) {
      console.log('No valid tickers found, trying next email...');
      continue;
    }

    console.log(`Using holdings from ${emailDate?.toLocaleDateString() || 'email'}`);
    console.log(`Holdings tickers: ${tickers.slice(0, 10).join(', ')}${tickers.length > 10 ? '...' : ''}`);
    console.log('---\n');

    return tickers;
  }

  console.warn('[WARN] Could not extract holdings from any recent email');
  return [];
}
