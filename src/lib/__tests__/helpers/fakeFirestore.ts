import type { WhereFilterOp } from 'firebase-admin/firestore';

export type CollectionStore = Record<string, Record<string, any>>;

type ArrayUnionValue = {
  __op: 'arrayUnion';
  values: any[];
};

type IncrementValue = {
  __op: 'increment';
  amount: number;
};

function isArrayUnionValue(value: unknown): value is ArrayUnionValue {
  return Boolean(value && typeof value === 'object' && (value as any).__op === 'arrayUnion');
}

function isIncrementValue(value: unknown): value is IncrementValue {
  return Boolean(value && typeof value === 'object' && (value as any).__op === 'increment');
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  if (value instanceof FakeTimestamp) {
    return FakeTimestamp.fromDate(value.toDate()) as unknown as T;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => clone(item)) as unknown as T;
  }

  if (typeof value === 'object') {
    const entries: Record<string, any> = {};
    Object.entries(value as Record<string, any>).forEach(([key, val]) => {
      entries[key] = clone(val);
    });
    return entries as unknown as T;
  }

  return value;
}

export class FakeFieldValue {
  static serverTimestamp(): Date {
    return new Date('2024-01-01T00:00:00.000Z');
  }

  static arrayUnion(...values: any[]): ArrayUnionValue {
    return {
      __op: 'arrayUnion',
      values,
    };
  }

  static increment(amount: number): IncrementValue {
    return {
      __op: 'increment',
      amount,
    };
  }
}

export class FakeTimestamp {
  private readonly date: Date;
  private static nowDate: Date = new Date('2024-01-01T00:00:00.000Z');

  private constructor(date: Date) {
    this.date = new Date(date.getTime());
  }

  static fromDate(date: Date): FakeTimestamp {
    return new FakeTimestamp(date);
  }

  static now(): FakeTimestamp {
    return new FakeTimestamp(FakeTimestamp.nowDate);
  }

  static setNow(date: Date) {
    FakeTimestamp.nowDate = new Date(date.getTime());
  }

  toDate(): Date {
    return new Date(this.date.getTime());
  }
}

let globalIdCounter = 0;

function generateId(prefix: string): string {
  globalIdCounter += 1;
  return `${prefix}_${globalIdCounter}`;
}

function coerceComparable(value: any): any {
  if (value instanceof FakeTimestamp) {
    return value.toDate().getTime();
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return value;
}

function applyFieldValues(existing: Record<string, any>, updates: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (isArrayUnionValue(value)) {
      const current = Array.isArray(result[key]) ? (result[key] as any[]) : [];
      const merged = [...current];
      value.values.forEach((item) => {
        if (!merged.some((existingItem) => JSON.stringify(existingItem) === JSON.stringify(item))) {
          merged.push(item);
        }
      });
      result[key] = merged;
      continue;
    }

    if (isIncrementValue(value)) {
      const currentNumber = typeof result[key] === 'number' ? (result[key] as number) : 0;
      result[key] = currentNumber + value.amount;
      continue;
    }

    result[key] = value;
  }

  return result;
}

class FakeQueryDoc {
  constructor(private readonly collectionStore: Record<string, any>, public readonly id: string) {}

  data() {
    return clone(this.collectionStore[this.id]);
  }

  get ref() {
    return new FakeDocumentReference(this.collectionStore, this.id);
  }
}

type OrderByInstruction = {
  field: string;
  direction: 'asc' | 'desc';
};

class FakeQuery {
  constructor(
    private readonly collectionStore: Record<string, any>,
    private readonly filters: Array<{ field: string; op: WhereFilterOp; value: any }>,
    private readonly limitValue?: number,
    private readonly orders: OrderByInstruction[] = [],
  ) {}

  where(field: string, op: WhereFilterOp, value: any) {
    return new FakeQuery(this.collectionStore, [...this.filters, { field, op, value }], this.limitValue, this.orders);
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc') {
    return new FakeQuery(
      this.collectionStore,
      this.filters,
      this.limitValue,
      [...this.orders, { field, direction }],
    );
  }

  limit(count: number) {
    return new FakeQuery(this.collectionStore, this.filters, count, this.orders);
  }

  async get() {
    const matchedEntries: Array<[string, any]> = [];

    for (const [id, data] of Object.entries(this.collectionStore)) {
      if (this.matches(data)) {
        matchedEntries.push([id, data]);
      }
    }

    if (this.orders.length > 0) {
      matchedEntries.sort((a, b) => this.compareOrdered(a, b));
    }

    const limitedEntries = this.limitValue
      ? matchedEntries.slice(0, this.limitValue)
      : matchedEntries;

    const docs = limitedEntries.map(([id]) => new FakeQueryDoc(this.collectionStore, id));

    return {
      empty: docs.length === 0,
      size: docs.length,
      docs,
    };
  }

  private compareOrdered(aEntry: [string, any], bEntry: [string, any]): number {
    for (const { field, direction } of this.orders) {
      const aValue = field === '__name__' ? aEntry[0] : (aEntry[1] ?? {})[field];
      const bValue = field === '__name__' ? bEntry[0] : (bEntry[1] ?? {})[field];

      const coercedA = coerceComparable(aValue);
      const coercedB = coerceComparable(bValue);

      if (coercedA < coercedB) {
        return direction === 'asc' ? -1 : 1;
      }

      if (coercedA > coercedB) {
        return direction === 'asc' ? 1 : -1;
      }
    }

    return 0;
  }

  private matches(data: any): boolean {
    return this.filters.every(({ field, op, value }) => {
      const docValue = (data ?? {})[field];
      const coercedDocValue = coerceComparable(docValue);
      const coercedValue = coerceComparable(value);

      switch (op) {
        case '==':
          return coercedDocValue === coercedValue;
        case 'in':
          return Array.isArray(value) && value.some((item) => coerceComparable(item) === coercedDocValue);
        case '<=':
          return coercedDocValue <= coercedValue;
        case '<':
          return coercedDocValue < coercedValue;
        case '>=':
          return coercedDocValue >= coercedValue;
        case '>':
          return coercedDocValue > coercedValue;
        default:
          return false;
      }
    });
  }
}

export class FakeDocumentReference {
  constructor(private readonly collectionStore: Record<string, any>, public readonly id: string) {}

  async get() {
    const data = this.collectionStore[this.id];
    return {
      exists: data !== undefined,
      data: () => clone(data),
    };
  }

  async set(value: Record<string, any>) {
    this.collectionStore[this.id] = clone(value);
  }

  async update(updates: Record<string, any>) {
    const existing = this.collectionStore[this.id] ?? {};
    this.collectionStore[this.id] = applyFieldValues(existing, updates);
  }

  collection(subName: string) {
    const subCollectionKey = `${this.id}__${subName}`;
    if (!this.collectionStore[subCollectionKey]) {
      this.collectionStore[subCollectionKey] = {};
    }

    const subStore = this.collectionStore[subCollectionKey];
    return {
      add: async (data: Record<string, any>) => {
        const newId = generateId(`${subName}`);
        subStore[newId] = clone(data);
        return { id: newId };
      },
    };
  }
}

class FakeBatch {
  private readonly operations: Array<() => Promise<void>> = [];

  set(ref: FakeDocumentReference, data: Record<string, any>) {
    this.operations.push(async () => {
      await ref.set(data);
    });
  }

  update(ref: FakeDocumentReference, updates: Record<string, any>) {
    this.operations.push(async () => {
      await ref.update(updates);
    });
  }

  async commit() {
    await Promise.all(this.operations.map((op) => op()));
  }
}

export class FakeFirestore {
  constructor(private readonly store: CollectionStore = {}) {}

  reset(newStore: CollectionStore = {}) {
    Object.keys(this.store).forEach((key) => delete this.store[key]);
    Object.assign(this.store, JSON.parse(JSON.stringify(newStore)));
  }

  collection(name: string) {
    if (!this.store[name]) {
      this.store[name] = {};
    }

    const collectionStore = this.store[name];

    const docFunction = (id?: string) => {
      const docId = id ?? generateId(name);
      if (!collectionStore[docId] && !id) {
        collectionStore[docId] = undefined;
      }
      return new FakeDocumentReference(collectionStore, docId);
    };

    const query = new FakeQuery(collectionStore, []);

    return {
      doc: docFunction,
      where: query.where.bind(query),
      orderBy: query.orderBy.bind(query),
      add: async (data: Record<string, any>) => {
        const newId = generateId(name);
        collectionStore[newId] = clone(data);
        return { id: newId };
      },
      get: async () => {
        const docs = Object.keys(collectionStore).map(
          (id) => new FakeQueryDoc(collectionStore, id),
        );
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
        };
      },
    };
  }

  batch() {
    return new FakeBatch();
  }

  exportStore() {
    return JSON.parse(JSON.stringify(this.store));
  }
}

export function createFakeFirestore(initial?: CollectionStore) {
  return new FakeFirestore(initial ?? {});
}
