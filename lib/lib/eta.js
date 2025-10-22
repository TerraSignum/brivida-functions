"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.etaService = exports.MAPBOX_TOKEN = void 0;
const v2_1 = require("firebase-functions/v2");
const firestore_1 = require("firebase-admin/firestore");
const params_1 = require("firebase-functions/params");
exports.MAPBOX_TOKEN = (0, params_1.defineSecret)('MAPBOX_TOKEN');
exports.etaService = {
    async calculateEta({ origin, destination }) {
        v2_1.logger.info(`Calculating ETA from ${origin.lat},${origin.lng} to ${destination.lat},${destination.lng}`);
        const db = (0, firestore_1.getFirestore)();
        const originKey = `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}`;
        const destKey = `${destination.lat.toFixed(3)},${destination.lng.toFixed(3)}`;
        const cacheKey = `${originKey}|${destKey}`;
        try {
            const cacheRef = db.collection('travelCache').doc(cacheKey);
            const cacheDoc = await cacheRef.get();
            if (cacheDoc.exists) {
                const cacheData = cacheDoc.data();
                const cacheAge = Date.now() - cacheData.cachedAt.toMillis();
                const cacheTTL = 10 * 60 * 1000;
                if (cacheAge < cacheTTL) {
                    v2_1.logger.info(`ETA cache hit: ${cacheData.minutes} minutes`);
                    return {
                        minutes: cacheData.minutes,
                        fromCache: true,
                    };
                }
                else {
                    v2_1.logger.info('ETA cache expired, fetching fresh data');
                }
            }
        }
        catch (error) {
            v2_1.logger.warn('Cache check failed, proceeding with API call', error);
        }
        try {
            const token = exports.MAPBOX_TOKEN.value();
            let durationSeconds = null;
            if (token) {
                const mapboxUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?alternatives=false&overview=false&access_token=${token}`;
                v2_1.logger.info(`Fetching ETA from Mapbox Directions`);
                const mbRes = await fetch(mapboxUrl);
                if (mbRes.ok) {
                    const mbData = await mbRes.json();
                    if (mbData.routes && mbData.routes.length > 0) {
                        const route = mbData.routes[0];
                        if (route && typeof route.duration === 'number') {
                            durationSeconds = route.duration;
                        }
                        else {
                            v2_1.logger.warn('Mapbox route has no valid duration, falling back to OSRM');
                        }
                    }
                    else {
                        v2_1.logger.warn('Mapbox returned no routes, falling back to OSRM', { message: mbData.message });
                    }
                }
                else {
                    v2_1.logger.warn(`Mapbox API error: ${mbRes.status} ${mbRes.statusText}, falling back to OSRM`);
                }
            }
            if (durationSeconds == null) {
                const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=false`;
                v2_1.logger.info(`Fetching ETA from OSRM: ${osrmUrl}`);
                const response = await fetch(osrmUrl);
                if (!response.ok) {
                    throw new Error(`OSRM API error: ${response.status} ${response.statusText}`);
                }
                const data = await response.json();
                if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
                    throw new Error(`OSRM routing failed: ${data.message || 'No routes found'}`);
                }
                const route = data.routes[0];
                if (!route || typeof route.duration !== 'number') {
                    throw new Error(`OSRM route invalid: missing or invalid duration`);
                }
                durationSeconds = route.duration;
            }
            const minutes = Math.ceil(durationSeconds / 60);
            v2_1.logger.info(`ETA calculated: ${minutes} minutes (${durationSeconds} seconds)`);
            try {
                const cacheRef = db.collection('travelCache').doc(cacheKey);
                await cacheRef.set({
                    originKey,
                    destKey,
                    minutes,
                    cachedAt: firestore_1.FieldValue.serverTimestamp(),
                });
                v2_1.logger.info('ETA result cached successfully');
            }
            catch (cacheError) {
                v2_1.logger.warn('Failed to cache ETA result', cacheError);
            }
            return {
                minutes,
                fromCache: false,
            };
        }
        catch (error) {
            v2_1.logger.error('ETA calculation failed', error);
            const fallbackMinutes = calculateFallbackEta(origin, destination);
            v2_1.logger.warn(`Using fallback ETA: ${fallbackMinutes} minutes`);
            return {
                minutes: fallbackMinutes,
                fromCache: false,
            };
        }
    },
};
function calculateFallbackEta(origin, destination) {
    const R = 6371;
    const dLat = toRadians(destination.lat - origin.lat);
    const dLng = toRadians(destination.lng - origin.lng);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(origin.lat)) * Math.cos(toRadians(destination.lat)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceKm = R * c;
    const avgSpeedKmh = 30;
    const hours = distanceKm / avgSpeedKmh;
    const minutes = Math.ceil(hours * 60);
    return Math.max(minutes, 5);
}
function toRadians(degrees) {
    return degrees * (Math.PI / 180);
}
//# sourceMappingURL=eta.js.map