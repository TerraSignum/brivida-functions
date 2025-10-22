import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { leadsService } from '../leads';
import { chatService } from '../chat';
import { etaService } from '../eta';

jest.mock('../chat', () => ({
  chatService: {
    ensureChat: jest.fn(),
  },
}));

jest.mock('../eta', () => ({
  etaService: {
    calculateEta: jest.fn(),
  },
}));

type DocStore = Record<string, Record<string, Record<string, unknown>>>;

interface CalendarEventRecord {
  id: string;
  data: Record<string, unknown>;
}

interface ArrayUnionValue {
  __op: 'arrayUnion';
  values: unknown[];
}

const serverTimestampValue = new Date('2024-01-01T00:00:00.000Z');

let mockDb: FakeFirestore;
let docStore: DocStore;
let calendarEvents: CalendarEventRecord[];

class CalendarEventError extends Error {}

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

const mockedChatService = chatService as jest.Mocked<typeof chatService>;
const mockedEtaService = etaService as jest.Mocked<typeof etaService>;

class FakeDocumentReference {
  constructor(
    private readonly store: DocStore,
    public readonly collection: string,
    public readonly id: string,
  ) {}

  get path(): string {
    return `${this.collection}/${this.id}`;
  }

  async get() {
    const data = this.store[this.collection]?.[this.id];
    return {
      exists: data !== undefined,
      data: () => data,
    };
  }
}

class FakeTransaction {
  constructor(private readonly store: DocStore) {}

  async get(ref: FakeDocumentReference) {
    return ref.get();
  }

  update(ref: FakeDocumentReference, updates: Record<string, unknown>) {
    if (!this.store[ref.collection]) {
      this.store[ref.collection] = {};
    }

    const collection = this.store[ref.collection]!;
    const existingDoc = (collection[ref.id] as Record<string, unknown> | undefined) ?? {};
    const updatedDoc = applyFieldValues(existingDoc, updates);

    collection[ref.id] = updatedDoc;
  }
}

class FakeFirestore {
  constructor(
    private readonly store: DocStore,
    private readonly events: CalendarEventRecord[],
  ) {}

  private calendarEventFailure: Error | null = null;

  setCalendarEventFailure(error: Error | null) {
    this.calendarEventFailure = error;
  }

  collection(name: string) {
    if (name === 'calendarEvents') {
      return {
        add: async (data: Record<string, unknown>) => {
          if (this.calendarEventFailure) {
            throw this.calendarEventFailure;
          }
          const id = `event_${this.events.length + 1}`;
          this.events.push({ id, data });
          return { id };
        },
      };
    }

    return {
      doc: (id: string) => new FakeDocumentReference(this.store, name, id),
    };
  }

  async runTransaction<T>(handler: (transaction: FakeTransaction) => Promise<T>) {
    const transaction = new FakeTransaction(this.store);
    return handler(transaction);
  }
}

function isArrayUnionValue(value: unknown): value is ArrayUnionValue {
  return Boolean(
    value &&
      typeof value === 'object' &&
      '__op' in (value as Record<string, unknown>) &&
      (value as ArrayUnionValue).__op === 'arrayUnion',
  );
}

function applyFieldValues(
  existing: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (isArrayUnionValue(value)) {
      const current = Array.isArray(result[key]) ? (result[key] as unknown[]) : [];
      const merged = [...current];

      for (const item of value.values) {
        if (!merged.includes(item)) {
          merged.push(item);
        }
      }

      result[key] = merged;
      continue;
    }

    result[key] = value;
  }

  return result;
}

describe('leadsService.acceptLead', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    docStore = {
      leads: {
        'lead-123': {
          jobId: 'job-456',
          proUid: 'pro-001',
          status: 'pending',
        },
      },
      jobs: {
        'job-456': {
          status: 'open',
          customerUid: 'customer-789',
          scheduledDate: { toDate: () => new Date('2025-10-15T08:00:00.000Z') },
          estimatedDuration: 3,
          address: 'Musterstraße 1, Berlin',
          coordinates: { lat: 52.52, lng: 13.405 },
          visibleTo: [],
        },
      },
      proProfiles: {
        'pro-001': {
          address: 'Hauptstraße 5, Berlin',
        },
      },
    };

    calendarEvents = [];
    mockDb = new FakeFirestore(docStore, calendarEvents);

    mockedChatService.ensureChat.mockResolvedValue({ chatId: 'chat-001', existed: false });
    mockedEtaService.calculateEta.mockResolvedValue({ minutes: 20 });
  });

  it('creates a calendar event when a lead is accepted', async () => {
    const result = await leadsService.acceptLead({
      leadId: 'lead-123',
      userId: 'pro-001',
    });

    expect(result).toMatchObject({
      leadId: 'lead-123',
      jobId: 'job-456',
      jobEventId: 'event_1',
    });

    expect(calendarEvents).toHaveLength(1);
    const [event] = calendarEvents;

    expect(event.data).toMatchObject({
      ownerUid: 'pro-001',
      jobId: 'job-456',
      bufferBefore: 15,
      bufferAfter: 15,
      visibility: 'busy',
    });

    expect(event.data.start).toEqual(new Date('2025-10-15T08:00:00.000Z'));
    expect(event.data.end).toEqual(new Date('2025-10-15T11:00:00.000Z'));
    expect(event.data.createdAt).toBe(serverTimestampValue);
    expect(event.data.updatedAt).toBe(serverTimestampValue);

    expect(mockedChatService.ensureChat).toHaveBeenCalledWith({
      jobId: 'job-456',
      customerUid: 'customer-789',
      proUid: 'pro-001',
    });

    expect(mockedEtaService.calculateEta).toHaveBeenCalledWith({
      origin: 'Hauptstraße 5, Berlin',
      destination: 'Musterstraße 1, Berlin',
    });

    expect(docStore.jobs['job-456']).toMatchObject({
      status: 'assigned',
      visibleTo: ['pro-001'],
      estimatedTravelTime: 20,
    });

    expect(docStore.leads['lead-123']).toMatchObject({
      status: 'accepted',
    });
  });

  it('throws when lead does not belong to user', async () => {
    docStore.leads['lead-123'].proUid = 'other-pro';

    await expect(
      leadsService.acceptLead({ leadId: 'lead-123', userId: 'pro-001' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(docStore.leads['lead-123'].status).toBe('pending');
    expect(calendarEvents).toHaveLength(0);
  });

  it('throws when job is not open', async () => {
    docStore.jobs['job-456'].status = 'assigned';

    await expect(
      leadsService.acceptLead({ leadId: 'lead-123', userId: 'pro-001' }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(docStore.jobs['job-456'].status).toBe('assigned');
  });

  it('returns null jobEventId when calendar event creation fails', async () => {
    mockDb.setCalendarEventFailure(new CalendarEventError('calendar failed'));

    const result = await leadsService.acceptLead({ leadId: 'lead-123', userId: 'pro-001' });

    expect(result.jobEventId).toBeNull();
    expect(calendarEvents).toHaveLength(0);
  });

  it('continues when ETA calculation fails', async () => {
    mockedEtaService.calculateEta.mockRejectedValueOnce(new Error('ETA failed'));

    const result = await leadsService.acceptLead({ leadId: 'lead-123', userId: 'pro-001' });

    expect(result.jobEventId).toBe('event_1');
    expect(docStore.jobs['job-456']).not.toHaveProperty('estimatedTravelTime');
  });

  it('skips ETA when pro profile is missing', async () => {
    delete docStore.proProfiles['pro-001'];

    await leadsService.acceptLead({ leadId: 'lead-123', userId: 'pro-001' });

    expect(mockedEtaService.calculateEta).not.toHaveBeenCalled();
  });
});

describe('leadsService.declineLead', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    docStore = {
      leads: {
        'lead-xyz': {
          jobId: 'job-999',
          proUid: 'pro-decline',
          status: 'pending',
        },
      },
    };

    calendarEvents = [];
    mockDb = new FakeFirestore(docStore, calendarEvents);
  });

  it('declines lead and sets status', async () => {
    const result = await leadsService.declineLead({ leadId: 'lead-xyz', userId: 'pro-decline' });

    expect(result).toMatchObject({ leadId: 'lead-xyz' });
    expect(docStore.leads['lead-xyz']).toMatchObject({
      status: 'declined',
      updatedAt: serverTimestampValue,
    });
  });

  it('throws when declining someone else’s lead', async () => {
    await expect(
      leadsService.declineLead({ leadId: 'lead-xyz', userId: 'other-pro' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(docStore.leads['lead-xyz'].status).toBe('pending');
  });

  it('throws when lead is no longer pending', async () => {
    docStore.leads['lead-xyz'].status = 'accepted';

    await expect(
      leadsService.declineLead({ leadId: 'lead-xyz', userId: 'pro-decline' }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
