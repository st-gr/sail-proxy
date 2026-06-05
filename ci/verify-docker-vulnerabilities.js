#!/usr/bin/env node

/**
 * Verify Docker Image Vulnerabilities
 * 
 * This script runs Trivy scans on Docker images and reports vulnerabilities
 * in a clear, structured format.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m'
};

async function scanImage(imageName) {
  console.log(`\n${colors.blue}Scanning ${imageName}...${colors.reset}`);
  
  try {
    // Run Trivy scan in JSON format
    const { stdout: jsonOutput } = await execAsync(`trivy image --format json ${imageName}`);
    const scanResult = JSON.parse(jsonOutput);
    
    let totalHigh = 0;
    let totalCritical = 0;
    const vulnerabilities = [];
    
    // Collect all vulnerabilities
    if (scanResult.Results) {
      for (const result of scanResult.Results) {
        if (result.Vulnerabilities) {
          for (const vuln of result.Vulnerabilities) {
            if (vuln.Severity === 'HIGH' || vuln.Severity === 'CRITICAL') {
              vulnerabilities.push({
                library: vuln.PkgName,
                version: vuln.InstalledVersion,
                fixedVersion: vuln.FixedVersion,
                severity: vuln.Severity,
                cve: vuln.VulnerabilityID,
                title: vuln.Title
              });
              
              if (vuln.Severity === 'HIGH') totalHigh++;
              if (vuln.Severity === 'CRITICAL') totalCritical++;
            }
          }
        }
      }
    }
    
    // Report results
    if (totalHigh === 0 && totalCritical === 0) {
      console.log(`${colors.green}✅ ${imageName}: No HIGH/CRITICAL vulnerabilities found${colors.reset}`);
    } else {
      console.log(`${colors.red}❌ ${imageName}: Found ${totalHigh} HIGH and ${totalCritical} CRITICAL vulnerabilities${colors.reset}\n`);
      
      // Group by library
      const grouped = {};
      vulnerabilities.forEach(vuln => {
        const key = `${vuln.library}@${vuln.version}`;
        if (!grouped[key]) {
          grouped[key] = [];
        }
        grouped[key].push(vuln);
      });
      
      // Display grouped vulnerabilities
      Object.entries(grouped).forEach(([key, vulns]) => {
        const firstVuln = vulns[0];
        console.log(`  ${colors.yellow}${firstVuln.library}${colors.reset} (${firstVuln.version}) → ${firstVuln.fixedVersion || 'no fix available'}`);
        vulns.forEach(vuln => {
          console.log(`    - ${vuln.cve}: ${vuln.title}`);
        });
      });
    }
    
    return { image: imageName, high: totalHigh, critical: totalCritical };
    
  } catch (error) {
    console.error(`${colors.red}Failed to scan ${imageName}: ${error.message}${colors.reset}`);
    return { image: imageName, error: error.message };
  }
}

async function main() {
  console.log(`${colors.bold}Docker Image Vulnerability Scanner${colors.reset}`);
  console.log('=' . repeat(50));
  
  const images = process.argv.slice(2);
  
  if (images.length === 0) {
    images.push('docker-gateway', 'docker-admin', 'docker-nginx');
  }
  
  console.log(`\nScanning images: ${images.join(', ')}`);
  
  const results = [];
  for (const image of images) {
    const result = await scanImage(image);
    results.push(result);
  }
  
  // Summary
  console.log(`\n${colors.bold}Summary:${colors.reset}`);
  console.log('=' . repeat(50));
  
  let totalVulns = 0;
  results.forEach(result => {
    if (result.error) {
      console.log(`${result.image}: ${colors.red}ERROR - ${result.error}${colors.reset}`);
    } else {
      const vulnCount = result.high + result.critical;
      totalVulns += vulnCount;
      
      if (vulnCount === 0) {
        console.log(`${result.image}: ${colors.green}PASS${colors.reset}`);
      } else {
        console.log(`${result.image}: ${colors.red}FAIL (${result.high} HIGH, ${result.critical} CRITICAL)${colors.reset}`);
      }
    }
  });
  
  if (totalVulns > 0) {
    console.log(`\n${colors.red}Total vulnerabilities found: ${totalVulns}${colors.reset}`);
    process.exit(1);
  } else {
    console.log(`\n${colors.green}All images passed security scan!${colors.reset}`);
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
    process.exit(1);
  });
}