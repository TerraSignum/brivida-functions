import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HttpsError } from 'firebase-functions/v2/https';
import { createFakeFirestore, FakeFieldValue, FakeTimestamp } from './helpers/fakeFirestore';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

let fakeDb = createFakeFirestore();

const firestoreNamespace = () => fakeDb;
(firestoreNamespace as any).FieldValue = FakeFieldValue;
(firestoreNamespace as any).Timestamp = FakeTimestamp;

jest.mock('firebase-admin', () => ({
  firestore: firestoreNamespace,
}));

const enforceAdminRoleMock = jest.fn(async (_auth: any) => undefined);
const isAdminMock = jest.fn(async (_auth: any) => true);
const runDataRetentionCleanupMock = jest.fn(async () => ({}));
const getKpiSummaryMock = jest.fn(async () => ({}));
const calculateAdvancedMetricsMock = jest.fn(async () => ({}));
const reviewsServiceMock = {
  validateReview: jest.fn(() => ({ valid: true })),
  submitReview: jest.fn(async () => undefined),
  moderateReview: jest.fn(async () => undefined),
  hasReviewedJob: jest.fn(async () => undefined),
  getProRatingAggregate: jest.fn(async () => ({})),
} as {
  validateReview: jest.Mock;
  submitReview: jest.Mock;
  moderateReview: jest.Mock;
  hasReviewedJob: jest.Mock;
  getProRatingAggregate: jest.Mock;
};

function getFirebaseV2Shared(): {
  HttpsError?: any;
  onCall?: jest.Mock;
  onRequest?: jest.Mock;
} {
  const globalObj = globalThis as Record<string, unknown>;
  const key = '__firebaseV2Shared';
  if (!globalObj[key]) {
    globalObj[key] = {};
  }
  return globalObj[key] as {
    HttpsError?: any;
    onCall?: jest.Mock;
    onRequest?: jest.Mock;
  };
}

jest.mock('firebase-functions/v2', () => {
  const shared = getFirebaseV2Shared();
  const MockHttpsError = class extends Error {
    code: string;
    details?: unknown;
    httpErrorCode?: { status: number; canonicalName: string };

    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
      this.httpErrorCode = { status: 500, canonicalName: code.toUpperCase().replace(/-/g, '_') };
    }
  };

  const onCall = jest.fn((_config: unknown, handler: any) => ({
    run: async (dataOrRequest: any, context?: any) => {
      if (dataOrRequest && typeof dataOrRequest === 'object' && 'auth' in dataOrRequest) {
        return handler(dataOrRequest);
      }
      return handler({ data: dataOrRequest, auth: context?.auth });
    },
  }));

  const onRequest = jest.fn((_config: unknown, handler: any) => handler);

  shared.HttpsError = MockHttpsError;
  shared.onCall = onCall;
  shared.onRequest = onRequest;

  return {
    logger,
    https: {
      onCall,
      onRequest,
      HttpsError: MockHttpsError,
    },
  };
});

jest.mock('firebase-functions/v2/https', () => {
  const shared = getFirebaseV2Shared();
  const MockHttpsError =
    shared.HttpsError ??
    class extends Error {
      code: string;
      details?: unknown;
      constructor(code: string, message: string, details?: unknown) {
        super(message);
        this.code = code;
        this.details = details;
      }
    };

  const onCall =
    shared.onCall ??
    jest.fn((_config: unknown, handler: any) => ({
      run: async (dataOrRequest: any, context?: any) => {
        if (dataOrRequest && typeof dataOrRequest === 'object' && 'auth' in dataOrRequest) {
          return handler(dataOrRequest);
        }
        return handler({ data: dataOrRequest, auth: context?.auth });
      },
    }));

  const onRequest =
    shared.onRequest ??
    jest.fn((_config: unknown, handler: any) => async (req: any, res: any) => handler(req, res));

  return {
    HttpsError: MockHttpsError,
    onCall,
    onRequest,
  };
});

jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => fakeDb),
  FieldValue: FakeFieldValue,
  Timestamp: FakeTimestamp,
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({
    send: jest.fn(),
    sendEachForMulticast: jest.fn(),
  })),
}));

jest.mock('../auth', () => ({
  enforceAdminRole: enforceAdminRoleMock,
  isAdmin: isAdminMock,
}));

jest.mock('../retention', () => ({
  runDataRetentionCleanup: runDataRetentionCleanupMock,
  initializeRetentionConfig: jest.fn(),
}));

jest.mock('../kpi', () => ({
  getKpiSummary: getKpiSummaryMock,
  calculateAdvancedMetrics: calculateAdvancedMetricsMock,
}));

jest.mock('../reviews', () => ({
  reviewsService: reviewsServiceMock,
}));

jest.mock('../firestore', () => ({
  getDb: jest.fn(() => fakeDb),
  getDbAdmin: jest.fn(() => fakeDb),
}));

describe('admin enforcement call flows', () => {
  let triggerDataRetentionCF: typeof import('../../index').triggerDataRetentionCF;
  let getKpiSummaryCF: typeof import('../../index').getKpiSummaryCF;
  let getAdvancedMetricsCF: typeof import('../../index').getAdvancedMetricsCF;
  let moderateReviewCF: typeof import('../../index').moderateReviewCF;
  let setFlags: typeof import('../health').setFlags;

  beforeAll(async () => {
    const indexModule = await import('../../index');
    triggerDataRetentionCF = indexModule.triggerDataRetentionCF;
    getKpiSummaryCF = indexModule.getKpiSummaryCF;
    getAdvancedMetricsCF = indexModule.getAdvancedMetricsCF;
    moderateReviewCF = indexModule.moderateReviewCF;

    const healthModule = await import('../health');
    setFlags = healthModule.setFlags;
  });

  beforeEach(() => {
    fakeDb = createFakeFirestore();

    enforceAdminRoleMock.mockReset();
    enforceAdminRoleMock.mockResolvedValue(undefined);
    isAdminMock.mockReset();
    runDataRetentionCleanupMock.mockReset();
    getKpiSummaryMock.mockReset();
    calculateAdvancedMetricsMock.mockReset();
    reviewsServiceMock.validateReview.mockReset();
    reviewsServiceMock.validateReview.mockReturnValue({ valid: true });
    reviewsServiceMock.submitReview.mockReset();
  reviewsServiceMock.submitReview.mockImplementation(async () => undefined);
    reviewsServiceMock.moderateReview.mockReset();
  reviewsServiceMock.moderateReview.mockImplementation(async () => undefined);
    reviewsServiceMock.hasReviewedJob.mockReset();
  reviewsServiceMock.hasReviewedJob.mockImplementation(async () => false);
    reviewsServiceMock.getProRatingAggregate.mockReset();
  reviewsServiceMock.getProRatingAggregate.mockImplementation(async () => ({}));
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();

    const firestoreModule = jest.requireMock('firebase-admin/firestore') as {
      getFirestore: jest.Mock;
    };
    firestoreModule.getFirestore.mockReturnValue(fakeDb);

    const firestoreHelpersModule = jest.requireMock('../firestore') as {
      getDb: jest.Mock;
      getDbAdmin: jest.Mock;
    };
    firestoreHelpersModule.getDb.mockReturnValue(fakeDb);
    firestoreHelpersModule.getDbAdmin.mockReturnValue(fakeDb);
  });

  it('allows admin to trigger data retention cleanup', async () => {
  runDataRetentionCleanupMock.mockResolvedValue({ jobsPrivateDeleted: 2 });

  const response = await (triggerDataRetentionCF as any).run({}, { auth: { uid: 'admin-uid' } });

    expect(enforceAdminRoleMock).toHaveBeenCalledWith({ uid: 'admin-uid' });
    expect(runDataRetentionCleanupMock).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      success: true,
      triggeredBy: 'admin-uid',
      result: { jobsPrivateDeleted: 2 },
    });
  });

  it('rejects when admin enforcement fails for retention cleanup', async () => {
    const error = new HttpsError('permission-denied', 'Admin role required');
  enforceAdminRoleMock.mockRejectedValueOnce(error);

    await expect((triggerDataRetentionCF as any).run({}, { auth: { uid: 'user-1' } })).rejects.toBe(error);
    expect(runDataRetentionCleanupMock).not.toHaveBeenCalled();
  });

  it('enforces admin role for KPI summary callable', async () => {
  getKpiSummaryMock.mockResolvedValue({ revenue: 123 });

    const payload = { startDate: '2025-01-01', endDate: '2025-01-31' };
    const result = await (getKpiSummaryCF as any).run(payload, { auth: { uid: 'admin-2' } });

    expect(enforceAdminRoleMock).toHaveBeenCalledWith({ uid: 'admin-2' });
    expect(getKpiSummaryMock).toHaveBeenCalledWith('2025-01-01', '2025-01-31');
    expect(result).toEqual({ revenue: 123 });
  });

  it('enforces admin role for advanced KPI metrics callable', async () => {
  calculateAdvancedMetricsMock.mockResolvedValue({ churnRate: 0.1 });

    const result = await (getAdvancedMetricsCF as any).run({}, { auth: { uid: 'admin-3' } });

    expect(enforceAdminRoleMock).toHaveBeenCalledWith({ uid: 'admin-3' });
    expect(calculateAdvancedMetricsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ churnRate: 0.1 });
  });

  it('enforces admin role for review moderation flow', async () => {
    await (moderateReviewCF as any).run({ reviewId: 'rev-1', action: 'visible' }, { auth: { uid: 'admin-4' } });

    expect(enforceAdminRoleMock).toHaveBeenCalledWith({ uid: 'admin-4' });
    expect(reviewsServiceMock.moderateReview).toHaveBeenCalledWith({
      request: { reviewId: 'rev-1', action: 'visible', reason: undefined },
      adminUid: 'admin-4',
      auth: { uid: 'admin-4' },
    });
  });

  it('writes admin audit log when flags are updated', async () => {
    const proRef = fakeDb.collection('proProfiles').doc('pro-1');
    await proRef.set({ flags: { softBanned: false, hardBanned: false } });

    await setFlags({
      data: { proUid: 'pro-1', softBanned: true, notes: 'Quality issues' },
      auth: { uid: 'admin-10' },
    } as any);

    const updatedPro = await proRef.get();
    expect(updatedPro.data()).toMatchObject({
      flags: expect.objectContaining({ softBanned: true, notes: 'Quality issues' }),
    });

    const adminLogs = await fakeDb.collection('adminLogs').get();
    expect(adminLogs.size).toBe(1);
    const logData = adminLogs.docs[0].data();
    expect(logData).toMatchObject({
      actorUid: 'admin-10',
      action: 'setFlag',
      targetId: 'pro-1',
    });
  });
});
