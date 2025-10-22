import { FieldValue, getFirestore, GeoPoint } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { etaService } from './eta';
import { notificationService } from './notifications';

// ========================================
// TYPES & INTERFACES
// ========================================

interface JobData {
  id: string;
  customerUid: string;
  title: string;
  services: string[];
  location: {
    address: string;
    coordinates: GeoPoint;
  };
  preferredDate: Date;
  duration: number; // hours
  budget: number; // EUR
  status: string;
}

interface ProCandidate {
  uid: string;
  radius: number; // km
  services: string[];
  hourlyRate: number; // EUR/hour
  rating: number; // 0-5
  responseRate: number; // 0-1
  profileCompleteness: number; // 0-1
  healthScore?: {
    score: number;
    noShowRate: number;
    cancelRate: number;
    avgResponseMins: number;
    inAppRatio: number;
    ratingAvg: number;
    ratingCount: number;
  };
  flags?: {
    softBanned: boolean;
    hardBanned: boolean;
    notes?: string;
  };
  badges: string[];
  location: GeoPoint;
  availability: any[];
}

interface LeadScore {
  pro: ProCandidate;
  score: number;
  distance: number; // km
  eta: number; // minutes
  priceMatch: number; // 0-1
  reasons: string[];
}

// ========================================
// MATCHING ALGORITHM
// ========================================

export const matchingService = {
  /**
   * Create job and generate leads for suitable pros
   */
  async createJobWithLeads(jobData: JobData): Promise<{ jobId: string; leadsCreated: number }> {
    logger.info('🎯 MATCHING: Starting job creation with lead matching', { jobId: jobData.id });

    const db = getFirestore();

    try {
      // 1. Create the job document
      await db.collection('jobs').doc(jobData.id).set({
        ...jobData,
        status: 'open',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        visibleTo: [jobData.customerUid], // Initially only customer can see
      });

      // 2. Find and score suitable pros
      const candidates = await this.findCandidatePros(jobData);
      const scoredCandidates = await this.scoreCandidates(jobData, candidates);

      // 3. Create leads for top candidates
      scoredCandidates.sort((a, b) => b.score - a.score);
      const topCandidates = scoredCandidates.slice(0, 10); // Top 10 pros

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
            createdAt: FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
          });

          // Send push notification to pro
          await notificationService.sendPushNotification({
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
          logger.info('📤 MATCHING: Lead created and notification sent', { 
            leadId, 
            proUid: candidate.pro.uid,
            score: candidate.score
          });

        } catch (error) {
          logger.error('❌ MATCHING: Failed to create lead', { 
            proUid: candidate.pro.uid, 
            error 
          });
        }
      });

      await Promise.allSettled(leadPromises);

      logger.info('✅ MATCHING: Job created with leads', { 
        jobId: jobData.id, 
        leadsCreated,
        totalCandidates: candidates.length 
      });

      return { jobId: jobData.id, leadsCreated };

    } catch (error) {
      logger.error('❌ MATCHING: Error in job creation with leads', { error, jobId: jobData.id });
      throw error;
    }
  },

  /**
   * Find candidate pros based on location and services
   */
  async findCandidatePros(job: JobData): Promise<ProCandidate[]> {
    logger.info('🔍 MATCHING: Finding candidate pros', { jobLocation: job.location.address });

    const db = getFirestore();
    const candidates: ProCandidate[] = [];

    try {
      // Query pros that offer the required services
      const prosSnapshot = await db.collection('proProfiles')
        .where('isActive', '==', true)
        .where('services', 'array-contains-any', job.services)
        .get();

      for (const proDoc of prosSnapshot.docs) {
        const proData = proDoc.data();
        
        // Skip hard-banned pros immediately
        if (proData.flags?.hardBanned === true) {
          logger.debug('🚫 MATCHING: Skipping hard-banned pro', { proUid: proDoc.id });
          continue;
        }

        // Calculate distance
        const distance = this.calculateDistance(
          job.location.coordinates,
          proData.location
        );

        // Check if within pro's service radius
        if (distance <= (proData.radius || 25)) { // Default 25km radius
          const candidate: ProCandidate = {
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

      logger.info('✅ MATCHING: Found candidates', { 
        total: candidates.length,
        afterBanFilter: candidates.length
      });

      return candidates;

    } catch (error) {
      logger.error('❌ MATCHING: Error finding candidates', { error });
      throw error;
    }
  },

  /**
   * Score candidates based on multiple factors including ban status
   */
  async scoreCandidates(job: JobData, candidates: ProCandidate[]): Promise<LeadScore[]> {
    logger.info('🎯 MATCHING: Scoring candidates', { candidateCount: candidates.length });

    const scoredCandidates: LeadScore[] = [];

    for (const pro of candidates) {
      try {
        const distance = this.calculateDistance(job.location.coordinates, pro.location);
        const eta = await this.calculateEtaForCandidate(pro, job, distance);
        const score = this.calculateCandidateScore(job, pro, distance, eta);
        
        scoredCandidates.push(score);

        logger.debug('🎯 MATCHING: Candidate scored', {
          proUid: pro.uid,
          score: score.score,
          distance: Math.round(distance * 10) / 10,
          eta,
          softBanned: pro.flags?.softBanned || false,
          reasons: score.reasons.slice(0, 3) // First 3 reasons
        });

      } catch (error) {
        logger.error('❌ MATCHING: Error scoring candidate', { proUid: pro.uid, error });
      }
    }

    logger.info('✅ MATCHING: Candidates scored', { 
      total: scoredCandidates.length,
      avgScore: Math.round(scoredCandidates.reduce((sum, c) => sum + c.score, 0) / scoredCandidates.length)
    });

    return scoredCandidates;
  },

  /**
   * Calculate ETA for a candidate pro to job location
   */
  async calculateEtaForCandidate(pro: ProCandidate, job: JobData, distance: number): Promise<number> {
    try {
      const etaResult = await etaService.calculateEta({
        origin: { lat: pro.location.latitude, lng: pro.location.longitude },
        destination: { lat: job.location.coordinates.latitude, lng: job.location.coordinates.longitude },
      });
      return etaResult.minutes;
    } catch (etaError) {
      // Fallback ETA calculation
      const eta = Math.round(distance * 2); // Rough estimate: 2 minutes per km
      logger.warn('📍 MATCHING: Using fallback ETA calculation', { 
        distance, 
        eta, 
        error: etaError instanceof Error ? etaError.message : 'Unknown error'
      });
      return eta;
    }
  },

  /**
   * Calculate comprehensive score for a candidate
   */
  calculateCandidateScore(job: JobData, pro: ProCandidate, distance: number, eta: number): LeadScore {
    // Calculate individual score components (0-100 each)
    const distanceScore = Math.max(0, 100 - (distance * 5)); // Penalty: 5 points per km
    const priceScore = this.calculatePriceScore(job.budget, pro.hourlyRate, job.duration);
    const ratingScore = (pro.rating / 5) * 100; // 0-5 rating to 0-100
    const responseScore = pro.responseRate * 100; // 0-1 to 0-100
    const completenessScore = pro.profileCompleteness * 100; // 0-1 to 0-100
    const healthScore = pro.healthScore?.score || 50; // Use health score if available

    // Badge bonuses
    const badgeBonus = this.calculateBadgeBonus(pro.badges);

    // Base weighted score
    let finalScore = Math.round(
      0.25 * distanceScore +     // 25% distance
      0.20 * priceScore +        // 20% price match
      0.20 * ratingScore +       // 20% rating
      0.15 * responseScore +     // 15% response rate
      0.10 * completenessScore + // 10% profile completeness
      0.10 * healthScore         // 10% health score
    ) + badgeBonus;

    // *** BAN EFFECTS INTEGRATION ***
    const { penalizedScore, banPenalty } = this.applyBanPenalties(finalScore, pro.flags);
    finalScore = penalizedScore;

    // Ensure score is within bounds
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

  /**
   * Calculate badge bonus points
   */
  calculateBadgeBonus(badges: string[]): number {
    let badgeBonus = 0;
    if (badges.includes('verified')) badgeBonus += 5;
    if (badges.includes('topRated')) badgeBonus += 10;
    if (badges.includes('fastResponder')) badgeBonus += 5;
    if (badges.includes('reliable')) badgeBonus += 8;
    if (badges.includes('premium')) badgeBonus += 15;
    return badgeBonus;
  },

  /**
   * Apply ban penalties to score
   */
  applyBanPenalties(score: number, flags?: { softBanned: boolean; hardBanned: boolean }): { penalizedScore: number; banPenalty: string } {
    let banPenalty = '';
    let penalizedScore = score;
    
    if (flags?.softBanned === true) {
      penalizedScore = Math.round(score * 0.5); // 50% penalty for soft-banned pros
      banPenalty = 'Soft ban: -50% score';
      logger.debug('⚠️ MATCHING: Applied soft ban penalty', { 
        originalScore: score,
        penalizedScore
      });
    }
    // Note: Hard-banned pros are already filtered out in findCandidatePros

    return { penalizedScore, banPenalty };
  },

  /**
   * Generate human-readable reasons for score
   */
  generateScoreReasons(distance: number, priceScore: number, pro: ProCandidate, banPenalty: string): string[] {
    const reasons: string[] = [];
    if (distance <= 5) reasons.push('Sehr nah');
    if (priceScore >= 80) reasons.push('Passendes Budget');
    if (pro.rating >= 4.5) reasons.push('Top-bewertet');
    if (pro.badges.includes('verified')) reasons.push('Verifiziert');
    if (banPenalty) reasons.push(banPenalty);
    return reasons;
  },

  /**
   * Calculate price match score based on budget vs hourly rate
   */
  calculatePriceScore(jobBudget: number, proHourlyRate: number, jobDuration: number): number {
    const estimatedCost = proHourlyRate * jobDuration;
    const budgetRatio = jobBudget / estimatedCost;

    if (budgetRatio >= 1.2) return 100; // Budget 20% higher than cost
    if (budgetRatio >= 1.0) return 90;  // Budget matches cost
    if (budgetRatio >= 0.9) return 70;  // Budget 10% lower
    if (budgetRatio >= 0.8) return 50;  // Budget 20% lower
    if (budgetRatio >= 0.7) return 30;  // Budget 30% lower
    return 10; // Budget too low
  },

  /**
   * Calculate haversine distance between two coordinates (in km)
   */
  calculateDistance(coord1: GeoPoint, coord2: GeoPoint): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRadians(coord2.latitude - coord1.latitude);
    const dLon = this.toRadians(coord2.longitude - coord1.longitude);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(coord1.latitude)) * Math.cos(this.toRadians(coord2.latitude)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  },
};