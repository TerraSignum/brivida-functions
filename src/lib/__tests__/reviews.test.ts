import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { reviewsService } from '../reviews';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { enforceAdminRole } from '../auth';

type CollectionStore = Record<string, Record<string, any>>;

type WhereFilter = { field: string; op: '=='; value: any };

type QueryState = {
  collection: string;
  filters: WhereFilter[];
  limit?: number;
};

let autoIdCounter = 0;

const generateId = (prefix: string) => {
  autoIdCounter += 1;
  return `${prefix}_${autoIdCounter}`;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class MockDocumentReference {
  constructor(private store: CollectionStore, private collection: string, public readonly id: string) {}

  async get() {
    const doc = this.store[this.collection]?.[this.id];
    return {
      exists: doc !== undefined,
      data: () => clone(doc),
    };
  }

  async set(data: Record<string, any>, options?: { merge?: boolean }) {
    if (!this.store[this.collection]) {
      this.store[this.collection] = {};
    }

    if (options?.merge && this.store[this.collection][this.id]) {
      this.store[this.collection][this.id] = mergeObjects(this.store[this.collection][this.id], data);
      return;
    }

    this.store[this.collection][this.id] = clone(data);
  }

  async update(updates: Record<string, any>) {
    if (!this.store[this.collection]?.[this.id]) {
      throw new Error('Document does not exist');
    }

    this.store[this.collection][this.id] = applyUpdates(this.store[this.collection][this.id], updates);
  }
}

class MockQuery {
  constructor(private store: CollectionStore, private state: QueryState) {}

  where(field: string, op: '==', value: any) {
    return new MockQuery(this.store, {
      collection: this.state.collection,
      filters: [...this.state.filters, { field, op, value }],
      limit: this.state.limit,
    });
  }

  limit(count: number) {
    return new MockQuery(this.store, {
      collection: this.state.collection,
      filters: this.state.filters,
      limit: count,
    });
  }

  async get() {
    const collectionDocs = Object.entries(this.store[this.state.collection] ?? {});

    const filtered = collectionDocs.filter(([_, data]) =>
      this.state.filters.every(({ field, value }) => (data ?? {})[field] === value),
    );

    const limited = typeof this.state.limit === 'number' ? filtered.slice(0, this.state.limit) : filtered;

    return {
      empty: limited.length === 0,
      size: limited.length,
      docs: limited.map(([id, data]) => ({ id, data: () => clone(data) })),
    };
  }
}

class MockCollection {
  constructor(private store: CollectionStore, private name: string) {}

  doc(id?: string) {
    const docId = id ?? generateId(this.name);
    return new MockDocumentReference(this.store, this.name, docId);
  }

  where(field: string, op: '==', value: any) {
    return new MockQuery(this.store, {
      collection: this.name,
      filters: [{ field, op, value }],
    });
  }

  async add(data: Record<string, any>) {
    const docId = generateId(this.name);
    if (!this.store[this.name]) {
      this.store[this.name] = {};
    }
    this.store[this.name][docId] = clone(data);
    return { id: docId };
  }
}

class MockFirestore {
  constructor(private readonly store: CollectionStore) {}

  collection(name: string) {
    if (!this.store[name]) {
      this.store[name] = {};
    }
    return new MockCollection(this.store, name);
  }

  async runTransaction<T>(handler: (transaction: MockTransaction) => Promise<T>) {
    const transaction = new MockTransaction(this.store);
    return handler(transaction);
  }
}

class MockTransaction {
  constructor(private readonly store: CollectionStore) {}

  async get(ref: MockDocumentReference) {
    return ref.get();
  }

  set(ref: MockDocumentReference, data: Record<string, any>, options?: { merge?: boolean }) {
    return ref.set(data, options);
  }

  update(ref: MockDocumentReference, updates: Record<string, any>) {
    return ref.update(updates);
  }
}

function mergeObjects(target: Record<string, any>, source: Record<string, any>) {
  const result = clone(target);
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergeObjects(result[key] ?? {}, value as Record<string, any>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function applyUpdates(target: Record<string, any>, updates: Record<string, any>) {
  const result = clone(target);
  for (const [key, value] of Object.entries(updates)) {
    if (key.includes('.')) {
      setNested(result, key.split('.'), value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function setNested(obj: Record<string, any>, path: string[], value: any) {
  const [head, ...rest] = path;
  if (!head) {
    return;
  }
  if (rest.length === 0) {
    obj[head] = value;
    return;
  }
  if (!obj[head] || typeof obj[head] !== 'object') {
    obj[head] = {};
  }
  setNested(obj[head], rest, value);
}

jest.mock('firebase-admin/firestore', () => {
  const fieldValue = {
    serverTimestamp: jest.fn(() => 'timestamp'),
  };
  return {
    getFirestore: jest.fn(),
    FieldValue: fieldValue,
  };
});

jest.mock('firebase-functions/v2', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../auth', () => ({
  enforceAdminRole: jest.fn(),
}));

describe('reviewsService', () => {
  const getFirestoreMock = getFirestore as jest.Mock;
  const mockFieldValue = FieldValue as unknown as { serverTimestamp: jest.Mock };
  const loggerInfo = logger.info as jest.Mock;
  const loggerWarn = logger.warn as jest.Mock;
  const loggerError = logger.error as jest.Mock;
  const enforceAdminRoleMock = enforceAdminRole as jest.Mock;

  let store: CollectionStore;
  let firestore: MockFirestore;

  beforeEach(() => {
    autoIdCounter = 0;
    store = {
      jobs: {},
      payments: {},
      users: {},
      proProfiles: {},
      reviews: {},
      healthScores: {},
    };
    firestore = new MockFirestore(store);
    getFirestoreMock.mockReturnValue(firestore);
    loggerInfo.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
  enforceAdminRoleMock.mockReset();
  enforceAdminRoleMock.mockImplementation(async () => undefined);
    mockFieldValue.serverTimestamp.mockClear();
  });

  describe('submitReview', () => {
    it('creates review, updates aggregates and marks health score for recalculation', async () => {
      store.jobs['job-1'] = {
        customerUid: 'customer-1',
        status: 'completed',
        proUid: 'pro-1',
      };

      store.payments['payment-1'] = {
        jobId: 'job-1',
        status: 'completed',
      };

      store.users['customer-1'] = {
        displayName: 'Alice Smith',
      };

      store.proProfiles['pro-1'] = {
        ratingAggregate: {
          average: 4.5,
          count: 2,
          distribution: { 4: 1, 5: 1 },
        },
        averageRating: 4.5,
        reviewCount: 2,
      };

      const result = await reviewsService.submitReview({
        request: {
          jobId: 'job-1',
          paymentId: 'payment-1',
          rating: 5,
          comment: 'Great job!',
        },
        userId: 'customer-1',
      });

      expect(result.proUid).toBe('pro-1');
      expect(result.reviewId).toMatch(/^reviews_/);

      const storedReview = store.reviews[result.reviewId];
      expect(storedReview).toMatchObject({
        jobId: 'job-1',
        paymentId: 'payment-1',
        customerUid: 'customer-1',
        proUid: 'pro-1',
        rating: 5,
        comment: 'Great job!',
        customerInitials: 'AS',
        moderation: { status: 'visible' },
      });

      expect(storedReview.createdAt).toBe('timestamp');
      expect(store.proProfiles['pro-1']).toMatchObject({
        averageRating: 4.67,
        reviewCount: 3,
        ratingAggregate: {
          average: 4.67,
          count: 3,
          distribution: { 4: 1, 5: 2 },
        },
      });

      expect(store.healthScores['pro-1']).toMatchObject({
        needsRecalc: true,
      });

      expect(loggerInfo).toHaveBeenCalledWith('Review submitted successfully', expect.objectContaining({
        reviewId: result.reviewId,
        proUid: 'pro-1',
        rating: 5,
      }));
    });

    it('rejects duplicate reviews from same customer for a job', async () => {
      store.jobs['job-1'] = {
        customerUid: 'customer-1',
        status: 'completed',
        proUid: 'pro-1',
      };

      store.payments['payment-1'] = {
        jobId: 'job-1',
        status: 'completed',
      };

      store.reviews['reviews_existing'] = {
        jobId: 'job-1',
        customerUid: 'customer-1',
        proUid: 'pro-1',
      };

      await expect(
        reviewsService.submitReview({
          request: {
            jobId: 'job-1',
            paymentId: 'payment-1',
            rating: 4,
            comment: 'Duplicate review',
          },
          userId: 'customer-1',
        }),
      ).rejects.toThrow('Review already exists for this job');
    });

    it('throws when job is not completed', async () => {
      store.jobs['job-1'] = {
        customerUid: 'customer-1',
        status: 'in_progress',
        proUid: 'pro-1',
      };

      store.payments['payment-1'] = {
        jobId: 'job-1',
        status: 'completed',
      };

      await expect(
        reviewsService.submitReview({
          request: {
            jobId: 'job-1',
            paymentId: 'payment-1',
            rating: 4,
            comment: 'Too early',
          },
          userId: 'customer-1',
        }),
      ).rejects.toThrow('Job must be completed to leave a review');
    });
  });

  describe('moderateReview', () => {
    beforeEach(() => {
      store.proProfiles['pro-1'] = {
        ratingAggregate: {
          average: 4.5,
          count: 2,
          distribution: { 4: 1, 5: 1 },
        },
        averageRating: 4.5,
        reviewCount: 2,
      };

      store.reviews['rev-1'] = {
        jobId: 'job-1',
        proUid: 'pro-1',
        rating: 4,
        moderation: { status: 'visible' },
      };
    });

    it('hides a review and updates aggregates', async () => {
      await reviewsService.moderateReview({
        request: {
          reviewId: 'rev-1',
          action: 'hidden',
          reason: 'inappropriate language',
        },
        adminUid: 'admin-1',
        auth: { uid: 'admin-1' },
      });

      expect(enforceAdminRoleMock).toHaveBeenCalledWith({ uid: 'admin-1' });

      expect(store.reviews['rev-1']).toMatchObject({
        moderation: {
          status: 'hidden',
          reason: 'inappropriate language',
          adminUid: 'admin-1',
        },
      });

      expect(store.proProfiles['pro-1']).toMatchObject({
        averageRating: 5,
        reviewCount: 1,
        ratingAggregate: {
          average: 5,
          count: 1,
          distribution: { 5: 1 },
        },
      });

      expect(store.healthScores['pro-1']).toMatchObject({ needsRecalc: true });
      expect(loggerInfo).toHaveBeenCalledWith('Review moderated successfully', { reviewId: 'rev-1', action: 'hidden' });
    });

    it('makes hidden review visible and restores aggregate', async () => {
      store.reviews['rev-1'].moderation.status = 'hidden';
      store.proProfiles['pro-1'] = {
        ratingAggregate: {
          average: 5,
          count: 1,
          distribution: { 5: 1 },
        },
        averageRating: 5,
        reviewCount: 1,
      };

      await reviewsService.moderateReview({
        request: {
          reviewId: 'rev-1',
          action: 'visible',
        },
        adminUid: 'admin-1',
        auth: { uid: 'admin-1' },
      });

      expect(store.reviews['rev-1'].moderation.status).toBe('visible');
      expect(store.proProfiles['pro-1']).toMatchObject({
        ratingAggregate: {
          average: 4.5,
          count: 2,
          distribution: { 4: 1, 5: 1 },
        },
        averageRating: 4.5,
        reviewCount: 2,
      });
    });

    it('throws when review is missing', async () => {
      delete store.reviews['rev-1'];

      await expect(
        reviewsService.moderateReview({
          request: { reviewId: 'missing', action: 'hidden' },
          adminUid: 'admin-1',
          auth: { uid: 'admin-1' },
        }),
      ).rejects.toThrow('Review not found');
    });
  });

  describe('hasReviewedJob', () => {
    it('returns true when review exists', async () => {
      store.reviews['rev-1'] = {
        jobId: 'job-1',
        customerUid: 'customer-1',
      };

      const hasReviewed = await reviewsService.hasReviewedJob({ jobId: 'job-1', userId: 'customer-1' });
      expect(hasReviewed).toBe(true);
    });

    it('returns false when no review exists', async () => {
      const hasReviewed = await reviewsService.hasReviewedJob({ jobId: 'job-1', userId: 'customer-1' });
      expect(hasReviewed).toBe(false);
    });
  });

  describe('getProRatingAggregate', () => {
    it('returns stored aggregate when profile exists', async () => {
      store.proProfiles['pro-1'] = {
        ratingAggregate: {
          average: 4.6,
          count: 10,
          distribution: { 5: 6, 4: 3, 3: 1 },
        },
      };

      const aggregate = await reviewsService.getProRatingAggregate('pro-1');
      expect(aggregate).toEqual({
        average: 4.6,
        count: 10,
        distribution: { 5: 6, 4: 3, 3: 1 },
      });
    });

    it('returns defaults when profile is missing', async () => {
      const aggregate = await reviewsService.getProRatingAggregate('pro-unknown');
      expect(aggregate).toEqual({ average: 0, count: 0, distribution: {} });
    });
  });

  describe('detectSpam', () => {
    it('flags spam keywords and returns reasons', () => {
      const result = reviewsService.detectSpam('This is a BUY NOW offer!!! CLICK HERE for free money');
      expect(result.isSpam).toBe(true);
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          'Contains spam keyword: buy now',
          'Contains spam keyword: click here',
          'Contains spam keyword: free money',
        ]),
      );
      expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    });

    it('allows normal comment', () => {
      const result = reviewsService.detectSpam('Great service, would hire again.');
      expect(result.isSpam).toBe(false);
      expect(result.reasons).toHaveLength(0);
    });
  });

  describe('validateReview', () => {
    it('returns errors for invalid submission', () => {
      const result = reviewsService.validateReview({
        jobId: '',
        paymentId: '',
        rating: 0,
        comment: 'BUY NOW!!!!! spam spam spam',
      });

      expect(result.isValid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          'Rating must be between 1 and 5',
          'Job ID is required',
          'Payment ID is required',
        ]),
      );
      expect(result.errors.some((error) => error.includes('Potentially inappropriate content'))).toBe(true);
    });

    it('passes for valid submission', () => {
      const result = reviewsService.validateReview({
        jobId: 'job-1',
        paymentId: 'payment-1',
        rating: 5,
        comment: 'Fantastic work and very punctual.',
      });

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
