#!/usr/bin/env node
/**
 * Worktree Merge Script
 *
 * Merges a completed worktree back into the main branch.
 *
 * Usage:
 *   node worktree-merge.js --name batch2          # Merge and cleanup
 *   node worktree-merge.js --name batch2 --keep   # Merge but keep worktree
 *   node worktree-merge.js --help                 # Show help
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
function warn(msg) { console.log(`  ⚠ ${msg}`); }
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

// ============ Worktree Operations ============

function getWorktreePath(name) {
  const projectName = path.basename(PROJECT_ROOT);
  return path.join(path.dirname(PROJECT_ROOT), `${projectName}-${name}`);
}

function getBranchName(name) {
  return `worktree-${name}`;
}

function verifyWorktreeExists(name) {
  const worktreePath = getWorktreePath(name);
  if (!fileExists(worktreePath)) {
    throw new Error(`Worktree not found at ${worktreePath}`);
  }

  const branchName = getBranchName(name);
  const worktrees = run('git worktree list');
  if (!worktrees.includes(branchName)) {
    throw new Error(`Worktree branch ${branchName} not found in git worktree list`);
  }

  return { worktreePath, branchName };
}

function getWorktreeCommits(branchName) {
  // Get commits on worktree branch that aren't on current branch
  try {
    const commits = run(`git log HEAD..${branchName} --oneline`, { ignoreError: true });
    return commits ? commits.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ============ Feature Sync ============

function loadFeatures(filePath) {
  if (!fileExists(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function syncFeatureStatuses(mainFeaturesPath, worktreeFeaturesPath) {
  const mainData = loadFeatures(mainFeaturesPath);
  const worktreeData = loadFeatures(worktreeFeaturesPath);

  if (!mainData || !worktreeData) {
    warn('Could not load features.json from both locations');
    return { synced: 0, completed: [] };
  }

  // Get the assigned feature IDs from worktree
  const assignedIds = new Set(
    worktreeData.worktree?.assigned_feature_ids ||
    worktreeData.features.filter(f => f.status !== 'assigned-elsewhere').map(f => f.id)
  );

  // Build a map of worktree feature statuses
  const worktreeStatusMap = new Map();
  worktreeData.features.forEach(f => {
    if (assignedIds.has(f.id)) {
      worktreeStatusMap.set(f.id, f);
    }
  });

  // Update main features with worktree statuses
  let synced = 0;
  const completed = [];

  mainData.features = mainData.features.map(f => {
    const worktreeFeature = worktreeStatusMap.get(f.id);
    if (worktreeFeature) {
      synced++;
      if (worktreeFeature.status === 'complete') {
        completed.push(f.name);
      }
      // Sync relevant fields
      return {
        ...f,
        status: worktreeFeature.status === 'assigned-elsewhere' ? f.status : worktreeFeature.status,
        test_status: worktreeFeature.test_status || f.test_status,
        test_method: worktreeFeature.test_method || f.test_method,
        last_tested: worktreeFeature.last_tested || f.last_tested,
        commits: [...(f.commits || []), ...(worktreeFeature.commits || [])],
        notes: worktreeFeature.notes || f.notes,
        blockers: worktreeFeature.blockers || f.blockers,
        deviations: worktreeFeature.deviations || f.deviations
      };
    }
    // Clear "assigned-to-worktree" status if it was set
    if (f.status === 'assigned-to-worktree') {
      return { ...f, status: 'pending' };
    }
    return f;
  });

  // Write updated main features
  fs.writeFileSync(mainFeaturesPath, JSON.stringify(mainData, null, 2));

  return { synced, completed };
}

// ============ Merge Operations ============

function checkForConflicts(branchName) {
  // Try a dry-run merge
  try {
    run(`git merge --no-commit --no-ff ${branchName}`, { ignoreError: false });
    run('git merge --abort', { ignoreError: true });
    return false; // No conflicts
  } catch {
    run('git merge --abort', { ignoreError: true });
    return true; // Has conflicts
  }
}

function performMerge(branchName, worktreeName) {
  const commitMsg = `Merge worktree '${worktreeName}' into main`;
  run(`git merge ${branchName} -m "${commitMsg}"`);
  success(`Merged ${branchName} into current branch`);
}

function cleanupWorktree(name) {
  const worktreePath = getWorktreePath(name);
  const branchName = getBranchName(name);

  // Remove worktree
  log('Removing worktree...');
  run(`git worktree remove "${worktreePath}" --force`, { ignoreError: true });
  success(`Removed worktree at ${worktreePath}`);

  // Delete branch
  log('Deleting branch...');
  run(`git branch -d ${branchName}`, { ignoreError: true });
  success(`Deleted branch ${branchName}`);
}

// ============ AGENTS.md Sync ============

function syncAgentsFile(mainPath, worktreePath) {
  const mainAgents = path.join(mainPath, 'AGENTS.md');
  const worktreeAgents = path.join(worktreePath, 'AGENTS.md');

  if (!fileExists(worktreeAgents)) {
    return false;
  }

  if (!fileExists(mainAgents)) {
    // Just copy it over
    fs.copyFileSync(worktreeAgents, mainAgents);
    return true;
  }

  // Append worktree learnings to main (simple concat of Session Log sections)
  const mainContent = fs.readFileSync(mainAgents, 'utf-8');
  const worktreeContent = fs.readFileSync(worktreeAgents, 'utf-8');

  // Find Session Log section in worktree
  const sessionLogMatch = worktreeContent.match(/## Session Log\n([\s\S]*?)(?=\n## |$)/);
  if (sessionLogMatch && sessionLogMatch[1].trim()) {
    const worktreeLearnings = sessionLogMatch[1].trim();

    // Check if main already has these learnings (simple duplicate check)
    if (!mainContent.includes(worktreeLearnings.slice(0, 100))) {
      // Append to main's Session Log
      const updatedMain = mainContent.replace(
        /## Session Log\n/,
        `## Session Log\n\n${worktreeLearnings}\n\n`
      );
      fs.writeFileSync(mainAgents, updatedMain);
      return true;
    }
  }

  return false;
}

// ============ Main ============

function showHelp() {
  console.log(`
Worktree Merge - Merge completed worktree back into main

Usage:
  node worktree-merge.js --name <name> [options]

Options:
  --name <name>    Required. Name of the worktree to merge
  --keep           Keep worktree after merge (don't cleanup)
  --help           Show this help

What this does:
  1. Verifies worktree exists and has commits
  2. Checks for merge conflicts
  3. Syncs feature statuses from worktree to main features.json
  4. Merges worktree branch into current branch
  5. Syncs AGENTS.md learnings
  6. Cleans up worktree and branch (unless --keep)

Examples:
  node worktree-merge.js --name batch2
  node worktree-merge.js --name api-features --keep
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let name = null;
  let keepWorktree = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
        name = args[++i];
        break;
      case '--keep':
        keepWorktree = true;
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

  header(`Merging Worktree: ${name}`);

  try {
    // Verify worktree exists
    const { worktreePath, branchName } = verifyWorktreeExists(name);
    success(`Found worktree at ${worktreePath}`);

    // Check for commits
    const commits = getWorktreeCommits(branchName);
    if (commits.length === 0) {
      warn('No new commits in worktree branch');
    } else {
      log(`Found ${commits.length} commits to merge:`);
      commits.slice(0, 5).forEach(c => console.log(`    ${c}`));
      if (commits.length > 5) {
        console.log(`    ... and ${commits.length - 5} more`);
      }
    }

    // Check for conflicts
    header('Checking for Conflicts');
    const hasConflicts = checkForConflicts(branchName);
    if (hasConflicts) {
      error('Merge conflicts detected!');
      console.log(`
  To resolve manually:
  1. git merge ${branchName}
  2. Fix conflicts
  3. git add . && git commit
  4. node worktree-merge.js --name ${name} --keep
      `);
      process.exit(1);
    }
    success('No conflicts detected');

    // Sync feature statuses BEFORE merge (so we capture worktree's features.json)
    header('Syncing Feature Statuses');
    const worktreeFeaturesPath = path.join(worktreePath, 'features.json');
    const { synced, completed } = syncFeatureStatuses(FEATURES_FILE, worktreeFeaturesPath);
    success(`Synced ${synced} features`);
    if (completed.length > 0) {
      log(`Completed features: ${completed.join(', ')}`);
    }

    // Perform merge
    header('Merging Branch');
    performMerge(branchName, name);

    // Sync AGENTS.md
    const agentsSynced = syncAgentsFile(PROJECT_ROOT, worktreePath);
    if (agentsSynced) {
      success('Synced AGENTS.md learnings');
    }

    // Cleanup
    if (!keepWorktree) {
      header('Cleaning Up');
      cleanupWorktree(name);
    } else {
      log('Keeping worktree (--keep flag)');
    }

    // Summary
    header('Merge Complete');
    console.log(`
  Commits merged:  ${commits.length}
  Features synced: ${synced}
  Completed:       ${completed.length}

  Your main branch now includes all work from the '${name}' worktree.

  Run 'git log --oneline -10' to see recent commits.
`);

  } catch (err) {
    error(err.message);
    process.exit(1);
  }
}

main();
