/**
 * API Key Updater Script
 * Fetches a new API key from the main proxy and updates the .env file
 */

const fs = require('fs');
const https = require('https');
const http = require('http');

// Read .env file
const envPath = '.env';
let envContent = '';
let mainProxyUrl = 'http://localhost:3000';

try {
    envContent = fs.readFileSync(envPath, 'utf8');
    const envLines = envContent.split('\n');
    
    // Extract MAIN_PROXY_URL
    for (const line of envLines) {
        if (line.startsWith('MAIN_PROXY_URL=')) {
            mainProxyUrl = line.split('=')[1].trim();
            break;
        }
    }
} catch (error) {
    console.log('Could not read .env file, using default URL');
}

console.log('Using main proxy URL:', mainProxyUrl);

// Parse URL
const url = new URL(mainProxyUrl + '/api/admin/api-keys');
const isHttps = url.protocol === 'https:';
const httpModule = isHttps ? https : http;

// Prepare request data
const postData = JSON.stringify({
    'createdBy': 'Ollama Server',
    'email': 'ollama-server@sap-ai-core.local'
});

const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
    }
};

// Make request
const req = httpModule.request(options, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
        data += chunk;
    });
    
    res.on('end', () => {
        try {
            if (res.statusCode === 200 || res.statusCode === 201) {
                const response = JSON.parse(data);
                const apiKey = response.apiKey;
                
                if (apiKey) {
                    console.log('Successfully obtained API key:', apiKey.substring(0, 10) + '...');
                    
                    // Update .env file
                    let updatedContent = envContent;
                    const apiKeyRegex = /^MAIN_PROXY_API_KEY=.*$/m;
                    
                    if (apiKeyRegex.test(updatedContent)) {
                        // Replace existing API key
                        updatedContent = updatedContent.replace(apiKeyRegex, 'MAIN_PROXY_API_KEY=' + apiKey);
                    } else {
                        // Add new API key line
                        updatedContent += '\nMAIN_PROXY_API_KEY=' + apiKey;
                    }
                    
                    fs.writeFileSync(envPath, updatedContent, 'utf8');
                    console.log('Updated .env file with new API key');
                    process.exit(0);
                } else {
                    console.log('No API key found in response');
                    process.exit(1);
                }
            } else {
                console.log('Failed to create API key. Status:', res.statusCode);
                console.log('Response:', data);
                process.exit(1);
            }
        } catch (error) {
            console.log('Error parsing response:', error.message);
            process.exit(1);
        }
    });
});

req.on('error', (error) => {
    console.log('Request failed:', error.message);
    console.log('Continuing with existing API key...');
    process.exit(0);
});

// Send request
req.write(postData);
req.end();
