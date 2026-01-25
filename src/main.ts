#!/usr/bin/env node
/**
 * Earnings Alerts - Main Entry Point
 *
 * Checks for upcoming earnings reports and sends email alerts.
 */

import { Command } from 'commander';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const program = new Command();

program
  .name('earnings-alerts')
  .description('Email alerts for upcoming company earnings report dates')
  .version('1.0.0')
  .option('--check-trading-day', 'Only run on trading days (skip weekends/holidays)', false)
  .option('--dry-run', 'Show what would be sent without actually sending', false)
  .option('-v, --verbose', 'Verbose output', false);

program.parse();

const options = program.opts();

async function main() {
  console.log('Earnings Alerts');
  console.log('================');

  if (options.verbose) {
    console.log('Options:', options);
  }

  if (options.dryRun) {
    console.log('[DRY RUN MODE - No emails will be sent]');
  }

  // TODO: Implement the main logic
  // 1. Check if trading day (if --check-trading-day)
  // 2. Read Google Sheet
  // 3. Find due alerts
  // 4. Send emails (or show what would be sent if --dry-run)

  console.log('\nNot yet implemented. Features coming soon!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
