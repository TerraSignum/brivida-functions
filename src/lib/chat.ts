import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

export interface EnsureChatParams {
  jobId: string;
  customerUid: string;
  proUid: string;
}

export const chatService = {
  async ensureChat({ jobId, customerUid, proUid }: EnsureChatParams) {
    logger.info(`Ensuring chat exists for job ${jobId} between ${customerUid} and ${proUid}`);
    
    const db = getFirestore();
    
    return db.runTransaction(async (transaction) => {
      // Sort members for consistent querying
      const memberUids = [customerUid, proUid].sort((a, b) => a.localeCompare(b));
      
      // Check if chat already exists for this job and members
      const existingChatQuery = await db
        .collection('chats')
        .where('jobId', '==', jobId)
        .where('memberUids', '==', memberUids)
        .limit(1)
        .get();

      if (!existingChatQuery.empty) {
        const existingChat = existingChatQuery.docs[0];
        logger.info(`Chat already exists: ${existingChat.id}`);
        return {
          chatId: existingChat.id,
          existed: true,
        };
      }

      // Create new chat
      const now = FieldValue.serverTimestamp();
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
      
      logger.info(`Created new chat: ${chatRef.id}`);
      return {
        chatId: chatRef.id,
        existed: false,
      };
    });
  },

  async updateLastMessageTime(chatId: string) {
    const db = getFirestore();
    
    try {
      await db.collection('chats').doc(chatId).update({
        lastMessageAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      logger.error(`Failed to update lastMessageAt for chat ${chatId}:`, error);
      // Don't throw - this is not critical
    }
  },
};