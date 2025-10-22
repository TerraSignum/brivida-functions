"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportCsv = exportCsv;
exports.exportMyTransfersCsv = exportMyTransfersCsv;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("./firestore");
const storage_1 = require("firebase-admin/storage");
const v2_1 = require("firebase-functions/v2");
const auth_1 = require("./auth");
async function exportCsv(request) {
    const { data, auth } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    const adminUid = auth.uid;
    const { kind, dateFrom, dateTo } = data;
    if (!kind) {
        throw new https_1.HttpsError('invalid-argument', 'Export kind is required');
    }
    try {
        v2_1.logger.info('🔥 EXPORT: Starting CSV export', { kind, dateFrom, dateTo });
        const db = (0, firestore_1.getDb)();
        const storage = (0, storage_1.getStorage)();
        const bucket = storage.bucket();
        let csvData;
        let fileName;
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        switch (kind) {
            case 'jobs':
                csvData = await exportJobs(db, dateFrom, dateTo);
                fileName = `jobs_export_${timestamp}.csv`;
                break;
            case 'payments':
                csvData = await exportPayments(db, dateFrom, dateTo);
                fileName = `payments_export_${timestamp}.csv`;
                break;
            case 'disputes':
                csvData = await exportDisputes(db, dateFrom, dateTo);
                fileName = `disputes_export_${timestamp}.csv`;
                break;
            case 'users':
                csvData = await exportUsers(db, dateFrom, dateTo);
                fileName = `users_export_${timestamp}.csv`;
                break;
            case 'abuseEvents':
                csvData = await exportAbuseEvents(db, dateFrom, dateTo);
                fileName = `abuse_events_export_${timestamp}.csv`;
                break;
            default:
                throw new https_1.HttpsError('invalid-argument', `Unsupported export kind: ${kind}`);
        }
        const file = bucket.file(`exports/${fileName}`);
        await file.save(csvData, {
            metadata: {
                contentType: 'text/csv',
                metadata: {
                    exportedBy: adminUid,
                    exportedAt: now.toISOString(),
                    kind,
                    dateFrom: dateFrom || '',
                    dateTo: dateTo || ''
                }
            }
        });
        const [downloadUrl] = await file.getSignedUrl({
            action: 'read',
            expires: new Date(now.getTime() + 60 * 60 * 1000)
        });
        await db.collection('adminLogs').add({
            actorUid: adminUid,
            action: 'exportCsv',
            targetType: 'export',
            targetId: fileName,
            after: { kind, dateFrom, dateTo, fileName },
            notes: `CSV export: ${kind}`,
            createdAt: now
        });
        v2_1.logger.info('✅ EXPORT: CSV export completed', { fileName, kind });
        return {
            downloadUrl,
            fileName,
            expiresInMinutes: 60,
            createdAt: now.toISOString()
        };
    }
    catch (error) {
        v2_1.logger.error('❌ EXPORT: Error exporting CSV', { error, kind });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to export CSV');
    }
}
async function exportMyTransfersCsv(request) {
    var _a;
    const { data, auth } = request;
    if (!(auth === null || auth === void 0 ? void 0 : auth.uid)) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    if (!((_a = auth.token) === null || _a === void 0 ? void 0 : _a.role) || auth.token.role !== 'pro') {
        throw new https_1.HttpsError('permission-denied', 'Pro role required');
    }
    const { from, to } = data;
    try {
        v2_1.logger.info('🔥 TRANSFER EXPORT: Starting Pro transfer export', {
            proUid: auth.uid,
            from,
            to
        });
        const db = (0, firestore_1.getDb)();
        const storage = (0, storage_1.getStorage)();
        const bucket = storage.bucket();
        const csvData = await exportUserTransfers(db, auth.uid, from, to);
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `transfers_${auth.uid}_${timestamp}.csv`;
        const file = bucket.file(`transfers-exports/${fileName}`);
        await file.save(csvData, {
            metadata: {
                contentType: 'text/csv',
                metadata: {
                    exportedBy: auth.uid,
                    exportedAt: now.toISOString(),
                    kind: 'transfers',
                    proUid: auth.uid,
                    from: from || '',
                    to: to || ''
                }
            }
        });
        const [downloadUrl] = await file.getSignedUrl({
            action: 'read',
            expires: new Date(now.getTime() + 60 * 60 * 1000)
        });
        v2_1.logger.info('✅ TRANSFER EXPORT: Pro transfer export completed', {
            fileName,
            proUid: auth.uid
        });
        return {
            downloadUrl,
            filename: fileName,
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString()
        };
    }
    catch (error) {
        v2_1.logger.error('❌ TRANSFER EXPORT: Error exporting Pro transfers', {
            error,
            proUid: auth.uid
        });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to export transfers');
    }
}
async function exportJobs(db, dateFrom, dateTo) {
    let query = db.collection('jobs').orderBy('createdAt', 'desc');
    if (dateFrom) {
        query = query.where('createdAt', '>=', new Date(dateFrom));
    }
    if (dateTo) {
        query = query.where('createdAt', '<=', new Date(dateTo));
    }
    const snapshot = await query.limit(10000).get();
    const headers = [
        'ID', 'Customer UID', 'Pro UID', 'Status', 'Size (m²)', 'Rooms',
        'Services', 'Budget', 'Address', 'Created At', 'Completed At', 'Notes'
    ];
    let csv = headers.join(',') + '\n';
    snapshot.docs.forEach((doc) => {
        var _a;
        const data = doc.data();
        const row = [
            escapeCsv(doc.id),
            escapeCsv(data.customerUid || ''),
            escapeCsv(data.proUid || ''),
            escapeCsv(data.status || ''),
            data.sizeM2 || 0,
            data.rooms || 0,
            escapeCsv((data.services || []).join('; ')),
            data.budget || 0,
            escapeCsv(((_a = data.address) === null || _a === void 0 ? void 0 : _a.street) || ''),
            formatDate(data.createdAt),
            formatDate(data.completedAt),
            escapeCsv(data.notes || '')
        ];
        csv += row.join(',') + '\n';
    });
    return csv;
}
async function exportPayments(db, dateFrom, dateTo) {
    let query = db.collection('payments').orderBy('createdAt', 'desc');
    if (dateFrom) {
        query = query.where('createdAt', '>=', new Date(dateFrom));
    }
    if (dateTo) {
        query = query.where('createdAt', '<=', new Date(dateTo));
    }
    const snapshot = await query.limit(10000).get();
    const headers = [
        'ID', 'Job ID', 'Customer UID', 'Amount (€)', 'Currency', 'Status',
        'Platform Fee', 'Refunded', 'Created At', 'Captured At', 'Transferred At',
        'Stripe Payment Intent ID'
    ];
    let csv = headers.join(',') + '\n';
    snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const row = [
            escapeCsv(doc.id),
            escapeCsv(data.jobId || ''),
            escapeCsv(data.customerUid || ''),
            data.amountGross || 0,
            escapeCsv(data.currency || 'EUR'),
            escapeCsv(data.status || ''),
            data.platformFee || 0,
            data.totalRefunded || 0,
            formatDate(data.createdAt),
            formatDate(data.capturedAt),
            formatDate(data.transferredAt),
            escapeCsv(data.stripePaymentIntentId || '')
        ];
        csv += row.join(',') + '\n';
    });
    return csv;
}
async function exportDisputes(db, dateFrom, dateTo) {
    let query = db.collection('disputes').orderBy('openedAt', 'desc');
    if (dateFrom) {
        query = query.where('openedAt', '>=', new Date(dateFrom));
    }
    if (dateTo) {
        query = query.where('openedAt', '<=', new Date(dateTo));
    }
    const snapshot = await query.limit(10000).get();
    const headers = [
        'Case ID', 'Job ID', 'Payment ID', 'Customer UID', 'Pro UID', 'Status',
        'Reason', 'Requested Amount', 'Awarded Amount', 'Opened At', 'Resolved At',
        'Description'
    ];
    let csv = headers.join(',') + '\n';
    snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const row = [
            escapeCsv(doc.id),
            escapeCsv(data.jobId || ''),
            escapeCsv(data.paymentId || ''),
            escapeCsv(data.customerUid || ''),
            escapeCsv(data.proUid || ''),
            escapeCsv(data.status || ''),
            escapeCsv(data.reason || ''),
            data.requestedAmount || 0,
            data.awardedAmount || 0,
            formatDate(data.openedAt),
            formatDate(data.resolvedAt),
            escapeCsv(data.description || '')
        ];
        csv += row.join(',') + '\n';
    });
    return csv;
}
async function exportUsers(db, dateFrom, dateTo) {
    let query = db.collection('users').orderBy('createdAt', 'desc');
    if (dateFrom) {
        query = query.where('createdAt', '>=', new Date(dateFrom));
    }
    if (dateTo) {
        query = query.where('createdAt', '<=', new Date(dateTo));
    }
    const snapshot = await query.limit(10000).get();
    const headers = [
        'UID', 'Email', 'Role', 'Verified', 'Created At', 'Last Sign In',
        'Phone', 'Name'
    ];
    let csv = headers.join(',') + '\n';
    snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const row = [
            escapeCsv(doc.id),
            escapeCsv(data.email || ''),
            escapeCsv(data.role || 'customer'),
            data.emailVerified ? 'Yes' : 'No',
            formatDate(data.createdAt),
            formatDate(data.lastSignInTime),
            escapeCsv(data.phoneNumber || ''),
            escapeCsv(data.displayName || '')
        ];
        csv += row.join(',') + '\n';
    });
    return csv;
}
async function exportAbuseEvents(db, dateFrom, dateTo) {
    let query = db.collection('abuseEvents').orderBy('createdAt', 'desc');
    if (dateFrom) {
        query = query.where('createdAt', '>=', new Date(dateFrom));
    }
    if (dateTo) {
        query = query.where('createdAt', '<=', new Date(dateTo));
    }
    const snapshot = await query.limit(10000).get();
    const headers = [
        'ID', 'User UID', 'Type', 'Job ID', 'Weight', 'Description',
        'Reported By', 'Created At'
    ];
    let csv = headers.join(',') + '\n';
    snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const row = [
            escapeCsv(doc.id),
            escapeCsv(data.userUid || ''),
            escapeCsv(data.type || ''),
            escapeCsv(data.jobId || ''),
            data.weight || 0,
            escapeCsv(data.description || ''),
            escapeCsv(data.reportedBy || ''),
            formatDate(data.createdAt)
        ];
        csv += row.join(',') + '\n';
    });
    return csv;
}
function escapeCsv(value) {
    if (typeof value !== 'string')
        return String(value);
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}
function formatDate(timestamp) {
    if (!timestamp)
        return '';
    try {
        let date;
        if (timestamp.toDate) {
            date = timestamp.toDate();
        }
        else if (timestamp instanceof Date) {
            date = timestamp;
        }
        else {
            date = new Date(timestamp);
        }
        return date.toISOString();
    }
    catch (error) {
        v2_1.logger.warn('Failed to format date', { timestamp, error });
        return '';
    }
}
async function exportUserTransfers(db, proUid, dateFrom, dateTo) {
    let query = db.collection('transfers')
        .where('proUid', '==', proUid)
        .orderBy('createdAt', 'desc');
    if (dateFrom) {
        query = query.where('createdAt', '>=', new Date(dateFrom));
    }
    if (dateTo) {
        query = query.where('createdAt', '<=', new Date(dateTo));
    }
    const snapshot = await query.limit(5000).get();
    const headers = [
        'Transfer ID', 'Job ID', 'Payment ID', 'Amount Net (€)', 'Amount Gross (€)',
        'Platform Fee (€)', 'Currency', 'Status', 'Manual Release', 'Released By',
        'Created At', 'Completed At', 'Released At', 'Stripe Transfer ID',
        'Connected Account ID'
    ];
    let csv = headers.join(',') + '\n';
    snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const row = [
            escapeCsv(doc.id),
            escapeCsv(data.jobId || ''),
            escapeCsv(data.paymentId || ''),
            data.amountNet || 0,
            data.amountGross || 0,
            data.platformFee || 0,
            escapeCsv(data.currency || 'EUR'),
            escapeCsv(data.status || ''),
            data.manualRelease ? 'Yes' : 'No',
            escapeCsv(data.releasedBy || ''),
            formatDate(data.createdAt),
            formatDate(data.completedAt),
            formatDate(data.releasedAt),
            escapeCsv(data.stripeTransferId || ''),
            escapeCsv(data.connectedAccountId || '')
        ];
        csv += row.join(',') + '\n';
    });
    return csv;
}
//# sourceMappingURL=exports.js.map