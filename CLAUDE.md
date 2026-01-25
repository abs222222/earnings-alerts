# Earnings Alerts - Claude Agent Instructions

## Project Overview

Email alert system for upcoming company earnings report dates. Reads from Google Sheet, calculates alert timing based on premarket/post-market, sends emails via Gmail API.

---

## Key Requirements

- **Data Source**: Google Sheet (updated weekly from FactSet)
- **Alert Logic**:
  - Post-market (4pm-8pm) → alert morning of report day
  - Premarket (5am-9:30am) / Unknown → alert morning of day before
- **Trading Days**: NYSE calendar (skip weekends + holidays)
- **Recipients**: Hardcoded list in config/recipients.json
- **Scheduling**: Windows Task Scheduler + GitHub Actions

---

## Session Start Protocol

Before doing ANY work:

```bash
# Verify the project state
npm run build  # or check if TypeScript compiles

# Review progress
cat claude-progress.txt
git status
git log --oneline -5

# Check features
cat features.json | grep -A3 '"status": "pending"'
```

---

## Working on Features

### Before Starting
1. Update features.json: Set status to "in-progress"
2. Note in claude-progress.txt what you're working on

### After Completing
1. Test the feature
2. Update features.json:
   - status: "complete"
   - test_status: "passed" | "failed"
   - test_method: "manual" | "automated"
   - last_tested: "YYYY-MM-DD"
3. Commit with descriptive message
4. Update claude-progress.txt

---

## Reference Files (trump-etf)

Reuse patterns from these files:
- `~/projects/trump-etf-tracker/google_utils.py` - Google auth
- `~/projects/trump-etf-tracker/src/email.py` - Gmail sending
- `~/projects/trump-etf-tracker/setup_tasks.bat` - Task scheduler
- `~/projects/trump-etf-tracker/src/main.py` - CLI pattern

---

## Git Commit Format

```bash
git commit -m "feat(category): description

- Specific change 1
- Specific change 2

Tested: manual/automated"
```

Categories: setup, data, calendar, alerts, email, main, scheduling

---

## Key Files

| File | Purpose |
|------|---------|
| `features.json` | Feature tracking |
| `claude-progress.txt` | Session progress log |
| `config/recipients.json` | Email recipient list |
| `config/settings.json` | Sheet ID, thresholds |
| `data/sent-alerts.json` | Deduplication tracking |

---

## Do NOT

- Send emails without --dry-run first
- Commit credentials or .env files
- Skip the session start protocol
- Leave features in broken state
