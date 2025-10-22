"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewsService = void 0;
const firestore_1 = require("firebase-admin/firestore");
const v2_1 = require("firebase-functions/v2");
const auth_1 = require("./auth");
exports.reviewsService = {
    async submitReview(params) {
        const db = (0, firestore_1.getFirestore)();
        const { request, userId } = params;
        const { jobId, paymentId, rating, comment } = request;
        v2_1.logger.info('Submitting review', { jobId, paymentId, rating, userId });
        if (!jobId || !paymentId || !rating || rating < 1 || rating > 5) {
            throw new Error('Invalid review data');
        }
        if (comment.length > 500) {
            throw new Error('Comment too long (max 500 characters)');
        }
        return await db.runTransaction(async (transaction) => {
            const jobRef = db.collection('jobs').doc(jobId);
            const jobDoc = await transaction.get(jobRef);
            if (!jobDoc.exists) {
                throw new Error('Job not found');
            }
            const jobData = jobDoc.data();
            if (jobData.customerUid !== userId) {
                throw new Error('Job does not belong to user');
            }
            if (jobData.status !== 'completed') {
                throw new Error('Job must be completed to leave a review');
            }
            const proUid = jobData.proUid;
            const paymentRef = db.collection('payments').doc(paymentId);
            const paymentDoc = await transaction.get(paymentRef);
            if (!paymentDoc.exists) {
                throw new Error('Payment not found');
            }
            const paymentData = paymentDoc.data();
            if (paymentData.jobId !== jobId) {
                throw new Error('Payment does not match job');
            }
            if (paymentData.status !== 'completed') {
                throw new Error('Payment must be completed to leave a review');
            }
            const existingReviews = await db.collection('reviews')
                .where('jobId', '==', jobId)
                .where('customerUid', '==', userId)
                .limit(1)
                .get();
            if (!existingReviews.empty) {
                throw new Error('Review already exists for this job');
            }
            const customerRef = db.collection('users').doc(userId);
            const customerDoc = await transaction.get(customerRef);
            const customerData = customerDoc.data() || {};
            const customerDisplayName = customerData.displayName;
            const customerInitials = generateInitials(customerDisplayName);
            const reviewRef = db.collection('reviews').doc();
            const reviewData = {
                jobId,
                paymentId,
                customerUid: userId,
                proUid,
                rating,
                comment: comment.trim(),
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                moderation: {
                    status: 'visible',
                    updatedAt: firestore_1.FieldValue.serverTimestamp(),
                },
                customerDisplayName,
                customerInitials,
            };
            transaction.set(reviewRef, reviewData);
            const proProfileRef = db.collection('proProfiles').doc(proUid);
            const proProfileDoc = await transaction.get(proProfileRef);
            if (proProfileDoc.exists) {
                const proData = proProfileDoc.data();
                const currentAggregate = proData.ratingAggregate || {
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
            await recalculateProHealthScore(transaction, proUid);
            v2_1.logger.info('Review submitted successfully', {
                reviewId: reviewRef.id,
                proUid,
                rating
            });
            return { reviewId: reviewRef.id, proUid };
        });
    },
    async moderateReview(params) {
        const db = (0, firestore_1.getFirestore)();
        const { request, adminUid, auth } = params;
        const { reviewId, action, reason } = request;
        v2_1.logger.info('Moderating review', { reviewId, action, adminUid });
        await (0, auth_1.enforceAdminRole)(auth);
        await db.runTransaction(async (transaction) => {
            var _a;
            const reviewRef = db.collection('reviews').doc(reviewId);
            const reviewDoc = await transaction.get(reviewRef);
            if (!reviewDoc.exists) {
                throw new Error('Review not found');
            }
            const reviewData = reviewDoc.data();
            const currentStatus = ((_a = reviewData.moderation) === null || _a === void 0 ? void 0 : _a.status) || 'visible';
            const proUid = reviewData.proUid;
            const rating = reviewData.rating;
            const proProfileRef = db.collection('proProfiles').doc(proUid);
            const proProfileDoc = await transaction.get(proProfileRef);
            if (proProfileDoc.exists) {
                const proData = proProfileDoc.data();
                const currentAggregate = proData.ratingAggregate || {
                    average: 0,
                    count: 0,
                    distribution: {},
                };
                let newAggregate = currentAggregate;
                if (currentStatus === 'visible' && action === 'hidden') {
                    newAggregate = removeRatingFromAggregate(currentAggregate, rating);
                }
                if (currentStatus === 'hidden' && action === 'visible') {
                    newAggregate = addRatingToAggregate(currentAggregate, rating);
                }
                transaction.update(proProfileRef, {
                    ratingAggregate: newAggregate,
                    averageRating: newAggregate.average,
                    reviewCount: newAggregate.count,
                });
            }
            transaction.update(reviewRef, {
                'moderation.status': action,
                'moderation.reason': reason || null,
                'moderation.adminUid': adminUid,
                'moderation.updatedAt': firestore_1.FieldValue.serverTimestamp(),
            });
            await recalculateProHealthScore(transaction, proUid);
            v2_1.logger.info('Review moderated successfully', { reviewId, action });
        });
    },
    async hasReviewedJob(params) {
        const db = (0, firestore_1.getFirestore)();
        const { jobId, userId } = params;
        const snapshot = await db.collection('reviews')
            .where('jobId', '==', jobId)
            .where('customerUid', '==', userId)
            .limit(1)
            .get();
        return !snapshot.empty;
    },
    async getProRatingAggregate(proUid) {
        const db = (0, firestore_1.getFirestore)();
        const proProfileDoc = await db.collection('proProfiles').doc(proUid).get();
        if (!proProfileDoc.exists) {
            return { average: 0, count: 0, distribution: {} };
        }
        const proData = proProfileDoc.data();
        return proData.ratingAggregate || { average: 0, count: 0, distribution: {} };
    },
    detectSpam(comment) {
        const reasons = [];
        const lowercaseComment = comment.toLowerCase();
        const spamKeywords = [
            'spam', 'scam', 'fake', 'bot', 'click here', 'buy now',
            'free money', 'get rich', 'work from home', 'miracle cure'
        ];
        for (const keyword of spamKeywords) {
            if (lowercaseComment.includes(keyword)) {
                reasons.push(`Contains spam keyword: ${keyword}`);
            }
        }
        const capitalLetters = comment.match(/[A-Z]/g);
        const capitalRatio = capitalLetters ? capitalLetters.length / comment.length : 0;
        if (capitalRatio > 0.7 && comment.length > 10) {
            reasons.push('Excessive capital letters');
        }
        if (/(.)\1{4,}/.test(comment)) {
            reasons.push('Excessive repeated characters');
        }
        const specialChars = comment.match(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g);
        const specialRatio = specialChars ? specialChars.length / comment.length : 0;
        if (specialRatio > 0.3) {
            reasons.push('Too many special characters');
        }
        if (/https?:\/\//.test(comment) || /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.test(comment)) {
            reasons.push('Contains URLs or email addresses');
        }
        return {
            isSpam: reasons.length > 0,
            reasons
        };
    },
    validateReview(request) {
        const errors = [];
        if (!request.rating || request.rating < 1 || request.rating > 5) {
            errors.push('Rating must be between 1 and 5');
        }
        if (request.comment && request.comment.length > 500) {
            errors.push('Comment must be 500 characters or less');
        }
        if (request.comment) {
            const spamCheck = this.detectSpam(request.comment);
            if (spamCheck.isSpam) {
                errors.push(`Potentially inappropriate content: ${spamCheck.reasons.join(', ')}`);
            }
        }
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
function generateInitials(displayName) {
    if (!displayName || displayName.trim().length === 0) {
        return null;
    }
    const words = displayName.trim().split(' ');
    if (words.length === 1) {
        return words[0][0].toUpperCase();
    }
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
function addRatingToAggregate(aggregate, rating) {
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
function removeRatingFromAggregate(aggregate, rating) {
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
async function recalculateProHealthScore(transaction, proUid) {
    const db = (0, firestore_1.getFirestore)();
    const healthRef = db.collection('healthScores').doc(proUid);
    transaction.set(healthRef, {
        lastRecalculated: firestore_1.FieldValue.serverTimestamp(),
        needsRecalc: true
    }, { merge: true });
    v2_1.logger.info('Marked health score for recalculation', { proUid });
}
//# sourceMappingURL=reviews.js.map