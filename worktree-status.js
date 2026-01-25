#!/usr/bin/env node
/**
 * Worktree Status Script
 *
 * Shows status of all active worktrees and their progress.
 *
 * Usage:
 *   node worktree-status.js         # Show all worktrees
 *   node worktree-status.js --help  # Show help
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = process.cwd();

// ============ Utilities ============

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

function padRight(str, len) {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function padLeft(str, len) {
  return str.length >= len ? str.slice(0, len) : ' '.repeat(len - str.length) + str;
}

// ============ Worktree Discovery ============

function parseWorktrees() {
  const output = run('git worktree list --porcelain', { ignoreError: true });
  if (!output) return [];

  const worktrees = [];
  let current = {};

  output.split('\n').forEach(line => {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.replace('worktree ', '') };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.replace('HEAD ', '');
    } else if (line.startsWith('branch ')) {
      current.branch = line.replace('branch refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    }
  });

  if (current.path) worktrees.push(current);

  return worktrees;
}

function isHarnessWorktree(worktree) {
  // Check if this worktree was created by our harness (has worktree- branch prefix)
  return worktree.branch && worktree.branch.startsWith('worktree-');
}

function getWorktreeName(worktree) {
  if (worktree.branch && worktree.branch.startsWith('worktree-')) {
    return worktree.branch.replace('worktree-', '');
  }
  return path.basename(worktree.path);
}

// ============ Feature Analysis ============

function analyzeFeatures(worktreePath) {
  const featuresPath = path.join(worktreePath, 'features.json');
  if (!fileExists(featuresPath)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(featuresPath, 'utf-8'));
    const features = data.features || [];

    const assigned = features.filter(f =>
      f.status !== 'assigned-elsewhere' && f.status !== 'assigned-to-worktree'
    );

    const stats = {
      total: assigned.length,
      pending: assigned.filter(f => f.status === 'pending').length,
      inProgress: assigned.filter(f => f.status === 'in-progress').length,
      complete: assigned.filter(f => f.status === 'complete').length,
      failed: assigned.filter(f => f.status === 'failed').length,
      assignedIds: data.worktree?.assigned_feature_ids || assigned.map(f => f.id)
    };

    return stats;
  } catch {
    return null;
  }
}

function analyzeSession(worktreePath) {
  const sessionPath = path.join(worktreePath, '.claude', 'session-state.json');
  if (!fileExists(sessionPath)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    return {
      session: data.current_session?.id || 1,
      turns: data.current_session?.turns_this_session || 0,
      circuitBreaker: data.circuit_breaker?.consecutive_failures || 0
    };
  } catch {
    return null;
  }
}

function getCommitCount(worktree) {
  if (!worktree.branch) return 0;

  try {
    // Count commits on this branch that aren't on the main tracking branch
    const mainBranch = run('git rev-parse --abbrev-ref HEAD', { ignoreError: true }) || 'main';
    const output = run(`git rev-list --count ${mainBranch}..${worktree.branch}`, { ignoreError: true });
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

// ============ Display ============

function showStatus(worktrees) {
  const projectName = path.basename(PROJECT_ROOT);

  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║  WORKTREE STATUS: ${padRight(projectName, 47)}║
╚════════════════════════════════════════════════════════════════════╝
`);

  // Separate main and harness worktrees
  const mainWorktree = worktrees.find(w => w.path === PROJECT_ROOT);
  const harnessWorktrees = worktrees.filter(w => isHarnessWorktree(w) && w.path !== PROJECT_ROOT);

  // Show main project status
  if (mainWorktree) {
    const features = analyzeFeatures(PROJECT_ROOT);
    console.log('MAIN PROJECT');
    console.log('─'.repeat(68));
    console.log(`  Path:     ${mainWorktree.path}`);
    console.log(`  Branch:   ${mainWorktree.branch || 'detached'}`);
    if (features) {
      const progress = features.total > 0
        ? Math.round((features.complete / features.total) * 100)
        : 0;
      console.log(`  Features: ${features.complete}/${features.total} complete (${progress}%)`);
    }
    console.log('');
  }

  // Show harness worktrees
  if (harnessWorktrees.length === 0) {
    console.log('No active worktrees.\n');
    console.log('Create one with: node worktree-create.js --name <name>\n');
    return;
  }

  console.log(`ACTIVE WORKTREES (${harnessWorktrees.length})`);
  console.log('─'.repeat(68));

  // Table header
  console.log(
    padRight('  Name', 16) +
    padRight('Features', 20) +
    padRight('Session', 12) +
    padRight('Commits', 10)
  );
  console.log('  ' + '─'.repeat(64));

  harnessWorktrees.forEach(worktree => {
    const name = getWorktreeName(worktree);
    const features = analyzeFeatures(worktree.path);
    const session = analyzeSession(worktree.path);
    const commits = getCommitCount(worktree);

    let featureStr = 'N/A';
    if (features) {
      const pct = features.total > 0
        ? Math.round((features.complete / features.total) * 100)
        : 0;
      featureStr = `${features.complete}/${features.total} (${pct}%)`;
      if (features.inProgress > 0) featureStr += ` [${features.inProgress} active]`;
      if (features.failed > 0) featureStr += ` [${features.failed} failed]`;
    }

    let sessionStr = 'N/A';
    if (session) {
      sessionStr = `S${session.session}/T${session.turns}`;
      if (session.circuitBreaker > 0) {
        sessionStr += ` ⚠${session.circuitBreaker}`;
      }
    }

    console.log(
      padRight(`  ${name}`, 16) +
      padRight(featureStr, 20) +
      padRight(sessionStr, 12) +
      padLeft(String(commits), 10)
    );
  });

  console.log('');

  // Detail view
  console.log('DETAILS');
  console.log('─'.repeat(68));

  harnessWorktrees.forEach(worktree => {
    const name = getWorktreeName(worktree);
    const features = analyzeFeatures(worktree.path);

    console.log(`\n  ${name}:`);
    console.log(`    Path:   ${worktree.path}`);
    console.log(`    Branch: ${worktree.branch}`);

    if (features && features.assignedIds) {
      console.log(`    IDs:    ${features.assignedIds.join(', ')}`);
    }
  });

  console.log('\n');

  // Commands hint
  console.log('COMMANDS');
  console.log('─'.repeat(68));
  console.log('  Create:  node worktree-create.js --name <name>');
  console.log('  Merge:   node worktree-merge.js --name <name>');
  console.log('  Work:    cd <path> && node orchestrator.js');
  console.log('');
}

// ============ Main ============

function showHelp() {
  console.log(`
Worktree Status - Show status of all active worktrees

Usage:
  node worktree-status.js [options]

Options:
  --help    Show this help

Displays:
  - Main project progress
  - All active worktrees
  - Feature completion per worktree
  - Session info (turns, circuit breaker)
  - Commit counts
`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    showHelp();
    return;
  }

  // Validate we're in a git repo
  try {
    run('git rev-parse --git-dir');
  } catch {
    console.error('Not a git repository. Run this from your project root.');
    process.exit(1);
  }

  const worktrees = parseWorktrees();
  showStatus(worktrees);
}

main();
