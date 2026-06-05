// Enhanced JWT signature verification using njs crypto
import crypto from "crypto";

function b64url(s) { 
    s = s.replace(/-/g, '+').replace(/_/g, '/'); 
    return atob(s + '==='.slice((s.length + 3) % 4)); 
}

// Fetch JWKS from Dex with caching
function fetchJWKS(r) {
    const cacheKey = 'dex_jwks';
    const cached = ngx.shared.jwks_cache.get(cacheKey);
    
    if (cached) {
        try {
            return JSON.parse(cached);
        } catch (e) {
            r.warn('JWKS cache corrupted, refetching');
        }
    }
    
    try {
        const res = ngx.fetch('http://dex:5556/dex/keys', {
            method: 'GET',
            headers: { 
                'Accept': 'application/json',
                'User-Agent': 'SAP-LLM-Gateway-Nginx/1.0'
            }
        });
        
        if (res.status !== 200) {
            throw new Error(`JWKS fetch failed with status: ${res.status}`);
        }
        
        const jwks = res.json();
        
        if (!jwks || !jwks.keys || !Array.isArray(jwks.keys)) {
            throw new Error('Invalid JWKS format');
        }
        
        // Cache for 1 hour
        ngx.shared.jwks_cache.set(cacheKey, JSON.stringify(jwks), 3600);
        r.log(ngx.INFO, `Cached JWKS with ${jwks.keys.length} keys`);
        
        return jwks;
    } catch (e) {
        r.error(`JWKS fetch error: ${e.message}`);
        return null;
    }
}

// Find JWK by kid
function findJWK(jwks, kid) {
    if (!jwks || !jwks.keys) return null;
    
    for (let key of jwks.keys) {
        if (key.kid === kid && key.kty === 'RSA' && key.use === 'sig') {
            return key;
        }
    }
    return null;
}

// Convert JWK to PEM format for crypto operations
function jwkToPem(jwk) {
    if (!jwk.n || !jwk.e) {
        throw new Error('Invalid RSA JWK: missing n or e');
    }
    
    // Convert base64url to buffer
    const modulus = Buffer.from(b64url(jwk.n), 'binary');
    const exponent = Buffer.from(b64url(jwk.e), 'binary');
    
    // Create RSA public key in PEM format
    // This is a simplified approach - in production use proper ASN.1 encoding
    const publicKey = crypto.createPublicKey({
        key: {
            kty: 'RSA',
            n: jwk.n,
            e: jwk.e
        },
        format: 'jwk'
    });
    
    return publicKey.export({ type: 'spki', format: 'pem' });
}

// Verify JWT signature using RSA-SHA256
function verifySignature(r, token, header, payload, signature, jwk) {
    try {
        if (header.alg !== 'RS256') {
            return { valid: false, error: `Unsupported algorithm: ${header.alg}` };
        }
        
        if (!jwk) {
            return { valid: false, error: 'No matching JWK found' };
        }
        
        // Convert JWK to PEM
        const publicKeyPem = jwkToPem(jwk);
        
        // Create signing input (header.payload)
        const parts = token.split('.');
        const signingInput = parts[0] + '.' + parts[1];
        
        // Decode signature from base64url
        const signatureBuffer = Buffer.from(b64url(signature), 'binary');
        
        // Verify signature
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(signingInput);
        const isValid = verifier.verify(publicKeyPem, signatureBuffer);
        
        if (!isValid) {
            return { valid: false, error: 'JWT signature verification failed' };
        }
        
        r.log(ngx.INFO, 'JWT signature verified successfully');
        return { valid: true };
        
    } catch (e) {
        r.error(`Signature verification error: ${e.message}`);
        return { valid: false, error: `Signature verification failed: ${e.message}` };
    }
}

function validateJWTWithCrypto(r) {
    const h = r.headersIn.Authorization || '';
    if (!h.startsWith('Bearer ')) {
        return { valid: false, error: 'No bearer token' };
    }
    
    const token = h.slice(7);
    const parts = token.split('.');
    
    if (parts.length !== 3) {
        return { valid: false, error: 'Invalid JWT structure' };
    }
    
    try {
        const header = JSON.parse(b64url(parts[0]));
        const payload = JSON.parse(b64url(parts[1]));
        const signature = parts[2];
        
        // Validate required header fields
        if (!header.alg || !header.kid) {
            return { valid: false, error: 'Missing required JWT header fields' };
        }
        
        if (header.alg !== 'RS256') {
            return { valid: false, error: `Unsupported algorithm: ${header.alg}` };
        }
        
        // Validate claims
        if (payload.iss !== 'http://localhost:8080/dex') {
            return { valid: false, error: 'Invalid issuer' };
        }
        
        if (payload.aud !== 'oauth2-proxy') {
            return { valid: false, error: 'Invalid audience' };
        }
        
        // Validate timing
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) {
            return { valid: false, error: 'Token expired' };
        }
        
        if (payload.nbf && payload.nbf > now) {
            return { valid: false, error: 'Token not yet valid' };
        }
        
        if (payload.iat && payload.iat > now + 300) {
            return { valid: false, error: 'Token issued in future' };
        }
        
        // Fetch JWKS and verify signature
        const jwks = fetchJWKS(r);
        if (!jwks) {
            return { valid: false, error: 'Could not fetch JWKS for signature verification' };
        }
        
        const jwk = findJWK(jwks, header.kid);
        const sigVerification = verifySignature(r, token, header, payload, signature, jwk);
        
        if (!sigVerification.valid) {
            return sigVerification;
        }
        
        return { 
            valid: true, 
            claims: payload,
            header: header 
        };
        
    } catch (e) {
        r.error(`JWT validation error: ${e.message}`);
        return { valid: false, error: `JWT parsing failed: ${e.message}` };
    }
}

function user(r) { 
    const c = claims(r); 
    return c.preferred_username || c.name || c.sub || ''; 
}

function email(r) { 
    const c = claims(r); 
    return c.email || ''; 
}

function groups(r) { 
    const c = claims(r); 
    return Array.isArray(c.groups) ? c.groups.join(',') : (c.groups || ''); 
}

function claims(r) {
    const validation = validateJWTWithCrypto(r);
    return validation.valid ? validation.claims : {};
}

function isValid(r) {
    const validation = validateJWTWithCrypto(r);
    return validation.valid ? '1' : '0';
}

function validationError(r) {
    const validation = validateJWTWithCrypto(r);
    return validation.valid ? '' : (validation.error || 'Unknown error');
}

export default { user, email, groups, isValid, validationError };