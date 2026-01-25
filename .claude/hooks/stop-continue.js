#!/usr/bin/env node
/**
 * Stop Hook: Hybrid Termination for Long-Running Agent (v3)
 * Enhanced with verification enforcement and task schema support.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const FEATURES_FILE = path.join(PROJECT_ROOT, 'features.json');
const SESSION_FILE = path.join(__dirname, '..', 'session-state.json');
const AGENTS_FILE = path.join(PROJECT_ROOT, 'AGENTS.md');

const DEFAULT_THRESHOLDS = {
  max_features_per_session: 5,
  max_turns_per_session: 60,
  max_retries_same_task: 3,
  max_duration_minutes: 60
};

function getProjectConfig() {
  try { return JSON.parse(fs.readFileSync(FEATURES_FILE, 'utf-8')).config || {}; }
  catch { return {}; }
}

function getBrowserTestCategories() { return getProjectConfig().browser_test_categories || []; }
function isAutoVerifyEnabled() { return getProjectConfig().auto_verify !== false; }
function getMaxVerifyRetries() { return getProjectConfig().max_verify_retries || 2; }

function getSessionState() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')); }
  catch {
    return {
      current_session: { id: 1, started_at: new Date().toISOString(), features_complete_at_session_start: getTotalCompleteFeatures(), turns_this_session: 0, retries_current_task: 0, current_task: null, verify_attempts: 0 },
      thresholds: DEFAULT_THRESHOLDS, history: []
    };
  }
}

function saveSessionState(state) { fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2)); }
function incrementTurns(state) { state.current_session.turns_this_session++; saveSessionState(state); }

function ensureBaseline(state) {
  if (state.current_session.features_complete_at_session_start === undefined) {
    state.current_session.features_complete_at_session_start = getTotalCompleteFeatures();
    saveSessionState(state);
  }
}

function recordTaskStart(state, taskName) {
  if (state.current_session.current_task === taskName) {
    state.current_session.retries_current_task++;
  } else {
    state.current_session.current_task = taskName;
    state.current_session.retries_current_task = 1;
    state.current_session.verify_attempts = 0;
  }
  saveSessionState(state);
}

function recordVerifyAttempt(state) {
  state.current_session.verify_attempts = (state.current_session.verify_attempts || 0) + 1;
  saveSessionState(state);
}

function recordFeatureCompleted(state, featureName) {
  state.current_session.last_completed_feature = featureName;
  state.current_session.awaiting_learnings = true;
  saveSessionState(state);
}

function clearAwaitingLearnings(state) {
  state.current_session.awaiting_learnings = false;
  state.current_session.last_completed_feature = null;
  saveSessionState(state);
}

function getAgentsFileModTime() {
  try {
    return fs.statSync(AGENTS_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

// ============ Circuit Breaker ============

function getCircuitBreaker(state) {
  return state.circuit_breaker || {
    consecutive_failures: 0,
    max_failures: 5,
    tripped: false,
    tripped_at: null,
    last_failure_reason: null
  };
}

function recordFailure(state, reason) {
  if (!state.circuit_breaker) {
    state.circuit_breaker = getCircuitBreaker(state);
  }
  state.circuit_breaker.consecutive_failures++;
  state.circuit_breaker.last_failure_reason = reason;

  if (state.circuit_breaker.consecutive_failures >= state.circuit_breaker.max_failures) {
    state.circuit_breaker.tripped = true;
    state.circuit_breaker.tripped_at = new Date().toISOString();
  }
  saveSessionState(state);
}

function recordSuccess(state) {
  if (!state.circuit_breaker) {
    state.circuit_breaker = getCircuitBreaker(state);
  }
  state.circuit_breaker.consecutive_failures = 0;
  state.circuit_breaker.last_failure_reason = null;
  // Don't reset tripped - that requires manual intervention
  saveSessionState(state);
}

function isCircuitBreakerTripped(state) {
  const cb = getCircuitBreaker(state);
  return cb.tripped === true;
}

function getCircuitBreakerStatus(state) {
  const cb = getCircuitBreaker(state);
  return `${cb.consecutive_failures}/${cb.max_failures} failures`;
}

function getFeatures() {
  try { return JSON.parse(fs.readFileSync(FEATURES_FILE, 'utf-8')); }
  catch { return { features: [] }; }
}

function getTotalCompleteFeatures() {
  return getFeatures().features.filter(f => f.status === 'complete').length;
}

function getFeaturesCompletedThisSession(state) {
  return Math.max(0, getTotalCompleteFeatures() - (state.current_session.features_complete_at_session_start || 0));
}

function getPendingFeatures() { return getFeatures().features.filter(f => f.status === 'pending'); }
function getInProgressFeatures() { return getFeatures().features.filter(f => f.status === 'in-progress'); }
function getFailedFeatures() { return getFeatures().features.filter(f => f.status === 'failed' || f.test_status === 'failed'); }
function getBlockedFeatures() { return getFeatures().features.filter(f => f.blockers && f.blockers.length > 0); }

function getNeedsVerificationFeatures() {
  return getFeatures().features.filter(f => f.task && f.task.verify && f.status === 'complete' && f.test_status !== 'passed');
}

function getUnverifiedBrowserFeatures() {
  const cats = getBrowserTestCategories();
  if (!cats.length) return [];
  return getFeatures().features.filter(f => cats.includes(f.category) && f.status === 'complete' && f.test_method !== 'browser');
}

function runVerifyCommand(feature) {
  if (!feature.task || !feature.task.verify) return { success: true, output: 'No verify command' };
  try {
    const output = execSync(feature.task.verify, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, output: output.slice(0, 1000) };
  } catch (err) {
    return { success: false, output: (err.stderr || err.stdout || err.message || 'Error').slice(0, 1000) };
  }
}

function checkTermination(state) {
  const t = state.thresholds || DEFAULT_THRESHOLDS;
  const s = state.current_session;
  const done = getFeaturesCompletedThisSession(state);

  if (done >= t.max_features_per_session) {
    return { shouldTerminate: true, reason: 'batch_complete', message: 'Completed ' + done + ' features. Fresh context needed.' };
  }
  if (s.turns_this_session >= t.max_turns_per_session) {
    return { shouldTerminate: true, reason: 'context_limit', message: 'Reached ' + s.turns_this_session + ' turns.' };
  }
  if (s.retries_current_task >= t.max_retries_same_task) {
    return { shouldTerminate: true, reason: 'stuck_loop', message: 'Stuck on ' + s.current_task };
  }
  const mins = (Date.now() - new Date(s.started_at).getTime()) / 60000;
  if (mins >= t.max_duration_minutes) {
    return { shouldTerminate: true, reason: 'time_limit', message: 'Session ran ' + Math.round(mins) + ' min.' };
  }
  return { shouldTerminate: false };
}

function buildTaskPrompt(f) {
  let p = '';
  if (f.task) {
    if (f.task.files && f.task.files.length) p += '\nFiles: ' + f.task.files.join(', ');
    if (f.task.action) p += '\nAction: ' + f.task.action;
    if (f.task.verify) p += '\nVerify: ' + f.task.verify;
    if (f.task.done) p += '\nDone when: ' + f.task.done;
  }
  return p;
}

function main() {
  const state = getSessionState();
  ensureBaseline(state);
  incrementTurns(state);

  const done = getFeaturesCompletedThisSession(state);
  const max = state.thresholds?.max_features_per_session || 5;
  const cbStatus = getCircuitBreakerStatus(state);
  const info = '[Session ' + state.current_session.id + ' | Turn ' + state.current_session.turns_this_session + ' | Features: ' + done + '/' + max + ' | Circuit: ' + cbStatus + ']';

  const term = checkTermination(state);
  if (term.shouldTerminate) {
    console.log(JSON.stringify({
      continue: true,
      prompt: 'SESSION END: ' + term.reason + '\n' + term.message + '\n\n1. Wrap up current work\n2. Update claude-progress.txt\n3. Commit\n4. Reply: SESSION_COMPLETE'
    }));
    return;
  }

  // Circuit breaker check - stop if too many consecutive failures
  if (isCircuitBreakerTripped(state)) {
    const cb = getCircuitBreaker(state);
    console.log(JSON.stringify({
      continue: false,
      reason: 'CIRCUIT BREAKER TRIPPED\n' +
        'Consecutive failures: ' + cb.consecutive_failures + '\n' +
        'Last failure: ' + cb.last_failure_reason + '\n' +
        'Tripped at: ' + cb.tripped_at + '\n\n' +
        'To reset: Set circuit_breaker.tripped=false in .claude/session-state.json'
    }));
    return;
  }

  const blocked = getBlockedFeatures();
  if (blocked.length) {
    console.log(JSON.stringify({ continue: false, reason: 'BLOCKED: Resolve blockers in features.json' }));
    return;
  }

  const failed = getFailedFeatures();
  if (failed.length) {
    const f = failed[0];
    recordTaskStart(state, f.name);
    console.log(JSON.stringify({
      continue: true,
      prompt: info + '\n\nFIX: "' + f.name + '"\n' + f.description + buildTaskPrompt(f) + '\n\nFix, verify, update status, commit.'
    }));
    return;
  }

  if (isAutoVerifyEnabled()) {
    const needsV = getNeedsVerificationFeatures();
    if (needsV.length) {
      const f = needsV[0];
      recordVerifyAttempt(state);
      const res = runVerifyCommand(f);
      const maxR = getMaxVerifyRetries();
      const att = state.current_session.verify_attempts;

      if (res.success) {
        recordFeatureCompleted(state, f.name);
        recordSuccess(state); // Reset circuit breaker on success
        console.log(JSON.stringify({
          continue: true,
          prompt: info + '\n\nVERIFY PASSED: "' + f.name + '"\n\n1. Update: test_status=passed, test_method=automated\n2. Append learnings to AGENTS.md (if any notable discoveries)\n3. Commit and continue.'
        }));
      } else if (att >= maxR) {
        recordFailure(state, 'Verification failed for "' + f.name + '": ' + res.output.slice(0, 200));
        console.log(JSON.stringify({
          continue: true,
          prompt: info + '\n\nVERIFY FAILED (' + att + '/' + maxR + '): "' + f.name + '"\nError: ' + res.output + '\nSet status=failed, continue to next.'
        }));
      } else {
        console.log(JSON.stringify({
          continue: true,
          prompt: info + '\n\nVERIFY FAILED (' + att + '/' + maxR + '): "' + f.name + '"\nError: ' + res.output + '\nFix and retry.'
        }));
      }
      return;
    }
  }

  const unvUI = getUnverifiedBrowserFeatures();
  if (unvUI.length) {
    const f = unvUI[0];
    recordTaskStart(state, 'browser_' + f.name);
    console.log(JSON.stringify({
      continue: true,
      prompt: info + '\n\nBROWSER TEST: "' + f.name + '"\nStart server, test in browser, update test_method=browser.'
    }));
    return;
  }

  const inProg = getInProgressFeatures();
  if (inProg.length) {
    const f = inProg[0];
    recordTaskStart(state, f.name);
    console.log(JSON.stringify({
      continue: true,
      prompt: info + '\n\nCONTINUE: "' + f.name + '"\n' + f.description + buildTaskPrompt(f) + '\nComplete, verify, commit.'
    }));
    return;
  }

  const pending = getPendingFeatures();
  if (pending.length) {
    const f = pending[0];
    clearAwaitingLearnings(state); // Clear flag when moving to new feature
    recordTaskStart(state, f.name);
    console.log(JSON.stringify({
      continue: true,
      prompt: info + '\n\nIMPLEMENT: "' + f.name + '" (' + pending.length + ' left)\n' + f.description + buildTaskPrompt(f) + '\n\n1. status=in-progress\n2. Build it\n3. Verify\n4. status=complete\n5. Commit'
    }));
    return;
  }

  console.log(JSON.stringify({ continue: false, reason: 'All features complete!' }));
}

main();
