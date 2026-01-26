/**
 * Alert Logic for Earnings Alerts
 *
 * Handles:
 * - Determining alert dates based on report time
 * - Finding reports due for alerts today
 * - Time-of-day parsing
 * - Alert deduplication
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { isSameDay, format, differenceInCalendarDays } from 'date-fns';
import { EarningsReport, AlertDue, SentAlert, TimeOfDay } from './types';
import { isTradingDay, getPreviousTradingDay, getTradingDayOnOrBefore } from './calendar';

// Path to sent alerts file
const DATA_DIR = join(__dirname, '..', 'data');
const SENT_ALERTS_FILE = join(DATA_DIR, 'sent-alerts.json');

/**
 * Time ranges for premarket and postmarket (24-hour format)
 * Premarket: 5:00am - 9:30am
 * Postmarket: 4:00pm - 8:00pm
 */
interface TimeRange {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

const PREMARKET_RANGE: TimeRange = {
  startHour: 5,
  startMinute: 0,
  endHour: 9,
  endMinute: 30,
};

const POSTMARKET_RANGE: TimeRange = {
  startHour: 16,
  startMinute: 0,
  endHour: 20,
  endMinute: 0,
};

// ============================================================================
// Time-of-Day Parsing (Feature 13)
// ============================================================================

/**
 * Parse a time string to determine if it's premarket or postmarket
 *
 * Handles various formats:
 * - Named: "premarket", "postmarket", "pre", "post", "AMC", "BMO"
 * - Time with period: "6:00am", "4:30pm", "9am", "5:30 PM"
 * - 24-hour format: "16:00", "0530"
 *
 * Ranges:
 * - Premarket: 5:00am - 9:30am (05:00 - 09:30)
 * - Postmarket: 4:00pm - 8:00pm (16:00 - 20:00)
 *
 * @param timeStr - Raw time string from sheet
 * @returns TimeOfDay enum value
 */
export function parseTimeOfDay(timeStr: string | undefined | null): TimeOfDay {
  if (!timeStr || typeof timeStr !== 'string') {
    return 'unknown';
  }

  const normalized = timeStr.trim().toLowerCase();

  // Empty string
  if (!normalized) {
    return 'unknown';
  }

  // Named indicators - premarket
  const premarketIndicators = [
    'premarket',
    'pre-market',
    'pre',
    'bmo', // Before Market Open
    'before market open',
    'before market',
    'before open',
    'morning',
  ];

  for (const indicator of premarketIndicators) {
    if (normalized === indicator || normalized.includes(indicator)) {
      return 'premarket';
    }
  }

  // Named indicators - postmarket
  const postmarketIndicators = [
    'postmarket',
    'post-market',
    'post',
    'amc', // After Market Close
    'after market close',
    'after market',
    'after close',
    'after hours',
    'evening',
  ];

  for (const indicator of postmarketIndicators) {
    if (normalized === indicator || normalized.includes(indicator)) {
      return 'postmarket';
    }
  }

  // Try to parse specific time
  const parsedTime = parseTimeString(normalized);
  if (parsedTime !== null) {
    return categorizeTime(parsedTime.hours, parsedTime.minutes);
  }

  return 'unknown';
}

/**
 * Parse a time string into hours and minutes (24-hour format)
 *
 * @param timeStr - Normalized (lowercase) time string
 * @returns Object with hours and minutes, or null if unparseable
 */
function parseTimeString(timeStr: string): { hours: number; minutes: number } | null {
  // Format: "6:00am", "4:30pm", "9am", "5:30 PM", "12:00pm"
  const timeWithPeriod = timeStr.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)$/i);
  if (timeWithPeriod) {
    let hours = parseInt(timeWithPeriod[1], 10);
    const minutes = parseInt(timeWithPeriod[2] || '0', 10);
    const period = timeWithPeriod[3].toLowerCase();

    // Convert to 24-hour
    if (period === 'pm' && hours !== 12) {
      hours += 12;
    } else if (period === 'am' && hours === 12) {
      hours = 0;
    }

    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return { hours, minutes };
    }
  }

  // Format: "16:00", "09:30" (24-hour with colon)
  const time24Colon = timeStr.match(/^(\d{2}):(\d{2})$/);
  if (time24Colon) {
    const hours = parseInt(time24Colon[1], 10);
    const minutes = parseInt(time24Colon[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return { hours, minutes };
    }
  }

  // Format: "0600", "1630" (24-hour no colon)
  const time24NoColon = timeStr.match(/^(\d{2})(\d{2})$/);
  if (time24NoColon) {
    const hours = parseInt(time24NoColon[1], 10);
    const minutes = parseInt(time24NoColon[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return { hours, minutes };
    }
  }

  return null;
}

/**
 * Categorize a time into premarket, postmarket, or unknown
 *
 * @param hours - Hour in 24-hour format (0-23)
 * @param minutes - Minutes (0-59)
 * @returns TimeOfDay category
 */
function categorizeTime(hours: number, minutes: number): TimeOfDay {
  const timeValue = hours * 60 + minutes;

  const premarketStart = PREMARKET_RANGE.startHour * 60 + PREMARKET_RANGE.startMinute;
  const premarketEnd = PREMARKET_RANGE.endHour * 60 + PREMARKET_RANGE.endMinute;

  const postmarketStart = POSTMARKET_RANGE.startHour * 60 + POSTMARKET_RANGE.startMinute;
  const postmarketEnd = POSTMARKET_RANGE.endHour * 60 + POSTMARKET_RANGE.endMinute;

  if (timeValue >= premarketStart && timeValue <= premarketEnd) {
    return 'premarket';
  }

  if (timeValue >= postmarketStart && timeValue <= postmarketEnd) {
    return 'postmarket';
  }

  // Times outside both ranges - categorize based on proximity
  // Before market hours (midnight to 5am) -> treat as premarket (safer)
  if (timeValue < premarketStart) {
    return 'premarket';
  }

  // Between market close and postmarket (3:30pm to 4pm) -> treat as postmarket
  if (timeValue > premarketEnd && timeValue < postmarketStart) {
    // Regular trading hours or gap - default to unknown
    return 'unknown';
  }

  // After postmarket (8pm to midnight) -> already reported, no alert needed
  // But we'll treat as postmarket for consistency
  if (timeValue > postmarketEnd) {
    return 'postmarket';
  }

  return 'unknown';
}

// ============================================================================
// Alert Date Calculation (Feature 11)
// ============================================================================

/**
 * Calculate the alert date for an earnings report
 *
 * Logic:
 * - Postmarket (4pm-8pm) -> alert morning OF report date
 * - Premarket (5am-9:30am) -> alert morning of DAY BEFORE report date
 * - Unknown -> treat as premarket (safer - alerts day before)
 *
 * The alert date is adjusted to be a trading day:
 * - If the calculated alert date is not a trading day, use the previous trading day
 *
 * @param report - Earnings report with date and time
 * @returns Alert date (trading day)
 */
export function determineAlertDate(report: EarningsReport): Date {
  const reportDate = report.reportDate;
  const timeOfDay = report.timeOfDay;

  let alertDate: Date;

  if (timeOfDay === 'postmarket') {
    // Postmarket: alert morning of report date
    // If report is postmarket on Wednesday, alert on Wednesday morning
    alertDate = new Date(
      Date.UTC(reportDate.getUTCFullYear(), reportDate.getUTCMonth(), reportDate.getUTCDate())
    );
  } else {
    // Premarket or unknown: alert day before report date
    // If report is premarket on Thursday, alert on Wednesday morning
    alertDate = getPreviousTradingDay(reportDate);
  }

  // Ensure alert date is a trading day
  return getTradingDayOnOrBefore(alertDate);
}

/**
 * Calculate alert date with a specific number of days before
 *
 * For multi-day alerts (e.g., 5 days and 1 day before), calculate
 * the alert date for each threshold.
 *
 * @param report - Earnings report
 * @param tradingDaysBefore - Number of trading days before to alert
 * @returns Alert date (trading day)
 */
export function determineAlertDateWithOffset(
  report: EarningsReport,
  tradingDaysBefore: number
): Date {
  // First, get the "base" alert date (using standard logic)
  const baseAlertDate = determineAlertDate(report);

  if (tradingDaysBefore <= 0) {
    return baseAlertDate;
  }

  // Go back additional trading days
  let date = baseAlertDate;
  let daysBack = tradingDaysBefore;

  while (daysBack > 0) {
    date = getPreviousTradingDay(date);
    daysBack--;
  }

  return date;
}

// ============================================================================
// Find Due Alerts (Feature 12)
// ============================================================================

/**
 * Find all reports that need alerts TODAY
 *
 * Filters the reports list to find those whose calculated alert date
 * matches the provided date (typically today).
 *
 * @param reports - List of all earnings reports
 * @param today - The date to check alerts for (typically today)
 * @param alertDaysBefore - Array of trading days before to check (default: [0])
 * @returns Array of AlertDue objects for reports needing alerts
 */
export function findDueAlerts(
  reports: EarningsReport[],
  today: Date,
  alertDaysBefore: number[] = [0]
): AlertDue[] {
  const dueAlerts: AlertDue[] = [];

  // Normalize today to UTC date
  const todayNorm = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );

  for (const report of reports) {
    // Check each alert threshold
    for (const daysBefore of alertDaysBefore) {
      const alertDate = determineAlertDateWithOffset(report, daysBefore);

      if (isSameDay(alertDate, todayNorm)) {
        const daysUntilReport = differenceInCalendarDays(report.reportDate, todayNorm);

        dueAlerts.push({
          report,
          alertDate,
          reportDateFormatted: format(report.reportDate, 'EEEE, MMMM d, yyyy'),
          daysUntilReport,
        });

        // Only add once per report (for the first matching threshold)
        break;
      }
    }
  }

  // Sort by report date
  dueAlerts.sort((a, b) => a.report.reportDate.getTime() - b.report.reportDate.getTime());

  return dueAlerts;
}

/**
 * Find reports due for alerts today (convenience function)
 *
 * Uses the current date and default alert thresholds.
 *
 * @param reports - List of all earnings reports
 * @param alertDaysBefore - Optional array of trading days before
 * @returns Array of AlertDue objects
 */
export function findAlertsDueToday(
  reports: EarningsReport[],
  alertDaysBefore?: number[]
): AlertDue[] {
  return findDueAlerts(reports, new Date(), alertDaysBefore);
}

// ============================================================================
// Alert Deduplication (Feature 14)
// ============================================================================

/**
 * Load sent alerts from file
 *
 * @returns Array of SentAlert records
 */
export function loadSentAlerts(): SentAlert[] {
  try {
    if (!existsSync(SENT_ALERTS_FILE)) {
      return [];
    }

    const data = readFileSync(SENT_ALERTS_FILE, 'utf-8');
    const parsed = JSON.parse(data);

    if (!Array.isArray(parsed)) {
      console.warn('[WARN] sent-alerts.json is not an array, returning empty');
      return [];
    }

    return parsed as SentAlert[];
  } catch (error) {
    console.warn('[WARN] Failed to load sent alerts:', error);
    return [];
  }
}

/**
 * Save sent alerts to file
 *
 * @param alerts - Array of SentAlert records
 */
export function saveSentAlerts(alerts: SentAlert[]): void {
  try {
    // Ensure data directory exists
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(SENT_ALERTS_FILE, JSON.stringify(alerts, null, 2), 'utf-8');
  } catch (error) {
    console.error('[ERROR] Failed to save sent alerts:', error);
    throw error;
  }
}

/**
 * Check if an alert has already been sent for a report
 *
 * @param ticker - Stock ticker symbol
 * @param reportDate - The report date
 * @param alertDaysBefore - Optional: specific alert threshold (for multi-day alerts)
 * @returns true if alert was already sent
 */
export function hasAlertBeenSent(
  ticker: string,
  reportDate: Date,
  alertDaysBefore?: number
): boolean {
  const sentAlerts = loadSentAlerts();
  const reportDateStr = format(reportDate, 'yyyy-MM-dd');
  const tickerUpper = ticker.toUpperCase();

  return sentAlerts.some((alert) => {
    const matchesTicker = alert.ticker.toUpperCase() === tickerUpper;
    const matchesDate = alert.reportDate === reportDateStr;

    // If alertDaysBefore is specified, also check that
    // (for systems with multiple alert thresholds)
    if (alertDaysBefore !== undefined && 'alertDaysBefore' in alert) {
      return matchesTicker && matchesDate && (alert as any).alertDaysBefore === alertDaysBefore;
    }

    return matchesTicker && matchesDate;
  });
}

/**
 * Mark an alert as sent
 *
 * @param ticker - Stock ticker symbol
 * @param reportDate - The report date
 * @param alertDaysBefore - Optional: specific alert threshold
 */
export function markAlertSent(
  ticker: string,
  reportDate: Date,
  alertDaysBefore?: number
): void {
  const sentAlerts = loadSentAlerts();
  const reportDateStr = format(reportDate, 'yyyy-MM-dd');

  const newAlert: SentAlert & { alertDaysBefore?: number } = {
    ticker: ticker.toUpperCase(),
    reportDate: reportDateStr,
    sentAt: new Date().toISOString(),
  };

  if (alertDaysBefore !== undefined) {
    newAlert.alertDaysBefore = alertDaysBefore;
  }

  sentAlerts.push(newAlert);
  saveSentAlerts(sentAlerts);
}

/**
 * Filter out already-sent alerts from a list
 *
 * @param dueAlerts - List of alerts that are due
 * @param alertDaysBefore - Optional: specific alert threshold
 * @returns Filtered list excluding already-sent alerts
 */
export function filterUnsentAlerts(
  dueAlerts: AlertDue[],
  alertDaysBefore?: number
): AlertDue[] {
  return dueAlerts.filter((alert) => {
    const alreadySent = hasAlertBeenSent(
      alert.report.ticker,
      alert.report.reportDate,
      alertDaysBefore
    );

    if (alreadySent) {
      console.log(
        `[SKIP] Alert already sent for ${alert.report.ticker} (report date: ${format(alert.report.reportDate, 'yyyy-MM-dd')})`
      );
    }

    return !alreadySent;
  });
}

/**
 * Clean up old sent alerts (older than specified days)
 *
 * Prevents the sent-alerts.json file from growing indefinitely.
 *
 * @param daysToKeep - Number of days to keep (default: 30)
 * @returns Number of alerts removed
 */
export function cleanupOldAlerts(daysToKeep = 30): number {
  const sentAlerts = loadSentAlerts();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  const originalCount = sentAlerts.length;
  const filteredAlerts = sentAlerts.filter((alert) => {
    const sentDate = new Date(alert.sentAt);
    return sentDate >= cutoffDate;
  });

  if (filteredAlerts.length < originalCount) {
    saveSentAlerts(filteredAlerts);
  }

  return originalCount - filteredAlerts.length;
}
