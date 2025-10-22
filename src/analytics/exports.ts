import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { enforceAdminRole } from '../lib/auth';

interface ExportAnalyticsRequest {
  type: 'events' | 'daily';
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Export analytics data as CSV for admin users
 */
export const exportAnalyticsCsv = onCall({
  region: 'europe-west1',
}, async (request): Promise<{
  downloadUrl: string;
  filename: string;
  expiresAt: string;
}> => {
  const { data, auth } = request;
  
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  // Check if user has admin role
  await enforceAdminRole(auth);

  const { type, dateFrom, dateTo } = data as ExportAnalyticsRequest;

  // Validate export type
  if (!type || !['events', 'daily'].includes(type)) {
    throw new HttpsError('invalid-argument', 'Invalid export type. Must be "events" or "daily"');
  }

  try {
    logger.info('🔥 ANALYTICS EXPORT: Starting export', { 
      type, 
      adminUid: auth.uid, 
      dateFrom, 
      dateTo 
    });

    const db = getFirestore();
    const storage = getStorage();
    const bucket = storage.bucket();

    let csvData: string;
    let filename: string;

    if (type === 'events') {
      csvData = await exportEventsData(db, dateFrom, dateTo);
      filename = `analytics_events_${auth.uid}_${Date.now()}.csv`;
    } else {
      csvData = await exportDailyData(db, dateFrom, dateTo);
      filename = `analytics_daily_${auth.uid}_${Date.now()}.csv`;
    }

    // Upload to Cloud Storage
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

    // Generate signed URL (expires in 1 hour)
    const [downloadUrl] = await file.getSignedUrl({
      action: 'read',
      expires: new Date(Date.now() + 60 * 60 * 1000) // 1 hour
    });

    logger.info('✅ ANALYTICS EXPORT: Export completed', { 
      filename, 
      type,
      adminUid: auth.uid 
    });

    return {
      downloadUrl,
      filename,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };

  } catch (error) {
    logger.error('❌ ANALYTICS EXPORT: Export failed', { error, type });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to export analytics data');
  }
});

/**
 * Export events data as CSV
 */
async function exportEventsData(db: FirebaseFirestore.Firestore, dateFrom?: string, dateTo?: string): Promise<string> {
  let query = db.collection('analyticsEvents').orderBy('ts', 'desc');

  // Apply date filters if provided
  if (dateFrom) {
    const startDate = new Date(dateFrom);
    query = query.where('ts', '>=', Timestamp.fromDate(startDate));
  }

  if (dateTo) {
    const endDate = new Date(dateTo);
    endDate.setHours(23, 59, 59, 999); // End of day
    query = query.where('ts', '<=', Timestamp.fromDate(endDate));
  }

  // Limit to prevent memory issues
  query = query.limit(10000);

  const snapshot = await query.get();

  // CSV headers
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

  const rows: string[] = [headers.join(',')];

  snapshot.docs.forEach(doc => {
    const event = doc.data();
    
    const row = [
      event.ts?.toDate?.()?.toISOString() || '',
      event.src || '',
      event.name || '',
      event.uid || '',
      event.role || '',
      event.sessionId || '',
      event.context?.platform || '',
      event.context?.appVersion || '',
      JSON.stringify(event.props || {}).replace(/"/g, '""'), // Escape quotes for CSV
    ];

    rows.push(row.map(cell => `"${cell}"`).join(','));
  });

  return rows.join('\n');
}

/**
 * Export daily aggregated data as CSV
 */
async function exportDailyData(db: FirebaseFirestore.Firestore, dateFrom?: string, dateTo?: string): Promise<string> {
  let query = db.collection('analyticsDaily').orderBy('__name__', 'desc');

  // Apply date filters for document IDs if provided
  if (dateFrom) {
    const startDateId = formatDateId(new Date(dateFrom));
    query = query.where('__name__', '>=', startDateId);
  }

  if (dateTo) {
    const endDateId = formatDateId(new Date(dateTo));
    query = query.where('__name__', '<=', endDateId);
  }

  // Limit to prevent memory issues
  query = query.limit(365); // Max 1 year of daily data

  const snapshot = await query.get();

  // CSV headers for daily KPIs
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

  const rows: string[] = [headers.join(',')];

  snapshot.docs.forEach(doc => {
    const daily = doc.data();
    const kpis = daily.kpis || {};
    
    const row = [
      doc.id, // Date in yyyyMMdd format
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
      daily.updatedAt?.toDate?.()?.toISOString() || '',
    ];

    rows.push(row.map(cell => `"${cell}"`).join(','));
  });

  return rows.join('\n');
}

/**
 * Format date as yyyyMMdd for document ID
 */
function formatDateId(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}