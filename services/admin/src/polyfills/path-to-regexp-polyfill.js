/**
 * Polyfill for path-to-regexp 0.1.12 to add match() function
 * This makes it compatible with router 2.2.0 which expects the modern API
 * 
 * This file should be required at the very beginning of the application
 * before any modules that use path-to-regexp are loaded.
 */

// Only patch if we're using the 0.1.x version
try {
  const pathToRegexp = require('path-to-regexp');
  
  // Check if it's the old version (0.1.x) by checking if match function exists
  if (typeof pathToRegexp === 'function' && !pathToRegexp.match) {
    console.log('[path-to-regexp-polyfill] Patching path-to-regexp 0.1.x for router 2.2.0 compatibility');
    
    // Monkey-patch the module
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    
    Module.prototype.require = function(id) {
      const module = originalRequire.apply(this, arguments);
      
      if (id === 'path-to-regexp') {
        // Check if we're dealing with the old version that needs patching
        if (typeof module === 'function' && !module.match && !module.pathToRegexp) {
          // Old version (0.1.x) - Return a wrapper that maintains compatibility
          return function pathToRegexpWrapper(path, keys, options) {
            const regexp = module(path, keys, options);
            
            // Add match function that router 2.2.0 expects
            if (!regexp.match) {
              regexp.match = function(str) {
                return function(pathname) {
                  const result = regexp.exec(pathname);
                  if (!result) return false;
                  
                  // Create params object from captured groups
                  const params = {};
                  if (keys) {
                    for (let i = 0; i < keys.length; i++) {
                      const key = keys[i];
                      const value = result[i + 1];
                      if (value !== undefined) {
                        params[key.name] = value;
                      }
                    }
                  }
                  
                  return {
                    path: result[0],
                    index: result.index,
                    params: params
                  };
                };
              };
            }
            
            return regexp;
          };
        }
        // If it's already a newer version with proper API, return as-is
      }
      
      return module;
    };
  }
} catch (e) {
  // path-to-regexp not installed or error during patching
  console.error('[path-to-regexp-polyfill] Failed to patch path-to-regexp:', e.message);
}