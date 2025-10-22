import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createFakeFirestore, FakeFieldValue, FakeTimestamp as HelperTimestamp } from '../../lib/__tests__/helpers/fakeFirestore';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

let fakeDb = createFakeFirestore();
let bucketSave: jest.Mock;
let bucketGetSignedUrl: jest.Mock;
let bucket: any;
let FirestoreTimestamp: typeof HelperTimestamp;

const enforceAdminRoleMock = jest.fn(async () => {});

jest.mock('firebase-functions/v2', () => ({
  logger,
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (_config: unknown, handler: any) => ({
    run: handler,
  }),
}));

jest.mock('firebase-admin/firestore', () => {
  const helpers = require('../../lib/__tests__/helpers/fakeFirestore');
  return {
    getFirestore: jest.fn(() => fakeDb),
    FieldValue: helpers.FakeFieldValue,
    Timestamp: helpers.FakeTimestamp,
  };
});

jest.mock('firebase-admin', () => ({
  firestore: Object.assign(() => fakeDb, {
    FieldValue: FakeFieldValue,
    Timestamp: HelperTimestamp,
  }),
}));

jest.mock('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({
    bucket: jest.fn(() => bucket),
  })),
}));

jest.mock('../../lib/auth', () => ({
  enforceAdminRole: enforceAdminRoleMock,
}));

describe('analytics aggregation', () => {
  let aggregateDaily: typeof import('../aggregation').aggregateDaily;

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    jest.resetModules();
    fakeDb = createFakeFirestore();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
    bucketSave = jest.fn(async () => {});
    bucketGetSignedUrl = jest.fn(async () => ['https://download.example']);
    bucket = {
      file: jest.fn(() => ({
        save: bucketSave,
        getSignedUrl: bucketGetSignedUrl,
      })),
    };

    jest.setSystemTime(new Date('2025-03-01T12:00:00Z'));

    const firestoreModule = await import('firebase-admin/firestore');
    FirestoreTimestamp = firestoreModule.Timestamp as unknown as typeof HelperTimestamp;

    const aggregationModule = await import('../aggregation');
    aggregateDaily = aggregationModule.aggregateDaily;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('aggregates analytics events into daily KPIs', async () => {
    await fakeDb.collection('analyticsEvents').doc('evt1').set({
      uid: 'cust-1',
      role: 'customer',
      name: 'job_created',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T01:15:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt2').set({
      uid: 'pro-1',
      role: 'pro',
      name: 'lead_created',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T02:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt3').set({
      uid: 'pro-1',
      role: 'pro',
      name: 'lead_accepted',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T03:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt4').set({
      uid: 'cust-1',
      role: 'customer',
      name: 'payment_captured',
      props: { amountEur: 45.678 },
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T04:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt5').set({
      uid: 'pro-1',
      role: 'pro',
      name: 'payment_released',
      props: { amountEur: 30.111 },
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T05:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt6').set({
      uid: 'cust-2',
      role: 'customer',
      name: 'payment_refunded',
      props: { amountEur: 5.444 },
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T06:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt7').set({
      uid: 'cust-1',
      role: 'customer',
      name: 'chat_msg_sent',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T07:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt8').set({
      uid: 'cust-1',
      role: 'customer',
      name: 'signup_success',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T08:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt9').set({
      uid: 'cust-1',
      role: 'customer',
      name: 'dispute_opened',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T09:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt10').set({
      uid: 'cust-1',
      role: 'customer',
      name: 'dispute_resolved',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T10:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt11').set({
      uid: 'cust-1',
      role: 'customer',
      name: 'review_submitted',
      props: { rating: 4 },
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T11:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt12').set({
      uid: 'cust-2',
      role: 'customer',
      name: 'review_submitted',
      props: { rating: 5 },
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T12:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt13').set({
      uid: 'cust-2',
      role: 'customer',
      name: 'push_delivered',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T13:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt14').set({
      uid: 'cust-2',
      role: 'customer',
      name: 'push_delivered',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T14:00:00Z')),
    });

    await fakeDb.collection('analyticsEvents').doc('evt15').set({
      uid: 'cust-2',
      role: 'customer',
      name: 'push_opened',
  ts: FirestoreTimestamp.fromDate(new Date('2025-03-01T15:00:00Z')),
    });

    const scheduledEvent = { scheduleTime: new Date().toISOString() } as any;
    await aggregateDaily.run(scheduledEvent);

    const docSnapshot = await fakeDb.collection('analyticsDaily').doc('20250301').get();
    const data = docSnapshot.data();

    expect(data).toBeDefined();
    expect(data?.kpis).toMatchObject({
      jobsCreated: 1,
      leadsCreated: 1,
      leadsAccepted: 1,
      paymentsCapturedEur: 45.68,
      paymentsReleasedEur: 30.11,
      refundsEur: 5.44,
      chatMessages: 1,
      activePros: 1,
      activeCustomers: 2,
      newUsers: 1,
      disputesOpened: 1,
      disputesResolved: 1,
      avgRating: 4.5,
      ratingsCount: 2,
      pushDelivered: 2,
      pushOpened: 1,
      pushOpenRate: 50,
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Daily aggregation completed'), expect.any(Object));
  });

  it('skips aggregation when no events are present', async () => {
    const scheduledEvent = { scheduleTime: new Date().toISOString() } as any;
    await aggregateDaily.run(scheduledEvent);

    const collectionSnapshot = await fakeDb.collection('analyticsDaily').get();
    expect(collectionSnapshot.empty).toBe(true);
    expect(logger.info).toHaveBeenCalledWith('📊 ANALYTICS: No events found for aggregation');
  });
});

describe('analytics helpers', () => {
  let logServerEvent: typeof import('../helpers').logServerEvent;

  beforeEach(async () => {
    jest.resetModules();
    fakeDb = createFakeFirestore();
    logger.info.mockReset();
    logger.error.mockReset();
    process.env.ANALYTICS_SALT = 'unit_test_salt';

    const helpersModule = await import('../helpers');
    logServerEvent = helpersModule.logServerEvent;
  });

  afterEach(() => {
    delete process.env.ANALYTICS_SALT;
  });

  it('logs sanitized server events with hashed context', async () => {
    const request = {
      ip: '10.0.0.5',
      get: (header: string) => (header === 'User-Agent' ? 'UnitTestAgent/1.0' : undefined),
    };

    await logServerEvent({
      uid: 'user-1',
      role: 'pro',
      name: 'payment_captured',
      props: {
        amountEur: 19.99,
        email: 'hidden@example.com',
        disputeReason: 'address issue',
      },
      request,
    });

    const snapshot = await fakeDb.collection('analyticsEvents').get();
    expect(snapshot.size).toBe(1);

    const event = snapshot.docs[0].data();

    expect(event.uid).toBe('user-1');
    expect(event.role).toBe('pro');
    expect(event.props).toEqual({ amountEur: 19.99 });
    expect(event.context.ipHash).toBeDefined();
    expect(event.context.uaHash).toBeDefined();
    expect(event.context.ipHash).not.toContain('10.0.0.5');
    expect(event.sessionId).toMatch(/^server_/);

    expect(logger.info).toHaveBeenCalledWith('📊 ANALYTICS: Server event logged', {
      name: 'payment_captured',
      uid: 'user-1',
      role: 'pro',
    });
  });
});

describe('analytics exports', () => {
  let exportAnalyticsCsv: typeof import('../exports').exportAnalyticsCsv;

  beforeEach(async () => {
    jest.resetModules();
    fakeDb = createFakeFirestore();
    logger.info.mockReset();
    logger.error.mockReset();
    enforceAdminRoleMock.mockReset();

    bucketSave = jest.fn(async () => {});
    bucketGetSignedUrl = jest.fn(async () => ['https://download.example']);
    bucket = {
      file: jest.fn(() => ({
        save: bucketSave,
        getSignedUrl: bucketGetSignedUrl,
      })),
    };

    const firestoreModule = await import('firebase-admin/firestore');
    FirestoreTimestamp = firestoreModule.Timestamp as unknown as typeof HelperTimestamp;

    await fakeDb.collection('analyticsEvents').doc('evt-1').set({
      ts: FirestoreTimestamp.fromDate(new Date('2025-02-15T09:00:00Z')),
      src: 'server',
      name: 'payment_captured',
      uid: 'cust-1',
      role: 'customer',
      sessionId: 'sess-1',
      context: { platform: 'app', appVersion: '1.2.3' },
      props: { amountEur: 42.5 },
    });

    await fakeDb.collection('analyticsDaily').doc('20250215').set({
      kpis: {
        jobsCreated: 2,
        leadsCreated: 3,
      },
      updatedAt: FirestoreTimestamp.fromDate(new Date('2025-02-16T00:00:00Z')),
    });

    const exportsModule = await import('../exports');
    exportAnalyticsCsv = exportsModule.exportAnalyticsCsv;
  });

  it('requires authentication', async () => {
    await expect(
      exportAnalyticsCsv.run({
        data: { type: 'events' },
        auth: null,
      } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('exports analytics events to CSV for admins', async () => {
    const result = await exportAnalyticsCsv.run({
      data: {
        type: 'events',
        dateFrom: '2025-02-14',
        dateTo: '2025-02-16',
      },
      auth: { uid: 'admin-1' },
    } as any);

    expect(enforceAdminRoleMock).toHaveBeenCalledWith({ uid: 'admin-1' });
    expect(bucket.file).toHaveBeenCalledWith(expect.stringMatching(/^analytics-exports\/analytics_events_/));
    expect(bucketSave).toHaveBeenCalled();
    expect(bucketGetSignedUrl).toHaveBeenCalled();

  const [csvData, options] = bucketSave.mock.calls[0] as [string, any];
    expect(csvData).toContain('Event Name');
    expect(csvData).toContain('payment_captured');
  expect(options.metadata.metadata.type).toBe('events');

    expect(result.downloadUrl).toBe('https://download.example');
    expect(result.filename).toMatch(/^analytics_events_/);
    expect(result.expiresAt).toBeDefined();
  });

  it('exports daily KPIs to CSV', async () => {
    const result = await exportAnalyticsCsv.run({
      data: { type: 'daily' },
      auth: { uid: 'admin-2' },
    } as any);

    expect(enforceAdminRoleMock).toHaveBeenCalledWith({ uid: 'admin-2' });
    expect(bucket.file).toHaveBeenCalledWith(expect.stringMatching(/^analytics-exports\/analytics_daily_/));
    const [csvData] = bucketSave.mock.calls[0];
    expect(csvData).toContain('Jobs Created');
    expect(csvData).toContain('20250215');

    expect(result.filename).toMatch(/^analytics_daily_/);
  });
});
