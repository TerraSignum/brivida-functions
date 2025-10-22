import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { getDb } from './firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { enforceAdminRole } from './auth';

interface ExportCsvData {
  kind: 'jobs' | 'payments' | 'disputes' | 'users' | 'abuseEvents';
  dateFrom?: string;
  dateTo?: string;
}

interface ExportTransfersData {
  from?: string;
  to?: string;
}

export async function exportCsv(request: CallableRequest<ExportCsvData>) {
  const { data, auth } = request;

  await enforceAdminRole(auth);
  const adminUid = auth!.uid;

  const { kind, dateFrom, dateTo } = data;

  if (!kind) {
    throw new HttpsError('invalid-argument', 'Export kind is required');
  }

  try {
    logger.info('🔥 EXPORT: Starting CSV export', { kind, dateFrom, dateTo });

    const db = getDb();
    const storage = getStorage();
    const bucket = storage.bucket();

    // Generate CSV data based on kind
    let csvData: string;
    let fileName: string;

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
        throw new HttpsError('invalid-argument', `Unsupported export kind: ${kind}`);
    }

    // Upload to Cloud Storage
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

    // Generate signed URL (expires in 1 hour)
    const [downloadUrl] = await file.getSignedUrl({
      action: 'read',
      expires: new Date(now.getTime() + 60 * 60 * 1000) // 1 hour
    });

    // Log admin action
    await db.collection('adminLogs').add({
  actorUid: adminUid,
      action: 'exportCsv',
      targetType: 'export',
      targetId: fileName,
      after: { kind, dateFrom, dateTo, fileName },
      notes: `CSV export: ${kind}`,
      createdAt: now
    });

    logger.info('✅ EXPORT: CSV export completed', { fileName, kind });

    return {
      downloadUrl,
      fileName,
      expiresInMinutes: 60,
      createdAt: now.toISOString()
    };

  } catch (error) {
    logger.error('❌ EXPORT: Error exporting CSV', { error, kind });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to export CSV');
  }
}

/**
 * Export transfers for a specific Pro user
 * Pro users can only export their own transfers
 */
export async function exportMyTransfersCsv(request: CallableRequest<ExportTransfersData>) {
  const { data, auth } = request;
  
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  // Check if user has Pro role
  if (!auth.token?.role || auth.token.role !== 'pro') {
    throw new HttpsError('permission-denied', 'Pro role required');
  }

  const { from, to } = data;

  try {
    logger.info('🔥 TRANSFER EXPORT: Starting Pro transfer export', { 
      proUid: auth.uid, 
      from, 
      to 
    });

    const db = getDb();
    const storage = getStorage();
    const bucket = storage.bucket();

    // Generate CSV data for user's transfers
    const csvData = await exportUserTransfers(db, auth.uid, from, to);
    
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `transfers_${auth.uid}_${timestamp}.csv`;

    // Upload to Cloud Storage
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

    // Generate signed URL (expires in 1 hour)
    const [downloadUrl] = await file.getSignedUrl({
      action: 'read',
      expires: new Date(now.getTime() + 60 * 60 * 1000) // 1 hour
    });

    logger.info('✅ TRANSFER EXPORT: Pro transfer export completed', { 
      fileName, 
      proUid: auth.uid 
    });

    return {
      downloadUrl,
      filename: fileName,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    };

  } catch (error) {
    logger.error('❌ TRANSFER EXPORT: Error exporting Pro transfers', { 
      error, 
      proUid: auth.uid 
    });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to export transfers');
  }
}

// ========================================
// EXPORT FUNCTIONS
// ========================================

async function exportJobs(db: any, dateFrom?: string, dateTo?: string): Promise<string> {
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

  snapshot.docs.forEach((doc: any) => {
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
      escapeCsv(data.address?.street || ''),
      formatDate(data.createdAt),
      formatDate(data.completedAt),
      escapeCsv(data.notes || '')
    ];
    csv += row.join(',') + '\n';
  });

  return csv;
}

async function exportPayments(db: any, dateFrom?: string, dateTo?: string): Promise<string> {
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

  snapshot.docs.forEach((doc: any) => {
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

async function exportDisputes(db: any, dateFrom?: string, dateTo?: string): Promise<string> {
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

  snapshot.docs.forEach((doc: any) => {
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

async function exportUsers(db: any, dateFrom?: string, dateTo?: string): Promise<string> {
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

  snapshot.docs.forEach((doc: any) => {
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

async function exportAbuseEvents(db: any, dateFrom?: string, dateTo?: string): Promise<string> {
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

  snapshot.docs.forEach((doc: any) => {
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

// ========================================
// UTILITY FUNCTIONS
// ========================================

function escapeCsv(value: string): string {
  if (typeof value !== 'string') return String(value);
  
  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function formatDate(timestamp: any): string {
  if (!timestamp) return '';
  
  try {
    let date: Date;
    if (timestamp.toDate) {
      // Firestore Timestamp
      date = timestamp.toDate();
    } else if (timestamp instanceof Date) {
      date = timestamp;
    } else {
      date = new Date(timestamp);
    }
    
    return date.toISOString();
  } catch (error) {
    logger.warn('Failed to format date', { timestamp, error });
    return '';
  }
}

async function exportUserTransfers(db: any, proUid: string, dateFrom?: string, dateTo?: string): Promise<string> {
  let query = db.collection('transfers')
    .where('proUid', '==', proUid)
    .orderBy('createdAt', 'desc');

  if (dateFrom) {
    query = query.where('createdAt', '>=', new Date(dateFrom));
  }
  if (dateTo) {
    query = query.where('createdAt', '<=', new Date(dateTo));
  }

  const snapshot = await query.limit(5000).get(); // Limit for Pro users

  const headers = [
    'Transfer ID', 'Job ID', 'Payment ID', 'Amount Net (€)', 'Amount Gross (€)', 
    'Platform Fee (€)', 'Currency', 'Status', 'Manual Release', 'Released By',
    'Created At', 'Completed At', 'Released At', 'Stripe Transfer ID', 
    'Connected Account ID'
  ];

  let csv = headers.join(',') + '\n';

  snapshot.docs.forEach((doc: any) => {
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