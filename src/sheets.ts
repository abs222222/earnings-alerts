/**
 * Google Sheets data access for earnings alerts
 *
 * Reads earnings data from Google Sheet and parses into typed objects.
 * Handles validation and error cases gracefully.
 */

import { getSheetsService } from './google-auth';
import { EarningsReport, TimeOfDay } from './types';
import { parse, isValid } from 'date-fns';

// Column indices (0-based) - adjust if sheet structure changes
const COLUMNS = {
  TICKER: 0,
  COMPANY: 1,
  REPORT_DATE: 2,
  TIME_OF_DAY: 3,
};

/**
 * Validation result for a single row
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Result of reading and parsing sheet data
 */
export interface SheetReadResult {
  reports: EarningsReport[];
  totalRows: number;
  validRows: number;
  skippedRows: number;
  warnings: string[];
}

/**
 * Get sheet ID from environment or throw error
 */
function getSheetId(): string {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    throw new Error(
      'GOOGLE_SHEET_ID not set. Add it to .env file or environment variables.'
    );
  }
  return sheetId;
}

/**
 * Get sheet name from environment or use default
 */
function getSheetName(): string {
  return process.env.SHEET_NAME || 'Earnings';
}

/**
 * Read raw data from Google Sheet
 *
 * @returns Array of row arrays (each row is an array of cell values)
 */
export async function readRawSheetData(): Promise<string[][]> {
  const sheets = await getSheetsService();
  const sheetId = getSheetId();
  const sheetName = getSheetName();

  // Read all data from the sheet (A:D covers ticker, company, date, time)
  const range = `${sheetName}!A:D`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: range,
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    console.log('No data found in sheet');
    return [];
  }

  return rows as string[][];
}

/**
 * Parse a date string into a Date object
 * Handles various date formats commonly found in spreadsheets
 *
 * @param dateStr - Date string from sheet
 * @returns Parsed Date or null if invalid
 */
function parseDate(dateStr: string): Date | null {
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }

  const trimmed = dateStr.trim();
  if (!trimmed) {
    return null;
  }

  // Common date formats to try
  const formats = [
    'yyyy-MM-dd', // 2024-01-15
    'M/d/yyyy', // 1/15/2024
    'MM/dd/yyyy', // 01/15/2024
    'M/d/yy', // 1/15/24
    'MM/dd/yy', // 01/15/24
    'MMM d, yyyy', // Jan 15, 2024
    'MMMM d, yyyy', // January 15, 2024
    'd-MMM-yyyy', // 15-Jan-2024
  ];

  for (const format of formats) {
    const parsed = parse(trimmed, format, new Date());
    if (isValid(parsed)) {
      return parsed;
    }
  }

  // Try native Date parsing as fallback
  const nativeDate = new Date(trimmed);
  if (isValid(nativeDate)) {
    return nativeDate;
  }

  return null;
}

/**
 * Parse time of day string into TimeOfDay enum
 *
 * @param timeStr - Time string from sheet (e.g., "premarket", "postmarket", "6:00am")
 * @returns TimeOfDay enum value
 */
function parseTimeOfDay(timeStr: string | undefined): TimeOfDay {
  if (!timeStr || typeof timeStr !== 'string') {
    return 'unknown';
  }

  const normalized = timeStr.trim().toLowerCase();

  // Direct matches
  if (normalized === 'premarket' || normalized === 'pre-market' || normalized === 'pre') {
    return 'premarket';
  }
  if (normalized === 'postmarket' || normalized === 'post-market' || normalized === 'post' || normalized === 'amc' || normalized === 'after market close') {
    return 'postmarket';
  }
  if (normalized === 'bmo' || normalized === 'before market open') {
    return 'premarket';
  }

  // Try to parse specific time (e.g., "6:00am", "4:30pm")
  const timeMatch = normalized.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const period = timeMatch[3]?.toLowerCase();

    // Convert to 24-hour format
    if (period === 'pm' && hours !== 12) {
      hours += 12;
    } else if (period === 'am' && hours === 12) {
      hours = 0;
    }

    // Pre-market: 5:00am - 9:30am (5-9.5 in 24h = 5-9.5)
    // Post-market: 4:00pm - 8:00pm (16-20 in 24h)
    if (hours >= 5 && hours < 10) {
      return 'premarket';
    }
    if (hours >= 16 && hours <= 20) {
      return 'postmarket';
    }
  }

  return 'unknown';
}

/**
 * Validate a single row of data
 *
 * @param row - Array of cell values
 * @param rowIndex - Row number (for error messages)
 * @returns Validation result
 */
function validateRow(row: string[], rowIndex: number): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const ticker = row[COLUMNS.TICKER]?.trim();
  const reportDate = row[COLUMNS.REPORT_DATE]?.trim();

  // Required fields
  if (!ticker) {
    errors.push(`Row ${rowIndex}: Missing ticker symbol`);
  } else if (!/^[A-Z0-9.]+$/i.test(ticker)) {
    warnings.push(`Row ${rowIndex}: Ticker "${ticker}" has unusual characters`);
  }

  if (!reportDate) {
    errors.push(`Row ${rowIndex}: Missing report date`);
  } else {
    const parsed = parseDate(reportDate);
    if (!parsed) {
      errors.push(`Row ${rowIndex}: Invalid date format "${reportDate}"`);
    }
  }

  // Optional field warnings
  const company = row[COLUMNS.COMPANY]?.trim();
  if (!company) {
    warnings.push(`Row ${rowIndex}: Missing company name for ${ticker || 'unknown ticker'}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Parse a single row into an EarningsReport object
 *
 * @param row - Array of cell values
 * @returns EarningsReport or null if parsing fails
 */
function parseRow(row: string[]): EarningsReport | null {
  const ticker = row[COLUMNS.TICKER]?.trim().toUpperCase();
  const company = row[COLUMNS.COMPANY]?.trim() || ticker; // Fall back to ticker if no company name
  const dateStr = row[COLUMNS.REPORT_DATE]?.trim();
  const timeStr = row[COLUMNS.TIME_OF_DAY]?.trim();

  const reportDate = parseDate(dateStr);
  if (!reportDate) {
    return null;
  }

  return {
    ticker,
    company,
    reportDate,
    timeOfDay: parseTimeOfDay(timeStr),
    rawTimeString: timeStr || undefined,
  };
}

/**
 * Read earnings data from Google Sheet and parse into typed objects
 *
 * @param skipHeader - Whether to skip the first row as a header (default: true)
 * @returns SheetReadResult with parsed reports and statistics
 */
export async function readEarningsData(skipHeader = true): Promise<SheetReadResult> {
  const rawData = await readRawSheetData();

  if (rawData.length === 0) {
    return {
      reports: [],
      totalRows: 0,
      validRows: 0,
      skippedRows: 0,
      warnings: [],
    };
  }

  // Skip header row if requested
  const dataRows = skipHeader ? rawData.slice(1) : rawData;
  const startIndex = skipHeader ? 2 : 1; // 1-based row number for logging

  const reports: EarningsReport[] = [];
  const allWarnings: string[] = [];
  let skippedRows = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNumber = startIndex + i;

    // Skip empty rows
    if (!row || row.every((cell) => !cell?.trim())) {
      continue;
    }

    const validation = validateRow(row, rowNumber);

    // Collect warnings
    allWarnings.push(...validation.warnings);

    if (!validation.valid) {
      // Log errors and skip invalid rows
      validation.errors.forEach((err) => console.warn(`[SKIP] ${err}`));
      skippedRows++;
      continue;
    }

    const report = parseRow(row);
    if (report) {
      reports.push(report);
    } else {
      console.warn(`[SKIP] Row ${rowNumber}: Failed to parse (unexpected error)`);
      skippedRows++;
    }
  }

  // Log warnings (but don't skip the rows)
  allWarnings.forEach((warn) => console.warn(`[WARN] ${warn}`));

  return {
    reports,
    totalRows: dataRows.length,
    validRows: reports.length,
    skippedRows,
    warnings: allWarnings,
  };
}

/**
 * Get all valid earnings reports from the configured Google Sheet
 *
 * Convenience function that just returns the reports array.
 *
 * @returns Array of EarningsReport objects
 */
export async function getEarningsReports(): Promise<EarningsReport[]> {
  const result = await readEarningsData();
  console.log(
    `Loaded ${result.validRows} earnings reports (${result.skippedRows} rows skipped)`
  );
  return result.reports;
}
