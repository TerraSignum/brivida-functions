/**
 * PG-14: Location & Geocoding Services
 * 
 * Handles address geocoding via Google Geocoding API
 * Separates public job data from private location data for security
 */

import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { enforceAdminRole } from './auth';

export const GOOGLE_API_KEY_SECRET = defineSecret('GOOGLE_API_KEY');
export const GOOGLE_CLIENT_ID_PARAM = defineString('GOOGLE_CLIENT_ID');
export const GOOGLE_CLIENT_SECRET_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
export const GOOGLE_GEOCODING_API_KEY = GOOGLE_API_KEY_SECRET;

export function resolveGoogleApiKey(): string | undefined {
  try {
    const secretValue = GOOGLE_API_KEY_SECRET.value();
    if (typeof secretValue === 'string' && secretValue.trim().length > 0) {
      return secretValue.trim();
    }
  } catch (error) {
    logger.debug('GOOGLE_API_KEY secret not available, checking env vars', error);
  }

  const envCandidate =
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_KEY ||
    process.env.GCP_DISTANCE_MATRIX_KEY;

  if (envCandidate && envCandidate.trim().length > 0) {
    return envCandidate.trim();
  }

  return undefined;
}

export function resolveGoogleClientId(): string | undefined {
  const paramValue = GOOGLE_CLIENT_ID_PARAM.value();
  if (paramValue && paramValue.trim().length > 0) {
    return paramValue.trim();
  }

  const envCandidate = process.env.GOOGLE_CLIENT_ID;
  return envCandidate?.trim();
}

export function resolveGoogleClientSecret(): string | undefined {
  try {
    const secretValue = GOOGLE_CLIENT_SECRET_SECRET.value();
    if (secretValue && secretValue.trim().length > 0) {
      return secretValue.trim();
    }
  } catch (error) {
    logger.debug('GOOGLE_CLIENT_SECRET secret not available, checking env vars', error);
  }

  const envCandidate = process.env.GOOGLE_CLIENT_SECRET;
  return envCandidate?.trim();
}

interface SetJobAddressRequest {
  jobId: string;
  addressText: string;
  entranceNotes?: string;
}

interface GetEtaRequest {
  jobId: string;
  proLat: number;
  proLng: number;
}

interface GeocodeResult {
  formattedAddress: string;
  lat: number;
  lng: number;
  city?: string;
  district?: string;
}

interface EtaResult {
  duration: string;
  distance: string;
  durationValue: number;
  distanceValue: number;
}

/**
 * Calculate ETA from pro location to job location using Google Distance Matrix API
 */
export async function calculateEta(
  proLat: number,
  proLng: number,
  jobLat: number,
  jobLng: number
): Promise<EtaResult> {
  const apiKey = resolveGoogleApiKey();
  if (!apiKey) {
    logger.warn('Google API key missing while calculating ETA');
    throw new HttpsError('failed-precondition', 'Google API key not configured');
  }
  const origins = `${proLat},${proLng}`;
  const destinations = `${jobLat},${jobLng}`;
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${destinations}&mode=driving&units=metric&key=${apiKey}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json() as any;
    
    if (data.status !== 'OK') {
      logger.error('Distance Matrix API failed', { status: data.status, error_message: data.error_message });
      throw new HttpsError('unavailable', `ETA calculation failed: ${data.status}`);
    }
    
    const element = data.rows[0]?.elements[0];
    if (!element || element.status !== 'OK') {
      throw new HttpsError('not-found', 'Route not found');
    }
    
    return {
      duration: element.duration.text,
      distance: element.distance.text,
      durationValue: element.duration.value, // in seconds
      distanceValue: element.distance.value, // in meters
    };
  } catch (error) {
    logger.error('ETA calculation failed', { error, proLat, proLng, jobLat, jobLng });
    throw new HttpsError('unavailable', 'ETA service unavailable');
  }
}
export async function geocodeAddress(addressText: string): Promise<GeocodeResult> {
  const apiKey = resolveGoogleApiKey();
  if (!apiKey) {
    logger.warn('Google API key missing while geocoding address');
    throw new HttpsError('failed-precondition', 'Google API key not configured');
  }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressText)}&key=${apiKey}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json() as any; // Cast to any for Google API response
    
    if (data.status !== 'OK') {
      logger.error('Geocoding failed', { status: data.status, error_message: data.error_message });
      throw new HttpsError('unavailable', `Geocoding failed: ${data.status}`);
    }
    
    if (!data.results || data.results.length === 0) {
      throw new HttpsError('not-found', 'No results found for the provided address');
    }
    
    const result = data.results[0];
    const location = result.geometry.location;
    
    // Extract city and district from address components
    let city: string | undefined;
    let district: string | undefined;
    
    for (const component of result.address_components || []) {
      const types = component.types;
      
      if (types.includes('locality')) {
        city = component.long_name;
      } else if (types.includes('administrative_area_level_2')) {
        district = component.long_name;
      }
    }
    
    return {
      formattedAddress: result.formatted_address,
      lat: location.lat,
      lng: location.lng,
      city,
      district,
    };
  } catch (error) {
    logger.error('Geocoding request failed', { error, addressText });
    throw new HttpsError('unavailable', 'Geocoding service unavailable');
  }
}

/**
 * Set job address and geocode it
 * Only job owner can set the address
 */
export const setJobAddressCF = onCall(
  { 
    region: 'europe-west1',
    secrets: [GOOGLE_API_KEY_SECRET],
  },
  async (request: CallableRequest<SetJobAddressRequest>) => {
    const { jobId, addressText, entranceNotes } = request.data;
    const uid = request.auth?.uid;
    
    if (!uid) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }
    
    if (!jobId || !addressText) {
      throw new HttpsError('invalid-argument', 'jobId and addressText are required');
    }
    
    const db = getFirestore();
    
    try {
      // Verify job ownership and status
      const jobRef = db.collection('jobs').doc(jobId);
      const jobDoc = await jobRef.get();
      
      if (!jobDoc.exists) {
        throw new HttpsError('not-found', 'Job not found');
      }
      
      const jobData = jobDoc.data()!;
      
      if (jobData.customerUid !== uid) {
        throw new HttpsError('permission-denied', 'Only job owner can set address');
      }
      
      if (!['open', 'assigned'].includes(jobData.status)) {
        throw new HttpsError('failed-precondition', 'Cannot modify address for completed/cancelled jobs');
      }
      
      // Geocode the address
      logger.info('Geocoding address', { jobId, addressText });
      const geocodeResult = await geocodeAddress(addressText);
      
      // Use Firestore transaction to update both collections
      await db.runTransaction(async (transaction) => {
        const now = FieldValue.serverTimestamp();
        
        // Update/create private location data
        const privateRef = db.collection('jobsPrivate').doc(jobId);
        const privateDoc = await transaction.get(privateRef);
        
        const privateData = {
          addressText,
          addressFormatted: geocodeResult.formattedAddress,
          location: {
            lat: geocodeResult.lat,
            lng: geocodeResult.lng,
          },
          entranceNotes: entranceNotes || null,
          updatedAt: now,
        };
        
        if (privateDoc.exists) {
          transaction.update(privateRef, privateData);
        } else {
          transaction.set(privateRef, {
            ...privateData,
            createdAt: now,
          });
        }
        
        // Update public job data
        const publicUpdates: any = {
          hasPrivateLocation: true,
          updatedAt: now,
        };
        
        // Update city/district if they were missing and we found them
        if (geocodeResult.city && !jobData.addressCity) {
          publicUpdates.addressCity = geocodeResult.city;
        }
        if (geocodeResult.district && !jobData.addressDistrict) {
          publicUpdates.addressDistrict = geocodeResult.district;
        }
        
        transaction.update(jobRef, publicUpdates);
      });
      
      logger.info('Address set successfully', { jobId, formattedAddress: geocodeResult.formattedAddress });
      
      return {
        success: true,
        formattedAddress: geocodeResult.formattedAddress,
        lat: geocodeResult.lat,
        lng: geocodeResult.lng,
      };
      
    } catch (error) {
      logger.error('Failed to set job address', { error, jobId, addressText });
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', 'Failed to set job address');
    }
  }
);

/**
 * Get ETA from pro location to job location
 * Only assigned pros can calculate ETA
 */
export const getEtaCF = onCall(
  { 
    region: 'europe-west1',
    secrets: [GOOGLE_API_KEY_SECRET],
  },
  async (request: CallableRequest<GetEtaRequest>) => {
    const { jobId, proLat, proLng } = request.data;
    const uid = request.auth?.uid;
    
    if (!uid) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }
    
    if (!jobId || typeof proLat !== 'number' || typeof proLng !== 'number') {
      throw new HttpsError('invalid-argument', 'jobId, proLat, and proLng are required');
    }
    
    const db = getFirestore();
    
    try {
      // Verify pro is assigned to the job
      const jobRef = db.collection('jobs').doc(jobId);
      const jobDoc = await jobRef.get();
      
      if (!jobDoc.exists) {
        throw new HttpsError('not-found', 'Job not found');
      }
      
      const jobData = jobDoc.data()!;
      
      if (!jobData.visibleTo?.includes(uid)) {
        throw new HttpsError('permission-denied', 'Only assigned pros can calculate ETA');
      }
      
      // Get job location from private data
      const privateRef = db.collection('jobsPrivate').doc(jobId);
      const privateDoc = await privateRef.get();
      
      if (!privateDoc.exists) {
        throw new HttpsError('not-found', 'Job location not found');
      }
      
      const privateData = privateDoc.data()!;
      const location = privateData.location;
      
      if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
        throw new HttpsError('failed-precondition', 'Invalid job location data');
      }
      
      // Calculate ETA
      logger.info('Calculating ETA', { jobId, proLat, proLng, jobLat: location.lat, jobLng: location.lng });
      const etaResult = await calculateEta(proLat, proLng, location.lat, location.lng);
      
      logger.info('ETA calculated successfully', { jobId, duration: etaResult.duration, distance: etaResult.distance });
      
      return {
        success: true,
        duration: etaResult.duration,
        distance: etaResult.distance,
        durationMinutes: Math.ceil(etaResult.durationValue / 60),
        distanceKm: Math.round(etaResult.distanceValue / 1000 * 10) / 10,
      };
      
    } catch (error) {
      logger.error('Failed to calculate ETA', { error, jobId, proLat, proLng });
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', 'Failed to calculate ETA');
    }
  }
);

/**
 * Admin function to refresh geocoding for a job
 */
export const refreshJobGeocodeCF = onCall(
  { 
    region: 'europe-west1',
    secrets: [GOOGLE_API_KEY_SECRET],
  },
  async (request: CallableRequest<{ jobId: string }>) => {
    const { jobId } = request.data;
    const uid = request.auth?.uid;
    
    if (!uid) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }
    
    await enforceAdminRole(request.auth);
    
    if (!jobId) {
      throw new HttpsError('invalid-argument', 'jobId is required');
    }
    
    const db = getFirestore();
    
    try {
      // Get existing private location data
      const privateRef = db.collection('jobsPrivate').doc(jobId);
      const privateDoc = await privateRef.get();
      
      if (!privateDoc.exists) {
        throw new HttpsError('not-found', 'Private location data not found');
      }
      
      const privateData = privateDoc.data()!;
      const addressText = privateData.addressText;
      
      if (!addressText) {
        throw new HttpsError('failed-precondition', 'No address text to geocode');
      }
      
      // Re-geocode the address
  logger.info('Re-geocoding address', { jobId, addressText, adminUid: uid });
      const geocodeResult = await geocodeAddress(addressText);
      
      // Update the location data
      await privateRef.update({
        addressFormatted: geocodeResult.formattedAddress,
        location: {
          lat: geocodeResult.lat,
          lng: geocodeResult.lng,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
      
  logger.info('Address refreshed successfully', { jobId, formattedAddress: geocodeResult.formattedAddress, adminUid: uid });
      
      return {
        success: true,
        formattedAddress: geocodeResult.formattedAddress,
        lat: geocodeResult.lat,
        lng: geocodeResult.lng,
      };
      
    } catch (error) {
      logger.error('Failed to refresh job address', { error, jobId });
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', 'Failed to refresh job address');
    }
  }
);