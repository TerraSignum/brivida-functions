"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchingService = void 0;
const firestore_1 = require("firebase-admin/firestore");
const v2_1 = require("firebase-functions/v2");
const eta_1 = require("./eta");
const notifications_1 = require("./notifications");
exports.matchingService = {
    async createJobWithLeads(jobData) {
        v2_1.logger.info('🎯 MATCHING: Starting job creation with lead matching', { jobId: jobData.id });
        const db = (0, firestore_1.getFirestore)();
        try {
            await db.collection('jobs').doc(jobData.id).set({
                ...jobData,
                status: 'open',
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
                visibleTo: [jobData.customerUid],
            });
            const candidates = await this.findCandidatePros(jobData);
            const scoredCandidates = await this.scoreCandidates(jobData, candidates);
            scoredCandidates.sort((a, b) => b.score - a.score);
            const topCandidates = scoredCandidates.slice(0, 10);
            let leadsCreated = 0;
            const leadPromises = topCandidates.map(async (candidate) => {
                try {
                    const leadId = db.collection('leads').doc().id;
                    await db.collection('leads').doc(leadId).set({
                        jobId: jobData.id,
                        proUid: candidate.pro.uid,
                        customerUid: jobData.customerUid,
                        status: 'pending',
                        score: candidate.score,
                        distance: candidate.distance,
                        eta: candidate.eta,
                        reasons: candidate.reasons,
                        createdAt: firestore_1.FieldValue.serverTimestamp(),
                        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                    });
                    await notifications_1.notificationService.sendPushNotification({
                        recipientUid: candidate.pro.uid,
                        title: 'Neuer Auftrag verfügbar',
                        body: `${jobData.title} in ${jobData.location.address} - €${jobData.budget}`,
                        data: {
                            type: 'new_lead',
                            leadId,
                            jobId: jobData.id,
                        },
                    });
                    leadsCreated++;
                    v2_1.logger.info('📤 MATCHING: Lead created and notification sent', {
                        leadId,
                        proUid: candidate.pro.uid,
                        score: candidate.score
                    });
                }
                catch (error) {
                    v2_1.logger.error('❌ MATCHING: Failed to create lead', {
                        proUid: candidate.pro.uid,
                        error
                    });
                }
            });
            await Promise.allSettled(leadPromises);
            v2_1.logger.info('✅ MATCHING: Job created with leads', {
                jobId: jobData.id,
                leadsCreated,
                totalCandidates: candidates.length
            });
            return { jobId: jobData.id, leadsCreated };
        }
        catch (error) {
            v2_1.logger.error('❌ MATCHING: Error in job creation with leads', { error, jobId: jobData.id });
            throw error;
        }
    },
    async findCandidatePros(job) {
        var _a;
        v2_1.logger.info('🔍 MATCHING: Finding candidate pros', { jobLocation: job.location.address });
        const db = (0, firestore_1.getFirestore)();
        const candidates = [];
        try {
            const prosSnapshot = await db.collection('proProfiles')
                .where('isActive', '==', true)
                .where('services', 'array-contains-any', job.services)
                .get();
            for (const proDoc of prosSnapshot.docs) {
                const proData = proDoc.data();
                if (((_a = proData.flags) === null || _a === void 0 ? void 0 : _a.hardBanned) === true) {
                    v2_1.logger.debug('🚫 MATCHING: Skipping hard-banned pro', { proUid: proDoc.id });
                    continue;
                }
                const distance = this.calculateDistance(job.location.coordinates, proData.location);
                if (distance <= (proData.radius || 25)) {
                    const candidate = {
                        uid: proDoc.id,
                        radius: proData.radius || 25,
                        services: proData.services || [],
                        hourlyRate: proData.hourlyRate || 25,
                        rating: proData.rating || 0,
                        responseRate: proData.responseRate || 0,
                        profileCompleteness: proData.profileCompleteness || 0,
                        healthScore: proData.healthScore,
                        flags: proData.flags,
                        badges: proData.badges || [],
                        location: proData.location,
                        availability: proData.availability || [],
                    };
                    candidates.push(candidate);
                }
            }
            v2_1.logger.info('✅ MATCHING: Found candidates', {
                total: candidates.length,
                afterBanFilter: candidates.length
            });
            return candidates;
        }
        catch (error) {
            v2_1.logger.error('❌ MATCHING: Error finding candidates', { error });
            throw error;
        }
    },
    async scoreCandidates(job, candidates) {
        var _a;
        v2_1.logger.info('🎯 MATCHING: Scoring candidates', { candidateCount: candidates.length });
        const scoredCandidates = [];
        for (const pro of candidates) {
            try {
                const distance = this.calculateDistance(job.location.coordinates, pro.location);
                const eta = await this.calculateEtaForCandidate(pro, job, distance);
                const score = this.calculateCandidateScore(job, pro, distance, eta);
                scoredCandidates.push(score);
                v2_1.logger.debug('🎯 MATCHING: Candidate scored', {
                    proUid: pro.uid,
                    score: score.score,
                    distance: Math.round(distance * 10) / 10,
                    eta,
                    softBanned: ((_a = pro.flags) === null || _a === void 0 ? void 0 : _a.softBanned) || false,
                    reasons: score.reasons.slice(0, 3)
                });
            }
            catch (error) {
                v2_1.logger.error('❌ MATCHING: Error scoring candidate', { proUid: pro.uid, error });
            }
        }
        v2_1.logger.info('✅ MATCHING: Candidates scored', {
            total: scoredCandidates.length,
            avgScore: Math.round(scoredCandidates.reduce((sum, c) => sum + c.score, 0) / scoredCandidates.length)
        });
        return scoredCandidates;
    },
    async calculateEtaForCandidate(pro, job, distance) {
        try {
            const etaResult = await eta_1.etaService.calculateEta({
                origin: { lat: pro.location.latitude, lng: pro.location.longitude },
                destination: { lat: job.location.coordinates.latitude, lng: job.location.coordinates.longitude },
            });
            return etaResult.minutes;
        }
        catch (etaError) {
            const eta = Math.round(distance * 2);
            v2_1.logger.warn('📍 MATCHING: Using fallback ETA calculation', {
                distance,
                eta,
                error: etaError instanceof Error ? etaError.message : 'Unknown error'
            });
            return eta;
        }
    },
    calculateCandidateScore(job, pro, distance, eta) {
        var _a;
        const distanceScore = Math.max(0, 100 - (distance * 5));
        const priceScore = this.calculatePriceScore(job.budget, pro.hourlyRate, job.duration);
        const ratingScore = (pro.rating / 5) * 100;
        const responseScore = pro.responseRate * 100;
        const completenessScore = pro.profileCompleteness * 100;
        const healthScore = ((_a = pro.healthScore) === null || _a === void 0 ? void 0 : _a.score) || 50;
        const badgeBonus = this.calculateBadgeBonus(pro.badges);
        let finalScore = Math.round(0.25 * distanceScore +
            0.20 * priceScore +
            0.20 * ratingScore +
            0.15 * responseScore +
            0.10 * completenessScore +
            0.10 * healthScore) + badgeBonus;
        const { penalizedScore, banPenalty } = this.applyBanPenalties(finalScore, pro.flags);
        finalScore = penalizedScore;
        finalScore = Math.max(0, Math.min(100, finalScore));
        const reasons = this.generateScoreReasons(distance, priceScore, pro, banPenalty);
        return {
            pro,
            score: finalScore,
            distance,
            eta,
            priceMatch: priceScore / 100,
            reasons,
        };
    },
    calculateBadgeBonus(badges) {
        let badgeBonus = 0;
        if (badges.includes('verified'))
            badgeBonus += 5;
        if (badges.includes('topRated'))
            badgeBonus += 10;
        if (badges.includes('fastResponder'))
            badgeBonus += 5;
        if (badges.includes('reliable'))
            badgeBonus += 8;
        if (badges.includes('premium'))
            badgeBonus += 15;
        return badgeBonus;
    },
    applyBanPenalties(score, flags) {
        let banPenalty = '';
        let penalizedScore = score;
        if ((flags === null || flags === void 0 ? void 0 : flags.softBanned) === true) {
            penalizedScore = Math.round(score * 0.5);
            banPenalty = 'Soft ban: -50% score';
            v2_1.logger.debug('⚠️ MATCHING: Applied soft ban penalty', {
                originalScore: score,
                penalizedScore
            });
        }
        return { penalizedScore, banPenalty };
    },
    generateScoreReasons(distance, priceScore, pro, banPenalty) {
        const reasons = [];
        if (distance <= 5)
            reasons.push('Sehr nah');
        if (priceScore >= 80)
            reasons.push('Passendes Budget');
        if (pro.rating >= 4.5)
            reasons.push('Top-bewertet');
        if (pro.badges.includes('verified'))
            reasons.push('Verifiziert');
        if (banPenalty)
            reasons.push(banPenalty);
        return reasons;
    },
    calculatePriceScore(jobBudget, proHourlyRate, jobDuration) {
        const estimatedCost = proHourlyRate * jobDuration;
        const budgetRatio = jobBudget / estimatedCost;
        if (budgetRatio >= 1.2)
            return 100;
        if (budgetRatio >= 1.0)
            return 90;
        if (budgetRatio >= 0.9)
            return 70;
        if (budgetRatio >= 0.8)
            return 50;
        if (budgetRatio >= 0.7)
            return 30;
        return 10;
    },
    calculateDistance(coord1, coord2) {
        const R = 6371;
        const dLat = this.toRadians(coord2.latitude - coord1.latitude);
        const dLon = this.toRadians(coord2.longitude - coord1.longitude);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.toRadians(coord1.latitude)) * Math.cos(this.toRadians(coord2.latitude)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    },
    toRadians(degrees) {
        return degrees * (Math.PI / 180);
    },
};
//# sourceMappingURL=matching.js.map