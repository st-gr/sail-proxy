#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { Command } = require('commander');

class HeaderManager {
    constructor(options = {}) {
        this.options = {
            headerFile: options.headerFile || './cli-tools/header-for-source-files.ts',
            excludePatterns: options.excludePatterns || ['node_modules', 'dist', '.git'],
            extensions: options.extensions || ['.ts', '.js'],
            dryRun: options.dryRun || false,
            verbose: options.verbose || false,
            backup: options.backup || false,
            maxFileSize: options.maxFileSize || 10 * 1024 * 1024, // 10MB
            ...options
        };
        this.headerContent = null;
        this.stats = {
            processed: 0,
            modified: 0,
            skipped: 0,
            errors: 0
        };
    }

    async loadHeader() {
        try {
            const headerPath = path.resolve(this.options.headerFile);
            this.headerContent = await fs.readFile(headerPath, 'utf8');
            // Normalize line endings
            this.headerContent = this.headerContent.replace(/\r\n/g, '\n');
            if (this.options.verbose) {
                console.log(`✓ Loaded header from: ${headerPath}`);
            }
        } catch (error) {
            throw new Error(`Failed to load header file: ${error.message}`);
        }
    }

    async discoverFiles(baseDir) {
        const files = [];
        
        // Check if baseDir is a file
        try {
            const stats = await fs.stat(baseDir);
            if (stats.isFile()) {
                const ext = path.extname(baseDir);
                if (this.options.extensions.includes(ext)) {
                    files.push(baseDir);
                }
                return files;
            }
        } catch (error) {
            // If stat fails, assume it's a directory and continue
        }
        
        const scanDirectory = async (dir) => {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    
                    // Skip excluded patterns
                    if (this.options.excludePatterns.some(pattern => 
                        entry.name.includes(pattern) || fullPath.includes(pattern))) {
                        continue;
                    }

                    if (entry.isDirectory()) {
                        await scanDirectory(fullPath);
                    } else if (entry.isFile()) {
                        const ext = path.extname(entry.name);
                        if (this.options.extensions.includes(ext)) {
                            files.push(fullPath);
                        }
                    }
                    // Skip symlinks and other special files
                }
            } catch (error) {
                if (this.options.verbose) {
                    console.warn(`⚠ Skipping directory ${dir}: ${error.message}`);
                }
                this.stats.errors++;
            }
        };

        await scanDirectory(baseDir);
        return files;
    }

    async isTextFile(filePath) {
        try {
            const buffer = await fs.readFile(filePath, { encoding: null });
            // Simple heuristic: if file contains null bytes, it's likely binary
            return !buffer.includes(0);
        } catch (error) {
            return false;
        }
    }

    async hasHeader(content) {
        const normalizedContent = content.replace(/\r\n/g, '\n');
        const headerLines = this.headerContent.split('\n');
        const contentLines = normalizedContent.split('\n');
        
        // Check if file starts with shebang
        const hasShebang = contentLines.length > 0 && contentLines[0].startsWith('#!');
        const startIndex = hasShebang ? 1 : 0;
        
        // Check if file has the header after shebang (if present)
        for (let i = 0; i < headerLines.length; i++) {
            const contentLineIndex = startIndex + i;
            if (contentLineIndex >= contentLines.length || headerLines[i] !== contentLines[contentLineIndex]) {
                return false;
            }
        }
        return true;
    }

    async addHeader(filePath, content) {
        const normalizedContent = content.replace(/\r\n/g, '\n');
        const contentLines = normalizedContent.split('\n');
        
        let newContent;
        if (contentLines.length > 0 && contentLines[0].startsWith('#!')) {
            // Preserve shebang as first line
            const shebang = contentLines[0];
            const restOfContent = contentLines.slice(1).join('\n');
            newContent = shebang + '\n' + this.headerContent + '\n\n' + restOfContent;
        } else {
            newContent = this.headerContent + '\n\n' + normalizedContent;
        }
        
        if (!this.options.dryRun) {
            if (this.options.backup) {
                await fs.writeFile(filePath + '.bak', content);
            }
            await fs.writeFile(filePath, newContent, 'utf8');
        }
        
        if (this.options.verbose || this.options.dryRun) {
            console.log(`${this.options.dryRun ? '[DRY-RUN] ' : ''}✓ Added header to: ${filePath}`);
        }
        this.stats.modified++;
    }

    async removeHeader(filePath, content) {
        const normalizedContent = content.replace(/\r\n/g, '\n');
        const headerLines = this.headerContent.split('\n');
        const contentLines = normalizedContent.split('\n');
        
        // Check if file starts with shebang
        const hasShebang = contentLines.length > 0 && contentLines[0].startsWith('#!');
        const startIndex = hasShebang ? 1 : 0;
        
        // Remove header lines after shebang (if present)
        const remainingLines = [];
        if (hasShebang) {
            remainingLines.push(contentLines[0]); // Keep shebang
        }
        
        // Skip the header lines and add the rest
        const afterHeaderIndex = startIndex + headerLines.length;
        for (let i = afterHeaderIndex; i < contentLines.length; i++) {
            remainingLines.push(contentLines[i]);
        }
        
        // Remove leading empty lines that might have been left (but preserve shebang)
        const preserveIndex = hasShebang ? 1 : 0;
        while (remainingLines.length > preserveIndex && remainingLines[preserveIndex].trim() === '') {
            remainingLines.splice(preserveIndex, 1);
        }
        
        const newContent = remainingLines.join('\n');
        
        if (!this.options.dryRun) {
            if (this.options.backup) {
                await fs.writeFile(filePath + '.bak', content);
            }
            await fs.writeFile(filePath, newContent, 'utf8');
        }
        
        if (this.options.verbose || this.options.dryRun) {
            console.log(`${this.options.dryRun ? '[DRY-RUN] ' : ''}✓ Removed header from: ${filePath}`);
        }
        this.stats.modified++;
    }

    async processFile(filePath, mode) {
        try {
            this.stats.processed++;
            
            // Skip the header template file itself
            const headerPath = path.resolve(this.options.headerFile);
            const currentFilePath = path.resolve(filePath);
            if (currentFilePath === headerPath) {
                if (this.options.verbose) {
                    console.log(`- Skipping header template file: ${filePath}`);
                }
                this.stats.skipped++;
                return;
            }
            
            // Check file size
            const stats = await fs.stat(filePath);
            if (stats.size > this.options.maxFileSize) {
                if (this.options.verbose) {
                    console.warn(`⚠ Skipping large file: ${filePath} (${Math.round(stats.size / 1024)}KB)`);
                }
                this.stats.skipped++;
                return;
            }

            // Check if it's a text file
            if (!(await this.isTextFile(filePath))) {
                if (this.options.verbose) {
                    console.warn(`⚠ Skipping binary file: ${filePath}`);
                }
                this.stats.skipped++;
                return;
            }

            const content = await fs.readFile(filePath, 'utf8');
            const hasHeaderAlready = await this.hasHeader(content);

            if (mode === 'add') {
                if (!hasHeaderAlready) {
                    await this.addHeader(filePath, content);
                } else {
                    if (this.options.verbose) {
                        console.log(`- Header already present: ${filePath}`);
                    }
                    this.stats.skipped++;
                }
            } else if (mode === 'remove') {
                if (hasHeaderAlready) {
                    await this.removeHeader(filePath, content);
                } else {
                    if (this.options.verbose) {
                        console.log(`- No header to remove: ${filePath}`);
                    }
                    this.stats.skipped++;
                }
            }
        } catch (error) {
            console.error(`✗ Error processing ${filePath}: ${error.message}`);
            this.stats.errors++;
        }
    }

    async processFiles(files, mode) {
        const batchSize = 10; // Process files in parallel batches
        
        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);
            await Promise.all(batch.map(file => this.processFile(file, mode)));
        }
    }

    printStats() {
        console.log('\n📊 Summary:');
        console.log(`   Processed: ${this.stats.processed}`);
        console.log(`   Modified:  ${this.stats.modified}`);
        console.log(`   Skipped:   ${this.stats.skipped}`);
        if (this.stats.errors > 0) {
            console.log(`   Errors:    ${this.stats.errors}`);
        }
    }
}

async function main() {
    const program = new Command();
    
    program
        .name('manage-headers')
        .description('Add or remove file headers from TypeScript and JavaScript files')
        .version('1.0.0')
        .argument('[mode]', 'Operation mode: "add" or "remove"', 'add')
        .argument('[baseFolder]', 'Base folder to scan', process.cwd())
        .option('-d, --dry-run', 'Preview changes without modifying files')
        .option('-v, --verbose', 'Verbose output')
        .option('-b, --backup', 'Create backup files (.bak)')
        .option('-h, --header-file <path>', 'Path to header template file', './cli-tools/header-for-source-files.ts')
        .option('-e, --extensions <ext...>', 'File extensions to process', ['.ts', '.js'])
        .option('-x, --exclude <patterns...>', 'Patterns to exclude', ['node_modules', 'dist', '.git'])
        .option('--max-size <bytes>', 'Maximum file size to process (bytes)', '10485760')
        .addHelpText('after', `
Examples:
  $ node manage-headers.js
    Add headers to all .ts/.js files in current directory

  $ node manage-headers.js remove . --dry-run --verbose
    Preview header removal with detailed output

  $ node manage-headers.js add ./src --backup --verbose
    Add headers to files in src/ with backup files

  $ node manage-headers.js --header-file ./my-header.txt --extensions .ts .tsx
    Use custom header file and process only TypeScript files

  $ node manage-headers.js remove /path/to/single-file.js
    Remove header from a specific file
`)
        .action(async (mode, baseFolder, options) => {
            try {
                if (!['add', 'remove'].includes(mode)) {
                    console.error('Error: Mode must be "add" or "remove"');
                    process.exit(1);
                }

                const resolvedBaseFolder = path.resolve(baseFolder);
                
                console.log(`🔍 Scanning for files in: ${resolvedBaseFolder}`);
                console.log(`📝 Mode: ${mode}`);
                console.log(`📄 Header file: ${options.headerFile}`);
                if (options.dryRun) {
                    console.log('🔬 DRY RUN - No files will be modified');
                }

                const manager = new HeaderManager({
                    headerFile: options.headerFile,
                    excludePatterns: options.exclude,
                    extensions: options.extensions,
                    dryRun: options.dryRun,
                    verbose: options.verbose,
                    backup: options.backup,
                    maxFileSize: parseInt(options.maxSize)
                });

                await manager.loadHeader();
                const files = await manager.discoverFiles(resolvedBaseFolder);
                
                console.log(`📁 Found ${files.length} files to process`);
                
                if (files.length === 0) {
                    console.log('No files found matching criteria.');
                    return;
                }

                await manager.processFiles(files, mode);
                manager.printStats();
                
            } catch (error) {
                console.error(`❌ Error: ${error.message}`);
                process.exit(1);
            }
        });

    program.parse();
}

if (require.main === module) {
    main().catch(error => {
        console.error(`❌ Unexpected error: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { HeaderManager };