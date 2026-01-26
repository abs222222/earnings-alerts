#!/usr/bin/env node
/**
 * Earnings Alerts - Main Entry Point
 *
 * Checks for upcoming earnings reports and sends email alerts.
 *
 * Features:
 * - Feature 18: CLI with --check-trading-day, --dry-run, --verbose
 * - Feature 19: Daily check orchestration
 * - Feature 27: Holdings priority - integrates holdings from email
 */

import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { format } from 'date-fns';

// Load environment variables
dotenv.config();

// Import modules
import { isTradingDay } from './calendar';
import { getHoldingsFromEmail } from './holdings-email';
import { getWatchlistTickers, getEarningsReports } from './sheets';
import { findDueAlerts, filterUnsentAlerts, markAlertSent } from './alerts';
import { sendAlertEmail, formatAlertEmail, getRecipients, AlertSections } from './email';
import { CliOptions, EarningsReport, AlertDue } from './types';
import { tradingDaysUntil, getNextTradingDay } from './calendar';

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
// Daily Check Orchestration (Feature 19, updated with Feature 27)
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
  // Step 2: Get holdings from email (Feature 27)
  // -------------------------------------------------------------------------
  logStep(2, 'Getting holdings from email...');

  let holdingsTickers: string[] = [];
  try {
    holdingsTickers = await getHoldingsFromEmail();
    logSuccess(`Found ${holdingsTickers.length} holdings`);

    if (options.verbose && holdingsTickers.length > 0) {
      logVerbose(`Holdings: ${holdingsTickers.slice(0, 10).join(', ')}${holdingsTickers.length > 10 ? '...' : ''}`);
    }
  } catch (error: any) {
    logError(`Failed to get holdings from email: ${error.message}`);
    logInfo('Continuing without holdings data...');
  }

  // -------------------------------------------------------------------------
  // Step 3: Get watchlist tickers from sheet (Feature 27)
  // -------------------------------------------------------------------------
  logStep(3, 'Getting watchlist tickers...');

  let watchlistTickers: string[] = [];
  try {
    watchlistTickers = await getWatchlistTickers();
    logSuccess(`Found ${watchlistTickers.length} watchlist tickers`);

    if (options.verbose && watchlistTickers.length > 0) {
      logVerbose(`Watchlist: ${watchlistTickers.slice(0, 10).join(', ')}${watchlistTickers.length > 10 ? '...' : ''}`);
    }
  } catch (error: any) {
    logError(`Failed to get watchlist: ${error.message}`);
    logInfo('Continuing without watchlist filter...');
  }

  // Combine tickers for filtering (holdings always included)
  const allTickersOfInterest = new Set([...holdingsTickers, ...watchlistTickers]);
  logInfo(`Total tickers of interest: ${allTickersOfInterest.size}`);

  // -------------------------------------------------------------------------
  // Step 4: Read Google Sheet (all earnings reports)
  // -------------------------------------------------------------------------
  logStep(4, 'Reading earnings data from Google Sheet...');

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

  // Filter earnings reports to only tickers of interest (Feature 27)
  const filteredReports =
    allTickersOfInterest.size > 0
      ? reports.filter((r) => allTickersOfInterest.has(r.ticker.toUpperCase()))
      : reports;

  logInfo(`Filtered to ${filteredReports.length} reports matching holdings/watchlist`);

  // -------------------------------------------------------------------------
  // Step 5: Calculate alerts for all 4 sections
  // -------------------------------------------------------------------------
  logStep(5, 'Calculating alerts for all sections...');

  const holdingsSet = new Set(holdingsTickers.map((t) => t.toUpperCase()));

  // Helper to create AlertDue from report
  function createAlertDue(report: EarningsReport): AlertDue {
    const daysUntil = tradingDaysUntil(today, report.reportDate);
    return {
      report,
      alertDate: today,
      reportDateFormatted: format(report.reportDate, 'EEE, MMM d'),
      daysUntilReport: daysUntil,
    };
  }

  // Helper to determine if report is on the next trading day
  function isReportingTomorrow(report: EarningsReport): boolean {
    const nextTradingDay = getNextTradingDay(today);
    const reportDateStr = format(report.reportDate, 'yyyy-MM-dd');
    const nextTradingDayStr = format(nextTradingDay, 'yyyy-MM-dd');
    return reportDateStr === nextTradingDayStr;
  }

  // Helper to get trading days until report (for determining upcoming window)
  function getTradingDaysToReport(report: EarningsReport): number {
    return tradingDaysUntil(today, report.reportDate);
  }

  // Separate reports into holdings vs watchlist
  const holdingsReports = filteredReports.filter((r) => holdingsSet.has(r.ticker.toUpperCase()));
  const watchlistReports = filteredReports.filter((r) => !holdingsSet.has(r.ticker.toUpperCase()));

  // Section 1: Holdings - Next Day
  const holdingsNextDay = holdingsReports
    .filter(isReportingTomorrow)
    .map(createAlertDue);

  // Section 2: Holdings - Next 5 trading days (excluding next day)
  const holdingsNextDayTickers = new Set(holdingsNextDay.map((a) => a.report.ticker));
  const holdingsUpcoming = holdingsReports
    .filter((r) => {
      if (holdingsNextDayTickers.has(r.ticker)) return false; // Exclude next day
      const days = getTradingDaysToReport(r);
      return days >= 1 && days <= 5; // 2-5 trading days (1 = tomorrow already handled)
    })
    .map(createAlertDue);

  // Section 3: Watchlist - Next Day
  const watchlistNextDay = watchlistReports
    .filter(isReportingTomorrow)
    .map(createAlertDue);

  // Section 4: Watchlist - Next 3 trading days (excluding next day)
  const watchlistNextDayTickers = new Set(watchlistNextDay.map((a) => a.report.ticker));
  const watchlistUpcoming = watchlistReports
    .filter((r) => {
      if (watchlistNextDayTickers.has(r.ticker)) return false; // Exclude next day
      const days = getTradingDaysToReport(r);
      return days >= 1 && days <= 3; // 2-3 trading days
    })
    .map(createAlertDue);

  logSuccess(`Holdings next day: ${holdingsNextDay.length}, upcoming: ${holdingsUpcoming.length}`);
  logSuccess(`Watchlist next day: ${watchlistNextDay.length}, upcoming: ${watchlistUpcoming.length}`);

  if (options.verbose) {
    if (holdingsNextDay.length > 0) {
      logVerbose('Holdings - Next Day:');
      holdingsNextDay.forEach((alert) => {
        logVerbose(`  ${alert.report.ticker} - ${alert.reportDateFormatted} (${alert.report.timeOfDay})`);
      });
    }
    if (holdingsUpcoming.length > 0) {
      logVerbose('Holdings - Upcoming (2-5 days):');
      holdingsUpcoming.forEach((alert) => {
        logVerbose(`  ${alert.report.ticker} - ${alert.reportDateFormatted} (${alert.report.timeOfDay})`);
      });
    }
    if (watchlistNextDay.length > 0) {
      logVerbose('Watchlist - Next Day:');
      watchlistNextDay.forEach((alert) => {
        logVerbose(`  ${alert.report.ticker} - ${alert.reportDateFormatted} (${alert.report.timeOfDay})`);
      });
    }
    if (watchlistUpcoming.length > 0) {
      logVerbose('Watchlist - Upcoming (2-3 days):');
      watchlistUpcoming.forEach((alert) => {
        logVerbose(`  ${alert.report.ticker} - ${alert.reportDateFormatted} (${alert.report.timeOfDay})`);
      });
    }
  }

  // Check if there's anything to send
  const totalAlerts = holdingsNextDay.length + holdingsUpcoming.length +
                      watchlistNextDay.length + watchlistUpcoming.length;

  if (totalAlerts === 0) {
    logInfo('No alerts in any section. Nothing to send.');
    return;
  }

  // -------------------------------------------------------------------------
  // Step 6: Send email (or dry-run)
  // -------------------------------------------------------------------------
  logStep(6, options.dryRun ? 'Preparing email (dry run)...' : 'Sending email...');

  const alertSections: AlertSections = {
    holdingsNextDay,
    holdingsUpcoming,
    watchlistNextDay,
    watchlistUpcoming,
  };

  // Show email preview in verbose mode or dry run
  if (options.verbose || options.dryRun) {
    const { subject } = formatAlertEmail(alertSections);
    log(`\n  Subject: ${subject}`);
    log(`  Recipients: ${getRecipients().join(', ') || '(none configured)'}`);
    log(`  Holdings next day: ${holdingsNextDay.length}`);
    log(`  Holdings upcoming: ${holdingsUpcoming.length}`);
    log(`  Watchlist next day: ${watchlistNextDay.length}`);
    log(`  Watchlist upcoming: ${watchlistUpcoming.length}`);
  }

  let emailSent: boolean;
  try {
    emailSent = await sendAlertEmail(alertSections, options.dryRun);

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
  // Step 7: Mark next-day alerts as sent (skip in dry-run mode)
  // -------------------------------------------------------------------------
  const nextDayAlerts = [...holdingsNextDay, ...watchlistNextDay];
  if (!options.dryRun && emailSent && nextDayAlerts.length > 0) {
    logStep(7, 'Marking next-day alerts as sent...');

    for (const alert of nextDayAlerts) {
      markAlertSent(alert.report.ticker, alert.report.reportDate);
      logVerbose(`Marked as sent: ${alert.report.ticker}`);
    }

    logSuccess(`Marked ${nextDayAlerts.length} next-day alert(s) as sent`);
  } else if (options.dryRun) {
    logStep(7, 'Skipping mark-as-sent (dry run mode)');
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log('\n========================================');
  log('Summary');
  log('========================================');
  log(`Holdings tickers: ${holdingsTickers.length}`);
  log(`Watchlist tickers: ${watchlistTickers.length}`);
  log(`Total reports in sheet: ${reports.length}`);
  log(`Filtered reports (of interest): ${filteredReports.length}`);
  log('');
  log(`Holdings - Next Day: ${holdingsNextDay.length}`);
  log(`Holdings - Upcoming (2-5 days): ${holdingsUpcoming.length}`);
  log(`Watchlist - Next Day: ${watchlistNextDay.length}`);
  log(`Watchlist - Upcoming (2-3 days): ${watchlistUpcoming.length}`);
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
