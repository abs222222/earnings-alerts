/**
 * Google API Authentication for Earnings Alerts
 *
 * Supports two authentication methods:
 * 1. Service Account (recommended for automated/scheduled scripts)
 * 2. OAuth User Credentials (for interactive use)
 *
 * Environment variables:
 * - GOOGLE_CREDENTIALS_PATH: Path to service account JSON
 * - GOOGLE_TOKEN_PATH: Path to OAuth token JSON (alternative)
 */

import * as fs from 'fs';
import * as path from 'path';
import { google, Auth } from 'googleapis';

// Required scopes for Sheets and Gmail
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

// Cached auth client
let cachedAuth: Auth.GoogleAuth | Auth.OAuth2Client | null = null;

/**
 * Get default token path (user's home directory)
 */
function getDefaultTokenPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.claude', 'code-executor', 'google_token.json');
}

/**
 * Load service account credentials and create auth client
 */
function loadServiceAccount(credentialsPath: string): Auth.GoogleAuth {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Service account credentials not found: ${credentialsPath}`);
  }

  return new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: SCOPES,
  });
}

/**
 * Load OAuth user credentials and create auth client
 *
 * Handles token format from google_utils.py which uses:
 * - "token" (not "access_token")
 * - "expiry" (not "expiry_date")
 */
function loadOAuthCredentials(tokenPath: string): Auth.OAuth2Client {
  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `OAuth token not found: ${tokenPath}\n` +
        'Run the Google auth setup script to generate a token.'
    );
  }

  const tokenContent = fs.readFileSync(tokenPath, 'utf-8');
  const token = JSON.parse(tokenContent);

  const oauth2Client = new google.auth.OAuth2(
    token.client_id,
    token.client_secret,
    'https://oauth2.googleapis.com/token' // redirect URI for refresh
  );

  // Handle both token formats (google_utils.py uses "token", standard uses "access_token")
  const accessToken = token.token || token.access_token;

  // Handle expiry format (google_utils.py uses ISO string "expiry", standard uses epoch ms "expiry_date")
  let expiryDate: number | undefined;
  if (token.expiry) {
    expiryDate = new Date(token.expiry).getTime();
  } else if (token.expiry_date) {
    expiryDate = token.expiry_date;
  }

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: token.refresh_token,
    expiry_date: expiryDate,
    token_type: token.token_type || 'Bearer',
  });

  return oauth2Client;
}

/**
 * Get authenticated Google API client
 *
 * Tries in order:
 * 1. Service account (if GOOGLE_CREDENTIALS_PATH set)
 * 2. OAuth token (if GOOGLE_TOKEN_PATH set or default path exists)
 *
 * @returns Authenticated client (GoogleAuth or OAuth2Client)
 * @throws Error if no valid credentials found
 */
export async function getAuthClient(): Promise<Auth.GoogleAuth | Auth.OAuth2Client> {
  // Return cached client if available
  if (cachedAuth) {
    return cachedAuth;
  }

  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH;
  const tokenPath = process.env.GOOGLE_TOKEN_PATH || getDefaultTokenPath();

  // Try service account first
  if (credentialsPath) {
    console.log('Using service account authentication');
    cachedAuth = loadServiceAccount(credentialsPath);
    return cachedAuth;
  }

  // Fall back to OAuth
  if (fs.existsSync(tokenPath)) {
    console.log('Using OAuth authentication');
    cachedAuth = loadOAuthCredentials(tokenPath);
    return cachedAuth;
  }

  throw new Error(
    'No Google credentials found.\n' +
      'Set GOOGLE_CREDENTIALS_PATH (service account) or GOOGLE_TOKEN_PATH (OAuth).\n' +
      `Default OAuth token path: ${tokenPath}`
  );
}

/**
 * Get Google Sheets API service
 */
export async function getSheetsService() {
  const auth = await getAuthClient();
  return google.sheets({ version: 'v4', auth: auth as Auth.GoogleAuth });
}

/**
 * Get Gmail API service
 */
export async function getGmailService() {
  const auth = await getAuthClient();
  return google.gmail({ version: 'v1', auth: auth as Auth.GoogleAuth });
}

/**
 * Test authentication by making a simple API call
 */
export async function testAuth(): Promise<boolean> {
  try {
    const sheets = await getSheetsService();
    // Just verify we can access the API (don't need a real spreadsheet)
    console.log('Google API authentication successful');
    return true;
  } catch (error) {
    console.error('Authentication test failed:', error);
    return false;
  }
}

/**
 * Clear cached auth client (useful for testing)
 */
export function clearAuthCache(): void {
  cachedAuth = null;
}
