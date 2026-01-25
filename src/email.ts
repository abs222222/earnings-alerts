/**
 * Email Module for Earnings Alerts
 *
 * Features:
 * - Send emails via Gmail API (Feature 15)
 * - HTML email template with earnings table (Feature 16)
 * - Recipient config loading (Feature 17)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { format } from 'date-fns';
import { getGmailService } from './google-auth';
import { AlertDue, TimeOfDay } from './types';

// Config path
const CONFIG_DIR = join(__dirname, '..', 'config');
const RECIPIENTS_FILE = join(CONFIG_DIR, 'recipients.json');

// ============================================================================
// Recipient Config (Feature 17)
// ============================================================================

interface RecipientsConfig {
  recipients: string[];
  enabled?: boolean;
  notes?: string;
}

/**
 * Load email recipients from config file
 *
 * @returns Array of email addresses
 * @throws Error if config file is missing or invalid
 */
export function getRecipients(): string[] {
  if (!existsSync(RECIPIENTS_FILE)) {
    throw new Error(
      `Recipients config not found: ${RECIPIENTS_FILE}\n` +
        'Create config/recipients.json with {"recipients": ["email@example.com"]}'
    );
  }

  try {
    const content = readFileSync(RECIPIENTS_FILE, 'utf-8');
    const config: RecipientsConfig = JSON.parse(content);

    if (!Array.isArray(config.recipients)) {
      throw new Error('recipients must be an array');
    }

    // Check if enabled (defaults to true if not specified)
    if (config.enabled === false) {
      console.log('[INFO] Email sending is disabled in config');
      return [];
    }

    // Validate email addresses
    const validEmails = config.recipients.filter((email) => {
      if (typeof email !== 'string' || !email.includes('@')) {
        console.warn(`[WARN] Invalid email address skipped: ${email}`);
        return false;
      }
      return true;
    });

    if (validEmails.length === 0) {
      console.warn('[WARN] No valid recipients configured');
    }

    return validEmails;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in recipients config: ${error.message}`);
    }
    throw error;
  }
}

// ============================================================================
// Email Template (Feature 16)
// ============================================================================

/**
 * Format time of day for display
 */
function formatTimeOfDay(timeOfDay: TimeOfDay): string {
  switch (timeOfDay) {
    case 'premarket':
      return 'Pre-market';
    case 'postmarket':
      return 'Post-market';
    default:
      return 'TBD';
  }
}

/**
 * Generate HTML table rows for alerts
 */
function generateTableRows(alerts: AlertDue[]): string {
  return alerts
    .map((alert) => {
      const { report, daysUntilReport } = alert;
      const urgencyClass = daysUntilReport <= 1 ? 'urgent' : '';

      return `
        <tr class="${urgencyClass}">
          <td style="padding: 12px; border-bottom: 1px solid #e0e0e0; font-weight: bold; color: #1976d2;">
            ${escapeHtml(report.ticker)}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">
            ${escapeHtml(report.company)}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">
            ${format(report.reportDate, 'EEE, MMM d')}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">
            ${formatTimeOfDay(report.timeOfDay)}
          </td>
        </tr>`;
    })
    .join('\n');
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format alert data into HTML email
 *
 * @param alerts - Array of alerts due
 * @returns Object with subject and html body
 */
export function formatAlertEmail(alerts: AlertDue[]): { subject: string; html: string } {
  if (alerts.length === 0) {
    return {
      subject: 'Earnings Alert: No companies reporting soon',
      html: '<p>No earnings reports are scheduled for alerts today.</p>',
    };
  }

  // Generate subject line
  const count = alerts.length;
  const companyText = count === 1 ? 'company' : 'companies';

  // Find the earliest report date for context
  const sortedAlerts = [...alerts].sort(
    (a, b) => a.report.reportDate.getTime() - b.report.reportDate.getTime()
  );
  const nextReport = sortedAlerts[0];
  const daysText =
    nextReport.daysUntilReport === 0
      ? 'today'
      : nextReport.daysUntilReport === 1
        ? 'tomorrow'
        : `in ${nextReport.daysUntilReport} days`;

  const subject = `Earnings Alert: ${count} ${companyText} reporting ${daysText}`;

  // Generate HTML body
  const today = format(new Date(), 'EEEE, MMMM d, yyyy');
  const tableRows = generateTableRows(sortedAlerts);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Earnings Alert</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">

  <div style="background: linear-gradient(135deg, #1976d2 0%, #1565c0 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="margin: 0; font-size: 24px; font-weight: 600;">Earnings Alert</h1>
    <p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 14px;">${today}</p>
  </div>

  <div style="background: #f8f9fa; padding: 20px; border: 1px solid #e0e0e0; border-top: none;">
    <p style="margin: 0 0 16px 0; font-size: 16px;">
      <strong>${count}</strong> ${companyText} ${count === 1 ? 'has' : 'have'} upcoming earnings reports:
    </p>

    <table style="width: 100%; border-collapse: collapse; background: white; border-radius: 4px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <thead>
        <tr style="background: #f5f5f5;">
          <th style="padding: 12px; text-align: left; border-bottom: 2px solid #1976d2; font-weight: 600;">Ticker</th>
          <th style="padding: 12px; text-align: left; border-bottom: 2px solid #1976d2; font-weight: 600;">Company</th>
          <th style="padding: 12px; text-align: left; border-bottom: 2px solid #1976d2; font-weight: 600;">Report Date</th>
          <th style="padding: 12px; text-align: left; border-bottom: 2px solid #1976d2; font-weight: 600;">Time</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>

    <p style="margin: 16px 0 0 0; font-size: 13px; color: #666;">
      <strong>Note:</strong> Pre-market reports are typically released between 5:00 AM - 9:30 AM ET.
      Post-market reports are released between 4:00 PM - 8:00 PM ET.
    </p>
  </div>

  <div style="padding: 16px; text-align: center; font-size: 12px; color: #999;">
    <p style="margin: 0;">This is an automated alert from Earnings Alerts.</p>
    <p style="margin: 4px 0 0 0;">Data sourced from Google Sheets.</p>
  </div>

</body>
</html>
`.trim();

  return { subject, html };
}

// ============================================================================
// Gmail Send (Feature 15)
// ============================================================================

/**
 * Create RFC 2822 formatted email message
 */
function createEmailMessage(
  to: string[],
  subject: string,
  htmlBody: string
): string {
  // Create multipart message
  const boundary = `boundary_${Date.now()}`;

  const plainText = 'This email requires an HTML-capable email client.';

  const message = [
    `To: ${to.join(', ')}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    plainText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    htmlBody,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  return message;
}

/**
 * Encode message for Gmail API (URL-safe base64)
 */
function encodeMessage(message: string): string {
  // Convert to base64 and make URL-safe
  const base64 = Buffer.from(message).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Send email via Gmail API
 *
 * @param to - Array of recipient email addresses
 * @param subject - Email subject line
 * @param htmlBody - HTML content of the email
 * @param dryRun - If true, don't actually send (just validate and log)
 * @returns true if email was sent (or would be sent in dry-run), false on error
 */
export async function sendEmail(
  to: string[],
  subject: string,
  htmlBody: string,
  dryRun = false
): Promise<boolean> {
  if (to.length === 0) {
    console.error('[ERROR] No recipients provided');
    return false;
  }

  // Validate inputs
  const invalidEmails = to.filter((email) => !email.includes('@'));
  if (invalidEmails.length > 0) {
    console.error(`[ERROR] Invalid email addresses: ${invalidEmails.join(', ')}`);
    return false;
  }

  // Dry run mode
  if (dryRun) {
    console.log('[DRY RUN] Would send email:');
    console.log(`  To: ${to.join(', ')}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  HTML body length: ${htmlBody.length} chars`);
    return true;
  }

  try {
    // Get Gmail service
    const gmail = await getGmailService();

    // Create and encode message
    const rawMessage = createEmailMessage(to, subject, htmlBody);
    const encodedMessage = encodeMessage(rawMessage);

    // Send via Gmail API
    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    const messageId = response.data.id;
    console.log(`[SUCCESS] Email sent. Message ID: ${messageId}`);
    console.log(`  To: ${to.join(', ')}`);
    console.log(`  Subject: ${subject}`);

    return true;
  } catch (error: any) {
    // Handle specific Gmail API errors
    if (error.code === 401) {
      console.error('[ERROR] Gmail authentication failed. Check credentials.');
    } else if (error.code === 403) {
      console.error('[ERROR] Gmail API access denied. Check scopes/permissions.');
    } else if (error.code === 400) {
      console.error('[ERROR] Invalid email format:', error.message);
    } else {
      console.error('[ERROR] Failed to send email:', error.message || error);
    }

    return false;
  }
}

/**
 * Send earnings alert email
 *
 * Convenience function that combines formatAlertEmail and sendEmail
 *
 * @param alerts - Array of alerts due
 * @param dryRun - If true, don't actually send
 * @returns true if email was sent successfully
 */
export async function sendAlertEmail(
  alerts: AlertDue[],
  dryRun = false
): Promise<boolean> {
  // Get recipients
  const recipients = getRecipients();
  if (recipients.length === 0) {
    console.log('[INFO] No recipients configured, skipping email');
    return false;
  }

  // Format email
  const { subject, html } = formatAlertEmail(alerts);

  // Send
  return sendEmail(recipients, subject, html, dryRun);
}
