"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.firestoreHelpers = void 0;
exports.getDb = getDb;
const firestore_1 = require("firebase-admin/firestore");
let _db = null;
function getDb() {
    _db !== null && _db !== void 0 ? _db : (_db = (0, firestore_1.getFirestore)());
    return _db;
}
exports.firestoreHelpers = {
    collections: {
        leads: () => getDb().collection('leads'),
        jobs: () => getDb().collection('jobs'),
        users: () => getDb().collection('users'),
        payments: () => getDb().collection('payments'),
        transfers: () => getDb().collection('transfers'),
        transactions: () => getDb().collection('transactions'),
        refunds: () => getDb().collection('refunds'),
    },
    async getLead(leadId) {
        const doc = await this.collections.leads().doc(leadId).get();
        if (!doc.exists)
            return null;
        const data = doc.data();
        return {
            id: doc.id,
            ...data,
        };
    },
    async getJob(jobId) {
        const doc = await this.collections.jobs().doc(jobId).get();
        if (!doc.exists)
            return null;
        const data = doc.data();
        return {
            id: doc.id,
            ...data,
        };
    },
    async updateLead(leadId, updates) {
        return this.collections.leads().doc(leadId).update(updates);
    },
    async updateJob(jobId, updates) {
        return this.collections.jobs().doc(jobId).update(updates);
    },
};
//# sourceMappingURL=firestore.js.map