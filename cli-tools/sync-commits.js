#!/usr/bin/env node

/**
 * Sync commits from a source git repository to a destination repository
 *
 * This script finds commits in the source repo that are newer than the last
 * commit in the destination repo, and replays them by copying file changes.
 *
 * Usage:
 *   node cli-tools/sync-commits.js --source /path/to/source --dest /path/to/dest
 *   node cli-tools/sync-commits.js --source /path/to/source --dest /path/to/dest --dry-run
 *
 * Options:
 *   --source   Path to source repository (required)
 *   --dest     Path to destination repository (defaults to current directory)
 *   --dry-run  Preview commits without applying them
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { source: null, dest: process.cwd(), dryRun: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && i + 1 < args.length) {
      parsed.source = path.resolve(args[++i]);
    } else if (args[i] === '--dest' && i + 1 < args.length) {
      parsed.dest = path.resolve(args[++i]);
    } else if (args[i] === '--dry-run') {
      parsed.dryRun = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node cli-tools/sync-commits.js --source <path> [--dest <path>] [--dry-run]

Options:
  --source   Path to source repository (required)
  --dest     Path to destination repository (defaults to current directory)
  --dry-run  Preview commits without applying them
  --help     Show this help message
`);
      process.exit(0);
    }
  }

  if (!parsed.source) {
    console.error('❌ Error: --source parameter is required');
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  return parsed;
}

// Execute git command in a specific directory
function gitExec(command, cwd, options = {}) {
  try {
    const result = execSync(command, {
      cwd,
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : ['pipe', 'pipe', 'pipe'],
      ...options
    });
    return result.trim();
  } catch (error) {
    if (options.allowFailure) {
      return null;
    }
    console.error(`❌ Git command failed: ${command}`);
    console.error(`   Working directory: ${cwd}`);
    console.error(`   Error: ${error.message}`);
    process.exit(1);
  }
}

// Validate that a directory is a git repository
function validateGitRepo(dir, label) {
  if (!fs.existsSync(dir)) {
    console.error(`❌ ${label} directory does not exist: ${dir}`);
    process.exit(1);
  }

  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) {
    console.error(`❌ ${label} is not a git repository: ${dir}`);
    process.exit(1);
  }

  console.log(`✅ ${label}: ${dir}`);
}

// Check if destination repo has uncommitted changes
function checkCleanWorkingTree(dir) {
  const status = gitExec('git status --porcelain', dir, { silent: true });
  if (status) {
    console.error('❌ Destination repository has uncommitted changes:');
    console.error(status);
    console.error('\n   Please commit or stash your changes before running this script.');
    process.exit(1);
  }
}

// Get the last commit timestamp from destination repo
function getLastCommitTimestamp(destDir) {
  const timestamp = gitExec('git log -1 --format=%ct', destDir, { silent: true, allowFailure: true });
  if (!timestamp) {
    console.log('⚠️  No commits found in destination repo, will sync all commits from source');
    return 0;
  }
  const date = new Date(parseInt(timestamp) * 1000);
  console.log(`🔍 Last commit in destination: ${date.toISOString()}`);
  return parseInt(timestamp);
}

// Get commits from source repo after the given timestamp
function getCommitsAfter(sourceDir, timestamp) {
  const sinceSec = timestamp + 1; // Start from 1 second after to avoid including the last dest commit
  const format = '%H|%ct|%an|%ae|%s';
  const logOutput = gitExec(
    `git log --format="${format}" --reverse --since=${sinceSec}`,
    sourceDir,
    { silent: true, allowFailure: true }
  );

  if (!logOutput) {
    return [];
  }

  const commits = logOutput.split('\n').map(line => {
    const [hash, timestamp, authorName, authorEmail, ...messageParts] = line.split('|');
    return {
      hash,
      timestamp: parseInt(timestamp),
      authorName,
      authorEmail,
      message: messageParts.join('|') // In case message contains |
    };
  });

  return commits;
}

// Get the full commit message (may be multiline)
function getFullCommitMessage(sourceDir, hash) {
  return gitExec(`git log -1 --format=%B ${hash}`, sourceDir, { silent: true });
}

// Get recent commit messages from destination (to detect duplicates)
function getRecentCommitMessages(destDir, since) {
  // Get commits from the last 24 hours or since timestamp, whichever is more recent
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  const sinceTimestamp = Math.max(since - 300, oneDayAgo); // Look back 5 min before timestamp

  const logOutput = gitExec(
    `git log --format=%s --since=${sinceTimestamp}`,
    destDir,
    { silent: true, allowFailure: true }
  );

  if (!logOutput) {
    return new Set();
  }

  // Return Set of commit subjects (first line of message)
  return new Set(logOutput.split('\n').map(line => line.trim()).filter(Boolean));
}

// Check if a commit already exists in destination based on message
function isDuplicateCommit(destMessages, sourceMessage) {
  // Compare just the first line (subject) of the commit message
  const sourceSubject = sourceMessage.split('\n')[0].trim();
  return destMessages.has(sourceSubject);
}

// Get file changes for a specific commit
function getFileChanges(sourceDir, hash) {
  const output = gitExec(
    `git diff-tree -r --no-commit-id --name-status ${hash}`,
    sourceDir,
    { silent: true }
  );

  if (!output) {
    return [];
  }

  const changes = output.split('\n').map(line => {
    const [status, ...pathParts] = line.split('\t');
    return {
      status, // A (added), M (modified), D (deleted)
      path: pathParts.join('\t')
    };
  });

  return changes;
}

// Get file content from source repo at specific commit
function getFileContent(sourceDir, hash, filePath) {
  try {
    return execSync(`git show ${hash}:"${filePath}"`, {
      cwd: sourceDir,
      encoding: 'buffer',
      stdio: 'pipe'
    });
  } catch (error) {
    return null;
  }
}

// Prompt user for confirmation
function promptUserConfirmation(commitCount) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n⚠️  WARNING: You are about to modify the destination repository!');
    console.log(`   This will apply ${commitCount} commit(s) to the destination.`);
    console.log('   💡 Tip: Use --dry-run to preview changes without applying them.\n');

    rl.question('   Do you want to proceed? (yes/no): ', (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      resolve(normalized === 'yes' || normalized === 'y');
    });
  });
}

// Apply a commit to the destination repo
function applyCommit(sourceDir, destDir, commit, dryRun) {
  console.log(`\n🔄 Processing: ${commit.hash.substring(0, 8)} - ${commit.message}`);

  const changes = getFileChanges(sourceDir, commit.hash);
  console.log(`   ${changes.length} file(s) changed`);

  if (dryRun) {
    changes.forEach(change => {
      const icon = change.status === 'D' ? '❌' : change.status === 'A' ? '➕' : '📝';
      console.log(`   ${icon} ${change.status} ${change.path}`);
    });
    return true;
  }

  // Apply file changes
  for (const change of changes) {
    const destPath = path.join(destDir, change.path);

    if (change.status === 'D') {
      // Delete file
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
        console.log(`   ❌ Deleted: ${change.path}`);
      }
    } else {
      // Add or modify file
      const content = getFileContent(sourceDir, commit.hash, change.path);
      if (content === null) {
        console.warn(`   ⚠️  Could not read file: ${change.path}`);
        continue;
      }

      // Create parent directories if needed
      const parentDir = path.dirname(destPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.writeFileSync(destPath, content);
      const icon = change.status === 'A' ? '➕' : '📝';
      console.log(`   ${icon} ${change.status} ${change.path}`);
    }
  }

  // Stage all changes
  gitExec('git add -A', destDir, { silent: true });

  // Check for conflicts (shouldn't happen with copy method, but be safe)
  const status = gitExec('git status --porcelain', destDir, { silent: true });
  if (!status) {
    console.log('   ⏭️  No changes to commit (possibly duplicate or already applied)');
    return true;
  }

  // Get full commit message (may be multiline)
  const fullMessage = getFullCommitMessage(sourceDir, commit.hash);

  // Create commit with original author and timestamp
  // IMPORTANT: Environment variables are passed ONLY to this specific git commit command
  // and do NOT persist or affect any subsequent git operations. Each execSync call
  // receives an isolated environment that is discarded after the command completes.
  const commitDate = new Date(commit.timestamp * 1000).toISOString();
  const commitEnv = {
    ...process.env, // Start with current environment
    GIT_AUTHOR_NAME: commit.authorName,
    GIT_AUTHOR_EMAIL: commit.authorEmail,
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_NAME: commit.authorName,
    GIT_COMMITTER_EMAIL: commit.authorEmail,
    GIT_COMMITTER_DATE: commitDate
  };

  try {
    // Pass the message as an argv element via spawnSync so the shell never
    // interprets backticks, $(...), or other metacharacters in the body.
    const result = spawnSync('git', ['commit', '-m', fullMessage], {
      cwd: destDir,
      env: commitEnv, // Environment variables scoped to this command only
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status !== 0) {
      const stderr = result.stderr ? result.stderr.toString() : '';
      throw new Error(stderr.trim() || `git commit exited with status ${result.status}`);
    }
    console.log(`   ✅ Commit created`);
    return true;
  } catch (error) {
    console.error(`   ❌ Failed to create commit: ${error.message}`);
    // Reset to clean state
    gitExec('git reset --hard HEAD', destDir, { silent: true });
    return false;
  }
}

// Main execution
async function main() {
  const args = parseArgs();

  console.log('🚀 Git Commit Sync Tool\n');

  // Phase 1: Validation
  console.log('📋 Validating repositories...');
  validateGitRepo(args.source, 'Source');
  validateGitRepo(args.dest, 'Destination');

  if (!args.dryRun) {
    checkCleanWorkingTree(args.dest);
    console.log('✅ Destination working tree is clean\n');
  }

  // Phase 2: Timestamp Discovery
  console.log('🔍 Finding last commit timestamp...');
  const lastTimestamp = getLastCommitTimestamp(args.dest);

  // Phase 3: Commit Discovery
  console.log('\n🔍 Finding commits to sync...');
  const allCommits = getCommitsAfter(args.source, lastTimestamp);

  if (allCommits.length === 0) {
    console.log('✅ No new commits to sync. Repositories are up to date.');
    process.exit(0);
  }

  // Get recent commit messages from destination to filter duplicates
  console.log('🔍 Checking for duplicate commits...');
  const destMessages = getRecentCommitMessages(args.dest, lastTimestamp);

  // Filter out commits that already exist in destination
  const commits = allCommits.filter(commit => {
    if (isDuplicateCommit(destMessages, commit.message)) {
      console.log(`   ⏭️  Skipping duplicate: ${commit.hash.substring(0, 8)} - ${commit.message}`);
      return false;
    }
    return true;
  });

  if (commits.length === 0) {
    console.log('✅ No new commits to sync (all commits already exist in destination).');
    process.exit(0);
  }

  const firstDate = new Date(commits[0].timestamp * 1000).toISOString();
  const lastDate = new Date(commits[commits.length - 1].timestamp * 1000).toISOString();
  console.log(`📦 Found ${commits.length} commit(s) to sync (${allCommits.length - commits.length} duplicate(s) skipped)`);
  console.log(`   Date range: ${firstDate} to ${lastDate}`);

  if (args.dryRun) {
    console.log('\n🔍 DRY RUN MODE - No changes will be made\n');
  } else {
    // Ask for confirmation before proceeding
    const confirmed = await promptUserConfirmation(commits.length);
    if (!confirmed) {
      console.log('\n❌ Sync cancelled by user.');
      console.log('   💡 Tip: Use --dry-run to preview changes without applying them.');
      process.exit(0);
    }
  }

  // Phase 4: Commit Replay
  console.log(`\n${'='.repeat(60)}`);
  console.log(args.dryRun ? 'Preview of commits to sync:' : 'Syncing commits...');
  console.log('='.repeat(60));

  let successCount = 0;
  let failCount = 0;

  for (const commit of commits) {
    const success = applyCommit(args.source, args.dest, commit, args.dryRun);
    if (success) {
      successCount++;
    } else {
      failCount++;
      console.error(`\n❌ Failed to apply commit ${commit.hash}`);
      console.error('   Stopping sync process.');
      console.error('   Please review the error and resolve manually.\n');
      process.exit(1);
    }
  }

  // Phase 5: Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 Summary');
  console.log('='.repeat(60));

  if (args.dryRun) {
    console.log(`✅ ${successCount} commit(s) ready to sync`);
    console.log('\nRun without --dry-run to apply these commits.');
  } else {
    console.log(`✅ Successfully synced ${successCount} commit(s)`);
    if (failCount > 0) {
      console.log(`❌ Failed: ${failCount} commit(s)`);
    }

    // Show last few commits in destination
    console.log('\n📝 Recent commits in destination repo:');
    const recentLog = gitExec('git log -5 --oneline', args.dest, { silent: true });
    console.log(recentLog.split('\n').map(line => `   ${line}`).join('\n'));
  }

  console.log('\n✅ Done.');
}

if (require.main === module) {
  main();
}

module.exports = { main };
