import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createFakeFirestore, FakeFieldValue, FakeTimestamp } from './helpers/fakeFirestore';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('firebase-functions/v2', () => ({
  logger,
}));

let fakeDb = createFakeFirestore();
const sendPushNotification = jest.fn(async () => {});
const createRefundMock = jest.fn(async () => ({ id: 're_123' }));
const isAdminMock = jest.fn(async () => false);

jest.mock('../firestore', () => ({
  getDb: () => fakeDb,
}));

jest.mock('../notifications', () => ({
  notificationService: {
    sendPushNotification,
  },
}));

jest.mock('../stripe', () => ({
  createRefund: createRefundMock,
}));

jest.mock('../auth', () => ({
  isAdmin: isAdminMock,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: FakeFieldValue,
  Timestamp: FakeTimestamp,
}));

describe('disputes module', () => {
  let disputesModule: typeof import('../disputes');

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    jest.resetModules();
    fakeDb = createFakeFirestore();
    sendPushNotification.mockReset();
    createRefundMock.mockReset();
    isAdminMock.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
    jest.setSystemTime(new Date('2025-01-01T10:00:00Z'));
    FakeTimestamp.setNow(new Date('2025-01-01T10:00:00Z'));

    disputesModule = await import('../disputes');
  });

  describe('openDispute', () => {
    const basePayment = {
      customerUid: 'cust-1',
      stripePaymentIntentId: 'pi_1',
      status: 'captured',
      capturedAt: FakeTimestamp.fromDate(new Date('2025-01-01T09:30:00Z')),
      amountGross: 120,
    };

    beforeEach(async () => {
      await fakeDb.collection('payments').doc('pay-1').set(basePayment);
      await fakeDb.collection('jobs').doc('job-1').set({
        proUid: 'pro-1',
      });
    });

    it('opens a dispute and notifies pro', async () => {
      const result = await disputesModule.openDispute({
        data: {
          jobId: 'job-1',
          paymentId: 'pay-1',
          reason: 'poor_quality',
          description: 'Issues with cleaning',
          requestedAmount: 50,
          mediaPaths: ['evidence.jpg'],
        },
        auth: { uid: 'cust-1' },
      } as any);

      expect(result).toHaveProperty('caseId');
      expect(sendPushNotification).toHaveBeenCalledWith(expect.objectContaining({
        recipientUid: 'pro-1',
      }));

      const caseId = result.caseId;
      const disputeDoc = await fakeDb.collection('disputes').doc(caseId).get();
      expect(disputeDoc.exists).toBe(true);
      expect(disputeDoc.data()).toMatchObject({
        status: 'open',
        requestedAmount: 50,
        evidence: expect.arrayContaining([expect.objectContaining({ path: 'evidence.jpg' })]),
      });
    });

    it('rejects when payment not found', async () => {
      await expect(
        disputesModule.openDispute({
          data: {
            jobId: 'job-1',
            paymentId: 'missing',
            reason: 'other',
            description: 'desc',
            requestedAmount: 10,
          },
          auth: { uid: 'cust-1' },
        } as any),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('rejects if caller is not customer', async () => {
      await expect(
        disputesModule.openDispute({
          data: {
            jobId: 'job-1',
            paymentId: 'pay-1',
            reason: 'other',
            description: 'desc',
            requestedAmount: 10,
          },
          auth: { uid: 'other-user' },
        } as any),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('rejects when payment status invalid', async () => {
      await fakeDb.collection('payments').doc('pay-1').update({ status: 'pending' });
      await expect(
        disputesModule.openDispute({
          data: {
            jobId: 'job-1',
            paymentId: 'pay-1',
            reason: 'other',
            description: 'desc',
            requestedAmount: 10,
          },
          auth: { uid: 'cust-1' },
        } as any),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    });

    it('rejects when dispute deadline exceeded', async () => {
      await fakeDb.collection('payments').doc('pay-1').update({
        capturedAt: FakeTimestamp.fromDate(new Date('2024-12-30T08:00:00Z')),
      });

      await expect(
        disputesModule.openDispute({
          data: {
            jobId: 'job-1',
            paymentId: 'pay-1',
            reason: 'other',
            description: 'desc',
            requestedAmount: 10,
          },
          auth: { uid: 'cust-1' },
        } as any),
      ).rejects.toMatchObject({ code: 'deadline-exceeded' });
    });

    it('rejects when another active dispute exists', async () => {
      await fakeDb.collection('disputes').doc('existing').set({
        jobId: 'job-1',
        status: 'open',
      });

      await expect(
        disputesModule.openDispute({
          data: {
            jobId: 'job-1',
            paymentId: 'pay-1',
            reason: 'other',
            description: 'desc',
            requestedAmount: 10,
          },
          auth: { uid: 'cust-1' },
        } as any),
      ).rejects.toMatchObject({ code: 'already-exists' });
    });
  });

  describe('addEvidence', () => {
    beforeEach(async () => {
      await fakeDb.collection('disputes').doc('case-1').set({
        customerUid: 'cust-1',
        proUid: 'pro-1',
        status: 'open',
        evidence: [],
        proResponse: [],
        audit: [],
      });
    });

    it('allows customer to add text evidence', async () => {
      await disputesModule.addEvidence({
        data: {
          caseId: 'case-1',
          role: 'customer',
          text: 'More context',
        },
        auth: { uid: 'cust-1' },
      } as any);

      const updated = (await fakeDb.collection('disputes').doc('case-1').get()).data();
      expect(updated?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'More context' })]));
      expect(sendPushNotification).toHaveBeenCalledWith(expect.objectContaining({
        recipientUid: 'pro-1',
        data: expect.objectContaining({ role: 'customer' }),
      }));
    });

    it('moves dispute to under_review on first pro response', async () => {
      await disputesModule.addEvidence({
        data: {
          caseId: 'case-1',
          role: 'pro',
          text: 'Pro response',
        },
        auth: { uid: 'pro-1' },
      } as any);

      const updated = (await fakeDb.collection('disputes').doc('case-1').get()).data();
      expect(updated?.status).toBe('under_review');
      expect(updated?.proResponse).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Pro response' })]));
    });

    it('prevents unauthorized access', async () => {
      await expect(
        disputesModule.addEvidence({
          data: {
            caseId: 'case-1',
            role: 'customer',
            text: 'content',
          },
          auth: { uid: 'intruder' },
        } as any),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('blocks evidence on resolved disputes', async () => {
      await fakeDb.collection('disputes').doc('case-1').update({ status: 'resolved_no_refund' });
      await expect(
        disputesModule.addEvidence({
          data: {
            caseId: 'case-1',
            role: 'customer',
            text: 'content',
          },
          auth: { uid: 'cust-1' },
        } as any),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    });
  });

  describe('resolveDispute', () => {
    beforeEach(async () => {
      await fakeDb.collection('disputes').doc('case-1').set({
        status: 'under_review',
        paymentId: 'pay-1',
        jobId: 'job-1',
        customerUid: 'cust-1',
        proUid: 'pro-1',
        audit: [],
      });

      await fakeDb.collection('payments').doc('pay-1').set({
        amountGross: 100,
        stripePaymentIntentId: 'pi_1',
      });

      sendPushNotification.mockResolvedValue(undefined);
      createRefundMock.mockResolvedValue({ id: 're_1' });
      isAdminMock.mockResolvedValue(true);
    });

    it('allows admin to issue full refund', async () => {
      const result = await disputesModule.resolveDispute({
        data: {
          caseId: 'case-1',
          decision: 'refund_full',
        },
        auth: { uid: 'admin-1' },
      } as any);

      expect(result).toMatchObject({ success: true, refundAmount: 100 });
      expect(createRefundMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 10000 }));

      const disputeDoc = (await fakeDb.collection('disputes').doc('case-1').get()).data();
      expect(disputeDoc?.status).toBe('resolved_refund_full');

      const paymentDoc = (await fakeDb.collection('payments').doc('pay-1').get()).data();
      expect(paymentDoc).toMatchObject({ status: 'refunded', refundedAmount: 100 });
    });

    it('validates partial refund amount', async () => {
      await expect(
        disputesModule.resolveDispute({
          data: {
            caseId: 'case-1',
            decision: 'refund_partial',
            amount: 150,
          },
          auth: { uid: 'admin-1' },
        } as any),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('requires admin privileges', async () => {
      isAdminMock.mockResolvedValue(false);
      await expect(
        disputesModule.resolveDispute({
          data: {
            caseId: 'case-1',
            decision: 'no_refund',
          },
          auth: { uid: 'not-admin' },
        } as any),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });
  });

  describe('scheduled helpers', () => {
    it('expires disputes past deadlines', async () => {
      await fakeDb.collection('disputes').doc('case-open').set({
        status: 'open',
        deadlineProResponse: FakeTimestamp.fromDate(new Date('2024-12-31T10:00:00Z')),
        deadlineDecision: FakeTimestamp.fromDate(new Date('2024-12-31T10:00:00Z')),
        audit: [],
      });

  const result = await disputesModule.expireDisputes();
  expect(result).toEqual({ updated: 2 });

      const updated = (await fakeDb.collection('disputes').doc('case-open').get()).data();
      expect(updated?.status).toBe('expired');
    });

    it('returns reminder count for pending disputes', async () => {
      await fakeDb.collection('disputes').doc('case-review').set({
        status: 'under_review',
        deadlineDecision: FakeTimestamp.fromDate(new Date('2025-01-01T18:00:00Z')),
      });

      const result = await disputesModule.remindModeration();
      expect(result).toEqual({ reminded: 1 });
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.anything());
    });
  });
});
