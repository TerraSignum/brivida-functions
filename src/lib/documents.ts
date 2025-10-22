/**
 * PG-17: Document verification Cloud Functions
 * Handles document uploads, reviews, and verification workflows
 */

import { FieldValue, QueryDocumentSnapshot, DocumentData } from 'firebase-admin/firestore';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

import { getDb } from './firestore';
import { enforceAdminRole } from './auth';

export interface ReviewDocumentRequest {
  documentId: string;
  status: 'approved' | 'rejected';
  rejectionReason?: string;
}

/**
 * Admin-only function to review and approve/reject uploaded documents
 */
export async function reviewDocument(request: CallableRequest<ReviewDocumentRequest>): Promise<{ success: boolean }> {
  const { auth, data } = request;
  
  // Enforce admin role
  await enforceAdminRole(auth);
  
  if (!data || !data.documentId || !data.status) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const { documentId, status, rejectionReason } = data;

  if (!['approved', 'rejected'].includes(status)) {
    throw new HttpsError('invalid-argument', 'Invalid status. Must be approved or rejected');
  }

  if (status === 'rejected' && (!rejectionReason || rejectionReason.trim().length === 0)) {
    throw new HttpsError('invalid-argument', 'Rejection reason is required when rejecting documents');
  }

  try {
    const db = getDb();
    const docRef = db.collection('documents').doc(documentId);
    const docSnapshot = await docRef.get();
    
    if (!docSnapshot.exists) {
      throw new HttpsError('not-found', 'Document not found');
    }

    const documentData = docSnapshot.data()!;
    
    // Prepare update data
    const updateData: any = {
      status: status,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewerUid: auth?.uid,
    };

    if (status === 'rejected' && rejectionReason) {
      updateData.rejectionReason = rejectionReason.trim();
    } else if (status === 'approved') {
      // Clear any previous rejection reason
      updateData.rejectionReason = FieldValue.delete();
      updateData.approvedAt = FieldValue.serverTimestamp();
    }

    // Update document status
    await docRef.update(updateData);

    // Update Pro profile verification status if needed
    if (status === 'approved') {
      await updateProVerificationStatus(documentData.proUid);
    }

    console.log(`Document ${documentId} ${status} by admin ${auth?.uid}`);
    
    return { success: true };
  } catch (error) {
    console.error('Error reviewing document:', error);
    
    if (error instanceof HttpsError) {
      throw error;
    }
    
    throw new HttpsError('internal', 'Failed to review document');
  }
}

/**
 * Get documents pending review for admin dashboard
 */
export async function getPendingDocuments(request: CallableRequest): Promise<{ documents: any[] }> {
  const { auth } = request;
  
  // Enforce admin role
  await enforceAdminRole(auth);
  
  try {
    const db = getDb();
    const snapshot = await db.collection('documents')
      .where('status', '==', 'reviewing')
      .orderBy('uploadedAt', 'asc')
      .limit(50)
      .get();

  const documents = snapshot.docs.map((doc: QueryDocumentSnapshot<DocumentData>) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return { documents };
  } catch (error) {
    console.error('Error fetching pending documents:', error);
    throw new HttpsError('internal', 'Failed to fetch pending documents');
  }
}

/**
 * Get document review statistics for admin analytics
 */
export async function getDocumentStats(request: CallableRequest): Promise<{
  totalDocuments: number;
  pendingReview: number;
  approved: number;
  rejected: number;
  avgReviewTime: number;
}> {
  const { auth } = request;
  
  // Enforce admin role
  await enforceAdminRole(auth);
  
  try {
    const db = getDb();
    // Get document counts by status
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

    // Calculate average review time (approved docs only)
    let avgReviewTime = 0;
    if (approved > 0) {
      const reviewedDocs = await db.collection('documents')
        .where('status', '==', 'approved')
        .where('reviewedAt', '!=', null)
        .limit(100)
        .get();

      let totalReviewTime = 0;
      let reviewedCount = 0;

  reviewedDocs.docs.forEach((doc: QueryDocumentSnapshot<DocumentData>) => {
        const data = doc.data();
        if (data.uploadedAt && data.reviewedAt) {
          const uploadTime = data.uploadedAt.toMillis();
          const reviewTime = data.reviewedAt.toMillis();
          totalReviewTime += (reviewTime - uploadTime);
          reviewedCount++;
        }
      });

      if (reviewedCount > 0) {
        avgReviewTime = totalReviewTime / reviewedCount / (1000 * 60 * 60); // Convert to hours
      }
    }

    return {
      totalDocuments,
      pendingReview,
      approved,
      rejected,
      avgReviewTime: Math.round(avgReviewTime * 100) / 100, // Round to 2 decimal places
    };
  } catch (error) {
    console.error('Error fetching document stats:', error);
    throw new HttpsError('internal', 'Failed to fetch document statistics');
  }
}

/**
 * Helper function to update Pro verification status based on approved documents
 */
async function updateProVerificationStatus(proUid: string): Promise<void> {
  try {
    const db = getDb();
    // Get all approved documents for this Pro
    const approvedDocsSnapshot = await db.collection('documents')
      .where('proUid', '==', proUid)
      .where('status', '==', 'approved')
      .get();

    const approvedTypes = new Set(
      approvedDocsSnapshot.docs.map((doc: QueryDocumentSnapshot<DocumentData>) => doc.data().type)
    );
    
    // Required document types for full verification
    const requiredTypes = ['idCard', 'criminalRecord', 'insuranceCertificate'];
    
    const isFullyVerified = requiredTypes.every(type => approvedTypes.has(type));
    
    // Update Pro profile verification status
    const proProfileRef = db.collection('proProfiles').doc(proUid);
    await proProfileRef.update({
      isVerified: isFullyVerified,
      lastVerificationCheck: FieldValue.serverTimestamp(),
      verifiedDocuments: Array.from(approvedTypes),
    });

    console.log(`Updated verification status for Pro ${proUid}: ${isFullyVerified ? 'fully verified' : 'partially verified'}`);
  } catch (error) {
    console.error('Error updating Pro verification status:', error);
    // Don't throw here as this is a secondary operation
  }
}