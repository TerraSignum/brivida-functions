import { FieldValue } from 'firebase-admin/firestore';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { getDb } from './firestore';
import { enforceAdminRole } from './auth';
import { logger } from 'firebase-functions/v2';

// Legal document types
export type LegalDocumentType = 'terms' | 'privacy' | 'impressum' | 'guidelines' | 'refund';
export type SupportedLanguage = 'de' | 'en' | 'pt' | 'es' | 'fr';

// Request interfaces
interface PublishLegalDocData {
  type: LegalDocumentType;
  version: string;
  language: SupportedLanguage;
  content: string;
  title: string;
  htmlContent?: string;
}

interface SetUserConsentData {
  tosVersion: string;
  privacyVersion: string;
  consentedIp: string;
  consentedLang: SupportedLanguage;
}

interface GetLegalDocData {
  type: LegalDocumentType;
  language: SupportedLanguage;
  version?: string;
}

/**
 * Publish a new legal document version (admin only)
 */
export async function publishLegalDoc(request: CallableRequest<PublishLegalDocData>) {
  const { data, auth } = request;
  
  // Enforce admin role
  await enforceAdminRole(auth);

  const { type, version, language, content, title, htmlContent } = data;

  if (!type || !version || !language || !content || !title) {
    throw new HttpsError('invalid-argument', 'Missing required fields: type, version, language, content, title');
  }

  // Validate version format (should be semantic: v1.0, v1.1, etc.)
  if (!/^v\d+\.\d+(\.\d+)?$/.test(version)) {
    throw new HttpsError('invalid-argument', 'Version must be in semantic format (e.g., v1.0, v1.1)');
  }

  try {
    logger.info('🔥 FUNCTIONS: Publishing legal document', { type, version, language, title });

    const db = getDb();
    
    // Check if this version already exists
    const existingDoc = await db
      .collection('legalDocs')
      .where('type', '==', type)
      .where('version', '==', version)
      .where('language', '==', language)
      .get();

    if (!existingDoc.empty) {
      throw new HttpsError('already-exists', `Legal document ${type} v${version} in ${language} already exists`);
    }

    // Create the document
    const docData = {
      type,
      version,
      language,
      content,
      title,
      htmlContent: htmlContent || null,
      publishedAt: FieldValue.serverTimestamp(),
      publishedBy: auth!.uid,
      isActive: true,
    };

    const docRef = db.collection('legalDocs').doc();
    await docRef.set(docData);

    // Log admin action
    logger.info('✅ Legal document published successfully', {
      docId: docRef.id,
      type,
      version,
      language,
      publishedBy: auth!.uid,
    });

    return {
      success: true,
      docId: docRef.id,
      version,
      publishedAt: new Date().toISOString(),
    };

  } catch (error) {
    logger.error('❌ Error publishing legal document:', error);
    
    if (error instanceof HttpsError) {
      throw error;
    }
    
    throw new HttpsError('internal', 'Failed to publish legal document');
  }
}

/**
 * Get a legal document (public read access)
 */
export async function getLegalDoc(request: CallableRequest<GetLegalDocData>) {
  const { data } = request;
  
  const { type, language, version } = data;

  if (!type || !language) {
    throw new HttpsError('invalid-argument', 'Missing required fields: type, language');
  }

  try {
    logger.info('🔥 FUNCTIONS: Getting legal document', { type, language, version });

    const db = getDb();
    
    let query = db
      .collection('legalDocs')
      .where('type', '==', type)
      .where('language', '==', language)
      .where('isActive', '==', true);

    if (version) {
      query = query.where('version', '==', version);
    }

    const docs = await query.orderBy('publishedAt', 'desc').limit(1).get();

    if (docs.empty) {
      const versionText = version ? ` v${version}` : '';
      throw new HttpsError('not-found', `Legal document ${type} in ${language}${versionText} not found`);
    }

    const doc = docs.docs[0];
    const docData = doc.data();

    return {
      success: true,
      document: {
        id: doc.id,
        type: docData.type,
        version: docData.version,
        language: docData.language,
        content: docData.content,
        title: docData.title,
        htmlContent: docData.htmlContent,
        publishedAt: docData.publishedAt?.toDate?.()?.toISOString() || null,
      },
    };

  } catch (error) {
    logger.error('❌ Error getting legal document:', error);
    
    if (error instanceof HttpsError) {
      throw error;
    }
    
    throw new HttpsError('internal', 'Failed to get legal document');
  }
}

/**
 * Set user consent (authenticated users only)
 */
export async function setUserConsent(request: CallableRequest<SetUserConsentData>) {
  const { data, auth } = request;
  
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { tosVersion, privacyVersion, consentedIp, consentedLang } = data;

  if (!tosVersion || !privacyVersion || !consentedIp || !consentedLang) {
    throw new HttpsError('invalid-argument', 'Missing required fields: tosVersion, privacyVersion, consentedIp, consentedLang');
  }

  try {
    logger.info('🔥 FUNCTIONS: Setting user consent', { 
      userId: auth.uid, 
      tosVersion, 
      privacyVersion, 
      consentedLang,
      ip: consentedIp 
    });

    const db = getDb();
    
    // Verify the TOS and Privacy versions exist
    const [tosDoc, privacyDoc] = await Promise.all([
      db.collection('legalDocs')
        .where('type', '==', 'terms')
        .where('version', '==', tosVersion)
        .where('language', '==', consentedLang)
        .where('isActive', '==', true)
        .get(),
      db.collection('legalDocs')
        .where('type', '==', 'privacy')
        .where('version', '==', privacyVersion)
        .where('language', '==', consentedLang)
        .where('isActive', '==', true)
        .get()
    ]);

    if (tosDoc.empty) {
      throw new HttpsError('not-found', `Terms of Service version ${tosVersion} in ${consentedLang} not found`);
    }

    if (privacyDoc.empty) {
      throw new HttpsError('not-found', `Privacy Policy version ${privacyVersion} in ${consentedLang} not found`);
    }

    // Create or update user consent
    const consentData = {
      userId: auth.uid,
      tosVersion,
      privacyVersion,
      consentedAt: FieldValue.serverTimestamp(),
      consentedIp,
      consentedLang,
      updatedAt: FieldValue.serverTimestamp(),
    };

    const consentRef = db.collection('userConsents').doc(auth.uid);
    await consentRef.set(consentData, { merge: true });

    // Log consent action with audit trail
    logger.info('✅ User consent recorded successfully', {
      userId: auth.uid,
      tosVersion,
      privacyVersion,
      consentedLang,
      timestamp: new Date().toISOString(),
    });

    return {
      success: true,
      userId: auth.uid,
      tosVersion,
      privacyVersion,
      consentedAt: new Date().toISOString(),
    };

  } catch (error) {
    logger.error('❌ Error setting user consent:', error);
    
    if (error instanceof HttpsError) {
      throw error;
    }
    
    throw new HttpsError('internal', 'Failed to set user consent');
  }
}

/**
 * Get user consent status (authenticated users for their own data only)
 */
export async function getUserConsent(request: CallableRequest<{ userId?: string }>) {
  const { data, auth } = request;
  
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  // Allow users to get their own consent, or admins to get any user's consent
  const targetUserId = data?.userId || auth.uid;
  
  if (targetUserId !== auth.uid) {
    // Check if requesting user is admin
    await enforceAdminRole(auth);
  }

  try {
    logger.info('🔥 FUNCTIONS: Getting user consent', { targetUserId, requesterId: auth.uid });

    const db = getDb();
    
    const consentDoc = await db.collection('userConsents').doc(targetUserId).get();

    if (!consentDoc.exists) {
      return {
        success: true,
        hasConsent: false,
        consent: null,
      };
    }

    const consentData = consentDoc.data()!;

    return {
      success: true,
      hasConsent: true,
      consent: {
        userId: consentData.userId,
        tosVersion: consentData.tosVersion,
        privacyVersion: consentData.privacyVersion,
        consentedAt: consentData.consentedAt?.toDate?.()?.toISOString() || null,
        consentedIp: consentData.consentedIp,
        consentedLang: consentData.consentedLang,
        updatedAt: consentData.updatedAt?.toDate?.()?.toISOString() || null,
      },
    };

  } catch (error) {
    logger.error('❌ Error getting user consent:', error);
    
    if (error instanceof HttpsError) {
      throw error;
    }
    
    throw new HttpsError('internal', 'Failed to get user consent');
  }
}

/**
 * Get legal compliance statistics (admin only)
 */
export async function getLegalStats(request: CallableRequest<{ language?: SupportedLanguage }>) {
  const { data, auth } = request;
  
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  // Require admin auth
  await enforceAdminRole(auth);

  try {
    logger.info('🔥 FUNCTIONS: Getting legal statistics', { requesterId: auth.uid });

    const db = getDb();
    
    // Get total user counts
    const usersSnapshot = await db.collection('users').count().get();
    const totalUsers = usersSnapshot.data().count;

    // Get users with consent
    const consentsSnapshot = await db.collection('userConsents').count().get();
    const usersWithConsent = consentsSnapshot.data().count;

    // Get latest document versions by language
    const language = data?.language || 'de';
    
    const [latestTos, latestPrivacy] = await Promise.all([
      db.collection('legalDocs')
        .where('type', '==', 'terms')
        .where('language', '==', language)
        .where('isActive', '==', true)
        .orderBy('publishedAt', 'desc')
        .limit(1)
        .get(),
      db.collection('legalDocs')
        .where('type', '==', 'privacy')
        .where('language', '==', language)
        .where('isActive', '==', true)
        .orderBy('publishedAt', 'desc')
        .limit(1)
        .get()
    ]);

    const latestTosVersion = latestTos.empty ? null : latestTos.docs[0].data().version;
    const latestPrivacyVersion = latestPrivacy.empty ? null : latestPrivacy.docs[0].data().version;

    // Get users consented to latest versions
    let currentTosConsents = 0;
    let currentPrivacyConsents = 0;

    if (latestTosVersion && latestPrivacyVersion) {
      const [tosConsents, privacyConsents] = await Promise.all([
        db.collection('userConsents')
          .where('tosVersion', '==', latestTosVersion)
          .count()
          .get(),
        db.collection('userConsents')
          .where('privacyVersion', '==', latestPrivacyVersion)
          .count()
          .get()
      ]);

      currentTosConsents = tosConsents.data().count;
      currentPrivacyConsents = privacyConsents.data().count;
    }

    const stats = {
      totalUsers,
      usersWithConsent,
      complianceRate: totalUsers > 0 ? (usersWithConsent / totalUsers * 100).toFixed(2) : '0.00',
      latestVersions: {
        tos: latestTosVersion,
        privacy: latestPrivacyVersion,
      },
      currentVersionConsents: {
        tos: currentTosConsents,
        privacy: currentPrivacyConsents,
      },
      language,
      generatedAt: new Date().toISOString(),
    };

    return {
      success: true,
      stats,
    };

  } catch (error) {
    logger.error('❌ Error getting legal statistics:', error);
    
    if (error instanceof HttpsError) {
      throw error;
    }
    
    throw new HttpsError('internal', 'Failed to get legal statistics');
  }
}

/**
 * Admin-only function to update legal document versions
 */
export async function updateLegalVersions(request: CallableRequest<{ 
  versions: Record<string, string> 
}>): Promise<{ success: boolean }> {
  const { auth, data } = request;
  
  // Enforce admin role
  await enforceAdminRole(auth);
  
  if (!data?.versions) {
    throw new HttpsError('invalid-argument', 'versions object is required');
  }

  const db = getDb();

  try {
    const validTypes = ['terms', 'privacy', 'refund', 'guidelines'];
    const updates: Record<string, string> = {};

    // Validate and prepare updates
    for (const [type, version] of Object.entries(data.versions)) {
      if (!validTypes.includes(type)) {
        throw new HttpsError('invalid-argument', `Invalid document type: ${type}`);
      }
      if (typeof version !== 'string' || !version.trim()) {
        throw new HttpsError('invalid-argument', `Invalid version for ${type}: ${version}`);
      }
      updates[`${type}Version`] = version.trim();
    }

    // Update versions in config
    await db.collection('config').doc('legalVersions').set({
      ...updates,
      lastUpdated: FieldValue.serverTimestamp(),
      updatedBy: auth?.uid,
    }, { merge: true });

    logger.info(`Legal versions updated by admin ${auth?.uid}`, { updates });

    return { success: true };
  } catch (error) {
    logger.error('Error updating legal versions:', error);
    
    if (error instanceof HttpsError) {
      throw error;
    }
    
    throw new HttpsError('internal', 'Failed to update legal versions');
  }
}