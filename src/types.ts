/**
 * Core types for earnings alerts
 */

export interface EarningsReport {
  ticker: string;
  company: string;
  reportDate: Date;
  timeOfDay: TimeOfDay;
  rawTimeString?: string; // Original time string from sheet
}

export type TimeOfDay =
  | 'premarket'      // 5:00am - 9:30am
  | 'postmarket'     // 4:00pm - 8:00pm
  | 'unknown';       // Treat as premarket (safer)

export interface AlertDue {
  report: EarningsReport;
  alertDate: Date;
  reportDateFormatted: string;
  daysUntilReport: number;
}

export interface SentAlert {
  ticker: string;
  reportDate: string; // ISO date string
  sentAt: string;     // ISO datetime string
}

export interface Config {
  googleSheetId: string;
  sheetName: string;
  recipients: string[];
  alertDaysBefore: number[];  // e.g., [5, 1] for 5 days and 1 day before
}

export interface CliOptions {
  checkTradingDay: boolean;
  dryRun: boolean;
  verbose: boolean;
}
