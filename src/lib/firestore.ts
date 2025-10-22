import { getFirestore } from 'firebase-admin/firestore';

// Lazy initialization to avoid calling getFirestore() before initializeApp()
let _db: FirebaseFirestore.Firestore | null = null;

export function getDb() {
  _db ??= getFirestore();
  return _db;
}

export interface Lead {
  id?: string;
  jobId: string;
  customerUid: string;
  proUid: string;
  message?: string;
  status: 'pending' | 'accepted' | 'declined';
  acceptedAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export interface Job {
  id?: string;
  customerUid: string;
  location?: {
    lat: number;
    lng: number;
  };
  addressMasked: boolean;
  sizeM2: number;
  rooms: number;
  services: string[];
  window: {
    start: Date;
    end: Date;
  };
  budget: number;
  notes: string;
  status: 'open' | 'assigned' | 'completed' | 'cancelled';
  visibleTo: string[];
  createdAt: Date;
  updatedAt?: Date;
}

export const firestoreHelpers = {
  collections: {
    leads: () => getDb().collection('leads'),
    jobs: () => getDb().collection('jobs'),
    users: () => getDb().collection('users'),
    payments: () => getDb().collection('payments'),
    transfers: () => getDb().collection('transfers'),
    transactions: () => getDb().collection('transactions'),
    refunds: () => getDb().collection('refunds'),
  },

  async getLead(leadId: string): Promise<Lead | null> {
    const doc = await this.collections.leads().doc(leadId).get();
    if (!doc.exists) return null;
    
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
    } as Lead;
  },

  async getJob(jobId: string): Promise<Job | null> {
    const doc = await this.collections.jobs().doc(jobId).get();
    if (!doc.exists) return null;
    
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
    } as Job;
  },

  async updateLead(leadId: string, updates: Partial<Lead>) {
    return this.collections.leads().doc(leadId).update(updates);
  },

  async updateJob(jobId: string, updates: Partial<Job>) {
    return this.collections.jobs().doc(jobId).update(updates);
  },
};