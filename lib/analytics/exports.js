"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportAnalyticsCsv = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const storage_1 = require("firebase-admin/storage");
const v2_1 = require("firebase-functions/v2");
const auth_1 = require("../lib/auth");
exports.exportAnalyticsCsv = (0, https_1.onCall)({
    region: 'europe-west1',
}, async (request) => {
    const { data, auth } = request;
    if (!(auth === null || auth === void 0 ? void 0 : auth.uid)) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    await (0, auth_1.enforceAdminRole)(auth);
    const { type, dateFrom, dateTo } = data;
    if (!type || !['events', 'daily'].includes(type)) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid export type. Must be "events" or "daily"');
    }
    try {
        v2_1.logger.info('🔥 ANALYTICS EXPORT: Starting export', {
            type,
            adminUid: auth.uid,
            dateFrom,
            dateTo
        });
        const db = (0, firestore_1.getFirestore)();
        const storage = (0, storage_1.getStorage)();
        const bucket = storage.bucket();
        let csvData;
        let filename;
        if (type === 'events') {
            csvData = await exportEventsData(db, dateFrom, dateTo);
            filename = `analytics_events_${auth.uid}_${Date.now()}.csv`;
        }
        else {
            csvData = await exportDailyData(db, dateFrom, dateTo);
            filename = `analytics_daily_${auth.uid}_${Date.now()}.csv`;
        }
        const file = bucket.file(`analytics-exports/${filename}`);
        await file.save(csvData, {
            metadata: {
                contentType: 'text/csv',
                metadata: {
                    exportedBy: auth.uid,
                    exportedAt: new Date().toISOString(),
                    type,
                    dateFrom: dateFrom || '',
                    dateTo: dateTo || '',
                }
            }
        });
        const [downloadUrl] = await file.getSignedUrl({
            action: 'read',
            expires: new Date(Date.now() + 60 * 60 * 1000)
        });
        v2_1.logger.info('✅ ANALYTICS EXPORT: Export completed', {
            filename,
            type,
            adminUid: auth.uid
        });
        return {
            downloadUrl,
            filename,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        };
    }
    catch (error) {
        v2_1.logger.error('❌ ANALYTICS EXPORT: Export failed', { error, type });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to export analytics data');
    }
});
async function exportEventsData(db, dateFrom, dateTo) {
    let query = db.collection('analyticsEvents').orderBy('ts', 'desc');
    if (dateFrom) {
        const startDate = new Date(dateFrom);
        query = query.where('ts', '>=', firestore_1.Timestamp.fromDate(startDate));
    }
    if (dateTo) {
        const endDate = new Date(dateTo);
        endDate.setHours(23, 59, 59, 999);
        query = query.where('ts', '<=', firestore_1.Timestamp.fromDate(endDate));
    }
    query = query.limit(10000);
    const snapshot = await query.get();
    const headers = [
        'Timestamp',
        'Source',
        'Event Name',
        'User ID',
        'User Role',
        'Session ID',
        'Platform',
        'App Version',
        'Properties JSON',
    ];
    const rows = [headers.join(',')];
    snapshot.docs.forEach(doc => {
        var _a, _b, _c, _d, _e;
        const event = doc.data();
        const row = [
            ((_c = (_b = (_a = event.ts) === null || _a === void 0 ? void 0 : _a.toDate) === null || _b === void 0 ? void 0 : _b.call(_a)) === null || _c === void 0 ? void 0 : _c.toISOString()) || '',
            event.src || '',
            event.name || '',
            event.uid || '',
            event.role || '',
            event.sessionId || '',
            ((_d = event.context) === null || _d === void 0 ? void 0 : _d.platform) || '',
            ((_e = event.context) === null || _e === void 0 ? void 0 : _e.appVersion) || '',
            JSON.stringify(event.props || {}).replace(/"/g, '""'),
        ];
        rows.push(row.map(cell => `"${cell}"`).join(','));
    });
    return rows.join('\n');
}
async function exportDailyData(db, dateFrom, dateTo) {
    let query = db.collection('analyticsDaily').orderBy('__name__', 'desc');
    if (dateFrom) {
        const startDateId = formatDateId(new Date(dateFrom));
        query = query.where('__name__', '>=', startDateId);
    }
    if (dateTo) {
        const endDateId = formatDateId(new Date(dateTo));
        query = query.where('__name__', '<=', endDateId);
    }
    query = query.limit(365);
    const snapshot = await query.get();
    const headers = [
        'Date',
        'Jobs Created',
        'Leads Created',
        'Leads Accepted',
        'Payments Captured (EUR)',
        'Payments Released (EUR)',
        'Refunds (EUR)',
        'Chat Messages',
        'Active Pros',
        'Active Customers',
        'New Users',
        'Disputes Opened',
        'Disputes Resolved',
        'Average Rating',
        'Ratings Count',
        'Push Delivered',
        'Push Opened',
        'Push Open Rate (%)',
        'Updated At',
    ];
    const rows = [headers.join(',')];
    snapshot.docs.forEach(doc => {
        var _a, _b, _c;
        const daily = doc.data();
        const kpis = daily.kpis || {};
        const row = [
            doc.id,
            kpis.jobsCreated || 0,
            kpis.leadsCreated || 0,
            kpis.leadsAccepted || 0,
            kpis.paymentsCapturedEur || 0,
            kpis.paymentsReleasedEur || 0,
            kpis.refundsEur || 0,
            kpis.chatMessages || 0,
            kpis.activePros || 0,
            kpis.activeCustomers || 0,
            kpis.newUsers || 0,
            kpis.disputesOpened || 0,
            kpis.disputesResolved || 0,
            kpis.avgRating || 0,
            kpis.ratingsCount || 0,
            kpis.pushDelivered || 0,
            kpis.pushOpened || 0,
            kpis.pushOpenRate || 0,
            ((_c = (_b = (_a = daily.updatedAt) === null || _a === void 0 ? void 0 : _a.toDate) === null || _b === void 0 ? void 0 : _b.call(_a)) === null || _c === void 0 ? void 0 : _c.toISOString()) || '',
        ];
        rows.push(row.map(cell => `"${cell}"`).join(','));
    });
    return rows.join('\n');
}
function formatDateId(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}
//# sourceMappingURL=exports.js.map