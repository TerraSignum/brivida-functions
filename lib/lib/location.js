"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshJobGeocodeCF = exports.getEtaCF = exports.setJobAddressCF = exports.GOOGLE_GEOCODING_API_KEY = exports.GOOGLE_CLIENT_SECRET_SECRET = exports.GOOGLE_CLIENT_ID_PARAM = exports.GOOGLE_API_KEY_SECRET = void 0;
exports.resolveGoogleApiKey = resolveGoogleApiKey;
exports.resolveGoogleClientId = resolveGoogleClientId;
exports.resolveGoogleClientSecret = resolveGoogleClientSecret;
exports.calculateEta = calculateEta;
exports.geocodeAddress = geocodeAddress;
const https_1 = require("firebase-functions/v2/https");
const params_1 = require("firebase-functions/params");
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const auth_1 = require("./auth");
exports.GOOGLE_API_KEY_SECRET = (0, params_1.defineSecret)('GOOGLE_API_KEY');
exports.GOOGLE_CLIENT_ID_PARAM = (0, params_1.defineString)('GOOGLE_CLIENT_ID');
exports.GOOGLE_CLIENT_SECRET_SECRET = (0, params_1.defineSecret)('GOOGLE_CLIENT_SECRET');
exports.GOOGLE_GEOCODING_API_KEY = exports.GOOGLE_API_KEY_SECRET;
function resolveGoogleApiKey() {
    try {
        const secretValue = exports.GOOGLE_API_KEY_SECRET.value();
        if (typeof secretValue === 'string' && secretValue.trim().length > 0) {
            return secretValue.trim();
        }
    }
    catch (error) {
        firebase_functions_1.logger.debug('GOOGLE_API_KEY secret not available, checking env vars', error);
    }
    const envCandidate = process.env.GOOGLE_API_KEY ||
        process.env.GOOGLE_KEY ||
        process.env.GCP_DISTANCE_MATRIX_KEY;
    if (envCandidate && envCandidate.trim().length > 0) {
        return envCandidate.trim();
    }
    return undefined;
}
function resolveGoogleClientId() {
    const paramValue = exports.GOOGLE_CLIENT_ID_PARAM.value();
    if (paramValue && paramValue.trim().length > 0) {
        return paramValue.trim();
    }
    const envCandidate = process.env.GOOGLE_CLIENT_ID;
    return envCandidate === null || envCandidate === void 0 ? void 0 : envCandidate.trim();
}
function resolveGoogleClientSecret() {
    try {
        const secretValue = exports.GOOGLE_CLIENT_SECRET_SECRET.value();
        if (secretValue && secretValue.trim().length > 0) {
            return secretValue.trim();
        }
    }
    catch (error) {
        firebase_functions_1.logger.debug('GOOGLE_CLIENT_SECRET secret not available, checking env vars', error);
    }
    const envCandidate = process.env.GOOGLE_CLIENT_SECRET;
    return envCandidate === null || envCandidate === void 0 ? void 0 : envCandidate.trim();
}
async function calculateEta(proLat, proLng, jobLat, jobLng) {
    var _a;
    const apiKey = resolveGoogleApiKey();
    if (!apiKey) {
        firebase_functions_1.logger.warn('Google API key missing while calculating ETA');
        throw new https_1.HttpsError('failed-precondition', 'Google API key not configured');
    }
    const origins = `${proLat},${proLng}`;
    const destinations = `${jobLat},${jobLng}`;
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${destinations}&mode=driving&units=metric&key=${apiKey}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status !== 'OK') {
            firebase_functions_1.logger.error('Distance Matrix API failed', { status: data.status, error_message: data.error_message });
            throw new https_1.HttpsError('unavailable', `ETA calculation failed: ${data.status}`);
        }
        const element = (_a = data.rows[0]) === null || _a === void 0 ? void 0 : _a.elements[0];
        if (!element || element.status !== 'OK') {
            throw new https_1.HttpsError('not-found', 'Route not found');
        }
        return {
            duration: element.duration.text,
            distance: element.distance.text,
            durationValue: element.duration.value,
            distanceValue: element.distance.value,
        };
    }
    catch (error) {
        firebase_functions_1.logger.error('ETA calculation failed', { error, proLat, proLng, jobLat, jobLng });
        throw new https_1.HttpsError('unavailable', 'ETA service unavailable');
    }
}
async function geocodeAddress(addressText) {
    const apiKey = resolveGoogleApiKey();
    if (!apiKey) {
        firebase_functions_1.logger.warn('Google API key missing while geocoding address');
        throw new https_1.HttpsError('failed-precondition', 'Google API key not configured');
    }
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressText)}&key=${apiKey}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status !== 'OK') {
            firebase_functions_1.logger.error('Geocoding failed', { status: data.status, error_message: data.error_message });
            throw new https_1.HttpsError('unavailable', `Geocoding failed: ${data.status}`);
        }
        if (!data.results || data.results.length === 0) {
            throw new https_1.HttpsError('not-found', 'No results found for the provided address');
        }
        const result = data.results[0];
        const location = result.geometry.location;
        let city;
        let district;
        for (const component of result.address_components || []) {
            const types = component.types;
            if (types.includes('locality')) {
                city = component.long_name;
            }
            else if (types.includes('administrative_area_level_2')) {
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
    }
    catch (error) {
        firebase_functions_1.logger.error('Geocoding request failed', { error, addressText });
        throw new https_1.HttpsError('unavailable', 'Geocoding service unavailable');
    }
}
exports.setJobAddressCF = (0, https_1.onCall)({
    region: 'europe-west1',
    secrets: [exports.GOOGLE_API_KEY_SECRET],
}, async (request) => {
    var _a;
    const { jobId, addressText, entranceNotes } = request.data;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    if (!jobId || !addressText) {
        throw new https_1.HttpsError('invalid-argument', 'jobId and addressText are required');
    }
    const db = (0, firestore_1.getFirestore)();
    try {
        const jobRef = db.collection('jobs').doc(jobId);
        const jobDoc = await jobRef.get();
        if (!jobDoc.exists) {
            throw new https_1.HttpsError('not-found', 'Job not found');
        }
        const jobData = jobDoc.data();
        if (jobData.customerUid !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only job owner can set address');
        }
        if (!['open', 'assigned'].includes(jobData.status)) {
            throw new https_1.HttpsError('failed-precondition', 'Cannot modify address for completed/cancelled jobs');
        }
        firebase_functions_1.logger.info('Geocoding address', { jobId, addressText });
        const geocodeResult = await geocodeAddress(addressText);
        await db.runTransaction(async (transaction) => {
            const now = firestore_1.FieldValue.serverTimestamp();
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
            }
            else {
                transaction.set(privateRef, {
                    ...privateData,
                    createdAt: now,
                });
            }
            const publicUpdates = {
                hasPrivateLocation: true,
                updatedAt: now,
            };
            if (geocodeResult.city && !jobData.addressCity) {
                publicUpdates.addressCity = geocodeResult.city;
            }
            if (geocodeResult.district && !jobData.addressDistrict) {
                publicUpdates.addressDistrict = geocodeResult.district;
            }
            transaction.update(jobRef, publicUpdates);
        });
        firebase_functions_1.logger.info('Address set successfully', { jobId, formattedAddress: geocodeResult.formattedAddress });
        return {
            success: true,
            formattedAddress: geocodeResult.formattedAddress,
            lat: geocodeResult.lat,
            lng: geocodeResult.lng,
        };
    }
    catch (error) {
        firebase_functions_1.logger.error('Failed to set job address', { error, jobId, addressText });
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to set job address');
    }
});
exports.getEtaCF = (0, https_1.onCall)({
    region: 'europe-west1',
    secrets: [exports.GOOGLE_API_KEY_SECRET],
}, async (request) => {
    var _a, _b;
    const { jobId, proLat, proLng } = request.data;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    if (!jobId || typeof proLat !== 'number' || typeof proLng !== 'number') {
        throw new https_1.HttpsError('invalid-argument', 'jobId, proLat, and proLng are required');
    }
    const db = (0, firestore_1.getFirestore)();
    try {
        const jobRef = db.collection('jobs').doc(jobId);
        const jobDoc = await jobRef.get();
        if (!jobDoc.exists) {
            throw new https_1.HttpsError('not-found', 'Job not found');
        }
        const jobData = jobDoc.data();
        if (!((_b = jobData.visibleTo) === null || _b === void 0 ? void 0 : _b.includes(uid))) {
            throw new https_1.HttpsError('permission-denied', 'Only assigned pros can calculate ETA');
        }
        const privateRef = db.collection('jobsPrivate').doc(jobId);
        const privateDoc = await privateRef.get();
        if (!privateDoc.exists) {
            throw new https_1.HttpsError('not-found', 'Job location not found');
        }
        const privateData = privateDoc.data();
        const location = privateData.location;
        if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
            throw new https_1.HttpsError('failed-precondition', 'Invalid job location data');
        }
        firebase_functions_1.logger.info('Calculating ETA', { jobId, proLat, proLng, jobLat: location.lat, jobLng: location.lng });
        const etaResult = await calculateEta(proLat, proLng, location.lat, location.lng);
        firebase_functions_1.logger.info('ETA calculated successfully', { jobId, duration: etaResult.duration, distance: etaResult.distance });
        return {
            success: true,
            duration: etaResult.duration,
            distance: etaResult.distance,
            durationMinutes: Math.ceil(etaResult.durationValue / 60),
            distanceKm: Math.round(etaResult.distanceValue / 1000 * 10) / 10,
        };
    }
    catch (error) {
        firebase_functions_1.logger.error('Failed to calculate ETA', { error, jobId, proLat, proLng });
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to calculate ETA');
    }
});
exports.refreshJobGeocodeCF = (0, https_1.onCall)({
    region: 'europe-west1',
    secrets: [exports.GOOGLE_API_KEY_SECRET],
}, async (request) => {
    var _a;
    const { jobId } = request.data;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    await (0, auth_1.enforceAdminRole)(request.auth);
    if (!jobId) {
        throw new https_1.HttpsError('invalid-argument', 'jobId is required');
    }
    const db = (0, firestore_1.getFirestore)();
    try {
        const privateRef = db.collection('jobsPrivate').doc(jobId);
        const privateDoc = await privateRef.get();
        if (!privateDoc.exists) {
            throw new https_1.HttpsError('not-found', 'Private location data not found');
        }
        const privateData = privateDoc.data();
        const addressText = privateData.addressText;
        if (!addressText) {
            throw new https_1.HttpsError('failed-precondition', 'No address text to geocode');
        }
        firebase_functions_1.logger.info('Re-geocoding address', { jobId, addressText, adminUid: uid });
        const geocodeResult = await geocodeAddress(addressText);
        await privateRef.update({
            addressFormatted: geocodeResult.formattedAddress,
            location: {
                lat: geocodeResult.lat,
                lng: geocodeResult.lng,
            },
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        firebase_functions_1.logger.info('Address refreshed successfully', { jobId, formattedAddress: geocodeResult.formattedAddress, adminUid: uid });
        return {
            success: true,
            formattedAddress: geocodeResult.formattedAddress,
            lat: geocodeResult.lat,
            lng: geocodeResult.lng,
        };
    }
    catch (error) {
        firebase_functions_1.logger.error('Failed to refresh job address', { error, jobId });
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to refresh job address');
    }
});
//# sourceMappingURL=location.js.map