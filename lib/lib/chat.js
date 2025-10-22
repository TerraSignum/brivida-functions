"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatService = void 0;
const firestore_1 = require("firebase-admin/firestore");
const v2_1 = require("firebase-functions/v2");
exports.chatService = {
    async ensureChat({ jobId, customerUid, proUid }) {
        v2_1.logger.info(`Ensuring chat exists for job ${jobId} between ${customerUid} and ${proUid}`);
        const db = (0, firestore_1.getFirestore)();
        return db.runTransaction(async (transaction) => {
            const memberUids = [customerUid, proUid].sort((a, b) => a.localeCompare(b));
            const existingChatQuery = await db
                .collection('chats')
                .where('jobId', '==', jobId)
                .where('memberUids', '==', memberUids)
                .limit(1)
                .get();
            if (!existingChatQuery.empty) {
                const existingChat = existingChatQuery.docs[0];
                v2_1.logger.info(`Chat already exists: ${existingChat.id}`);
                return {
                    chatId: existingChat.id,
                    existed: true,
                };
            }
            const now = firestore_1.FieldValue.serverTimestamp();
            const chatRef = db.collection('chats').doc();
            const chatData = {
                jobId,
                customerUid,
                proUid,
                memberUids,
                lastMessageAt: now,
                createdAt: now,
            };
            transaction.set(chatRef, chatData);
            v2_1.logger.info(`Created new chat: ${chatRef.id}`);
            return {
                chatId: chatRef.id,
                existed: false,
            };
        });
    },
    async updateLastMessageTime(chatId) {
        const db = (0, firestore_1.getFirestore)();
        try {
            await db.collection('chats').doc(chatId).update({
                lastMessageAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
        catch (error) {
            v2_1.logger.error(`Failed to update lastMessageAt for chat ${chatId}:`, error);
        }
    },
};
//# sourceMappingURL=chat.js.map