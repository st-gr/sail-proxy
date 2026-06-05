#!/usr/bin/env node

/**
 * consolidate-ui5-resources.js
 * Fast Node.js version for consolidating UI5 resources with symlinks
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Colors for output
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m', 
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m'
};

function log(message, color = 'blue') {
    const timestamp = new Date().toTimeString().split(' ')[0];
    console.log(`${colors[color]}[${timestamp}]${colors.reset} ${message}`);
}

function error(message) {
    console.error(`${colors.red}[ERROR]${colors.reset} ${message}`);
}

function success(message) {
    console.log(`${colors.green}[SUCCESS]${colors.reset} ${message}`);
}

function warn(message) {
    console.log(`${colors.yellow}[WARN]${colors.reset} ${message}`);
}

function formatBytes(bytes) {
    if (bytes >= 1073741824) {
        return `${Math.round(bytes / 1073741824)}GB`;
    } else if (bytes >= 1048576) {
        return `${Math.round(bytes / 1048576)}MB`;
    } else if (bytes >= 1024) {
        return `${Math.round(bytes / 1024)}KB`;
    }
    return `${bytes}B`;
}

function updateProgress(current, total, stage, stageWeight, completedStages = 0) {
    const stagePercent = Math.round((current / total) * stageWeight);
    const totalPercent = completedStages + stagePercent;
    const bar = '█'.repeat(Math.floor(totalPercent / 2)) + '░'.repeat(50 - Math.floor(totalPercent / 2));
    process.stdout.write(`\r${stage}: [${bar}] ${totalPercent}% (${current}/${total})`);
}

function usage() {
    console.log(`
Usage: node ${path.basename(__filename)} [OPTIONS]

Consolidate UI5 resources from multiple apps into a central location with symlinks.

Options:
    --dry-run           Show what would be done without making changes  
    --backup            Create backup before consolidation (uses extra space)
    --force             Proceed even if central resources directory exists
    -h, --help          Show this help message

Environment variables:
    ADMIN_ROOT          Root directory of admin service (default: /app/services/admin)

Examples:
    node ${path.basename(__filename)} --dry-run        # Preview what would be consolidated
    node ${path.basename(__filename)}                  # Perform actual consolidation (no backup)
    node ${path.basename(__filename)} --backup         # Perform consolidation with backup (uses more space)
    node ${path.basename(__filename)} --force          # Force consolidation even if directory exists
`);
}

async function findUI5Apps(appsDir) {
    const apps = [];
    
    if (!fs.existsSync(appsDir)) {
        throw new Error(`Apps directory not found: ${appsDir}`);
    }
    
    log(`Scanning for UI5 apps in ${appsDir}...`);
    
    const entries = fs.readdirSync(appsDir, { withFileTypes: true });
    
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const resourcesPath = path.join(appsDir, entry.name, 'dist', 'resources');
            if (fs.existsSync(resourcesPath)) {
                apps.push({
                    name: entry.name,
                    path: resourcesPath
                });
                log(`Found UI5 app: ${entry.name}`);
            }
        }
    }
    
    if (apps.length === 0) {
        throw new Error('No UI5 apps with resources found');
    }
    
    return apps;
}

function calculateChecksum(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(data).digest('hex');
    } catch (err) {
        return null;
    }
}

function getAllFiles(dirPath) {
    const files = [];
    
    function walkDir(currentPath) {
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                
                if (entry.isDirectory()) {
                    walkDir(fullPath);
                } else if (entry.isFile()) {
                    files.push(fullPath);
                }
            }
        } catch (err) {
            // Skip directories we can't read
        }
    }
    
    walkDir(dirPath);
    return files;
}

function copyDirectory(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
            copyDirectory(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function createBackup(apps, adminRoot) {
    const backupDir = path.join(adminRoot, `.resources-backup-${Date.now()}`);
    
    log(`Creating backup in ${backupDir}...`);
    fs.mkdirSync(backupDir, { recursive: true });
    
    for (const app of apps) {
        const backupAppDir = path.join(backupDir, app.name, 'dist');
        fs.mkdirSync(backupAppDir, { recursive: true });
        
        // Copy entire resources directory
        const destPath = path.join(backupAppDir, 'resources');
        copyDirectory(app.path, destPath);
    }
    
    // Write backup location file
    fs.writeFileSync(path.join(adminRoot, '.resources-backup-location'), backupDir);
    success(`Backup created: ${backupDir}`);
    
    return backupDir;
}

async function analyzeAndConsolidate(apps, centralDir, dryRun) {
    log('Analyzing files for consolidation...');
    
    // Stage 1: Scan all files and build file map (40% of progress)
    const fileMap = new Map(); // relativePath -> { checksum, instances: [{app, fullPath, size}] }
    let totalFiles = 0;
    let processedFiles = 0;
    
    // Count total files first
    for (const app of apps) {
        const files = getAllFiles(app.path);
        totalFiles += files.length;
    }
    
    log(`Scanning ${totalFiles} files across ${apps.length} apps...`);
    
    // Build file map with checksums
    for (const app of apps) {
        const files = getAllFiles(app.path);
        
        for (const filePath of files) {
            const relPath = path.relative(app.path, filePath);
            const checksum = calculateChecksum(filePath);
            const stats = fs.statSync(filePath);
            
            if (checksum) {
                if (!fileMap.has(relPath)) {
                    fileMap.set(relPath, { checksum, instances: [] });
                }
                
                const fileInfo = fileMap.get(relPath);
                fileInfo.instances.push({
                    app: app.name,
                    fullPath: filePath,
                    size: stats.size
                });
            }
            
            processedFiles++;
            if (processedFiles % 200 === 0) {
                updateProgress(processedFiles, totalFiles, 'Stage 1/3: Scanning files', 40, 0);
            }
        }
    }
    
    updateProgress(totalFiles, totalFiles, 'Stage 1/3: Scanning files', 40, 0);
    console.log('');
    
    // Stage 2: Identify duplicates and unique files (30% of progress)
    const duplicates = [];
    const uniqueFiles = [];
    let checkedFiles = 0;
    
    for (const [relPath, fileInfo] of fileMap.entries()) {
        if (fileInfo.instances.length > 1) {
            // Check if all instances have same checksum (true duplicates)
            const firstChecksum = fileInfo.checksum;
            let allSame = true;
            
            for (const instance of fileInfo.instances) {
                const instanceChecksum = calculateChecksum(instance.fullPath);
                if (instanceChecksum !== firstChecksum) {
                    allSame = false;
                    break;
                }
            }
            
            if (allSame) {
                duplicates.push({ relPath, fileInfo });
            } else {
                // Same name, different content - treat as unique per app
                for (const instance of fileInfo.instances) {
                    uniqueFiles.push({ 
                        relPath: `${instance.app}-${relPath}`, 
                        instance 
                    });
                }
            }
        } else {
            uniqueFiles.push({ relPath, instance: fileInfo.instances[0] });
        }
        
        checkedFiles++;
        if (checkedFiles % 100 === 0) {
            updateProgress(checkedFiles, fileMap.size, 'Stage 2/3: Analyzing duplicates', 30, 40);
        }
    }
    
    updateProgress(fileMap.size, fileMap.size, 'Stage 2/3: Analyzing duplicates', 30, 40);
    console.log('');
    
    // Stage 3: Perform consolidation (30% of progress)
    let consolidatedFiles = 0;
    const totalOperations = duplicates.length + uniqueFiles.length;
    let savedSpace = 0;
    
    if (!dryRun) {
        fs.mkdirSync(centralDir, { recursive: true });
    }
    
    console.log('');
    
    if (dryRun) {
        // Show detailed analysis like the old analyze script
        console.log('=== DUPLICATE FILES ANALYSIS ===');
        console.log('');
        console.log(`Total duplicate files: ${duplicates.length}`);
        console.log(`Total wasted space: ${formatBytes(savedSpace)}`);
        console.log('');
        
        // Show top 10 largest duplicates
        if (duplicates.length > 0) {
            console.log('=== TOP 10 LARGEST DUPLICATES ===');
            const top10 = duplicates
                .sort((a, b) => (b.fileInfo.instances[0].size * (b.fileInfo.instances.length - 1)) - 
                                (a.fileInfo.instances[0].size * (a.fileInfo.instances.length - 1)))
                .slice(0, 10);
            
            for (const { relPath, fileInfo } of top10) {
                const wastedSize = fileInfo.instances[0].size * (fileInfo.instances.length - 1);
                console.log(`${formatBytes(wastedSize)}: ${relPath}`);
                console.log(`  Copies: ${fileInfo.instances.length} apps`);
                console.log(`  Size each: ${formatBytes(fileInfo.instances[0].size)}`);
                console.log('');
            }
        }
        console.log('=== SIZE ANALYSIS ===');
        let totalCurrentSize = 0;
        for (const { relPath, fileInfo } of [...duplicates, ...uniqueFiles]) {
            const instances = fileInfo?.instances || [fileInfo.instance];
            for (const instance of instances) {
                totalCurrentSize += instance.size;
            }
        }
        console.log(`Total current resources size: ${formatBytes(totalCurrentSize)}`);
        console.log(`Estimated space savings: ${formatBytes(savedSpace)} (${Math.round(savedSpace / totalCurrentSize * 100)}%)`);
        console.log('');
    }
    
    console.log(`=== ${dryRun ? 'DRY RUN - ' : ''}CONSOLIDATION PLAN ===`);
    console.log(`Central directory: ${centralDir}`);
    console.log(`Duplicates to consolidate: ${duplicates.length}`);
    console.log(`Unique files to consolidate: ${uniqueFiles.length}`);
    console.log('');
    
    // Process duplicates
    for (const { relPath, fileInfo } of duplicates) {
        const masterInstance = fileInfo.instances[0];
        const centralPath = path.join(centralDir, relPath);
        
        if (!dryRun) {
            // Create directory structure
            fs.mkdirSync(path.dirname(centralPath), { recursive: true });
            
            // Copy master file to central location
            fs.copyFileSync(masterInstance.fullPath, centralPath);
        }
        
        // Replace all instances with symlinks
        for (const instance of fileInfo.instances) {
            const relativeLinkPath = path.relative(
                path.dirname(instance.fullPath),
                centralPath
            );
            
            if (!dryRun) {
                fs.unlinkSync(instance.fullPath);
                fs.symlinkSync(relativeLinkPath, instance.fullPath);
            }
            
            savedSpace += instance.size;
        }
        
        // Remove master file size from saved space (it still exists in central)
        savedSpace -= masterInstance.size;
        
        consolidatedFiles++;
        if (consolidatedFiles % 50 === 0) {
            updateProgress(consolidatedFiles, totalOperations, 'Stage 3/3: Creating symlinks', 30, 70);
        }
    }
    
    // Process unique files (copy to central, create symlinks)
    for (const { relPath, instance } of uniqueFiles) {
        const centralPath = path.join(centralDir, relPath);
        
        if (!dryRun) {
            fs.mkdirSync(path.dirname(centralPath), { recursive: true });
            fs.copyFileSync(instance.fullPath, centralPath);
            
            const relativeLinkPath = path.relative(
                path.dirname(instance.fullPath),
                centralPath
            );
            
            fs.unlinkSync(instance.fullPath);
            fs.symlinkSync(relativeLinkPath, instance.fullPath);
        }
        
        consolidatedFiles++;
        if (consolidatedFiles % 50 === 0) {
            updateProgress(consolidatedFiles, totalOperations, 'Stage 3/3: Creating symlinks', 30, 70);
        }
    }
    
    updateProgress(totalOperations, totalOperations, 'Stage 3/3: Creating symlinks', 30, 70);
    console.log('\n');
    
    return { 
        duplicatesCount: duplicates.length,
        uniqueCount: uniqueFiles.length,
        savedSpace: savedSpace
    };
}

function verifySymlinks(apps) {
    let brokenLinks = 0;
    let totalLinks = 0;
    
    for (const app of apps) {
        const files = getAllFiles(app.path);
        
        for (const filePath of files) {
            try {
                const stats = fs.lstatSync(filePath);
                if (stats.isSymbolicLink()) {
                    totalLinks++;
                    const target = fs.readlinkSync(filePath);
                    const absoluteTarget = path.resolve(path.dirname(filePath), target);
                    
                    if (!fs.existsSync(absoluteTarget)) {
                        brokenLinks++;
                        warn(`Broken symlink: ${filePath} -> ${target}`);
                    }
                }
            } catch (err) {
                // Skip files we can't read
            }
        }
    }
    
    return { totalLinks, brokenLinks };
}

async function main() {
    const adminRoot = process.env.ADMIN_ROOT || '/app/services/admin';
    const appsDir = path.join(adminRoot, 'app');
    const centralDir = path.join(adminRoot, 'app', 'resources');
    
    let dryRun = false;
    let shouldCreateBackup = false;  // Don't create backup by default to save space
    let force = false;
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    for (const arg of args) {
        switch (arg) {
            case '--dry-run':
                dryRun = true;
                shouldCreateBackup = false; // Don't create backup during dry-run
                break;
            case '--backup':
                shouldCreateBackup = true;
                break;
            case '--force':
                force = true;
                break;
            case '-h':
            case '--help':
                usage();
                process.exit(0);
                break;
            default:
                error(`Unknown option: ${arg}`);
                usage();
                process.exit(1);
        }
    }
    
    try {
        console.log('=== UI5 RESOURCES CONSOLIDATION ===');
        console.log(`Admin root: ${adminRoot}`);
        console.log(`Apps directory: ${appsDir}`);
        console.log(`Central resources: ${centralDir}`);
        console.log(`Dry run: ${dryRun}`);
        console.log(`Create backup: ${shouldCreateBackup}`);
        console.log('');
        
        // Check if central directory exists
        if (fs.existsSync(centralDir) && !force) {
            throw new Error(`Central resources directory already exists: ${centralDir}\nUse --force to proceed anyway`);
        }
        
        const apps = await findUI5Apps(appsDir);
        
        if (apps.length === 0) {
            throw new Error('No UI5 apps found to consolidate');
        }
        
        log(`Found ${apps.length} UI5 apps to consolidate`);
        console.log('');
        
        // Create backup if requested and not dry run
        let backupDir = null;
        if (shouldCreateBackup && !dryRun) {
            backupDir = createBackup(apps, adminRoot);
            console.log('');
        }
        
        // Perform consolidation
        const startTime = Date.now();
        const { duplicatesCount, uniqueCount, savedSpace } = await analyzeAndConsolidate(
            apps, 
            centralDir, 
            dryRun
        );
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        
        console.log('=== RESULTS ===');
        console.log(`Files consolidated: ${duplicatesCount + uniqueCount}`);
        console.log(`Duplicates found: ${duplicatesCount}`);
        console.log(`Unique files: ${uniqueCount}`);
        console.log(`Space ${dryRun ? 'that would be ' : ''}saved: ${formatBytes(savedSpace)}`);
        console.log(`Operation completed in: ${duration}s`);
        
        if (!dryRun) {
            console.log('');
            
            // Verify symlinks
            log('Verifying symlinks...');
            const { totalLinks, brokenLinks } = verifySymlinks(apps);
            
            if (brokenLinks === 0) {
                success(`All ${totalLinks} symlinks are working correctly!`);
            } else {
                warn(`Found ${brokenLinks} broken symlinks out of ${totalLinks} total`);
            }
            
            // Write consolidation report
            const reportPath = path.join(adminRoot, 'consolidation-report.txt');
            const report = `UI5 Resources Consolidation Report
Generated: ${new Date().toISOString()}
Duration: ${duration}s

Apps processed: ${apps.length}
Files consolidated: ${duplicatesCount + uniqueCount}
Duplicates found: ${duplicatesCount}
Unique files: ${uniqueCount}
Space saved: ${formatBytes(savedSpace)}
Symlinks created: ${totalLinks}
Broken symlinks: ${brokenLinks}

${backupDir ? `Backup location: ${backupDir}` : 'No backup created'}
Central resources: ${centralDir}
`;
            
            fs.writeFileSync(reportPath, report);
            console.log(`📋 Report saved: ${reportPath}`);
        }
        
        console.log('');
        
        if (dryRun) {
            console.log('=== NEXT STEPS ===');
            console.log('1. Review the analysis and consolidation plan above');
            console.log('2. Run without --dry-run to perform actual consolidation:');
            console.log(`   node ${path.basename(__filename)}`);
            console.log('3. Verify results after consolidation with:');
            console.log('   ./verify-consolidation.sh --test-http');
            
            if (savedSpace > 100 * 1024 * 1024) { // > 100MB savings
                console.log('');
                console.log(`💡 TIP: You could save ${formatBytes(savedSpace)} by consolidating resources!`);
            }
        } else {
            success('🎉 Consolidation complete!');
            console.log('');
            console.log('📋 Next Steps:');
            console.log(`1. Check the report: cat ${path.join(adminRoot, 'consolidation-report.txt')}`);
            console.log('2. Test your UI5 applications work correctly');
            console.log('3. If issues occur, restore from backup if created');
        }
        
    } catch (err) {
        error(err.message);
        process.exit(1);
    }
}

main();