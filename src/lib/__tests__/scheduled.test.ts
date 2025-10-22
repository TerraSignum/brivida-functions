import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createFakeFirestore } from './helpers/fakeFirestore';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('firebase-functions/v2', () => ({
  logger,
}));

let fakeDb = createFakeFirestore();

const calculateFeesMock = jest.fn(() => ({ platformFeeAmount: 10, amountNet: 90 }));
const createTransferMock = jest.fn(async () => ({ id: 'tr_123' }));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (_config: any, handler: any) => ({
    run: handler,
  }),
}));

jest.mock('../stripe', () => ({
  calculateFees: calculateFeesMock,
  createTransfer: createTransferMock,
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => fakeDb,
}));

describe('scheduled tasks', () => {
  let autoReleaseEscrow: typeof import('../scheduled').autoReleaseEscrow;

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
    calculateFeesMock.mockReset().mockReturnValue({ platformFeeAmount: 10, amountNet: 90 });
    createTransferMock.mockReset().mockResolvedValue({ id: 'tr_123' });
    jest.setSystemTime(new Date('2025-01-02T12:00:00Z'));

  const scheduledModule = await import('../scheduled');
  autoReleaseEscrow = scheduledModule.autoReleaseEscrow;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('releases eligible escrow payments and records transfer', async () => {
    await fakeDb.collection('jobs').doc('job-1').set({
      assignedProUid: 'pro-1',
      customerUid: 'cust-1',
    });
    await fakeDb.collection('payments').doc('pay-1').set({
      status: 'captured',
      amountGross: 120,
      currency: 'eur',
      jobId: 'job-1',
      connectedAccountId: 'acct_123',
      escrowHoldUntil: new Date('2025-01-02T10:00:00Z'),
      customerUid: 'cust-1',
    });

  await autoReleaseEscrow.run({} as any);

    expect(calculateFeesMock).toHaveBeenCalledWith(120);
    expect(createTransferMock).toHaveBeenCalledWith(expect.objectContaining({
      amount: Math.round(90 * 100),
      destination: 'acct_123',
    }));

    const updatedPayment = (await fakeDb.collection('payments').doc('pay-1').get()).data();
    expect(updatedPayment).toMatchObject({
      status: 'transferred',
      transferId: 'tr_123',
      platformFee: 10,
      proUid: 'pro-1',
    });

    const transferRecord = (await fakeDb.collection('transfers').doc('tr_123').get()).data();
    expect(transferRecord).toMatchObject({
      paymentId: 'pay-1',
      jobId: 'job-1',
      connectedAccountId: 'acct_123',
      amountNet: 90,
      platformFee: 10,
      status: 'completed',
      proUid: 'pro-1',
      customerUid: 'cust-1',
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Successfully released payment'));
  });

  it('skips when no payments qualify for release', async () => {
  await autoReleaseEscrow.run({} as any);

    expect(createTransferMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('No payments eligible for automatic release');
  });

  it('skips payments without connected account or already transferred', async () => {
    await fakeDb.collection('payments').doc('pay-missing-account').set({
      status: 'captured',
      amountGross: 90,
      currency: 'eur',
      jobId: 'job-2',
      escrowHoldUntil: new Date('2025-01-02T10:00:00Z'),
    });

    await fakeDb.collection('payments').doc('pay-transferred').set({
      status: 'transferred',
      amountGross: 80,
      currency: 'eur',
      jobId: 'job-3',
      connectedAccountId: 'acct_999',
      escrowHoldUntil: new Date('2025-01-02T09:00:00Z'),
    });

  await autoReleaseEscrow.run({} as any);

    expect(createTransferMock).not.toHaveBeenCalled();
    const untouchedMissingAccount = (await fakeDb.collection('payments').doc('pay-missing-account').get()).data();
    const untouchedTransferred = (await fakeDb.collection('payments').doc('pay-transferred').get()).data();

    expect(untouchedMissingAccount?.status).toBe('captured');
    expect(untouchedTransferred?.status).toBe('transferred');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no connected account'));
  });

  it('continues processing when individual transfers fail', async () => {
    createTransferMock.mockRejectedValueOnce(new Error('stripe down'));

    await fakeDb.collection('payments').doc('pay-1').set({
      status: 'captured',
      amountGross: 150,
      currency: 'eur',
      jobId: 'job-1',
      connectedAccountId: 'acct_1',
      escrowHoldUntil: new Date('2025-01-02T10:00:00Z'),
    });

    await fakeDb.collection('payments').doc('pay-2').set({
      status: 'captured',
      amountGross: 200,
      currency: 'eur',
      jobId: 'job-2',
      connectedAccountId: 'acct_2',
      escrowHoldUntil: new Date('2025-01-02T08:00:00Z'),
    });

  await autoReleaseEscrow.run({} as any);

    expect(createTransferMock).toHaveBeenCalledTimes(2);
    const secondPayment = (await fakeDb.collection('payments').doc('pay-2').get()).data();
    expect(secondPayment?.status).toBe('transferred');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to release payment pay-1:'), expect.any(Error));
  });
});
