"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewDocument = reviewDocument;
exports.getPendingDocuments = getPendingDocuments;
exports.getDocumentStats = getDocumentStats;
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const firestore_2 = require("./firestore");
const auth_1 = require("./auth");
async function reviewDocument(request) {
    const { auth, data } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    if (!data || !data.documentId || !data.status) {
        throw new https_1.HttpsError('invalid-argument', 'Missing required fields');
    }
    const { documentId, status, rejectionReason } = data;
    if (!['approved', 'rejected'].includes(status)) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid status. Must be approved or rejected');
    }
    if (status === 'rejected' && (!rejectionReason || rejectionReason.trim().length === 0)) {
        throw new https_1.HttpsError('invalid-argument', 'Rejection reason is required when rejecting documents');
    }
    try {
        const db = (0, firestore_2.getDb)();
        const docRef = db.collection('documents').doc(documentId);
        const docSnapshot = await docRef.get();
        if (!docSnapshot.exists) {
            throw new https_1.HttpsError('not-found', 'Document not found');
        }
        const documentData = docSnapshot.data();
        const updateData = {
            status: status,
            reviewedAt: firestore_1.FieldValue.serverTimestamp(),
            reviewerUid: auth === null || auth === void 0 ? void 0 : auth.uid,
        };
        if (status === 'rejected' && rejectionReason) {
            updateData.rejectionReason = rejectionReason.trim();
        }
        else if (status === 'approved') {
            updateData.rejectionReason = firestore_1.FieldValue.delete();
            updateData.approvedAt = firestore_1.FieldValue.serverTimestamp();
        }
        await docRef.update(updateData);
        if (status === 'approved') {
            await updateProVerificationStatus(documentData.proUid);
        }
        console.log(`Document ${documentId} ${status} by admin ${auth === null || auth === void 0 ? void 0 : auth.uid}`);
        return { success: true };
    }
    catch (error) {
        console.error('Error reviewing document:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to review document');
    }
}
async function getPendingDocuments(request) {
    const { auth } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    try {
        const db = (0, firestore_2.getDb)();
        const snapshot = await db.collection('documents')
            .where('status', '==', 'reviewing')
            .orderBy('uploadedAt', 'asc')
            .limit(50)
            .get();
        const documents = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
        }));
        return { documents };
    }
    catch (error) {
        console.error('Error fetching pending documents:', error);
        throw new https_1.HttpsError('internal', 'Failed to fetch pending documents');
    }
}
async function getDocumentStats(request) {
    const { auth } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    try {
        const db = (0, firestore_2.getDb)();
        const [totalSnapshot, pendingSnapshot, approvedSnapshot, rejectedSnapshot] = await Promise.all([
            db.collection('documents').count().get(),
            db.collection('documents').where('status', '==', 'reviewing').count().get(),
            db.collection('documents').where('status', '==', 'approved').count().get(),
            db.collection('documents').where('status', '==', 'rejected').count().get(),
        ]);
        const totalDocuments = totalSnapshot.data().count;
        const pendingReview = pendingSnapshot.data().count;
        const approved = approvedSnapshot.data().count;
        const rejected = rejectedSnapshot.data().count;
        let avgReviewTime = 0;
        if (approved > 0) {
            const reviewedDocs = await db.collection('documents')
                .where('status', '==', 'approved')
                .where('reviewedAt', '!=', null)
                .limit(100)
                .get();
            let totalReviewTime = 0;
            let reviewedCount = 0;
            reviewedDocs.docs.forEach((doc) => {
                const data = doc.data();
                if (data.uploadedAt && data.reviewedAt) {
                    const uploadTime = data.uploadedAt.toMillis();
                    const reviewTime = data.reviewedAt.toMillis();
                    totalReviewTime += (reviewTime - uploadTime);
                    reviewedCount++;
                }
            });
            if (reviewedCount > 0) {
                avgReviewTime = totalReviewTime / reviewedCount / (1000 * 60 * 60);
            }
        }
        return {
            totalDocuments,
            pendingReview,
            approved,
            rejected,
            avgReviewTime: Math.round(avgReviewTime * 100) / 100,
        };
    }
    catch (error) {
        console.error('Error fetching document stats:', error);
        throw new https_1.HttpsError('internal', 'Failed to fetch document statistics');
    }
}
async function updateProVerificationStatus(proUid) {
    try {
        const db = (0, firestore_2.getDb)();
        const approvedDocsSnapshot = await db.collection('documents')
            .where('proUid', '==', proUid)
            .where('status', '==', 'approved')
            .get();
        const approvedTypes = new Set(approvedDocsSnapshot.docs.map((doc) => doc.data().type));
        const requiredTypes = ['idCard', 'criminalRecord', 'insuranceCertificate'];
        const isFullyVerified = requiredTypes.every(type => approvedTypes.has(type));
        const proProfileRef = db.collection('proProfiles').doc(proUid);
        await proProfileRef.update({
            isVerified: isFullyVerified,
            lastVerificationCheck: firestore_1.FieldValue.serverTimestamp(),
            verifiedDocuments: Array.from(approvedTypes),
        });
        console.log(`Updated verification status for Pro ${proUid}: ${isFullyVerified ? 'fully verified' : 'partially verified'}`);
    }
    catch (error) {
        console.error('Error updating Pro verification status:', error);
    }
}
//# sourceMappingURL=documents.js.map