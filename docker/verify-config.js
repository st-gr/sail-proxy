#!/usr/bin/env node

/**
 * Configuration verification script
 * Checks if all variable substitutions have been properly applied
 */

const fs = require('fs');
const path = require('path');

function verifyFile(filePath, description) {
  console.log(`\nChecking ${description}:`);
  console.log(`File: ${filePath}`);
  
  if (!fs.existsSync(filePath)) {
    console.log('❌ File does not exist');
    return false;
  }
  
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Check for unresolved variable references
  const unresolvedVars = content.match(/\$\{[^}]+\}/g);
  
  if (unresolvedVars) {
    console.log('❌ Found unresolved variables:');
    unresolvedVars.forEach(variable => {
      console.log(`   ${variable}`);
    });
    return false;
  }
  
  // Check for BASE_URL placeholders
  if (content.includes('BASE_URL') && content.includes('${BASE_URL}')) {
    console.log('❌ Found unresolved BASE_URL placeholders');
    return false;
  }
  
  console.log('✅ Configuration looks good');
  return true;
}

function main() {
  console.log('='.repeat(60));
  console.log('   SAP LLM Gateway Configuration Verification');
  console.log('='.repeat(60));
  
  const dockerDir = __dirname;
  let allGood = true;
  
  // Check main configuration files
  allGood &= verifyFile(path.join(dockerDir, '.env.auth'), 'OAuth2 configuration');
  allGood &= verifyFile(path.join(dockerDir, 'dex.config.yaml'), 'Dex OIDC configuration');
  allGood &= verifyFile(path.join(dockerDir, '.env.nginx'), 'Nginx environment configuration');
  allGood &= verifyFile(path.join(dockerDir, 'njs', 'jwt.js'), 'JWT validation script');
  
  console.log('\n' + '='.repeat(60));
  if (allGood) {
    console.log('🎉 All configurations verified successfully!');
    console.log('You can now run: docker-compose up -d --build');
  } else {
    console.log('❌ Configuration issues found. Please run setup-docker.js again.');
  }
  console.log('='.repeat(60));
}

if (require.main === module) {
  main();
}

module.exports = { verifyFile };