import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { CallableRequest } from 'firebase-functions/v2/https';

let paymentsStore: Record<string, any> = {};
let transfersStore: Record<string, any> = {};
let refundsStore: Record<string, any> = {};
let jobsStore: Record<string, any> = {};
let usersStore: Record<string, any> = {};

function resetStores() {
  paymentsStore = {};
  transfersStore = {};
  refundsStore = {};
  jobsStore = {};
  usersStore = {};
}

function createDocInterface(store: Record<string, any>, id: string) {
  return {
    async get() {
      const data = store[id];
      return {
        exists: data !== undefined,
        data: () => data,
      };
    },
    async set(value: any) {
      store[id] = value;
    },
    async update(updates: Record<string, any>) {
      const current = store[id] ?? {};
      store[id] = { ...current, ...updates };
    },
  };
}

function createQueryDocs(
  store: Record<string, any>,
  predicate: (data: any) => boolean,
  limit: number,
) {
  const entries = Object.entries(store)
    .filter(([, data]) => predicate(data))
    .slice(0, limit);

  return entries.map(([id]) => ({
    id,
    data: () => store[id],
    ref: {
      update: async (updates: Record<string, any>) => {
        const current = store[id] ?? {};
        store[id] = { ...current, ...updates };
      },
    },
  }));
}

async function fetchPaymentsByField(
  field: string,
  value: unknown,
  count: number,
) {
  const docs = createQueryDocs(
    paymentsStore,
    (data) => data?.[field] === value,
    count,
  );

  return {
    empty: docs.length === 0,
    docs,
  };
}

function buildPaymentsWhere(field: string, value: unknown) {
  return {
    limit(count: number) {
      return {
        get: () => fetchPaymentsByField(field, value, count),
      };
    },
  };
}

function createPaymentsCollection() {
  return {
    doc: (id: string) => createDocInterface(paymentsStore, id),
    where: (field: string, _op: string, value: unknown) =>
      buildPaymentsWhere(field, value),
  };
}

function createGenericCollection(store: Record<string, any>) {
  return {
    doc: (id: string) => createDocInterface(store, id),
  };
}

resetStores();

jest.mock('../firestore', () => {
  const getJob = jest.fn(async (jobId: string) => jobsStore[jobId] ?? null);
  const updateJob = jest.fn(async (jobId: string, updates: Record<string, any>) => {
    const current = jobsStore[jobId] ?? {};
    jobsStore[jobId] = { ...current, ...updates };
  });

  return {
    firestoreHelpers: {
      collections: {
        payments: () => createPaymentsCollection(),
        transfers: () => createGenericCollection(transfersStore),
        refunds: () => createGenericCollection(refundsStore),
        users: () => createGenericCollection(usersStore),
        jobs: () => createGenericCollection(jobsStore),
      },
      getJob,
      updateJob,
    },
  };
});

jest.mock('../stripe', () => ({
  createPaymentIntent: jest.fn(),
  createTransfer: jest.fn(),
  createRefund: jest.fn(),
  calculateFees: jest.fn(),
}));

jest.mock('../auth', () => ({
  isAdmin: jest.fn(),
}));

jest.mock('../../analytics/helpers', () => ({
  logServerEvent: jest.fn(),
}));

import { firestoreHelpers } from '../firestore';
import * as stripeService from '../stripe';
import { isAdmin } from '../auth';
import { logServerEvent } from '../../analytics/helpers';
import {
  createPaymentIntentHandler,
  releaseTransferHandler,
  partialRefundHandler,
  handlePaymentIntentSucceeded,
  handleTransferCreated,
  handleChargeRefunded,
} from '../payments';

type AuthContext = NonNullable<CallableRequest<unknown>['auth']>;

type RequestAuth = {
  uid: string;
  token?: Record<string, unknown>;
};

function makeRequest<TData>(data: TData, auth: RequestAuth | null): CallableRequest<TData> {
  return {
    auth: auth as AuthContext | null,
    data,
  } as unknown as CallableRequest<TData>;
}

const mockedStripe = jest.mocked(stripeService);
const mockedIsAdmin = jest.mocked(isAdmin);
const mockedLogEvent = jest.mocked(logServerEvent);
const mockedFirestore = jest.mocked(firestoreHelpers);

beforeEach(() => {
  resetStores();
  jest.clearAllMocks();

  mockedStripe.createPaymentIntent.mockResolvedValue({
    id: 'pi_test',
    client_secret: 'secret_test',
  } as any);

  mockedStripe.calculateFees.mockReturnValue({
    platformFeeAmount: 12,
    amountNet: 88,
  });

  mockedStripe.createTransfer.mockResolvedValue({ id: 'tr_test' } as any);
  mockedStripe.createRefund.mockResolvedValue({ id: 're_test' } as any);
  mockedIsAdmin.mockResolvedValue(false);
});

describe('createPaymentIntentHandler', () => {
  it('creates payment intent and stores record', async () => {
    jobsStore['job-1'] = {
      customerUid: 'cust-1',
    };

    mockedStripe.createPaymentIntent.mockResolvedValue({
      id: 'pi_123',
      client_secret: 'secret_123',
    } as any);

    const request = makeRequest(
      {
        jobId: 'job-1',
        amount: 123,
        currency: 'eur',
        connectedAccountId: 'acct_1',
      },
      { uid: 'cust-1' },
    );

    const result = await createPaymentIntentHandler(request);

    expect(result).toEqual({
      paymentIntentId: 'pi_123',
      clientSecret: 'secret_123',
    });

    expect(paymentsStore['pi_123']).toMatchObject({
      jobId: 'job-1',
      customerUid: 'cust-1',
      amountGross: 123,
      currency: 'eur',
      status: 'pending',
      connectedAccountId: 'acct_1',
    });

    expect(mockedStripe.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12300,
        currency: 'eur',
      }),
    );
    expect(mockedFirestore.getJob).toHaveBeenCalledWith('job-1');
  });

  it('throws if user is not job customer', async () => {
    jobsStore['job-1'] = {
      customerUid: 'cust-owner',
    };

    const request = makeRequest(
      {
        jobId: 'job-1',
        amount: 50,
      },
      { uid: 'someone-else' },
    );

    await expect(createPaymentIntentHandler(request)).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('requires authentication', async () => {
    jobsStore['job-auth'] = {
      customerUid: 'cust-auth',
    };

    const request = makeRequest(
      {
        jobId: 'job-auth',
        amount: 60,
      },
      null,
    );

    await expect(createPaymentIntentHandler(request)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(mockedStripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('validates required fields', async () => {
    const missingAmount = makeRequest(
      {
        jobId: 'job-missing',
      },
      { uid: 'cust-missing' },
    );

    await expect(createPaymentIntentHandler(missingAmount)).rejects.toMatchObject({
      code: 'invalid-argument',
    });

    const missingJobId = makeRequest(
      {
        amount: 100,
      },
      { uid: 'cust-missing' },
    );

    await expect(createPaymentIntentHandler(missingJobId)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('rejects amounts below minimum threshold', async () => {
    jobsStore['job-low'] = {
      customerUid: 'cust-low',
    };

    const request = makeRequest(
      {
        jobId: 'job-low',
        amount: 0.49,
      },
      { uid: 'cust-low' },
    );

    await expect(createPaymentIntentHandler(request)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(mockedStripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('returns not-found when job is missing', async () => {
    const request = makeRequest(
      {
        jobId: 'missing-job',
        amount: 60,
      },
      { uid: 'cust-missing' },
    );

    await expect(createPaymentIntentHandler(request)).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('releaseTransferHandler', () => {
  it('releases transfer automatically after escrow period', async () => {
    jobsStore['job-1'] = {
      assignedProUid: 'pro-1',
      customerUid: 'cust-1',
    };
    paymentsStore['pi_1'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      connectedAccountId: 'acct_1',
      amountGross: 100,
      currency: 'eur',
      status: 'captured',
      escrowHoldUntil: new Date(Date.now() - 60_000),
    };

    mockedStripe.calculateFees.mockReturnValue({
      platformFeeAmount: 5,
      amountNet: 95,
    });

    mockedStripe.createTransfer.mockResolvedValue({ id: 'tr_1' } as any);

    const response = await releaseTransferHandler(
      makeRequest(
        {
          paymentId: 'pi_1',
          manualRelease: false,
        },
        { uid: 'cust-1' },
      ),
    );

    expect(response).toEqual({
      transferId: 'tr_1',
      amountNet: 95,
      platformFee: 5,
    });

    expect(paymentsStore['pi_1']).toMatchObject({
      status: 'transferred',
      transferId: 'tr_1',
      platformFee: 5,
      proUid: 'pro-1',
    });

    expect(Object.values(transfersStore)).toHaveLength(1);
    const [transfer] = Object.values(transfersStore);
    expect(transfer).toMatchObject({
      paymentId: 'pi_1',
      amountNet: 95,
      manualRelease: false,
      proUid: 'pro-1',
      customerUid: 'cust-1',
    });

    expect(mockedStripe.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 9500,
        destination: 'acct_1',
      }),
    );
  });

  it('prevents transfer before escrow expiry when manualRelease is false', async () => {
    paymentsStore['pi_future'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      connectedAccountId: 'acct_1',
      amountGross: 80,
      currency: 'eur',
      status: 'captured',
      escrowHoldUntil: new Date(Date.now() + 60_000),
    };

    await expect(
      releaseTransferHandler(
        makeRequest(
          {
            paymentId: 'pi_future',
            manualRelease: false,
          },
          { uid: 'cust-1' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('requires customer authentication for manual release', async () => {
    paymentsStore['pi_manual'] = {
      jobId: 'job-1',
      customerUid: 'cust-owner',
      connectedAccountId: 'acct_1',
      amountGross: 70,
      currency: 'eur',
      status: 'captured',
      escrowHoldUntil: new Date(Date.now() + 60_000),
    };

    await expect(
      releaseTransferHandler(
        makeRequest(
          {
            paymentId: 'pi_manual',
            manualRelease: true,
          },
          { uid: 'other-user' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('prevents transfer if payment already transferred', async () => {
    paymentsStore['pi_done'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      connectedAccountId: 'acct_1',
      amountGross: 40,
      currency: 'eur',
      status: 'transferred',
      escrowHoldUntil: new Date(Date.now() - 60_000),
    };

    await expect(
      releaseTransferHandler(
        makeRequest(
          {
            paymentId: 'pi_done',
          },
          { uid: 'cust-1' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(mockedStripe.createTransfer).not.toHaveBeenCalled();
  });

  it('requires captured status before transfer', async () => {
    paymentsStore['pi_pending'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      connectedAccountId: 'acct_1',
      amountGross: 75,
      currency: 'eur',
      status: 'pending',
      escrowHoldUntil: new Date(Date.now() - 60_000),
    };

    await expect(
      releaseTransferHandler(
        makeRequest(
          {
            paymentId: 'pi_pending',
          },
          { uid: 'cust-1' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('allows manual release by customer before escrow expiry', async () => {
    paymentsStore['pi_manual_ok'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      connectedAccountId: 'acct_1',
      amountGross: 150,
      currency: 'eur',
      status: 'captured',
      escrowHoldUntil: new Date(Date.now() + 60_000),
    };

    mockedStripe.createTransfer.mockResolvedValue({ id: 'tr_manual' } as any);
    mockedStripe.calculateFees.mockReturnValue({ platformFeeAmount: 15, amountNet: 135 });

    const result = await releaseTransferHandler(
      makeRequest(
        {
          paymentId: 'pi_manual_ok',
          manualRelease: true,
        },
        { uid: 'cust-1' },
      ),
    );

    expect(result).toEqual({
      transferId: 'tr_manual',
      amountNet: 135,
      platformFee: 15,
    });
    expect(paymentsStore['pi_manual_ok'].status).toBe('transferred');
  });

  it('rejects transfer when payment missing connected account', async () => {
    paymentsStore['pi_noacct'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      amountGross: 55,
      currency: 'eur',
      status: 'captured',
      escrowHoldUntil: new Date(Date.now() - 60_000),
    };

    await expect(
      releaseTransferHandler(
        makeRequest(
          {
            paymentId: 'pi_noacct',
          },
          { uid: 'cust-1' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockedStripe.createTransfer).not.toHaveBeenCalled();
  });

  it('throws not-found when payment document is missing', async () => {
    await expect(
      releaseTransferHandler(
        makeRequest(
          {
            paymentId: 'unknown',
          },
          { uid: 'cust-1' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('partialRefundHandler', () => {
  it('creates refund record for customer', async () => {
    paymentsStore['pi_refund'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      amountGross: 200,
      currency: 'eur',
      status: 'captured',
      stripePaymentIntentId: 'pi_refund',
    };

    mockedStripe.createRefund.mockResolvedValue({ id: 're_1' } as any);

    const result = await partialRefundHandler(
      makeRequest(
        {
          paymentId: 'pi_refund',
          refundAmount: 50,
        },
        { uid: 'cust-1' },
      ),
    );

    expect(result).toEqual({
      refundId: 're_1',
      amount: 50,
      currency: 'eur',
    });

    expect(refundsStore['re_1']).toMatchObject({
      paymentId: 'pi_refund',
      amount: 50,
      reason: 'requested_by_customer',
    });

    expect(mockedStripe.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: 'pi_refund',
        amount: 5000,
      }),
    );
  });

  it('allows admin override when customer differs', async () => {
    paymentsStore['pi_admin'] = {
      jobId: 'job-1',
      customerUid: 'cust-owner',
      amountGross: 120,
      currency: 'eur',
      status: 'captured',
      stripePaymentIntentId: 'pi_admin',
    };

    mockedIsAdmin.mockResolvedValue(true);
    mockedStripe.createRefund.mockResolvedValue({ id: 're_admin' } as any);

    const result = await partialRefundHandler(
      makeRequest(
        {
          paymentId: 'pi_admin',
          refundAmount: 20,
          reason: 'duplicate',
        },
        { uid: 'admin-user' },
      ),
    );

    expect(result.refundId).toBe('re_admin');
    expect(mockedIsAdmin).toHaveBeenCalled();
  });

  it('rejects refund requests from unauthorized users', async () => {
    paymentsStore['pi_denied'] = {
      jobId: 'job-1',
      customerUid: 'cust-owner',
      amountGross: 60,
      currency: 'eur',
      status: 'captured',
      stripePaymentIntentId: 'pi_denied',
    };

    mockedIsAdmin.mockResolvedValue(false);

    await expect(
      partialRefundHandler(
        makeRequest(
          {
            paymentId: 'pi_denied',
            refundAmount: 10,
          },
          { uid: 'random-user' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('does not allow refund amount to exceed original payment', async () => {
    paymentsStore['pi_over'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      amountGross: 30,
      currency: 'eur',
      status: 'captured',
      stripePaymentIntentId: 'pi_over',
    };

    await expect(
      partialRefundHandler(
        makeRequest(
          {
            paymentId: 'pi_over',
            refundAmount: 31,
          },
          { uid: 'cust-1' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mockedStripe.createRefund).not.toHaveBeenCalled();
  });

  it('requires positive refund amount', async () => {
    paymentsStore['pi_zero'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      amountGross: 80,
      currency: 'eur',
      status: 'captured',
      stripePaymentIntentId: 'pi_zero',
    };

    await expect(
      partialRefundHandler(
        makeRequest(
          {
            paymentId: 'pi_zero',
            refundAmount: 0,
          },
          { uid: 'cust-1' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('requires payment to be captured before refund', async () => {
    paymentsStore['pi_pending_refund'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      amountGross: 90,
      currency: 'eur',
      status: 'pending',
      stripePaymentIntentId: 'pi_pending_refund',
    };

    await expect(
      partialRefundHandler(
        makeRequest(
          {
            paymentId: 'pi_pending_refund',
            refundAmount: 10,
          },
          { uid: 'cust-1' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('throws not-found when payment document is missing', async () => {
    await expect(
      partialRefundHandler(
        makeRequest(
          {
            paymentId: 'missing',
            refundAmount: 10,
          },
          { uid: 'cust-1' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('webhook handlers', () => {
  it('updates payment and job on payment_intent.succeeded', async () => {
    paymentsStore['pi_hook'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      proUid: 'pro-1',
      amountEur: 99,
      status: 'pending',
    };

    jobsStore['job-1'] = { status: 'open' };

    await handlePaymentIntentSucceeded({
      id: 'pi_hook',
      latest_charge: 'ch_1',
    });

    expect(paymentsStore['pi_hook']).toMatchObject({
      status: 'captured',
      stripeChargeId: 'ch_1',
    });
    expect(jobsStore['job-1'].status).toBe('assigned');
    expect(mockedFirestore.updateJob).toHaveBeenCalledWith('job-1', expect.any(Object));
    expect(mockedLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'payment_captured',
        props: expect.objectContaining({ paymentId: 'pi_hook' }),
      }),
    );
  });

  it('marks transfer as completed on transfer.created', async () => {
    transfersStore['tr_1'] = {
      status: 'pending',
      proUid: 'pro-1',
      paymentId: 'pi_1',
      jobId: 'job-1',
      amountEur: 88,
    };

    await handleTransferCreated({ id: 'tr_1' });

    expect(transfersStore['tr_1'].status).toBe('completed');
    expect(transfersStore['tr_1'].completedAt).toBeInstanceOf(Date);
    expect(mockedLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'payment_released' }),
    );
  });

  it('records refund details on charge.refunded', async () => {
    paymentsStore['pi_ref'] = {
      jobId: 'job-1',
      customerUid: 'cust-1',
      proUid: 'pro-1',
      amountEur: 120,
      stripeChargeId: 'ch_ref',
    };

    await handleChargeRefunded({
      id: 'ch_ref',
      amount_refunded: 4500,
    });

    expect(paymentsStore['pi_ref']).toMatchObject({
      totalRefunded: 45,
    });

    expect(mockedLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'payment_refunded',
        props: expect.objectContaining({
          paymentId: 'pi_ref',
          totalRefunded: 45,
        }),
      }),
    );
  });

  it('skips payment update when payment document missing on payment_intent.succeeded', async () => {
    await expect(handlePaymentIntentSucceeded({
      id: 'pi_missing',
      latest_charge: 'ch_missing',
    })).resolves.toBeUndefined();

    expect(paymentsStore['pi_missing']).toBeUndefined();
    expect(mockedFirestore.updateJob).not.toHaveBeenCalled();
  });

  it('ignores transfer.created when document not found', async () => {
    await expect(handleTransferCreated({ id: 'tr_unknown' })).resolves.toBeUndefined();
    expect(mockedLogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'payment_released' }),
    );
  });

  it('ignores charge.refunded when payment not found', async () => {
    await expect(handleChargeRefunded({
      id: 'ch_unknown',
      amount_refunded: 1000,
    })).resolves.toBeUndefined();
    expect(paymentsStore).toEqual({});
  });
});
