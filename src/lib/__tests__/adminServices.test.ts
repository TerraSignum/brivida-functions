import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';

const serverTimestampValue = 'SERVER_TIMESTAMP';

interface CollectionStore {
  [collection: string]: Record<string, Record<string, unknown>>;
}

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

type OrderDirection = 'asc' | 'desc';

interface OrderByConfig {
  field: string;
  direction: OrderDirection;
}

type ComparableValue = string | number | Date | undefined;

const secretValues: Record<string, string> = {};
let mockDb: FakeFirestore;
let messagingInstance: FakeMessaging;
let stripeInstance: FakeStripeInstance;
const stripeConstructorSpy = jest.fn();
const enforceAdminRoleMock = jest.fn(async (_auth: unknown) => undefined);

jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn((name: string) => ({
    value: () => secretValues[name],
  })),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => serverTimestampValue),
    arrayUnion: (...values: unknown[]) => ({
      __op: 'arrayUnion',
      values,
    }),
  },
  getFirestore: jest.fn(() => mockDb),
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => messagingInstance),
}));

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn((key: string, options: unknown) => {
    stripeConstructorSpy(key, options);
    return stripeInstance;
  }),
}));

jest.mock('../auth', () => ({
  enforceAdminRole: enforceAdminRoleMock,
}));

interface FakeMessaging {
  sendEachForMulticast: jest.MockedFunction<
    (message: unknown) => Promise<{ successCount: number; failureCount: number }>
  >;
  send: jest.MockedFunction<(message: unknown) => Promise<void>>;
}

interface FakeStripeInstance {
  checkout: {
    sessions: {
      create: jest.MockedFunction<
        (params: Record<string, unknown>) => Promise<{ id: string; url: string }>
      >;
    };
  };
  webhooks: {
    constructEvent: jest.MockedFunction<
      (
        payload: unknown,
        signature: unknown,
        secret: unknown,
      ) => { type: string; data: { object: Record<string, unknown> } }
    >;
  };
}

interface ResponseMock {
  status: jest.MockedFunction<(code: number) => ResponseMock>;
  send: jest.MockedFunction<(body: unknown) => ResponseMock>;
  statusCode?: number;
  body?: unknown;
}

class FakeDocumentReference {
  constructor(
    private readonly store: CollectionStore,
    private readonly collection: string,
    private readonly docId: string,
  ) {}

  get id(): string {
    return this.docId;
  }

  async get() {
    const doc = this.store[this.collection]?.[this.docId];
    return {
      exists: doc !== undefined,
      data: () => doc,
    };
  }

  set(data: Record<string, unknown>) {
    if (!this.store[this.collection]) {
      this.store[this.collection] = {};
    }
    this.store[this.collection]![this.docId] = { ...data };
  }

  update(updates: Record<string, unknown>) {
    if (!this.store[this.collection]) {
      this.store[this.collection] = {};
    }
    const existing = this.store[this.collection]![this.docId] ?? {};
    this.store[this.collection]![this.docId] = {
      ...existing,
      ...resolveFieldValues(updates),
    };
  }
}

class FakeQueryDocumentSnapshot {
  constructor(
    private readonly store: CollectionStore,
    private readonly collection: string,
    public readonly id: string,
  ) {}

  data() {
    return this.store[this.collection]?.[this.id];
  }

  get ref() {
    return new FakeDocumentReference(this.store, this.collection, this.id);
  }
}

class FakeTransaction {
  constructor(private readonly store: CollectionStore) {}

  async get(ref: FakeDocumentReference) {
    return ref.get();
  }

  update(ref: FakeDocumentReference, updates: Record<string, unknown>) {
    ref.update(updates);
  }
}

class FakeQuery {
  constructor(
    private readonly store: CollectionStore,
    private readonly collection: string,
    private readonly filters: Filter[] = [],
    private readonly orderBys: OrderByConfig[] = [],
    private readonly limitCount?: number,
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(
      this.store,
      this.collection,
      [...this.filters, { field, op, value }],
      this.orderBys,
      this.limitCount,
    );
  }

  orderBy(field: string, direction: OrderDirection = 'asc'): FakeQuery {
    return new FakeQuery(
      this.store,
      this.collection,
      this.filters,
      [...this.orderBys, { field, direction }],
      this.limitCount,
    );
  }

  limit(count: number): FakeQuery {
    return new FakeQuery(
      this.store,
      this.collection,
      this.filters,
      this.orderBys,
      count,
    );
  }

  async get() {
    const collectionStore = this.store[this.collection] ?? {};
    let entries = Object.entries(collectionStore);

    entries = entries.filter(([, data]) => this.filters.every((filter) => matchesFilter(data, filter)));

    if (this.orderBys.length > 0) {
      entries = entries.sort(([, a], [, b]) => {
        for (const { field, direction } of this.orderBys) {
          const comparison = compareByField(a, b, field, direction);
          if (comparison !== 0) {
            return comparison;
          }
        }
        return 0;
      });
    }

    if (typeof this.limitCount === 'number') {
      entries = entries.slice(0, this.limitCount);
    }

    const docs = entries.map(([id]) => new FakeQueryDocumentSnapshot(this.store, this.collection, id));

    return {
      empty: docs.length === 0,
      docs,
    };
  }
}

class FakeFirestore {
  private readonly counters: Record<string, number> = {};

  constructor(private readonly store: CollectionStore) {}

  collection(name: string) {
    const buildQuery = () => new FakeQuery(this.store, name);
    return {
      doc: (id?: string) => {
        if (!id) {
          const current = this.counters[name] ?? 0;
          id = `${name}_${current + 1}`;
          this.counters[name] = current + 1;
        }
        return new FakeDocumentReference(this.store, name, id);
      },
      add: async (data: Record<string, unknown>) => {
        const ref = this.collection(name).doc();
        ref.set(data);
        return ref;
      },
      where: (field: string, op: string, value: unknown) => buildQuery().where(field, op, value),
      orderBy: (field: string, direction: OrderDirection = 'asc') =>
        buildQuery().orderBy(field, direction),
      limit: (count: number) => buildQuery().limit(count),
      get: () => buildQuery().get(),
    };
  }

  async runTransaction<T>(handler: (transaction: FakeTransaction) => Promise<T>) {
    const transaction = new FakeTransaction(this.store);
    return handler(transaction);
  }
}

function matchesFilter(data: Record<string, unknown>, filter: Filter): boolean {
  const actual = data?.[filter.field as keyof typeof data];
  switch (filter.op) {
    case '==':
      return actual === filter.value;
    case '!=':
      return actual !== filter.value;
    default:
      throw new Error(`Unsupported operator: ${filter.op}`);
  }
}

function compareByField(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  field: string,
  direction: OrderDirection,
): number {
  const aValue = a[field as keyof typeof a] as ComparableValue;
  const bValue = b[field as keyof typeof b] as ComparableValue;

  const normalize = (value: ComparableValue): number | string | null => {
    if (value instanceof Date) {
      return value.getTime();
    }
    return value ?? null;
  };

  const aComparable = normalize(aValue);
  const bComparable = normalize(bValue);

  if (aComparable === bComparable) {
    return 0;
  }

  const factor = direction === 'asc' ? 1 : -1;

  if (aComparable === null) {
    return -factor;
  }

  if (bComparable === null) {
    return factor;
  }

  return aComparable > bComparable ? factor : -factor;
}

function resolveFieldValues(updates: Record<string, unknown>) {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    resolved[key] = value;
  }
  return resolved;
}

function createStripeInstance(): FakeStripeInstance {
  const create = jest.fn<
    (params: Record<string, unknown>) => Promise<{ id: string; url: string }>
  >();
  const constructEvent = jest.fn<
    (
      payload: unknown,
      signature: unknown,
      secret: unknown,
    ) => { type: string; data: { object: Record<string, unknown> } }
  >();

  return {
    checkout: {
      sessions: {
        create,
      },
    },
    webhooks: {
      constructEvent,
    },
  };
}

function createMessagingInstance(): FakeMessaging {
  const sendEachForMulticast = jest.fn<
    (message: unknown) => Promise<{ successCount: number; failureCount: number }>
  >();
  sendEachForMulticast.mockResolvedValue({ successCount: 0, failureCount: 0 });

  const send = jest.fn<(message: unknown) => Promise<void>>();
  send.mockResolvedValue(undefined);

  return {
    sendEachForMulticast,
    send,
  };
}

function createResponseMock(): ResponseMock {
  const res: ResponseMock = {
    status: jest.fn<(code: number) => ResponseMock>(),
    send: jest.fn<(body: unknown) => ResponseMock>(),
  };

  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });

  res.send.mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  });

  return res;
}

describe('adminServices cloud functions', () => {
  let store: CollectionStore;
  let adminServicesModule: typeof import('../adminServices');

  beforeEach(async () => {
    jest.resetModules();
  enforceAdminRoleMock.mockReset();
  enforceAdminRoleMock.mockImplementation(async () => undefined);
    store = {
      adminServices: {},
      users: {},
      adminLogs: {},
    };
    secretValues.STRIPE_SECRET_KEY = 'sk_test';
    secretValues.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    mockDb = new FakeFirestore(store);
    messagingInstance = createMessagingInstance();
    stripeInstance = createStripeInstance();

    adminServicesModule = await import('../adminServices');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createAdminServiceCheckout', () => {
    it('creates a checkout session for a pro user', async () => {
      store.users['pro_1'] = {
        role: 'pro',
        email: 'pro@example.com',
      };

      const sessionResponse = {
        id: 'cs_test_123',
        url: 'https://stripe.test/session/cs_test_123',
      };
      stripeInstance.checkout.sessions.create.mockResolvedValue(sessionResponse);

      const checkoutCallable = adminServicesModule.createAdminServiceCheckout as any;

      const result = await checkoutCallable.run({
        data: {
          packageType: 'basic',
          returnUrl: 'https://app.test/success',
        },
        auth: { uid: 'pro_1' },
      });

      const checkoutResult = result as {
        sessionId: string;
        checkoutUrl: string;
        adminServiceId: string;
      };

      expect(checkoutResult).toEqual({
        sessionId: 'cs_test_123',
        checkoutUrl: 'https://stripe.test/session/cs_test_123',
        adminServiceId: expect.any(String),
      });

      const storedService = store.adminServices[checkoutResult.adminServiceId];
      expect(storedService).toMatchObject({
        proId: 'pro_1',
        package: 'basic',
        price: 79,
        status: 'pending_payment',
        stripeSessionId: 'cs_test_123',
      });

      expect(stripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer_email: 'pro@example.com',
          success_url: expect.stringContaining('status=success'),
          cancel_url: expect.stringContaining('status=cancelled'),
        }),
      );
    });

    it('rejects when the user is not a pro', async () => {
      store.users['customer_1'] = {
        role: 'customer',
        email: 'customer@example.com',
      };

      const checkoutCallable = adminServicesModule.createAdminServiceCheckout as any;

      await expect(
        checkoutCallable.run({
          data: {
            packageType: 'basic',
            returnUrl: 'https://app.test/success',
          },
          auth: { uid: 'customer_1' },
        }),
      ).rejects.toMatchObject({ code: 'internal' });

      expect(stripeInstance.checkout.sessions.create).not.toHaveBeenCalled();
    });
  });

  describe('updateAdminServiceStatus', () => {
    it('allows admins to update service status', async () => {
      store.users['admin_1'] = { role: 'admin' };
      store.adminServices['svc_1'] = {
        status: 'pending',
        proId: 'pro_1',
      };

      const request = {
        auth: { uid: 'admin_1' },
        data: {
          adminServiceId: 'svc_1',
          status: 'completed',
          assignedAdminId: 'admin_1',
          notes: 'Tudo concluído',
        },
      } as any;

      const updateCallable = adminServicesModule.updateAdminServiceStatus as any;

      const response = await updateCallable.run({
        data: request.data,
        auth: request.auth,
      });
      expect(response).toEqual({ success: true });
      expect(enforceAdminRoleMock).toHaveBeenCalledWith({ uid: 'admin_1' });

      expect(store.adminServices['svc_1']).toMatchObject({
        status: 'completed',
        assignedAdminId: 'admin_1',
        adminNotes: 'Tudo concluído',
        updatedAt: serverTimestampValue,
        completedAt: serverTimestampValue,
      });

      const adminLogsSnapshot = await mockDb.collection('adminLogs').get();
      expect(adminLogsSnapshot.docs).toHaveLength(1);
      expect(adminLogsSnapshot.docs[0].data()).toMatchObject({
        action: 'admin_service_status_update',
        adminUid: 'admin_1',
        adminServiceId: 'svc_1',
        newStatus: 'completed',
      });
    });

    it('rejects non-admin users', async () => {
      store.users['pro_1'] = { role: 'pro' };
      store.adminServices['svc_1'] = {
        status: 'pending',
      };

      const permissionDenied = Object.assign(new Error('Admin role required'), {
        code: 'permission-denied',
      });
      enforceAdminRoleMock.mockRejectedValueOnce(permissionDenied);

      const updateCallable = adminServicesModule.updateAdminServiceStatus as any;

      await expect(
        updateCallable.run({
          data: { adminServiceId: 'svc_1', status: 'assigned' },
          auth: { uid: 'pro_1' },
        }),
      ).rejects.toMatchObject({ code: 'permission-denied' });
      expect(enforceAdminRoleMock).toHaveBeenCalledWith({ uid: 'pro_1' });
    });
  });

  describe('handleAdminServiceWebhook', () => {
    it('processes checkout completion events', async () => {
      store.adminServices['svc_hook'] = {
        proId: 'pro_2',
        package: 'secure',
        price: 129,
        status: 'pending_payment',
      };

      store.users['pro_2'] = {
        role: 'pro',
        email: 'pro2@example.com',
        fcmToken: 'token_pro',
      };

      store.users['admin_1'] = {
        role: 'admin',
        fcmToken: 'token_admin',
      };

      stripeInstance.webhooks.constructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { adminServiceId: 'svc_hook' },
            payment_intent: 'pi_test_123',
          },
        },
      });

      messagingInstance.sendEachForMulticast.mockResolvedValue({
        successCount: 1,
        failureCount: 0,
      });

      const request = {
        headers: {
          'stripe-signature': 'sig_test',
        },
        rawBody: Buffer.from('test'),
      } as any;

      const response = createResponseMock();

      await adminServicesModule.handleAdminServiceWebhook(
        request,
        response as unknown as Response,
      );

      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.send).toHaveBeenCalledWith('Success');

      expect(store.adminServices['svc_hook']).toMatchObject({
        status: 'pending',
        stripePaymentIntentId: 'pi_test_123',
        updatedAt: serverTimestampValue,
        paidAt: serverTimestampValue,
      });

      expect(messagingInstance.sendEachForMulticast).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: ['token_admin'],
        }),
      );

      expect(messagingInstance.send).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'token_pro',
        }),
      );
    });
  });
});
