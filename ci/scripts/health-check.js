#!/usr/bin/env node

/**
 * Health Check Utility for CI Pipeline
 * 
 * Provides standardized health checking for all services
 * with configurable timeouts and retry logic.
 */

const axios = require('axios');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

/**
 * Health check configuration for each service
 */
const HEALTH_ENDPOINTS = {
  admin: {
    url: 'http://localhost:4004/health',
    fallback: 'http://localhost:4004',
    timeout: 5000,
    maxRetries: 30
  },
  gateway: {
    url: 'http://localhost:3000/health',
    fallback: 'http://localhost:3000',
    timeout: 5000,
    maxRetries: 30
  },
  ollama: {
    url: 'http://localhost:11434/health',
    fallback: 'http://localhost:11434',
    timeout: 5000,
    maxRetries: 30
  },
  valkey: {
    url: 'redis://localhost:6379',
    timeout: 3000,
    maxRetries: 10
  }
};

/**
 * Check if a service is healthy
 */
async function checkServiceHealth(serviceName, config = {}) {
  const serviceConfig = { ...HEALTH_ENDPOINTS[serviceName], ...config };
  
  console.log(`${colors.blue}[HEALTH]${colors.reset} Checking ${serviceName}...`);
  
  for (let attempt = 1; attempt <= serviceConfig.maxRetries; attempt++) {
    try {
      // Try primary health endpoint
      await axios.get(serviceConfig.url, {
        timeout: serviceConfig.timeout,
        validateStatus: () => true
      });
      
      console.log(`${colors.green}[HEALTH]${colors.reset} ${serviceName} is healthy ✅`);
      return true;
      
    } catch (primaryError) {
      // Try fallback endpoint if available
      if (serviceConfig.fallback) {
        try {
          await axios.get(serviceConfig.fallback, {
            timeout: serviceConfig.timeout,
            validateStatus: () => true
          });
          
          console.log(`${colors.green}[HEALTH]${colors.reset} ${serviceName} is healthy (fallback) ✅`);
          return true;
          
        } catch (fallbackError) {
          // Both failed, continue with retry logic
        }
      }
      
      // Log progress every 5 attempts
      if (attempt % 5 === 0) {
        console.log(`${colors.yellow}[HEALTH]${colors.reset} ${serviceName} not ready (${attempt}/${serviceConfig.maxRetries})`);
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`${colors.red}[HEALTH]${colors.reset} ${serviceName} failed health check ❌`);
  return false;
}

/**
 * Check all services
 */
async function checkAllServices() {
  const services = ['admin', 'gateway', 'ollama'];
  const results = {};
  
  console.log(`${colors.blue}[HEALTH]${colors.reset} Starting health checks for all services...`);
  
  for (const service of services) {
    results[service] = await checkServiceHealth(service);
  }
  
  const allHealthy = Object.values(results).every(result => result);
  
  if (allHealthy) {
    console.log(`${colors.green}[HEALTH]${colors.reset} All services are healthy! 🎉`);
    return true;
  } else {
    console.log(`${colors.red}[HEALTH]${colors.reset} Some services are unhealthy:`);
    Object.entries(results).forEach(([service, healthy]) => {
      const status = healthy ? '✅' : '❌';
      console.log(`  ${service}: ${status}`);
    });
    return false;
  }
}

/**
 * CLI interface
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // Check all services
    const success = await checkAllServices();
    process.exit(success ? 0 : 1);
  } else {
    // Check specific service
    const serviceName = args[0];
    if (!HEALTH_ENDPOINTS[serviceName]) {
      console.error(`${colors.red}[ERROR]${colors.reset} Unknown service: ${serviceName}`);
      console.log(`Available services: ${Object.keys(HEALTH_ENDPOINTS).join(', ')}`);
      process.exit(1);
    }
    
    const success = await checkServiceHealth(serviceName);
    process.exit(success ? 0 : 1);
  }
}

// Export for use as module
module.exports = {
  checkServiceHealth,
  checkAllServices,
  HEALTH_ENDPOINTS
};

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error(`${colors.red}[ERROR]${colors.reset} ${error.message}`);
    process.exit(1);
  });
}