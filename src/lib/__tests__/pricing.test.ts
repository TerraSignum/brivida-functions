import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createFakeFirestore, FakeFieldValue, FakeTimestamp } from './helpers/fakeFirestore';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

jest.mock('firebase-functions/v2', () => ({
  logger,
}));

const messagingSend = jest.fn(async () => {});
const stripeCreatePaymentIntent = jest.fn(async () => ({} as any));

let fakeDb = createFakeFirestore();

jest.mock('firebase-admin', () => ({
  firestore: Object.assign(() => fakeDb, {
    FieldValue: FakeFieldValue,
    Timestamp: FakeTimestamp,
  }),
  messaging: jest.fn(() => ({
    send: messagingSend,
  })),
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => fakeDb),
  FieldValue: FakeFieldValue,
  Timestamp: FakeTimestamp,
}));

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    paymentIntents: {
      create: stripeCreatePaymentIntent,
    },
  })),
}));

describe('pricing callables', () => {
  let createPaymentIntentCF: typeof import('../pricing').createPaymentIntentCF;
  let generateRecurringJobsCF: typeof import('../pricing').generateRecurringJobsCF;
  let notifyExpressJobsCF: typeof import('../pricing').notifyExpressJobsCF;
  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  beforeEach(async () => {
    jest.resetModules();
    fakeDb = createFakeFirestore();
    messagingSend.mockReset();
    stripeCreatePaymentIntent.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
    consoleErrorSpy.mockClear();
    process.env.STRIPE_SECRET_KEY = 'sk_test';

    const pricingModule = await import('../pricing');
    createPaymentIntentCF = pricingModule.createPaymentIntentCF;
    generateRecurringJobsCF = pricingModule.generateRecurringJobsCF;
    notifyExpressJobsCF = pricingModule.notifyExpressJobsCF;
  });

  describe('createPaymentIntentCF', () => {
    it('creates payment intent and stores pricing breakdown', async () => {
      const usersRef = fakeDb.collection('users').doc('cust-1');
      await usersRef.set({ email: 'test@example.com' });

      const jobRef = fakeDb.collection('jobs').doc('job-1');
      await jobRef.set({
        customerUid: 'cust-1',
        window: {
          start: FakeTimestamp.fromDate(new Date('2025-01-01T10:00:00Z')),
          end: FakeTimestamp.fromDate(new Date('2025-01-01T12:00:00Z')),
        },
        recurrence: { type: 'weekly', intervalDays: 7 },
      });

      stripeCreatePaymentIntent.mockResolvedValue({
        id: 'pi_123',
        client_secret: 'secret_123',
      });

      const data = {
        jobId: 'job-1',
        customerUid: 'cust-1',
        category: 'M' as const,
        baseHours: 4,
        extras: ['windows_in'] as const,
        materialProvidedByPro: true,
        isExpress: true,
        isRecurring: true,
        occurrenceIndex: 2,
      };

      const result = await createPaymentIntentCF.run(data, {
        auth: { uid: 'cust-1' },
      });

      expect(result).toEqual({
        clientSecret: 'secret_123',
        amounts: expect.objectContaining({ amountTotal: expect.any(Number) }),
      });

      const paymentDoc = await fakeDb.collection('payments').doc('pi_123').get();
      expect(paymentDoc.exists).toBe(true);
      expect(paymentDoc.data()).toMatchObject({
        jobId: 'job-1',
        status: 'pending',
        customerUid: 'cust-1',
      });

      const updatedJob = await jobRef.get();
      expect(updatedJob.data()).toMatchObject({
        paymentId: 'pi_123',
        paymentStatus: 'pending',
        paidAmount: expect.any(Number),
      });

      expect(stripeCreatePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({
        amount: expect.any(Number),
        metadata: expect.objectContaining({
          jobId: 'job-1',
          customerUid: 'cust-1',
        }),
      }));
    });

    it('rejects when user context is missing', async () => {
      const data = {
        jobId: 'job-1',
        customerUid: 'cust-1',
        category: 'S' as const,
        baseHours: 3,
        extras: [],
        materialProvidedByPro: false,
        isExpress: false,
        isRecurring: false,
        occurrenceIndex: 1,
      };

      await expect(
        createPaymentIntentCF.run(data, { auth: undefined }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('validates pricing inputs', async () => {
      const usersRef = fakeDb.collection('users').doc('cust-1');
      await usersRef.set({ email: 'test@example.com' });

      const jobRef = fakeDb.collection('jobs').doc('job-1');
      await jobRef.set({ customerUid: 'cust-1' });

      const data = {
        jobId: 'job-1',
        customerUid: 'cust-1',
        category: 'S' as const,
        baseHours: 3,
        extras: ['unknown_extra'] as any,
        materialProvidedByPro: false,
        isExpress: false,
        isRecurring: false,
        occurrenceIndex: 1,
      };

      await expect(
        createPaymentIntentCF.run(data, { auth: { uid: 'cust-1' } }),
      ).rejects.toMatchObject({ code: 'internal' });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error creating payment intent:',
        expect.objectContaining({ code: 'invalid-argument' }),
      );
    });

    it('requires job ownership', async () => {
      const usersRef = fakeDb.collection('users').doc('cust-1');
      await usersRef.set({ email: 'test@example.com' });
      await fakeDb.collection('jobs').doc('job-1').set({ customerUid: 'cust-1' });

      const data = {
        jobId: 'job-1',
        customerUid: 'cust-1',
        category: 'S' as const,
        baseHours: 3,
        extras: [],
        materialProvidedByPro: false,
        isExpress: false,
        isRecurring: false,
        occurrenceIndex: 1,
      };

      await expect(
        createPaymentIntentCF.run(data, { auth: { uid: 'other-user' } }),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('returns not-found when customer document missing', async () => {
      await fakeDb.collection('jobs').doc('job-1').set({ customerUid: 'cust-1' });

      const data = {
        jobId: 'job-1',
        customerUid: 'cust-1',
        category: 'S' as const,
        baseHours: 3,
        extras: [],
        materialProvidedByPro: false,
        isExpress: false,
        isRecurring: false,
        occurrenceIndex: 1,
      };

      await expect(
        createPaymentIntentCF.run(data, { auth: { uid: 'cust-1' } }),
      ).rejects.toMatchObject({ code: 'internal' });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error creating payment intent:',
        expect.objectContaining({ code: 'not-found' }),
      );
    });

    it('wraps Stripe failures as internal errors', async () => {
      const usersRef = fakeDb.collection('users').doc('cust-1');
      await usersRef.set({ email: 'test@example.com' });
      await fakeDb.collection('jobs').doc('job-1').set({ customerUid: 'cust-1' });

      stripeCreatePaymentIntent.mockRejectedValue(new Error('stripe failure'));

      const data = {
        jobId: 'job-1',
        customerUid: 'cust-1',
        category: 'S' as const,
        baseHours: 3,
        extras: [],
        materialProvidedByPro: false,
        isExpress: false,
        isRecurring: false,
        occurrenceIndex: 1,
      };

      await expect(
        createPaymentIntentCF.run(data, { auth: { uid: 'cust-1' } }),
      ).rejects.toMatchObject({ code: 'internal' });
    });
  });

  describe('generateRecurringJobsCF', () => {
    it('creates recurring jobs and updates parent', async () => {
      const start = new Date('2025-01-01T10:00:00Z');
      const end = new Date('2025-01-01T12:00:00Z');

      await fakeDb.collection('jobs').doc('job-1').set({
        customerUid: 'cust-1',
        window: {
          start: FakeTimestamp.fromDate(start),
          end: FakeTimestamp.fromDate(end),
        },
        recurrence: { type: 'weekly', intervalDays: 7 },
        status: 'open',
      });

      const response = await generateRecurringJobsCF.run(
        { jobId: 'job-1', occurrences: 2 },
        { auth: { uid: 'cust-1' } },
      );

      expect(response).toEqual({
        success: true,
        generatedJobs: 2,
        nextDates: expect.arrayContaining([expect.any(String)]),
      });

      const parentJob = (await fakeDb.collection('jobs').doc('job-1').get()).data();
      expect(parentJob).toMatchObject({
        recurringSeriesGenerated: true,
        recurringJobsCount: 2,
      });

      const jobsSnapshot = await fakeDb.collection('jobs').get();
      const childJobs = jobsSnapshot.docs.filter((doc) => doc.data().parentJobId === 'job-1');
      expect(childJobs).toHaveLength(2);
      childJobs.forEach((doc, index) => {
        expect(doc.data()).toMatchObject({
          status: 'pending',
          occurrenceIndex: index + 2,
          paymentStatus: 'none',
        });
      });
    });

    it('requires authentication', async () => {
      await expect(
        generateRecurringJobsCF.run({ jobId: 'job-1', occurrences: 1 }, { auth: undefined }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('validates job ownership', async () => {
      await fakeDb.collection('jobs').doc('job-1').set({
        customerUid: 'cust-owner',
        recurrence: { type: 'weekly', intervalDays: 7 },
        window: {
          start: FakeTimestamp.fromDate(new Date()),
          end: FakeTimestamp.fromDate(new Date()),
        },
      });

      await expect(
        generateRecurringJobsCF.run({ jobId: 'job-1', occurrences: 1 }, { auth: { uid: 'other' } }),
      ).rejects.toMatchObject({ code: 'internal' });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error generating recurring jobs:',
        expect.objectContaining({ code: 'permission-denied' }),
      );
    });

    it('rejects when job not found', async () => {
      await expect(
        generateRecurringJobsCF.run({ jobId: 'missing', occurrences: 1 }, { auth: { uid: 'cust-1' } }),
      ).rejects.toMatchObject({ code: 'internal' });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error generating recurring jobs:',
        expect.objectContaining({ code: 'not-found' }),
      );
    });

    it('requires job to be recurring', async () => {
      await fakeDb.collection('jobs').doc('job-1').set({
        customerUid: 'cust-1',
        recurrence: { type: 'none', intervalDays: 0 },
        window: {
          start: FakeTimestamp.fromDate(new Date()),
          end: FakeTimestamp.fromDate(new Date()),
        },
      });

      await expect(
        generateRecurringJobsCF.run({ jobId: 'job-1', occurrences: 1 }, { auth: { uid: 'cust-1' } }),
      ).rejects.toMatchObject({ code: 'internal' });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error generating recurring jobs:',
        expect.objectContaining({ code: 'invalid-argument' }),
      );
    });
  });

  describe('notifyExpressJobsCF', () => {
    it('sends notifications to matching pros and updates job', async () => {
      const jobRef = fakeDb.collection('jobs').doc('job-1');
      await jobRef.set({
        isExpress: true,
        category: 'Deep Clean',
        services: ['cleaning'],
        baseHours: 4,
      });

      await fakeDb.collection('proProfiles').doc('pro-1').set({
        isActive: true,
        acceptsExpressJobs: true,
        services: ['cleaning', 'laundry'],
      });

      await fakeDb.collection('users').doc('pro-1').set({
        fcmToken: 'token-1',
      });

      const snapshot = {
        id: 'job-1',
        data: () => ({
          isExpress: true,
          category: 'Deep Clean',
          services: ['cleaning'],
          baseHours: 4,
        }),
        ref: jobRef,
      } as any;

  await notifyExpressJobsCF.run(snapshot, {} as any);

      expect(messagingSend).toHaveBeenCalledTimes(1);
      const updatedJob = (await jobRef.get()).data();
      expect(updatedJob).toMatchObject({
        expressNotificationsSent: 1,
      });
    });

    it('skips non-express jobs', async () => {
      const jobRef = fakeDb.collection('jobs').doc('job-1');
      await jobRef.set({ isExpress: false });

      const snapshot = {
        id: 'job-1',
        data: () => ({ isExpress: false }),
        ref: jobRef,
      } as any;

  await notifyExpressJobsCF.run(snapshot, {} as any);

      expect(messagingSend).not.toHaveBeenCalled();
    });
  });
});
