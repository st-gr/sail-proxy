#!/usr/bin/env node

/**
 * Security Scanner for CI Pipeline
 * 
 * Performs comprehensive security scans including:
 * - Docker image vulnerability scanning with Trivy
 * - npm audit for dependency vulnerabilities
 * - Static code analysis for security issues
 * - Secret detection
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m'
};

const logger = {
  info: (msg) => console.log(`${colors.blue}[SECURITY]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[SECURITY]${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}[SECURITY]${colors.reset} ${msg}`),
  error: (msg) => console.error(`${colors.red}[SECURITY]${colors.reset} ${msg}`),
  step: (msg) => console.log(`${colors.blue}${colors.bold}► ${msg}${colors.reset}`)
};

/**
 * Run npm audit for dependency vulnerabilities
 */
async function runNpmAudit() {
  logger.step('Running npm dependency security audit...');
  
  try {
    // Run audit in each service directory
    const services = ['services/gateway', 'services/admin', 'services/ollama'];
    let hasVulnerabilities = false;
    
    for (const service of services) {
      logger.info(`Auditing ${service}...`);
      
      try {
        execSync('pnpm audit --audit-level moderate', {
          cwd: service,
          stdio: 'inherit'
        });
        logger.success(`${service}: No moderate or higher vulnerabilities found`);
      } catch (error) {
        logger.error(`${service}: Security vulnerabilities found`);
        hasVulnerabilities = true;
      }
    }
    
    if (hasVulnerabilities) {
      throw new Error('Security vulnerabilities found in dependencies');
    }
    
    logger.success('All dependency security audits passed');
    return true;
  } catch (error) {
    logger.error(`npm audit failed: ${error.message}`);
    return false;
  }
}

/**
 * Run Trivy security scan on Docker images
 */
async function runTrivyScan() {
  logger.step('Running Trivy Docker security scan...');
  
  try {
    // Check if Trivy is installed
    try {
      execSync('trivy --version', { stdio: 'pipe' });
    } catch (error) {
      logger.warning('Trivy not installed, installing...');
      
      // Install Trivy (Linux/macOS compatible)
      const platform = process.platform;
      if (platform === 'linux') {
        execSync('curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin', { stdio: 'inherit' });
      } else if (platform === 'darwin') {
        execSync('brew install trivy', { stdio: 'inherit' });
      } else {
        logger.warning('Trivy auto-install not supported on this platform. Please install manually.');
        return true; // Skip Trivy on unsupported platforms
      }
    }
    
    // Build images for scanning
    logger.info('Building images for security scan...');
    execSync('docker build -f docker/gateway.Dockerfile -t sap-llm-gateway:gateway-scan .', { stdio: 'inherit' });
    execSync('docker build -f docker/admin.Dockerfile -t sap-llm-gateway:admin-scan .', { stdio: 'inherit' });
    
    // Scan images
    const images = [
      { name: 'sap-llm-gateway:gateway-scan', service: 'gateway' },
      { name: 'sap-llm-gateway:admin-scan', service: 'admin' }
    ];
    
    let hasVulnerabilities = false;
    
    for (const image of images) {
      logger.info(`Scanning ${image.service} image...`);
      
      try {
        // Run Trivy scan (exit code 0 for no HIGH/CRITICAL vulnerabilities)
        execSync(`trivy image --severity HIGH,CRITICAL --exit-code 1 ${image.name}`, {
          stdio: 'inherit'
        });
        logger.success(`${image.service}: No HIGH/CRITICAL vulnerabilities found`);
      } catch (error) {
        logger.error(`${image.service}: HIGH/CRITICAL vulnerabilities found`);
        hasVulnerabilities = true;
      }
    }
    
    if (hasVulnerabilities) {
      throw new Error('HIGH/CRITICAL vulnerabilities found in Docker images');
    }
    
    logger.success('All Docker image security scans passed');
    return true;
  } catch (error) {
    logger.error(`Trivy scan failed: ${error.message}`);
    return false;
  }
}

/**
 * Static code security analysis
 */
async function runStaticSecurityAnalysis() {
  logger.step('Running static security analysis...');
  
  let issuesFound = false;
  
  try {
    // Check for hardcoded secrets/passwords
    logger.info('Checking for hardcoded secrets...');
    
    const secretPatterns = [
      { pattern: /password\s*[=:]\s*["'](?!.*test|.*example|.*demo|.*\$\{)[^"']{8,}["']/gi, name: 'hardcoded passwords' },
      { pattern: /api[_-]?key\s*[=:]\s*["'][^"']{20,}["']/gi, name: 'hardcoded API keys' },
      { pattern: /secret\s*[=:]\s*["'](?!.*test|.*example|.*demo|.*\$\{)[^"']{16,}["']/gi, name: 'hardcoded secrets' },
      { pattern: /token\s*[=:]\s*["'][^"']{20,}["']/gi, name: 'hardcoded tokens' },
      { pattern: /BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/g, name: 'private keys' }
    ];
    
    const excludePaths = ['node_modules', '.git', 'dist', 'gen', 'logs', 'coverage'];
    const filesToCheck = [];
    
    // Recursively find files to check
    function findFiles(dir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (excludePaths.includes(item)) continue;
        
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          findFiles(fullPath);
        } else if (/\.(js|ts|json|env|yaml|yml)$/.test(item)) {
          filesToCheck.push(fullPath);
        }
      }
    }
    
    findFiles('.');
    
    for (const pattern of secretPatterns) {
      for (const filePath of filesToCheck) {
        // Skip sample files and tests
        if (filePath.includes('sample') || filePath.includes('test') || filePath.includes('example')) {
          continue;
        }
        
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const matches = content.match(pattern.pattern);
          
          if (matches) {
            logger.error(`${pattern.name} found in ${filePath}`);
            matches.forEach(match => {
              // Don't log the actual secret, just indicate where
              logger.error(`  Line contains: ${match.substring(0, 20)}...`);
            });
            issuesFound = true;
          }
        } catch (error) {
          // Skip files that can't be read
        }
      }
    }
    
    // Check for dangerous code patterns
    logger.info('Checking for dangerous code patterns...');
    
    const dangerousPatterns = [
      { pattern: /eval\s*\(/g, name: 'eval() usage' },
      { pattern: /innerHTML\s*=/g, name: 'innerHTML assignment (XSS risk)' },
      { pattern: /document\.write\s*\(/g, name: 'document.write usage' },
      { pattern: /process\.env\.\w+\s*=/, name: 'direct process.env modification' }
    ];
    
    for (const pattern of dangerousPatterns) {
      for (const filePath of filesToCheck) {
        if (!filePath.endsWith('.js') && !filePath.endsWith('.ts')) continue;
        
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          if (pattern.pattern.test(content)) {
            logger.warning(`${pattern.name} found in ${filePath}`);
          }
        } catch (error) {
          // Skip files that can't be read
        }
      }
    }
    
    if (issuesFound) {
      throw new Error('Security issues found in static analysis');
    }
    
    logger.success('Static security analysis completed');
    return true;
  } catch (error) {
    logger.error(`Static analysis failed: ${error.message}`);
    return false;
  }
}

/**
 * Check for security TODOs and FIXMEs
 */
async function checkSecurityTodos() {
  logger.step('Checking for security TODOs...');
  
  try {
    const output = execSync('grep -r "TODO.*security\\|FIXME.*security" services/ --include="*.js" --include="*.ts" || true', { 
      encoding: 'utf8' 
    });
    
    if (output.trim()) {
      logger.warning('Security TODOs found:');
      console.log(output);
      logger.warning('Please address security TODOs before production deployment');
    } else {
      logger.success('No security TODOs found');
    }
    
    return true;
  } catch (error) {
    logger.error(`Security TODO check failed: ${error.message}`);
    return false;
  }
}

/**
 * Main security scan function
 */
async function runSecurityScan() {
  logger.info('Starting comprehensive security scan...');
  
  const results = {
    npmAudit: false,
    trivyScan: false,
    staticAnalysis: false,
    securityTodos: false
  };
  
  // Run all security checks
  results.npmAudit = await runNpmAudit();
  results.trivyScan = await runTrivyScan();
  results.staticAnalysis = await runStaticSecurityAnalysis();
  results.securityTodos = await checkSecurityTodos();
  
  // Summary
  const passed = Object.values(results).filter(result => result).length;
  const total = Object.keys(results).length;
  
  logger.info(`Security scan results: ${passed}/${total} checks passed`);
  
  Object.entries(results).forEach(([check, passed]) => {
    const status = passed ? '✅' : '❌';
    logger.info(`  ${check}: ${status}`);
  });
  
  const allPassed = Object.values(results).every(result => result);
  
  if (allPassed) {
    logger.success('🛡️ All security checks passed!');
    return true;
  } else {
    logger.error('🚨 Security scan failed - please address issues above');
    return false;
  }
}

// CLI interface
if (require.main === module) {
  runSecurityScan()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      logger.error(`Security scan error: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { runSecurityScan };