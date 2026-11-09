// CDS Authentication Adapter for Custom JWT Authentication
// This bridges our custom JWT middleware with CDS authentication requirements

import { Request, Response, NextFunction } from 'express';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

interface CustomUser {
  id?: string;
  sub?: string;
  email?: string;
  roles?: string[];
  attr?: Record<string, any>;
}

export default function cdsAuthAdapter(req: Request, res: Response, next: NextFunction): void {
  try {
    // Log the current user context before transformation
    logger.trace('CDSAuthAdapter', '🔄 Processing user context for CDS:', {
      url: req.url,
      method: req.method,
      hasUser: !!req.user,
      userType: req.user?.constructor?.name,
      originalUser: req.user
    });

    // If user context was already set by our custom JWT middleware, use it
    if (req.user) {
      // Cast to our custom user type to access additional properties
      const customUser = req.user as any as CustomUser;
      
      // Transform our user context to CDS format
      const userId = customUser.id || customUser.sub || customUser.email || 'anonymous';
      const userRoles = customUser.roles || [];
      const userAttr = customUser.attr || {};
      
      logger.trace('CDSAuthAdapter', '👤 Creating CDS User:', {
        userId,
        userRoles,
        roleCount: userRoles.length,
        userAttr,
        originalCustomUser: customUser
      });
      
      // Set CDS user context - Create a proper authenticated user
      // Using standard cds.User constructor instead of Privileged to maintain user identity
      const cdsUser = new cds.User({
        id: userId,
        roles: {
          ...Object.fromEntries(userRoles.map(role => [role, true])),
          'identified-user': true,
          'authenticated-user': true
        },
        attr: {
          ...userAttr,
          email: userId
        }
      });
      
      req.user = cdsUser;
      
      logger.info('CDSAuthAdapter', '✅ CDS user context created successfully:', {
        cdsUserId: cdsUser.id,
        cdsUserRoles: cdsUser.roles,
        cdsUserAttr: cdsUser.attr,
        isAuthenticated: cdsUser.is('authenticated'),
        isAdmin: cdsUser.is('admin'),
        isUser: cdsUser.is('user'),
        userClassName: cdsUser.constructor.name,
        // Debug: Check if email is properly accessible
        debugEmail: {
          fromId: cdsUser.id,
          fromAttrEmail: cdsUser.attr?.email,
          originalUserId: userId,
          originalEmail: customUser.email
        }
      });
      
    } else {
      // For requests without JWT (e.g., health checks), use anonymous user
      logger.warn('CDSAuthAdapter', '🔓 No user context found, using anonymous user for:', {
        url: req.url,
        method: req.method
      });
      
      req.user = cds.User.anonymous;
    }
    
  } catch (error) {
    logger.error('CDSAuthAdapter', '❌ Error processing user context:', error as Error, {
      originalUser: req.user,
      url: req.url
    });
    
    // Fall back to anonymous user on error
    req.user = cds.User.anonymous;
  }
  
  next();
}
