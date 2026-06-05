#!/usr/bin/env node
// refresh.js — remove old deps & lockfile, clean cache, reinstall

const { rmSync, existsSync } = require('fs');
const { spawnSync } = require('child_process');
const { globSync } = require('glob');

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.error) {
    console.error(`❌ Error running ${cmd} ${args.join(' ')}: ${res.error.message}`);
    process.exit(res.status || 1);
  }
  if (res.status !== 0) {
    console.error(`❌ Command failed with exit code ${res.status}`);
    process.exit(res.status);
  }
}

console.log('🗑 Removing all node_modules directories...');
try {
  // Remove root node_modules
  rmSync('node_modules', { recursive: true, force: true });
  
  // Find and remove all service node_modules
  const nodeModulesDirs = globSync('**/node_modules', { ignore: ['**/node_modules/**/node_modules'] });
  nodeModulesDirs.forEach(dir => {
    try {
      rmSync(dir, { recursive: true, force: true });
      console.log(`🗑 Removed ${dir}`);
    } catch (e) {
      console.warn(`⚠️ Warning: Could not remove ${dir}: ${e.message}`);
    }
  });
} catch (e) { 
  if (e.code !== 'ENOENT') {
    console.warn(`⚠️ Warning: Could not fully clean node_modules: ${e.message}`);
  }
}

// Remove old npm lockfiles
if (existsSync('package-lock.json')) {
  console.log('🗑 Removing package-lock.json...');
  rmSync('package-lock.json', { force: true });
}

// Remove old pnpm lockfiles
if (existsSync('pnpm-lock.yaml')) {
  console.log('🗑 Removing pnpm-lock.yaml...');
  rmSync('pnpm-lock.yaml', { force: true });
}

console.log('🧹 Cleaning pnpm store...');
run('pnpm', ['store', 'prune']);

console.log('📦 Installing dependencies...');
run('pnpm', ['install']);

console.log('✅ Done.');
