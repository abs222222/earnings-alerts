#!/usr/bin/env node
/**
 * Worktree Create Script
 *
 * Creates an isolated git worktree for parallel agent execution.
 *
 * Usage:
 *   node worktree-create.js --name batch2                    # Auto-assign next 5 pending features
 *   node worktree-create.js --name batch2 --count 3          # Assign next 3 pending features
 *   node worktree-create.js --name batch2 --features 6-10    # Assign specific feature IDs
 *   node worktree-create.js --help                           # Show help
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = process.cwd();
const FEATURES_FILE = path.join(PROJECT_ROOT, 'features.json');

// ============ Utilities ============

function log(msg) { console.log(`  ${msg}`); }
function success(msg) { console.log(`  ✓ ${msg}`); }
function error(msg) { console.error(`  ✗ ${msg}`); }
function header(msg) { console.log(`\n${msg}\n${'─'.repeat(50)}`); }

function run(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', cwd: PROJECT_ROOT, ...options }).trim();
  } catch (err) {
    if (options.ignoreError) return '';
    throw err;
  }
}

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ============ Feature Selection ============

function loadFeatures() {
  if (!fileExists(FEATURES_FILE)) {
    throw new Error('features.json not found. Run setup.js first.');
  }
  return JSON.parse(fs.readFileSync(FEATURES_FILE, 'utf-8'));
}

function getPendingFeatures(featuresData) {
  return featuresData.features.filter(f => f.status === 'pending');
}

function selectFeaturesByCount(featuresData, count) {
  const pending = getPendingFeatures(featuresData);
  if (pending.length === 0) {
    throw new Error('No pending features available.');
  }
  return pending.slice(0, count);
}

function selectFeaturesByRange(featuresData, rangeStr) {
  // Parse "6-10" or "6,7,8" or "6"
  const ids = [];
  if (rangeStr.includes('-')) {
    const [start, end] = rangeStr.split('-').map(Number);
    for (let i = start; i <= end; i++) ids.push(i);
  } else if (rangeStr.includes(',')) {
    ids.push(...rangeStr.split(',').map(Number));
  } else {
    ids.push(Number(rangeStr));
  }

  const selected = featuresData.features.filter(f => ids.includes(f.id));
  if (selected.length === 0) {
    throw new Error(`No features found with IDs: ${rangeStr}`);
  }
  return selected;
}

// ============ Worktree Creation ============

function getWorktreePath(name) {
  const projectName = path.basename(PROJECT_ROOT);
  return path.join(path.dirname(PROJECT_ROOT), `${projectName}-${name}`);
}

function createWorktree(name) {
  const worktreePath = getWorktreePath(name);
  const branchName = `worktree-${name}`;

  // Check if worktree already exists
  if (fileExists(worktreePath)) {
    throw new Error(`Worktree already exists at ${worktreePath}`);
  }

  // Check if branch already exists
  const branches = run('git branch --list', { ignoreError: true });
  if (branches.includes(branchName)) {
    throw new Error(`Branch ${branchName} already exists. Remove it first or use a different name.`);
  }

  // Create worktree with new branch from current HEAD
  log(`Creating worktree at ${worktreePath}...`);
  run(`git worktree add -b ${branchName} "${worktreePath}"`);
  success(`Created worktree: ${worktreePath}`);
  success(`Created branch: ${branchName}`);

  return { worktreePath, branchName };
}

// ============ File Copying ============

function copyEnvFiles(worktreePath) {
  const envPatterns = ['.env', '.env.local', '.env.development', '.env.development.local'];
  let copied = 0;

  for (const pattern of envPatterns) {
    const srcPath = path.join(PROJECT_ROOT, pattern);
    if (fileExists(srcPath)) {
      const destPath = path.join(worktreePath, pattern);
      fs.copyFileSync(srcPath, destPath);
      success(`Copied ${pattern}`);
      copied++;
    }
  }

  if (copied === 0) {
    log('No .env files found to copy (this may be fine)');
  }

  return copied;
}

function createFilteredFeaturesFile(worktreePath, featuresData, selectedFeatures) {
  // Create a copy of features.json with only selected features marked as pending
  // Others are marked as "assigned-elsewhere" so agent knows not to work on them
  const selectedIds = new Set(selectedFeatures.map(f => f.id));

  const filteredFeatures = featuresData.features.map(f => {
    if (selectedIds.has(f.id)) {
      return { ...f, status: 'pending' }; // Ensure selected are pending
    } else if (f.status === 'pending') {
      return { ...f, status: 'assigned-elsewhere' }; // Mark others as unavailable
    }
    return f; // Keep completed/failed as-is
  });

  const filteredData = {
    ...featuresData,
    features: filteredFeatures,
    worktree: {
      name: path.basename(worktreePath),
      created_at: new Date().toISOString(),
      assigned_feature_ids: Array.from(selectedIds)
    }
  };

  const destPath = path.join(worktreePath, 'features.json');
  fs.writeFileSync(destPath, JSON.stringify(filteredData, null, 2));
  success(`Created filtered features.json (${selectedFeatures.length} features assigned)`);
}

function createFreshSessionState(worktreePath) {
  const claudeDir = path.join(worktreePath, '.claude');
  if (!fileExists(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const sessionState = {
    current_session: {
      id: 1,
      started_at: null,
      features_complete_at_session_start: 0,
      turns_this_session: 0,
      retries_current_task: 0,
      current_task: null,
      termination_reason: null,
      verify_attempts: 0,
      last_completed_feature: null,
      awaiting_learnings: false
    },
    thresholds: {
      max_features_per_session: 5,
      max_turns_per_session: 60,
      max_retries_same_task: 3,
      max_duration_minutes: 60
    },
    circuit_breaker: {
      consecutive_failures: 0,
      max_failures: 5,
      tripped: false,
      tripped_at: null,
      last_failure_reason: null
    },
    history: []
  };

  const destPath = path.join(claudeDir, 'session-state.json');
  fs.writeFileSync(destPath, JSON.stringify(sessionState, null, 2));
  success('Created fresh session-state.json');
}

function updateMainFeaturesFile(featuresData, selectedFeatures) {
  // Mark selected features as "assigned-to-worktree" in main features.json
  const selectedIds = new Set(selectedFeatures.map(f => f.id));

  const updatedFeatures = featuresData.features.map(f => {
    if (selectedIds.has(f.id) && f.status === 'pending') {
      return { ...f, status: 'assigned-to-worktree', assigned_worktree: path.basename(getWorktreePath('')) };
    }
    return f;
  });

  const updatedData = { ...featuresData, features: updatedFeatures };
  fs.writeFileSync(FEATURES_FILE, JSON.stringify(updatedData, null, 2));
  success(`Updated main features.json (${selectedFeatures.length} features marked as assigned)`);
}

// ============ Main ============

function showHelp() {
  console.log(`
Worktree Create - Create parallel workspace for agent execution

Usage:
  node worktree-create.js --name <name> [options]

Options:
  --name <name>        Required. Name for the worktree (e.g., "batch2")
  --count <n>          Assign next N pending features (default: 5)
  --features <range>   Assign specific features by ID (e.g., "6-10" or "1,3,5")
  --no-install         Skip npm install
  --help               Show this help

Examples:
  node worktree-create.js --name batch2
  node worktree-create.js --name api-features --count 3
  node worktree-create.js --name ui-batch --features 6-10

After creation:
  1. Open a new terminal
  2. cd ${path.dirname(PROJECT_ROOT)}/<project>-<name>
  3. node orchestrator.js
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let name = null;
  let count = 5;
  let featureRange = null;
  let skipInstall = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
        name = args[++i];
        break;
      case '--count':
        count = parseInt(args[++i], 10);
        break;
      case '--features':
        featureRange = args[++i];
        break;
      case '--no-install':
        skipInstall = true;
        break;
      case '--help':
        showHelp();
        return;
    }
  }

  if (!name) {
    error('--name is required');
    showHelp();
    process.exit(1);
  }

  // Validate we're in a git repo
  try {
    run('git rev-parse --git-dir');
  } catch {
    error('Not a git repository. Run this from your project root.');
    process.exit(1);
  }

  header(`Creating Worktree: ${name}`);

  try {
    // Load features
    const featuresData = loadFeatures();

    // Select features
    let selectedFeatures;
    if (featureRange) {
      selectedFeatures = selectFeaturesByRange(featuresData, featureRange);
      log(`Selected ${selectedFeatures.length} features by ID: ${featureRange}`);
    } else {
      selectedFeatures = selectFeaturesByCount(featuresData, count);
      log(`Selected next ${selectedFeatures.length} pending features`);
    }

    // Show selected features
    console.log('\nFeatures to assign:');
    selectedFeatures.forEach(f => {
      console.log(`  [${f.id}] ${f.name}: ${f.description.slice(0, 50)}...`);
    });
    console.log('');

    // Create worktree
    const { worktreePath, branchName } = createWorktree(name);

    // Copy files
    header('Copying Configuration');
    copyEnvFiles(worktreePath);
    createFilteredFeaturesFile(worktreePath, featuresData, selectedFeatures);
    createFreshSessionState(worktreePath);

    // Update main features.json
    // Note: We don't mark as assigned in main to keep it simple
    // The worktree has its own filtered copy

    // Install dependencies
    if (!skipInstall && fileExists(path.join(PROJECT_ROOT, 'package.json'))) {
      header('Installing Dependencies');
      log('Running npm install in worktree (this may take a moment)...');
      try {
        run('npm install', { cwd: worktreePath, stdio: 'inherit' });
        success('Dependencies installed');
      } catch (err) {
        error('npm install failed - you may need to run it manually');
      }
    }

    // Summary
    header('Worktree Ready');
    console.log(`
  Location:  ${worktreePath}
  Branch:    ${branchName}
  Features:  ${selectedFeatures.length} assigned

  Next steps:
  1. Open a NEW terminal
  2. cd "${worktreePath}"
  3. node orchestrator.js

  When done:
  node worktree-merge.js --name ${name}
`);

  } catch (err) {
    error(err.message);
    process.exit(1);
  }
}

main();
