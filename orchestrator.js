#!/usr/bin/env node
/**
 * External Orchestrator for Long-Running Agent Sessions
 *
 * Generic template - works with any project
 *
 * Usage:
 *   node orchestrator.js [options]
 *
 * Options:
 *   --max-sessions N   Maximum sessions to run (default: 20)
 *   --dry-run          Show what would happen without running Claude
 *   --reset            Reset session state for fresh start
 *   --help             Show help
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
// Configuration
const SESSION_FILE = path.join(__dirname, '.claude', 'session-state.json');
const FEATURES_FILE = path.join(__dirname, 'features.json');
const DEFAULT_CONFIG = {
  maxSessions: 20,
  maxFeaturesPerSession: 5,
  claudeCommand: 'claude',
  projectDir: __dirname
};
// Global state for SIGINT handler
let globalState = null;
// ============ Session State Management ============
function getSessionState() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  } catch {
    return createInitialState();
  }
}
function createInitialState() {
  return {
    current_session: {
      id: 1,
      started_at: new Date().toISOString(),
      features_complete_at_session_start: getTotalCompleteFeatures(),
      turns_this_session: 0,
      retries_current_task: 0,
      current_task: null,
      termination_reason: null
    },
    thresholds: {
      max_features_per_session: 5,
      max_turns_per_session: 60,
      max_retries_same_task: 3,
      max_duration_minutes: 60
    },
    history: []
  };
}
function saveSessionState(state) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
}
function getTotalCompleteFeatures() {
  try {
    const data = JSON.parse(fs.readFileSync(FEATURES_FILE, 'utf-8'));
    return (data.features || []).filter(f => f.status === 'complete').length;
  } catch {
    return 0;
  }
}
function getFeaturesCompletedThisSession(state) {
  const currentComplete = getTotalCompleteFeatures();
  const baseline = state.current_session.features_complete_at_session_start || 0;
  return Math.max(0, currentComplete - baseline);
}
function startNewSession(state, reason = 'scheduled') {
  // Archive current session
  if (state.current_session.id > 0) {
    state.history.push({
      id: state.current_session.id,
      started_at: state.current_session.started_at,
      ended_at: new Date().toISOString(),
      features_completed: getFeaturesCompletedThisSession(state),
      turns: state.current_session.turns_this_session,
      termination_reason: reason
    });
  }
  const currentComplete = getTotalCompleteFeatures();
  state.current_session = {
    id: state.current_session.id + 1,
    started_at: new Date().toISOString(),
    features_complete_at_session_start: currentComplete,
    turns_this_session: 0,
    retries_current_task: 0,
    current_task: null,
    termination_reason: null
  };
  saveSessionState(state);
  return state;
}
function resetSessionState() {
  const freshState = createInitialState();
  saveSessionState(freshState);
  console.log('Session state reset. Ready for fresh start.');
  return freshState;
}
// SIGINT handler
function setupSIGINTHandler() {
  process.on('SIGINT', () => {
    console.log('\n\nReceived SIGINT (Ctrl+C). Saving state...');
    if (globalState) {
      globalState.current_session.termination_reason = 'user_interrupt';
      saveSessionState(globalState);
      console.log('State saved. Session can be resumed.');
    }
    process.exit(0);
  });
}
// ============ Feature Status ============
function getFeatureStatus() {
  try {
    const data = JSON.parse(fs.readFileSync(FEATURES_FILE, 'utf-8'));
    const features = data.features || [];
    return {
      total: features.length,
      complete: features.filter(f => f.status === 'complete').length,
      pending: features.filter(f => f.status === 'pending').length,
      inProgress: features.filter(f => f.status === 'in-progress').length,
      failed: features.filter(f => f.status === 'failed' || f.test_status === 'failed').length
    };
  } catch {
    return { total: 0, complete: 0, pending: 0, inProgress: 0, failed: 0 };
  }
}
function isProjectComplete() {
  const status = getFeatureStatus();
  return status.pending === 0 && status.inProgress === 0 && status.failed === 0;
}
// ============ Claude Session Runner ============
function runClaudeSession(sessionId, config) {
  return new Promise((resolve, reject) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Starting Session ${sessionId}`);
    console.log(`${'='.repeat(60)}\n`);
    const status = getFeatureStatus();
    console.log(`Features: ${status.complete}/${status.total} complete`);
    console.log(`Pending: ${status.pending} | Failed: ${status.failed}\n`);
    if (config.dryRun) {
      console.log('[DRY RUN] Would start Claude session here');
      resolve({ reason: 'dry_run', sessionId });
      return;
    }
    const sessionPrompt = `You are starting Session ${sessionId}.
FIRST: Read these files to understand current state:
1. cat claude-progress.txt (previous session notes)
2. cat features.json | head -100 (feature status)
3. git log --oneline -5 (recent commits)
Then follow the instructions in CLAUDE.md.
Session limits: Max ${config.maxFeaturesPerSession} features this session.
Begin by reviewing the project state.`;
    const claude = spawn(config.claudeCommand, [
      sessionPrompt
    ], {
      stdio: 'inherit',
      shell: true,
      cwd: config.projectDir
    });
    claude.on('close', (code) => {
      console.log(`\nSession ${sessionId} ended with code ${code}`);
      resolve({ reason: code === 0 ? 'normal' : 'error', sessionId, exitCode: code });
    });
    claude.on('error', (err) => {
      console.error(`Session ${sessionId} error:`, err);
      reject(err);
    });
  });
}
// ============ Main ============
async function main() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-sessions' && args[i + 1]) {
      config.maxSessions = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      config.dryRun = true;
    } else if (args[i] === '--reset') {
      resetSessionState();
      if (args.length === 1) return;
    } else if (args[i] === '--help') {
      console.log(`
Long-Running Agent Orchestrator
Usage: node orchestrator.js [options]
Options:
  --max-sessions N   Maximum sessions to run (default: 20)
  --dry-run          Show what would happen without running Claude
  --reset            Reset session state for fresh start
  --help             Show this help message
Press Ctrl+C to gracefully stop and save state.
`);
      return;
    }
  }
  setupSIGINTHandler();
  const status = getFeatureStatus();
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           LONG-RUNNING AGENT ORCHESTRATOR                  ║
╠════════════════════════════════════════════════════════════╣
║  Max Sessions: ${String(config.maxSessions).padEnd(42)}║
║  Features: ${String(status.complete + '/' + status.total).padEnd(46)}║
║  Project: ${config.projectDir.slice(-47).padEnd(47)}║
╚════════════════════════════════════════════════════════════╝
`);
  let state = getSessionState();
  globalState = state;
  let sessionsRun = 0;
  while (sessionsRun < config.maxSessions) {
    if (isProjectComplete()) {
      console.log('\n✅ PROJECT COMPLETE! All features done.\n');
      break;
    }
    state = startNewSession(state, sessionsRun === 0 ? 'initial' : 'scheduled');
    globalState = state;
    sessionsRun++;
    try {
      const result = await runClaudeSession(state.current_session.id, config);
      state.current_session.termination_reason = result.reason;
      saveSessionState(state);
      if (config.dryRun && sessionsRun >= 3) {
        console.log('[DRY RUN] Stopping after 3 simulated sessions');
        break;
      }
    } catch (error) {
      console.error(`Session ${state.current_session.id} failed:`, error);
      state.current_session.termination_reason = 'error';
      saveSessionState(state);
    }
    if (!config.dryRun && sessionsRun < config.maxSessions && !isProjectComplete()) {
      console.log('\nStarting new session in 5 seconds...\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  const finalStatus = getFeatureStatus();
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    ORCHESTRATOR SUMMARY                    ║
╠════════════════════════════════════════════════════════════╣
║  Sessions Run: ${String(sessionsRun).padEnd(42)}║
║  Features Complete: ${String(finalStatus.complete + '/' + finalStatus.total).padEnd(37)}║
║  Still Pending: ${String(finalStatus.pending).padEnd(41)}║
║  Failed: ${String(finalStatus.failed).padEnd(48)}║
╚════════════════════════════════════════════════════════════╝
`);
  if (!isProjectComplete()) {
    console.log('⚠️  Project not complete. Run orchestrator again or check for blockers.\n');
  }
}
main().catch(console.error);
