#!/usr/bin/env node
/**
 * Earnings Alerts - Main Entry Point
 *
 * Checks for upcoming earnings reports and sends email alerts.
 *
 * Features:
 * - Feature 18: CLI with --check-trading-day, --dry-run, --verbose
 * - Feature 19: Daily check orchestration
 */

import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { format } from 'date-fns';

// Load environment variables
dotenv.config();

// Import modules
import { isTradingDay } from './calendar';
import { getEarningsReports } from './sheets';
import { findDueAlerts, filterUnsentAlerts, markAlertSent } from './alerts';
import { sendAlertEmail, formatAlertEmail, getRecipients } from './email';
import { CliOptions } from './types';

// ============================================================================
// CLI Setup (Feature 18)
// ============================================================================

const program = new Command();

program
  .name('earnings-alerts')
  .description('Email alerts for upcoming company earnings report dates')
  .version('1.0.0')
  .option('--check-trading-day', 'Only run on trading days (skip weekends/holidays)', false)
  .option('--dry-run', 'Show what would be sent without actually sending', false)
  .option('-v, --verbose', 'Verbose output', false);

program.parse();

const rawOptions = program.opts();
const options: CliOptions = {
  checkTradingDay: rawOptions.checkTradingDay,
  dryRun: rawOptions.dryRun,
  verbose: rawOptions.verbose,
};

// ============================================================================
// Logging Helpers
// ============================================================================

function log(message: string): void {
  console.log(message);
}

function logVerbose(message: string): void {
  if (options.verbose) {
    console.log(`[VERBOSE] ${message}`);
  }
}

function logStep(step: number, message: string): void {
  console.log(`\n[Step ${step}] ${message}`);
}

function logSuccess(message: string): void {
  console.log(`[SUCCESS] ${message}`);
}

function logInfo(message: string): void {
  console.log(`[INFO] ${message}`);
}

function logError(message: string): void {
  console.error(`[ERROR] ${message}`);
}

// ============================================================================
// Daily Check Orchestration (Feature 19)
// ============================================================================

async function runDailyCheck(): Promise<void> {
  const today = new Date();
  const todayStr = format(today, 'yyyy-MM-dd');
  const todayDisplay = format(today, 'EEEE, MMMM d, yyyy');

  log('========================================');
  log('Earnings Alerts - Daily Check');
  log('========================================');
  log(`Date: ${todayDisplay}`);

  if (options.dryRun) {
    log('\n*** DRY RUN MODE - No emails will be sent ***');
  }

  if (options.verbose) {
    logVerbose(`Options: ${JSON.stringify(options)}`);
  }

  // -------------------------------------------------------------------------
  // Step 1: Check if trading day (if flag set)
  // -------------------------------------------------------------------------
  if (options.checkTradingDay) {
    logStep(1, 'Checking if today is a trading day...');

    if (!isTradingDay(today)) {
      logInfo(`${todayStr} is not a trading day. Exiting.`);
      return;
    }

    logSuccess(`${todayStr} is a trading day. Continuing.`);
  } else {
    logStep(1, 'Skipping trading day check (--check-trading-day not set)');
  }

  // -------------------------------------------------------------------------
  // Step 2: Read Google Sheet
  // -------------------------------------------------------------------------
  logStep(2, 'Reading earnings data from Google Sheet...');

  let reports;
  try {
    reports = await getEarningsReports();
    logSuccess(`Loaded ${reports.length} earnings reports`);

    if (options.verbose && reports.length > 0) {
      logVerbose('Sample reports:');
      reports.slice(0, 3).forEach((r) => {
        logVerbose(`  ${r.ticker} - ${r.company} - ${format(r.reportDate, 'yyyy-MM-dd')} (${r.timeOfDay})`);
      });
      if (reports.length > 3) {
        logVerbose(`  ... and ${reports.length - 3} more`);
      }
    }
  } catch (error: any) {
    logError(`Failed to read Google Sheet: ${error.message}`);
    throw error;
  }

  if (reports.length === 0) {
    logInfo('No earnings reports found in sheet. Nothing to do.');
    return;
  }

  // -------------------------------------------------------------------------
  // Step 3: Find due alerts
  // -------------------------------------------------------------------------
  logStep(3, 'Finding alerts due today...');

  const dueAlerts = findDueAlerts(reports, today);
  logSuccess(`Found ${dueAlerts.length} alert(s) due today`);

  if (options.verbose && dueAlerts.length > 0) {
    logVerbose('Due alerts:');
    dueAlerts.forEach((alert) => {
      logVerbose(
        `  ${alert.report.ticker} - reports ${alert.reportDateFormatted} (${alert.daysUntilReport} day(s) away)`
      );
    });
  }

  if (dueAlerts.length === 0) {
    logInfo('No alerts due today. Nothing to send.');
    return;
  }

  // -------------------------------------------------------------------------
  // Step 4: Filter unsent alerts
  // -------------------------------------------------------------------------
  logStep(4, 'Filtering out already-sent alerts...');

  const unsentAlerts = filterUnsentAlerts(dueAlerts);
  logSuccess(`${unsentAlerts.length} unsent alert(s) remain`);

  if (unsentAlerts.length === 0) {
    logInfo('All due alerts have already been sent. Nothing to do.');
    return;
  }

  if (options.verbose && unsentAlerts.length > 0) {
    logVerbose('Unsent alerts:');
    unsentAlerts.forEach((alert) => {
      logVerbose(`  ${alert.report.ticker} - ${alert.report.company}`);
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: Send email (or dry-run)
  // -------------------------------------------------------------------------
  logStep(5, options.dryRun ? 'Preparing email (dry run)...' : 'Sending email...');

  // Show email preview in verbose mode
  if (options.verbose || options.dryRun) {
    const { subject, html } = formatAlertEmail(unsentAlerts);
    log(`\n  Subject: ${subject}`);
    log(`  Recipients: ${getRecipients().join(', ') || '(none configured)'}`);
    log(`  Alerts included: ${unsentAlerts.length}`);

    if (options.dryRun) {
      // Show a summary of what would be sent
      log('\n  Companies in alert:');
      unsentAlerts.forEach((alert) => {
        log(`    - ${alert.report.ticker}: ${alert.report.company} (${alert.report.timeOfDay})`);
      });
    }
  }

  let emailSent: boolean;
  try {
    emailSent = await sendAlertEmail(unsentAlerts, options.dryRun);

    if (options.dryRun) {
      logSuccess('Dry run complete. Email would have been sent.');
    } else if (emailSent) {
      logSuccess('Email sent successfully!');
    } else {
      logError('Email was not sent (see errors above)');
    }
  } catch (error: any) {
    logError(`Failed to send email: ${error.message}`);
    throw error;
  }

  // -------------------------------------------------------------------------
  // Step 6: Mark alerts as sent (skip in dry-run mode)
  // -------------------------------------------------------------------------
  if (!options.dryRun && emailSent) {
    logStep(6, 'Marking alerts as sent...');

    for (const alert of unsentAlerts) {
      markAlertSent(alert.report.ticker, alert.report.reportDate);
      logVerbose(`Marked as sent: ${alert.report.ticker}`);
    }

    logSuccess(`Marked ${unsentAlerts.length} alert(s) as sent`);
  } else if (options.dryRun) {
    logStep(6, 'Skipping mark-as-sent (dry run mode)');
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log('\n========================================');
  log('Summary');
  log('========================================');
  log(`Total reports in sheet: ${reports.length}`);
  log(`Alerts due today: ${dueAlerts.length}`);
  log(`New alerts sent: ${options.dryRun ? '0 (dry run)' : unsentAlerts.length}`);
  log('========================================');
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  try {
    await runDailyCheck();
  } catch (error: any) {
    logError(error.message || 'Unknown error occurred');
    if (options.verbose && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
