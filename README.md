# Earnings Alerts

Automated email alerts for upcoming company earnings report dates. Runs daily via GitHub Actions (Mon-Fri at 6 AM EST).

## How it works

1. Reads earnings dates and watchlist tickers from a Google Sheet (updated weekly from FactSet)
2. Determines alert timing based on pre-market vs post-market reporting
3. Calculates trading days using the NYSE calendar (skips weekends and holidays)
4. Sends HTML email alerts via Gmail API

## Alert logic

- **Post-market reports** (4pm-8pm) — alert sent morning of the report day
- **Pre-market reports** (5am-9:30am) — alert sent morning of the day before
- **Unknown timing** — treated as pre-market (alert day before)

## Email sections

1. Holdings reporting pre-market today
2. Holdings reporting before next open
3. Holdings reporting 2-5 days out
4. Watchlist reporting pre-market today
5. Watchlist reporting next 2 days

## Setup

### Prerequisites

- Node.js 20+
- Google Cloud project with Gmail and Sheets APIs enabled
- OAuth credentials for Google APIs

### Local development

```bash
npm install
npm run dry-run    # test without sending emails
npm run check      # production run (checks trading day first)
```

### GitHub Actions

The workflow runs automatically Mon-Fri at 6 AM EST. Required secrets:

- `GOOGLE_CREDENTIALS_B64` — base64-encoded Google OAuth credentials
- `GOOGLE_TOKEN_B64` — base64-encoded Google OAuth token
- `RECIPIENTS_B64` — base64-encoded recipient list JSON

### Manual trigger

You can also trigger the workflow manually from the Actions tab in GitHub.

## Project structure

```
src/
  main.ts          # CLI entry point
  sheets.ts        # Google Sheets data reader
  alerts.ts        # Alert timing logic
  calendar.ts      # NYSE trading day calendar
  email.ts         # Gmail sending + HTML templates
  google-auth.ts   # Google API authentication
  holdings-email.ts # Holdings-specific email logic
  types.ts         # TypeScript type definitions
config/
  settings.json    # Sheet IDs, alert thresholds, market hours
```
