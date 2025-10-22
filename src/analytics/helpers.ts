import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { createHash } from 'crypto';

// Get analytics salt from environment
const ANALYTICS_SALT = process.env.ANALYTICS_SALT || 'default_salt_change_me';

/**
 * Hash sensitive data with salt for privacy protection
 */
function hashWithSalt(value: string): string {
  return createHash('sha256').update(ANALYTICS_SALT + value).digest('hex');
}

/**
 * Log a server-side analytics event
 */
export async function logServerEvent({
  uid,
  role,
  name,
  props = {},
  request,
}: {
  uid?: string;
  role?: string;
  name: string;
  props?: Record<string, any>;
  request?: any; // Express request object for IP/UA extraction
}) {
  try {
    const db = getFirestore();
    const now = new Date();
    
    // Build context with server-side information
    const context: Record<string, any> = {
      platform: 'server',
      appVersion: 'functions',
    };
    
    // Add hashed IP and User-Agent if available from request
    if (request) {
      if (request.ip) {
        context.ipHash = hashWithSalt(request.ip);
      }
      if (request?.get?.('User-Agent')) {
        context.uaHash = hashWithSalt(request.get('User-Agent'));
      }
    }
    
    // Create analytics event
    const event = {
      uid: uid || null,
      role: role || null,
      ts: Timestamp.fromDate(now),
      src: 'server',
      name,
      props: sanitizeProps(props),
      context,
      sessionId: 'server_' + now.getTime(), // Server sessions are timestamp-based
    };
    
    // Write to Firestore
    await db.collection('analyticsEvents').add(event);
    
    logger.info('📊 ANALYTICS: Server event logged', { name, uid, role });
    
  } catch (error) {
    logger.error('❌ ANALYTICS: Error logging server event', { error, name });
  }
}

/**
 * Sanitize properties to remove PII and validate types
 */
function sanitizeProps(props: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  
  // Whitelist of allowed property keys for server events
  const allowedKeys = new Set([
    'amountEur',
    'amountNet',
    'rating',
    'disputeReason',
    'disputeOutcome',
    'adminFlag',
    'exportKind',
    'pushType',
    'transferType',
    'jobType',
    'servicesCount',
    'sizeM2',
  ]);
  
  for (const [key, value] of Object.entries(props)) {
    // Check if key is whitelisted
    if (!allowedKeys.has(key)) {
      continue;
    }
    
    // Validate and sanitize value
    if (typeof value === 'string') {
      if (value.length <= 120 && !containsPII(value)) {
        sanitized[key] = value;
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (value === null || value === undefined) {
      sanitized[key] = null;
    }
  }
  
  return sanitized;
}

/**
 * Check if a string contains potential PII
 */
function containsPII(value: string): boolean {
  const lowerValue = value.toLowerCase();
  
  // Check for email pattern
  if (/^[^@]+@[^@]+\.[^@]+$/.test(value)) {
    return true;
  }
  
  // Check for phone number pattern
  if (/^\+?[\d\s\-()]{10,}$/.test(value.replace(/\s/g, ''))) {
    return true;
  }
  
  // Check for common PII keywords
  const piiKeywords = ['email', 'phone', 'address', 'name', 'street', 'city'];
  for (const keyword of piiKeywords) {
    if (lowerValue.includes(keyword)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Convenience functions for common server events
 */

export async function logPaymentEvent(eventName: string, {
  uid,
  role,
  amountEur,
  request,
}: {
  uid?: string;
  role?: string;
  amountEur: number;
  request?: any;
}) {
  await logServerEvent({
    uid,
    role,
    name: eventName,
    props: { amountEur },
    request,
  });
}

export async function logDisputeEvent(eventName: string, {
  uid,
  role,
  reason,
  outcome,
  amountEur,
  request,
}: {
  uid?: string;
  role?: string;
  reason?: string;
  outcome?: string;
  amountEur?: number;
  request?: any;
}) {
  await logServerEvent({
    uid,
    role,
    name: eventName,
    props: {
      ...(reason && { disputeReason: reason }),
      ...(outcome && { disputeOutcome: outcome }),
      ...(amountEur && { amountEur }),
    },
    request,
  });
}

export async function logTransferEvent({
  uid,
  role,
  amountNet,
  request,
}: {
  uid?: string;
  role?: string;
  amountNet: number;
  request?: any;
}) {
  await logServerEvent({
    uid,
    role,
    name: 'transfer_created',
    props: { amountNet },
    request,
  });
}

export async function logAdminEvent(eventName: string, {
  uid,
  flag,
  exportKind,
  request,
}: {
  uid?: string;
  flag?: string;
  exportKind?: string;
  request?: any;
}) {
  await logServerEvent({
    uid,
    role: 'admin',
    name: eventName,
    props: {
      ...(flag && { adminFlag: flag }),
      ...(exportKind && { exportKind }),
    },
    request,
  });
}

export async function logPushEvent(eventName: string, {
  uid,
  role,
  pushType,
  request,
}: {
  uid?: string;
  role?: string;
  pushType?: string;
  request?: any;
}) {
  await logServerEvent({
    uid,
    role,
    name: eventName,
    props: { ...(pushType && { pushType }) },
    request,
  });
}