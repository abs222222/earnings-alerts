/**
 * NYSE Trading Calendar
 *
 * Provides functions to work with NYSE trading days.
 * Handles weekends and US market holidays.
 */

import { addDays, isBefore, isAfter, isSameDay } from 'date-fns';

/**
 * NYSE Holidays 2025-2026
 *
 * Hardcoded holidays are simpler and sufficient for a 2-year window.
 * Update this list annually or switch to a library if longer range needed.
 *
 * Holiday list from NYSE:
 * - New Year's Day
 * - Martin Luther King Jr. Day (3rd Monday of January)
 * - Presidents Day (3rd Monday of February)
 * - Good Friday (varies)
 * - Memorial Day (last Monday of May)
 * - Juneteenth National Independence Day (June 19)
 * - Independence Day (July 4)
 * - Labor Day (first Monday of September)
 * - Thanksgiving Day (4th Thursday of November)
 * - Christmas Day (December 25)
 *
 * Note: When a holiday falls on Saturday, NYSE observes Friday.
 *       When a holiday falls on Sunday, NYSE observes Monday.
 */
const NYSE_HOLIDAYS: string[] = [
  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-20', // Martin Luther King Jr. Day
  '2025-02-17', // Presidents Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving Day
  '2025-12-25', // Christmas Day

  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed - July 4 is Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving Day
  '2026-12-25', // Christmas Day
];

// Convert to Set for O(1) lookups
const NYSE_HOLIDAY_SET = new Set(NYSE_HOLIDAYS);

/**
 * Convert a Date to a date-only string (YYYY-MM-DD) in UTC
 * Uses UTC to ensure consistency regardless of local timezone
 */
function toDateString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if a date is a weekend (Saturday or Sunday)
 * Uses UTC day of week for consistency
 */
function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6; // Sunday = 0, Saturday = 6
}

/**
 * Check if a date is an NYSE holiday
 */
function isNYSEHoliday(date: Date): boolean {
  return NYSE_HOLIDAY_SET.has(toDateString(date));
}

/**
 * Check if a given date is a trading day
 *
 * @param date - The date to check
 * @returns true if the NYSE is open on this date, false otherwise
 *
 * @example
 * isTradingDay(new Date('2025-01-02')) // true - Thursday
 * isTradingDay(new Date('2025-01-01')) // false - New Year's Day
 * isTradingDay(new Date('2025-01-04')) // false - Saturday
 */
export function isTradingDay(date: Date): boolean {
  if (isWeekend(date)) return false;
  if (isNYSEHoliday(date)) return false;
  return true;
}

/**
 * Get the next trading day after a given date
 *
 * @param date - The starting date
 * @returns The next date that is a trading day
 *
 * @example
 * getNextTradingDay(new Date('2025-01-03')) // 2025-01-06 (Monday after Friday)
 * getNextTradingDay(new Date('2025-12-24')) // 2025-12-26 (day after Christmas)
 */
export function getNextTradingDay(date: Date): Date {
  let next = addDays(date, 1);
  while (!isTradingDay(next)) {
    next = addDays(next, 1);
  }
  return next;
}

/**
 * Get the previous trading day before a given date
 *
 * @param date - The starting date
 * @returns The most recent date before this one that is a trading day
 *
 * @example
 * getPreviousTradingDay(new Date('2025-01-06')) // 2025-01-03 (Friday before Monday)
 * getPreviousTradingDay(new Date('2025-01-02')) // 2025-12-31 (day before New Year's)
 */
export function getPreviousTradingDay(date: Date): Date {
  let prev = addDays(date, -1);
  while (!isTradingDay(prev)) {
    prev = addDays(prev, -1);
  }
  return prev;
}

/**
 * Get the trading day on or before a given date
 *
 * If the date itself is a trading day, returns it.
 * Otherwise, returns the previous trading day.
 *
 * @param date - The date to check
 * @returns The date if it's a trading day, or the previous trading day
 */
export function getTradingDayOnOrBefore(date: Date): Date {
  if (isTradingDay(date)) return date;
  return getPreviousTradingDay(date);
}

/**
 * Get the trading day on or after a given date
 *
 * If the date itself is a trading day, returns it.
 * Otherwise, returns the next trading day.
 *
 * @param date - The date to check
 * @returns The date if it's a trading day, or the next trading day
 */
export function getTradingDayOnOrAfter(date: Date): Date {
  if (isTradingDay(date)) return date;
  return getNextTradingDay(date);
}

/**
 * Calculate the number of trading days between two dates
 *
 * @param from - Start date (inclusive if it's a trading day)
 * @param to - End date (inclusive if it's a trading day)
 * @returns Number of trading days. Negative if 'to' is before 'from'.
 *
 * @example
 * // Friday to next Friday (5 trading days: Mon-Fri)
 * tradingDaysUntil(new Date('2025-01-03'), new Date('2025-01-10')) // 5
 *
 * // Same day
 * tradingDaysUntil(new Date('2025-01-03'), new Date('2025-01-03')) // 0
 *
 * // Backwards
 * tradingDaysUntil(new Date('2025-01-10'), new Date('2025-01-03')) // -5
 */
export function tradingDaysUntil(from: Date, to: Date): number {
  // Normalize to start of day (UTC)
  const fromNorm = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const toNorm = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

  // Same day
  if (isSameDay(fromNorm, toNorm)) return 0;

  // Determine direction
  const isForward = isBefore(fromNorm, toNorm);

  let count = 0;
  let current = isForward ? addDays(fromNorm, 1) : addDays(fromNorm, -1);

  while (isForward ? !isAfter(current, toNorm) : !isBefore(current, toNorm)) {
    if (isTradingDay(current)) {
      count++;
    }
    current = isForward ? addDays(current, 1) : addDays(current, -1);
  }

  return isForward ? count : -count;
}

/**
 * Get all trading days in a date range
 *
 * @param from - Start date (inclusive)
 * @param to - End date (inclusive)
 * @returns Array of Date objects for each trading day in the range
 */
export function getTradingDaysInRange(from: Date, to: Date): Date[] {
  const result: Date[] = [];
  let current = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const endNorm = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

  while (!isAfter(current, endNorm)) {
    if (isTradingDay(current)) {
      result.push(new Date(current));
    }
    current = addDays(current, 1);
  }

  return result;
}

/**
 * Get the list of NYSE holidays
 * Useful for debugging or displaying calendar info
 */
export function getNYSEHolidays(): string[] {
  return [...NYSE_HOLIDAYS];
}
