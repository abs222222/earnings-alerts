/**
 * Google Sheets data access for earnings alerts
 *
 * Reads earnings data from Google Sheet and parses into typed objects.
 * Handles validation and error cases gracefully.
 */

import { getSheetsService } from './google-auth';
import { EarningsReport, TimeOfDay } from './types';
import { parse, isValid } from 'date-fns';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Settings loaded from config/settings.json
 */
interface Settings {
  sheets?: {
    earnings?: { id?: string; watchlistTab?: string };
  };
  holdingsEmail?: {
    sender?: string;
    filename?: string;
  };
  sheetName?: string;
}

/**
 * Load settings from config/settings.json
 */
export function loadSettings(): Settings {
  try {
    const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
    const content = fs.readFileSync(settingsPath, 'utf-8');
    return JSON.parse(content) as Settings;
  } catch {
    // Return empty object if settings file doesn't exist or is invalid
    return {};
  }
}

// Column indices (0-based) based on actual earnings sheet structure
// Col 1 (A): Ticker, Col 59: Next Earnings Date, Col 60: Time of day
const COLUMNS = {
  TICKER: 0,           // Column A
  REPORT_DATE: 58,     // Column 59 (0-indexed = 58)
  TIME_OF_DAY: 59,     // Column 60 (0-indexed = 59)
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
 * Get earnings sheet ID from environment variable or config file
 * Priority: GOOGLE_SHEET_ID env var > config/settings.json
 */
export function getEarningsSheetId(): string {
  // Check environment variable first
  const envSheetId = process.env.GOOGLE_SHEET_ID;
  if (envSheetId) {
    return envSheetId;
  }

  // Fall back to config file
  const settings = loadSettings();
  const configSheetId = settings.sheets?.earnings?.id;
  if (configSheetId) {
    return configSheetId;
  }

  throw new Error(
    'Earnings sheet ID not configured. Set GOOGLE_SHEET_ID env var or add to config/settings.json'
  );
}

/**
 * Get sheet ID from environment or config (backwards compatible alias)
 * @deprecated Use getEarningsSheetId() instead
 */
function getSheetId(): string {
  return getEarningsSheetId();
}

/**
 * List all tab names from a Google Sheet
 *
 * @param sheetId - The spreadsheet ID
 * @returns Array of tab names
 */
export async function listSheetTabs(sheetId: string): Promise<string[]> {
  const sheets = await getSheetsService();
  const response = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets.properties.title',
  });

  const sheetList = response.data.sheets;
  if (!sheetList || sheetList.length === 0) {
    return [];
  }

  return sheetList
    .map((sheet) => sheet.properties?.title)
    .filter((title): title is string => typeof title === 'string');
}

/**
 * Find the latest date-named tab from a list of tab names
 *
 * Date tabs must match YYYY-MM-DD format (e.g., "2026-01-25")
 *
 * @param tabNames - Array of tab names to search
 * @returns Most recent date tab name, or null if none found
 */
export function findLatestDateTab(tabNames: string[]): string | null {
  // Match YYYY-MM-DD pattern
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  const dateTabs = tabNames.filter((name) => datePattern.test(name));

  if (dateTabs.length === 0) {
    return null;
  }

  // Sort descending (most recent first) - string sort works for YYYY-MM-DD
  dateTabs.sort((a, b) => b.localeCompare(a));

  return dateTabs[0];
}

/**
 * Get the latest date-named tab from the earnings sheet
 *
 * Convenience function that combines listSheetTabs and findLatestDateTab
 *
 * @returns Most recent date tab name
 * @throws Error if no date-named tabs found
 */
export async function getLatestEarningsTab(): Promise<string> {
  const sheetId = getEarningsSheetId();
  const tabNames = await listSheetTabs(sheetId);
  const latestTab = findLatestDateTab(tabNames);

  if (!latestTab) {
    throw new Error(
      'No date-named tabs found in earnings sheet. Expected tabs with YYYY-MM-DD format.'
    );
  }

  console.log(`Auto-selected earnings tab: ${latestTab}`);
  return latestTab;
}

/**
 * Get sheet name from environment or auto-detect latest date tab
 *
 * Priority:
 * 1. SHEET_NAME environment variable (if set)
 * 2. Auto-detect latest date-named tab (YYYY-MM-DD format)
 */
async function getSheetName(): Promise<string> {
  // Use explicit env var if set
  const envSheetName = process.env.SHEET_NAME;
  if (envSheetName) {
    return envSheetName;
  }

  // Auto-detect latest date tab
  try {
    return await getLatestEarningsTab();
  } catch (error) {
    // Fall back to default if auto-detect fails
    console.warn('Could not auto-detect date tab, using default "Earnings"');
    return 'Earnings';
  }
}

/**
 * Read raw data from Google Sheet
 *
 * @returns Array of row arrays (each row is an array of cell values)
 */
export async function readRawSheetData(): Promise<string[][]> {
  const sheets = await getSheetsService();
  const sheetId = getSheetId();
  const sheetName = await getSheetName();

  // Read columns A and BG:BH (ticker, earnings date, time)
  // Sheet has 60+ columns, we need specific ones
  const range = `${sheetName}!A:BH`;

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

  // Skip explicit unknowns
  if (normalized === 'unspecified' || normalized === 'xx' || normalized === '') {
    return 'unknown';
  }

  // Direct text matches for premarket
  if (
    normalized === 'premarket' ||
    normalized === 'pre-market' ||
    normalized === 'pre' ||
    normalized === 'bmo' ||
    normalized === 'before market' ||
    normalized === 'before market open'
  ) {
    return 'premarket';
  }

  // Direct text matches for postmarket
  if (
    normalized === 'postmarket' ||
    normalized === 'post-market' ||
    normalized === 'post' ||
    normalized === 'amc' ||
    normalized === 'after market' ||
    normalized === 'after market close'
  ) {
    return 'postmarket';
  }

  // Try to parse specific time (e.g., "6:00 AM", "4:30 PM")
  const timeMatch = normalized.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const period = timeMatch[3]?.toLowerCase();

    // Convert to 24-hour format
    if (period === 'pm' && hours !== 12) {
      hours += 12;
    } else if (period === 'am' && hours === 12) {
      hours = 0;
    }

    // Post-market: 3:00pm - 8:00pm (15-20 in 24h)
    // Being generous with start time since some report at 3pm
    if (hours >= 15 && hours <= 20) {
      return 'postmarket';
    }

    // Pre-market: everything else with a time is available before market open
    // This includes midnight-5am (international companies), 5am-9:30am (normal premarket)
    // Reports at these times will be available when US market opens
    return 'premarket';
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
    // Skip silently - many rows may not have earnings dates
    errors.push(`Row ${rowIndex}: Missing report date`);
  } else {
    const parsed = parseDate(reportDate);
    if (!parsed) {
      errors.push(`Row ${rowIndex}: Invalid date format "${reportDate}"`);
    }
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
  const dateStr = row[COLUMNS.REPORT_DATE]?.trim();
  const timeStr = row[COLUMNS.TIME_OF_DAY]?.trim();

  const reportDate = parseDate(dateStr);
  if (!reportDate) {
    return null;
  }

  return {
    ticker,
    company: ticker, // Use ticker as company name (sheet doesn't have company column in our range)
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

/**
 * Read ticker watchlist from "Tickers for email" tab
 *
 * Returns unique uppercase ticker symbols from the watchlist tab.
 * Handles empty tab gracefully by returning empty array.
 *
 * @returns Array of unique uppercase ticker symbols
 */
export async function getWatchlistTickers(): Promise<string[]> {
  const sheets = await getSheetsService();
  const sheetId = getEarningsSheetId();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Tickers for email!A:A',
  });

  const rows = response.data.values || [];

  // Skip header if present, filter empty, uppercase, dedupe
  const tickers = rows
    .flat()
    .filter(Boolean)
    .map((t) => t.toString().trim().toUpperCase())
    .filter((t) => t && t !== 'TICKER'); // Skip header row

  return [...new Set(tickers)]; // Dedupe
}

// ============================================================================
// Holdings Sheet Writer (for Supabase integration)
// ============================================================================

const HOLDINGS_SHEET_ID = process.env.HOLDINGS_SHEET_ID || '1M8web_oJLugd_L9Nj6sWWiJdxSex2KU5xPgbidONT8E';

/**
 * Write holdings data to a Google Sheet with a dated tab
 *
 * @param data - 2D array of data (including header row)
 * @param tabDate - Date string for the tab name (YYYY-MM-DD)
 * @returns The name of the created tab
 */
export async function writeHoldingsToSheet(data: string[][], tabDate: string): Promise<string> {
  const sheets = await getSheetsService();

  // Check if tab already exists
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: HOLDINGS_SHEET_ID,
  });

  const existingTabs = spreadsheet.data.sheets?.map(
    (s) => s.properties?.title
  ) || [];

  // Create unique tab name
  let tabName = tabDate;
  let counter = 1;
  while (existingTabs.includes(tabName)) {
    tabName = `${tabDate}_${counter}`;
    counter++;
  }

  // Create the new tab
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: HOLDINGS_SHEET_ID,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: tabName,
          },
        },
      }],
    },
  });

  console.log(`Created tab: ${tabName}`);

  // Write data to the new tab
  if (data.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: HOLDINGS_SHEET_ID,
      range: `'${tabName}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: data,
      },
    });

    console.log(`Wrote ${data.length} rows to ${tabName}`);
  }

  return tabName;
}
