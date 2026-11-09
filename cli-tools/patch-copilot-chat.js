#!/usr/bin/env node

/**
 * VS Code Copilot Chat Extension Patcher with Backup
 * - Finds github.copilot-chat extension.js cross-platform.
 * - Creates a backup (extension.js.bak) if not present, always with the unpatched version.
 * - Applies or reverts the patch as needed.
 * - Usage: node patch-copilot-chat.js [--base_url=http://localhost:3000/openrouter/api/v1]
 */

// WARNING: Patching the VSCode Copilot Chat extension is at your own risk.
// The author takes no responsibility for any damages, malfunctions, or data loss
// that may result from using or modifying this script or the extension files.
// Use only if you understand the risks and are willing to accept full responsibility.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXTENSION_PREFIX = 'github.copilot-chat-';
const SEARCH_STRING = 'https://openrouter.ai/api/v1';
const DEFAULT_BASE_URL = 'http://localhost:3000/openrouter/api/v1';

function getVSCodeExtensionsDirs() {
    const home = os.homedir();
    const dirs = [
        path.join(home, '.vscode', 'extensions'),
        path.join(home, '.vscode-insiders', 'extensions')
    ];
    // WSL support
    if (os.platform() === 'linux' && fs.existsSync('/mnt/c/Users')) {
        const wslHome = '/mnt/c/Users/' + (process.env['USER'] || process.env['USERNAME']);
        dirs.push(path.join(wslHome, '.vscode', 'extensions'));
    }
    return dirs.filter(fs.existsSync);
}

function findCopilotChatExtensionJs() {
    for (const extDir of getVSCodeExtensionsDirs()) {
        for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.startsWith(EXTENSION_PREFIX)) {
                const extJs = path.join(extDir, entry.name, 'dist', 'extension.js');
                if (fs.existsSync(extJs)) return extJs;
            }
        }
    }
    return null;
}

function createBackupIfNeeded(filePath, searchString) {
    const backupPath = filePath + '.bak';
    if (fs.existsSync(backupPath)) {
        return;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    // If already patched, revert before backup
    if (!content.includes(searchString)) {
        console.log('File is patched, reverting before backup...');
        const backupContent = content.replace(/http:\/\/localhost:3000\/openrouter\/api\/v1/g, searchString);
        fs.writeFileSync(backupPath, backupContent, 'utf8');
    } else {
        fs.writeFileSync(backupPath, content, 'utf8');
    }
    console.log('Backup created:', backupPath);
}

function patchFile(filePath, baseUrl) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(baseUrl)) {
        console.log('Patch already applied. Undoing patch...');
        const reverted = content.replaceAll(baseUrl, SEARCH_STRING);
        fs.writeFileSync(filePath, reverted, 'utf8');
        console.log('Patch reverted.');
    } else if (content.includes(SEARCH_STRING)) {
        console.log('Patch not applied. Applying patch...');
        const patched = content.replaceAll(SEARCH_STRING, baseUrl);
        fs.writeFileSync(filePath, patched, 'utf8');
        console.log('Patch applied.');
    } else {
        console.error('Neither the original nor the patched string found. No changes made.');
    }
}

function main() {
    const arg = process.argv.find(a => a.startsWith('--base_url='));
    const baseUrl = arg ? arg.split('=')[1] : DEFAULT_BASE_URL;
    const force = process.argv.includes('-force') || process.argv.includes('--force');

    if (!force) {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question('Proceed with patching the GitHub Copilot Chat plugin? (y/N): ', (answer) => {
            rl.close();
            if (answer.trim().toLowerCase() !== 'y') {
                console.log('Aborted by user.');
                process.exit(0);
            } else {
                proceed(baseUrl);
            }
        });
        return;
    }
    proceed(baseUrl);
}

function proceed(baseUrl) {
    const extensionJs = findCopilotChatExtensionJs();
    if (!extensionJs) {
        console.error('github.copilot-chat extension.js not found.');
        process.exit(1);
    }
    console.log('Found:', extensionJs);
    createBackupIfNeeded(extensionJs, SEARCH_STRING);
    patchFile(extensionJs, baseUrl);
}

main();