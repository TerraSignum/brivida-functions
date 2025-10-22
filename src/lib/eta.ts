import { logger } from 'firebase-functions/v2';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';

interface EtaParams {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
}

interface EtaResult {
  minutes: number;
  fromCache?: boolean;
}

interface TravelCacheEntry {
  originKey: string;
  destKey: string;
  minutes: number;
  cachedAt: FirebaseFirestore.Timestamp;
}

interface OSRMResponse {
  code: string;
  message?: string;
  routes?: Array<{
    duration: number;
    distance: number;
  }>;
}

// Secure Mapbox token (set via `firebase functions:secrets:set MAPBOX_TOKEN`)
export const MAPBOX_TOKEN = defineSecret('MAPBOX_TOKEN');

interface MapboxDirectionsResponse {
  routes?: Array<{
    duration: number; // seconds
    distance: number; // meters
  }>;
  message?: string;
}

export const etaService = {
  /**
   * Calculate ETA between two locations using OSRM Public API
   * with caching to avoid repeated requests
   */
  async calculateEta({ origin, destination }: EtaParams): Promise<EtaResult> {
    logger.info(`Calculating ETA from ${origin.lat},${origin.lng} to ${destination.lat},${destination.lng}`);
    
    const db = getFirestore();
    
    // Create cache keys (round to 3 decimal places for ~100m precision)
    const originKey = `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}`;
    const destKey = `${destination.lat.toFixed(3)},${destination.lng.toFixed(3)}`;
    const cacheKey = `${originKey}|${destKey}`;
    
    // Check cache first (TTL: 10 minutes)
    try {
      const cacheRef = db.collection('travelCache').doc(cacheKey);
      const cacheDoc = await cacheRef.get();
      
      if (cacheDoc.exists) {
        const cacheData = cacheDoc.data() as TravelCacheEntry;
        const cacheAge = Date.now() - cacheData.cachedAt.toMillis();
        const cacheTTL = 10 * 60 * 1000; // 10 minutes in milliseconds
        
        if (cacheAge < cacheTTL) {
          logger.info(`ETA cache hit: ${cacheData.minutes} minutes`);
          return {
            minutes: cacheData.minutes,
            fromCache: true,
          };
        } else {
          logger.info('ETA cache expired, fetching fresh data');
        }
      }
    } catch (error) {
      logger.warn('Cache check failed, proceeding with API call', error);
    }
    
    // Prefer Mapbox Directions if secret is configured; otherwise use OSRM
    try {
      const token = MAPBOX_TOKEN.value();
      let durationSeconds: number | null = null;

      if (token) {
        const mapboxUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?alternatives=false&overview=false&access_token=${token}`;
        logger.info(`Fetching ETA from Mapbox Directions`);
        const mbRes = await fetch(mapboxUrl);
        if (mbRes.ok) {
          const mbData = await mbRes.json() as MapboxDirectionsResponse;
          if (mbData.routes && mbData.routes.length > 0) {
            const route = mbData.routes[0];
            if (route && typeof route.duration === 'number') {
              durationSeconds = route.duration;
            } else {
              logger.warn('Mapbox route has no valid duration, falling back to OSRM');
            }
          } else {
            logger.warn('Mapbox returned no routes, falling back to OSRM', { message: mbData.message });
          }
        } else {
          logger.warn(`Mapbox API error: ${mbRes.status} ${mbRes.statusText}, falling back to OSRM`);
        }
      }

      if (durationSeconds == null) {
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=false`;
        logger.info(`Fetching ETA from OSRM: ${osrmUrl}`);
        const response = await fetch(osrmUrl);
        if (!response.ok) {
          throw new Error(`OSRM API error: ${response.status} ${response.statusText}`);
        }
        const data = await response.json() as OSRMResponse;
        if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
          throw new Error(`OSRM routing failed: ${data.message || 'No routes found'}`);
        }
        // Safe array access with bounds checking
        const route = data.routes[0];
        if (!route || typeof route.duration !== 'number') {
          throw new Error(`OSRM route invalid: missing or invalid duration`);
        }
        durationSeconds = route.duration;
      }

      const minutes = Math.ceil(durationSeconds / 60);
      logger.info(`ETA calculated: ${minutes} minutes (${durationSeconds} seconds)`);
      
      // Cache the result
      try {
        const cacheRef = db.collection('travelCache').doc(cacheKey);
        await cacheRef.set({
          originKey,
          destKey,
          minutes,
          cachedAt: FieldValue.serverTimestamp(),
        });
        
        logger.info('ETA result cached successfully');
      } catch (cacheError) {
        logger.warn('Failed to cache ETA result', cacheError);
        // Don't fail the function if caching fails
      }
      
      return {
        minutes,
        fromCache: false,
      };
      
    } catch (error) {
      logger.error('ETA calculation failed', error);
      
      // Return a fallback ETA based on straight-line distance
      const fallbackMinutes = calculateFallbackEta(origin, destination);
      logger.warn(`Using fallback ETA: ${fallbackMinutes} minutes`);
      
      return {
        minutes: fallbackMinutes,
        fromCache: false,
      };
    }
  },
};

/**
 * Calculate fallback ETA based on straight-line distance
 * Assumes average speed of 30 km/h in urban areas
 */
function calculateFallbackEta(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): number {
  // Haversine formula for distance calculation
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(destination.lat - origin.lat);
  const dLng = toRadians(destination.lng - origin.lng);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
           Math.cos(toRadians(origin.lat)) * Math.cos(toRadians(destination.lat)) *
           Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceKm = R * c;
  
  // Assume 30 km/h average speed in urban areas
  const avgSpeedKmh = 30;
  const hours = distanceKm / avgSpeedKmh;
  const minutes = Math.ceil(hours * 60);
  
  // Minimum 5 minutes for any trip
  return Math.max(minutes, 5);
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}