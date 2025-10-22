import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { enforceAdminRole } from './auth';

// Types for reviews
export interface ReviewSubmissionRequest {
  jobId: string;
  paymentId: string;
  rating: number;
  comment: string;
}

export interface ReviewModerationRequest {
  reviewId: string;
  action: 'visible' | 'hidden' | 'flagged';
  reason?: string;
}

interface RatingAggregate {
  average: number;
  count: number;
  distribution: { [key: number]: number };
}

export const reviewsService = {
  /**
   * Submit a new review for a completed job
   */
  async submitReview(params: {
    request: ReviewSubmissionRequest;
    userId: string;
  }): Promise<{ reviewId: string; proUid: string }> {
    const db = getFirestore();
    const { request, userId } = params;
    const { jobId, paymentId, rating, comment } = request;

    logger.info('Submitting review', { jobId, paymentId, rating, userId });

    // Validate input
    if (!jobId || !paymentId || !rating || rating < 1 || rating > 5) {
      throw new Error('Invalid review data');
    }

    if (comment.length > 500) {
      throw new Error('Comment too long (max 500 characters)');
    }

    // Use transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // 1. Verify job exists and belongs to customer
      const jobRef = db.collection('jobs').doc(jobId);
      const jobDoc = await transaction.get(jobRef);
      
      if (!jobDoc.exists) {
        throw new Error('Job not found');
      }

      const jobData = jobDoc.data()!;
      if (jobData.customerUid !== userId) {
        throw new Error('Job does not belong to user');
      }

      // 2. Verify job is completed
      if (jobData.status !== 'completed') {
        throw new Error('Job must be completed to leave a review');
      }

      const proUid = jobData.proUid;

      // 3. Verify payment exists and is completed
      const paymentRef = db.collection('payments').doc(paymentId);
      const paymentDoc = await transaction.get(paymentRef);
      
      if (!paymentDoc.exists) {
        throw new Error('Payment not found');
      }

      const paymentData = paymentDoc.data()!;
      if (paymentData.jobId !== jobId) {
        throw new Error('Payment does not match job');
      }

      if (paymentData.status !== 'completed') {
        throw new Error('Payment must be completed to leave a review');
      }

      // 4. Check for duplicate review
      const existingReviews = await db.collection('reviews')
        .where('jobId', '==', jobId)
        .where('customerUid', '==', userId)
        .limit(1)
        .get();

      if (!existingReviews.empty) {
        throw new Error('Review already exists for this job');
      }

      // 5. Get customer data for anonymization
      const customerRef = db.collection('users').doc(userId);
      const customerDoc = await transaction.get(customerRef);
      const customerData = customerDoc.data() || {};
      
      const customerDisplayName = customerData.displayName;
      const customerInitials = generateInitials(customerDisplayName);

      // 6. Create the review
      const reviewRef = db.collection('reviews').doc();
      const reviewData = {
        jobId,
        paymentId,
        customerUid: userId,
        proUid,
        rating,
        comment: comment.trim(),
        createdAt: FieldValue.serverTimestamp(),
        moderation: {
          status: 'visible',
          updatedAt: FieldValue.serverTimestamp(),
        },
        customerDisplayName,
        customerInitials,
      };

      transaction.set(reviewRef, reviewData);

      // 7. Update pro profile rating aggregate
      const proProfileRef = db.collection('proProfiles').doc(proUid);
      const proProfileDoc = await transaction.get(proProfileRef);
      
      if (proProfileDoc.exists) {
        const proData = proProfileDoc.data()!;
        const currentAggregate: RatingAggregate = proData.ratingAggregate || {
          average: 0,
          count: 0,
          distribution: {},
        };

        const newAggregate = addRatingToAggregate(currentAggregate, rating);
        
        transaction.update(proProfileRef, {
          ratingAggregate: newAggregate,
          averageRating: newAggregate.average,
          reviewCount: newAggregate.count,
        });
      }

      // 8. Trigger health score recalculation
      await recalculateProHealthScore(transaction, proUid);

      logger.info('Review submitted successfully', { 
        reviewId: reviewRef.id, 
        proUid,
        rating 
      });

      return { reviewId: reviewRef.id, proUid };
    });
  },

  /**
   * Moderate a review (admin only)
   */
  async moderateReview(params: {
    request: ReviewModerationRequest;
    adminUid: string;
    auth: any; // Firebase auth context
  }): Promise<void> {
    const db = getFirestore();
    const { request, adminUid, auth } = params;
    const { reviewId, action, reason } = request;

    logger.info('Moderating review', { reviewId, action, adminUid });

    // Enforce admin role via custom claims
    await enforceAdminRole(auth);

    await db.runTransaction(async (transaction) => {
      // Get the review
      const reviewRef = db.collection('reviews').doc(reviewId);
      const reviewDoc = await transaction.get(reviewRef);
      
      if (!reviewDoc.exists) {
        throw new Error('Review not found');
      }

      const reviewData = reviewDoc.data()!;
      const currentStatus = reviewData.moderation?.status || 'visible';
      const proUid = reviewData.proUid;
      const rating = reviewData.rating;

      // Update pro rating aggregate based on moderation action
      const proProfileRef = db.collection('proProfiles').doc(proUid);
      const proProfileDoc = await transaction.get(proProfileRef);
      
      if (proProfileDoc.exists) {
        const proData = proProfileDoc.data()!;
        const currentAggregate: RatingAggregate = proData.ratingAggregate || {
          average: 0,
          count: 0,
          distribution: {},
        };

        let newAggregate = currentAggregate;

        // If hiding a visible review, remove from aggregate
        if (currentStatus === 'visible' && action === 'hidden') {
          newAggregate = removeRatingFromAggregate(currentAggregate, rating);
        }
        
        // If making a hidden review visible, add back to aggregate
        if (currentStatus === 'hidden' && action === 'visible') {
          newAggregate = addRatingToAggregate(currentAggregate, rating);
        }

        transaction.update(proProfileRef, {
          ratingAggregate: newAggregate,
          averageRating: newAggregate.average,
          reviewCount: newAggregate.count,
        });
      }

      // Update review moderation
      transaction.update(reviewRef, {
        'moderation.status': action,
        'moderation.reason': reason || null,
        'moderation.adminUid': adminUid,
        'moderation.updatedAt': FieldValue.serverTimestamp(),
      });

      // Trigger health score recalculation
      await recalculateProHealthScore(transaction, proUid);

      logger.info('Review moderated successfully', { reviewId, action });
    });
  },

  /**
   * Check if user has already reviewed a job
   */
  async hasReviewedJob(params: {
    jobId: string;
    userId: string;
  }): Promise<boolean> {
    const db = getFirestore();
    const { jobId, userId } = params;

    const snapshot = await db.collection('reviews')
      .where('jobId', '==', jobId)
      .where('customerUid', '==', userId)
      .limit(1)
      .get();

    return !snapshot.empty;
  },

  /**
   * Get rating aggregate for a pro
   */
  async getProRatingAggregate(proUid: string): Promise<RatingAggregate> {
    const db = getFirestore();
    const proProfileDoc = await db.collection('proProfiles').doc(proUid).get();
    
    if (!proProfileDoc.exists) {
      return { average: 0, count: 0, distribution: {} };
    }

    const proData = proProfileDoc.data()!;
    return proData.ratingAggregate || { average: 0, count: 0, distribution: {} };
  },

  /**
   * Anti-spam content detection
   */
  detectSpam(comment: string): { isSpam: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const lowercaseComment = comment.toLowerCase();

    // Basic spam keywords
    const spamKeywords = [
      'spam', 'scam', 'fake', 'bot', 'click here', 'buy now',
      'free money', 'get rich', 'work from home', 'miracle cure'
    ];

    for (const keyword of spamKeywords) {
      if (lowercaseComment.includes(keyword)) {
        reasons.push(`Contains spam keyword: ${keyword}`);
      }
    }

    // Excessive capital letters
    const capitalLetters = comment.match(/[A-Z]/g);
    const capitalRatio = capitalLetters ? capitalLetters.length / comment.length : 0;
    if (capitalRatio > 0.7 && comment.length > 10) {
      reasons.push('Excessive capital letters');
    }

    // Repeated characters
    if (/(.)\1{4,}/.test(comment)) {
      reasons.push('Excessive repeated characters');
    }

    // Too many special characters
    const specialChars = comment.match(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g);
    const specialRatio = specialChars ? specialChars.length / comment.length : 0;
    if (specialRatio > 0.3) {
      reasons.push('Too many special characters');
    }

    // URLs or email patterns
    if (/https?:\/\//.test(comment) || /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.test(comment)) {
      reasons.push('Contains URLs or email addresses');
    }

    return {
      isSpam: reasons.length > 0,
      reasons
    };
  },

  /**
   * Validate review content
   */
  validateReview(request: ReviewSubmissionRequest): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate rating
    if (!request.rating || request.rating < 1 || request.rating > 5) {
      errors.push('Rating must be between 1 and 5');
    }

    // Validate comment length
    if (request.comment && request.comment.length > 500) {
      errors.push('Comment must be 500 characters or less');
    }

    // Check for spam
    if (request.comment) {
      const spamCheck = this.detectSpam(request.comment);
      if (spamCheck.isSpam) {
        errors.push(`Potentially inappropriate content: ${spamCheck.reasons.join(', ')}`);
      }
    }

    // Validate required fields
    if (!request.jobId) {
      errors.push('Job ID is required');
    }

    if (!request.paymentId) {
      errors.push('Payment ID is required');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
};

// Helper functions
function generateInitials(displayName?: string): string | null {
  if (!displayName || displayName.trim().length === 0) {
    return null;
  }

  const words = displayName.trim().split(' ');
  if (words.length === 1) {
    return words[0][0].toUpperCase();
  }

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function addRatingToAggregate(aggregate: RatingAggregate, rating: number): RatingAggregate {
  const newCount = aggregate.count + 1;
  const newSum = (aggregate.average * aggregate.count) + rating;
  const newAverage = newSum / newCount;

  const newDistribution = { ...aggregate.distribution };
  newDistribution[rating] = (newDistribution[rating] || 0) + 1;

  return {
    average: Number(newAverage.toFixed(2)),
    count: newCount,
    distribution: newDistribution
  };
}

function removeRatingFromAggregate(aggregate: RatingAggregate, rating: number): RatingAggregate {
  if (aggregate.count <= 1) {
    return { average: 0, count: 0, distribution: {} };
  }

  const newCount = aggregate.count - 1;
  const currentSum = aggregate.average * aggregate.count;
  const newSum = currentSum - rating;
  const newAverage = newSum / newCount;

  const newDistribution = { ...aggregate.distribution };
  if (newDistribution[rating] && newDistribution[rating] > 0) {
    newDistribution[rating] = newDistribution[rating] - 1;
    if (newDistribution[rating] === 0) {
      delete newDistribution[rating];
    }
  }

  return {
    average: Number(newAverage.toFixed(2)),
    count: newCount,
    distribution: newDistribution
  };
}

async function recalculateProHealthScore(transaction: any, proUid: string): Promise<void> {
  // This would trigger health score recalculation
  // For now, we'll implement a simple placeholder
  const db = getFirestore();
  
  const healthRef = db.collection('healthScores').doc(proUid);
  transaction.set(healthRef, {
    lastRecalculated: FieldValue.serverTimestamp(),
    needsRecalc: true
  }, { merge: true });
  
  logger.info('Marked health score for recalculation', { proUid });
}