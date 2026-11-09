// CDS Authentication Adapter for Development Mode
// Simple JavaScript version to bypass TypeScript compilation issues

const cds = require('@sap/cds');
const { getDefaultLogger } = require('@libs/logger');

const logger = getDefaultLogger();

function cdsAuthAdapter(req, res, next) {
  try {
    // Skip processing for static resources and non-OData requests
    if (req.url.includes('/resources/') || 
        req.url.includes('/shell/') ||
        req.url.includes('.js') ||
        req.url.includes('.css') ||
        req.url.includes('.map') ||
        req.url.includes('/favicon') ||
        (!req.url.includes('/odata/') && !req.url.includes('$batch'))) {
      return next();
    }

    const isBatchRequest = req.url.includes('$batch');
    const isODataRequest = req.url.includes('/odata/');
    
    // Only log for OData requests to reduce noise
    if (isODataRequest || isBatchRequest) {
      logger.trace('CDSAuthAdapter', 'Processing OData request', {
        method: req.method,
        url: req.url,
        requestType: isBatchRequest ? 'BATCH' : 'DIRECT'
      });
    }
    
    // If user context was set by session middleware, transform it to CDS format
    if (req.user) {
      // Check if req.user is already a CDS User (avoid double conversion)
      if (req.user.constructor.name === 'User' && req.user.is) {
        // Already a CDS User, skip conversion
        if (isBatchRequest && cds.context) {
          cds.context.user = req.user;
          logger.trace('CDSAuthAdapter', 'CDS context set for batch request with existing CDS user', {
            userId: req.user.id
          });
        }
        return next();
      }
      
      const customUser = req.user;
      
      // Transform our user context to CDS format
      const userId = customUser.id || customUser.email || 'anonymous';
      const userRoles = customUser.roles || [];
      const userAttr = customUser.attr || {};
      
      if (isODataRequest || isBatchRequest) {
        logger.trace('CDSAuthAdapter', 'Creating CDS User for OData request', {
          userId,
          userRolesCount: userRoles.length,
          userRoles: userRoles,
          isBatch: isBatchRequest,
          hasAttributes: Object.keys(userAttr).length > 0
        });
      }
      
      // Create CDS user
      const cdsUser = new cds.User({
        id: userId,
        roles: userRoles,
        attr: userAttr
      });
      
      // Replace req.user with CDS user
      req.user = cdsUser;
      
      // For batch requests, also set the CDS context user to ensure 
      // individual operations inherit the authentication
      if (isBatchRequest && cds.context) {
        logger.trace('CDSAuthAdapter', 'Setting CDS context for batch request');
        cds.context.user = cdsUser;
      }
      
      if (isODataRequest || isBatchRequest) {
        logger.trace('CDSAuthAdapter', 'CDS user created successfully for OData request', {
          id: cdsUser.id,
          rolesCount: Object.keys(cdsUser.roles).length,
          roleNames: Object.keys(cdsUser.roles),
          isAdmin: cdsUser.is('admin'),
          isUser: cdsUser.is('user'),
          isAuthenticated: cdsUser.is('authenticated'),
          contextUserSet: isBatchRequest && cds.context?.user?.id === userId
        });
      }
      
    } else if (isODataRequest || isBatchRequest) {
      logger.trace('CDSAuthAdapter', 'No user context for OData request, using anonymous user', {
        method: req.method,
        url: req.url,
        requestType: isBatchRequest ? 'BATCH' : 'DIRECT'
      });
      req.user = cds.User.anonymous;
      if (isBatchRequest && cds.context) {
        cds.context.user = cds.User.anonymous;
      }
    }
    
  } catch (error) {
    logger.error('CDSAuthAdapter', 'Error processing authentication context', error, {
      method: req.method,
      url: req.url,
      hasUser: !!req.user,
      userType: req.user?.constructor?.name
    });
    req.user = cds.User.anonymous;
    if (cds.context) {
      cds.context.user = cds.User.anonymous;
    }
  }
  
  next();
}

module.exports = cdsAuthAdapter;