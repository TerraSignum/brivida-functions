"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishLegalDoc = publishLegalDoc;
exports.getLegalDoc = getLegalDoc;
exports.setUserConsent = setUserConsent;
exports.getUserConsent = getUserConsent;
exports.getLegalStats = getLegalStats;
exports.updateLegalVersions = updateLegalVersions;
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const firestore_2 = require("./firestore");
const auth_1 = require("./auth");
const v2_1 = require("firebase-functions/v2");
async function publishLegalDoc(request) {
    const { data, auth } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    const { type, version, language, content, title, htmlContent } = data;
    if (!type || !version || !language || !content || !title) {
        throw new https_1.HttpsError('invalid-argument', 'Missing required fields: type, version, language, content, title');
    }
    if (!/^v\d+\.\d+(\.\d+)?$/.test(version)) {
        throw new https_1.HttpsError('invalid-argument', 'Version must be in semantic format (e.g., v1.0, v1.1)');
    }
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Publishing legal document', { type, version, language, title });
        const db = (0, firestore_2.getDb)();
        const existingDoc = await db
            .collection('legalDocs')
            .where('type', '==', type)
            .where('version', '==', version)
            .where('language', '==', language)
            .get();
        if (!existingDoc.empty) {
            throw new https_1.HttpsError('already-exists', `Legal document ${type} v${version} in ${language} already exists`);
        }
        const docData = {
            type,
            version,
            language,
            content,
            title,
            htmlContent: htmlContent || null,
            publishedAt: firestore_1.FieldValue.serverTimestamp(),
            publishedBy: auth.uid,
            isActive: true,
        };
        const docRef = db.collection('legalDocs').doc();
        await docRef.set(docData);
        v2_1.logger.info('✅ Legal document published successfully', {
            docId: docRef.id,
            type,
            version,
            language,
            publishedBy: auth.uid,
        });
        return {
            success: true,
            docId: docRef.id,
            version,
            publishedAt: new Date().toISOString(),
        };
    }
    catch (error) {
        v2_1.logger.error('❌ Error publishing legal document:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to publish legal document');
    }
}
async function getLegalDoc(request) {
    var _a, _b, _c;
    const { data } = request;
    const { type, language, version } = data;
    if (!type || !language) {
        throw new https_1.HttpsError('invalid-argument', 'Missing required fields: type, language');
    }
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Getting legal document', { type, language, version });
        const db = (0, firestore_2.getDb)();
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
            throw new https_1.HttpsError('not-found', `Legal document ${type} in ${language}${versionText} not found`);
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
                publishedAt: ((_c = (_b = (_a = docData.publishedAt) === null || _a === void 0 ? void 0 : _a.toDate) === null || _b === void 0 ? void 0 : _b.call(_a)) === null || _c === void 0 ? void 0 : _c.toISOString()) || null,
            },
        };
    }
    catch (error) {
        v2_1.logger.error('❌ Error getting legal document:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to get legal document');
    }
}
async function setUserConsent(request) {
    const { data, auth } = request;
    if (!(auth === null || auth === void 0 ? void 0 : auth.uid)) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { tosVersion, privacyVersion, consentedIp, consentedLang } = data;
    if (!tosVersion || !privacyVersion || !consentedIp || !consentedLang) {
        throw new https_1.HttpsError('invalid-argument', 'Missing required fields: tosVersion, privacyVersion, consentedIp, consentedLang');
    }
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Setting user consent', {
            userId: auth.uid,
            tosVersion,
            privacyVersion,
            consentedLang,
            ip: consentedIp
        });
        const db = (0, firestore_2.getDb)();
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
            throw new https_1.HttpsError('not-found', `Terms of Service version ${tosVersion} in ${consentedLang} not found`);
        }
        if (privacyDoc.empty) {
            throw new https_1.HttpsError('not-found', `Privacy Policy version ${privacyVersion} in ${consentedLang} not found`);
        }
        const consentData = {
            userId: auth.uid,
            tosVersion,
            privacyVersion,
            consentedAt: firestore_1.FieldValue.serverTimestamp(),
            consentedIp,
            consentedLang,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        };
        const consentRef = db.collection('userConsents').doc(auth.uid);
        await consentRef.set(consentData, { merge: true });
        v2_1.logger.info('✅ User consent recorded successfully', {
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
    }
    catch (error) {
        v2_1.logger.error('❌ Error setting user consent:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to set user consent');
    }
}
async function getUserConsent(request) {
    var _a, _b, _c, _d, _e, _f;
    const { data, auth } = request;
    if (!(auth === null || auth === void 0 ? void 0 : auth.uid)) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const targetUserId = (data === null || data === void 0 ? void 0 : data.userId) || auth.uid;
    if (targetUserId !== auth.uid) {
        await (0, auth_1.enforceAdminRole)(auth);
    }
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Getting user consent', { targetUserId, requesterId: auth.uid });
        const db = (0, firestore_2.getDb)();
        const consentDoc = await db.collection('userConsents').doc(targetUserId).get();
        if (!consentDoc.exists) {
            return {
                success: true,
                hasConsent: false,
                consent: null,
            };
        }
        const consentData = consentDoc.data();
        return {
            success: true,
            hasConsent: true,
            consent: {
                userId: consentData.userId,
                tosVersion: consentData.tosVersion,
                privacyVersion: consentData.privacyVersion,
                consentedAt: ((_c = (_b = (_a = consentData.consentedAt) === null || _a === void 0 ? void 0 : _a.toDate) === null || _b === void 0 ? void 0 : _b.call(_a)) === null || _c === void 0 ? void 0 : _c.toISOString()) || null,
                consentedIp: consentData.consentedIp,
                consentedLang: consentData.consentedLang,
                updatedAt: ((_f = (_e = (_d = consentData.updatedAt) === null || _d === void 0 ? void 0 : _d.toDate) === null || _e === void 0 ? void 0 : _e.call(_d)) === null || _f === void 0 ? void 0 : _f.toISOString()) || null,
            },
        };
    }
    catch (error) {
        v2_1.logger.error('❌ Error getting user consent:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to get user consent');
    }
}
async function getLegalStats(request) {
    const { data, auth } = request;
    if (!(auth === null || auth === void 0 ? void 0 : auth.uid)) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    await (0, auth_1.enforceAdminRole)(auth);
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Getting legal statistics', { requesterId: auth.uid });
        const db = (0, firestore_2.getDb)();
        const usersSnapshot = await db.collection('users').count().get();
        const totalUsers = usersSnapshot.data().count;
        const consentsSnapshot = await db.collection('userConsents').count().get();
        const usersWithConsent = consentsSnapshot.data().count;
        const language = (data === null || data === void 0 ? void 0 : data.language) || 'de';
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
    }
    catch (error) {
        v2_1.logger.error('❌ Error getting legal statistics:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to get legal statistics');
    }
}
async function updateLegalVersions(request) {
    const { auth, data } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    if (!(data === null || data === void 0 ? void 0 : data.versions)) {
        throw new https_1.HttpsError('invalid-argument', 'versions object is required');
    }
    const db = (0, firestore_2.getDb)();
    try {
        const validTypes = ['terms', 'privacy', 'refund', 'guidelines'];
        const updates = {};
        for (const [type, version] of Object.entries(data.versions)) {
            if (!validTypes.includes(type)) {
                throw new https_1.HttpsError('invalid-argument', `Invalid document type: ${type}`);
            }
            if (typeof version !== 'string' || !version.trim()) {
                throw new https_1.HttpsError('invalid-argument', `Invalid version for ${type}: ${version}`);
            }
            updates[`${type}Version`] = version.trim();
        }
        await db.collection('config').doc('legalVersions').set({
            ...updates,
            lastUpdated: firestore_1.FieldValue.serverTimestamp(),
            updatedBy: auth === null || auth === void 0 ? void 0 : auth.uid,
        }, { merge: true });
        v2_1.logger.info(`Legal versions updated by admin ${auth === null || auth === void 0 ? void 0 : auth.uid}`, { updates });
        return { success: true };
    }
    catch (error) {
        v2_1.logger.error('Error updating legal versions:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to update legal versions');
    }
}
//# sourceMappingURL=legal.js.map