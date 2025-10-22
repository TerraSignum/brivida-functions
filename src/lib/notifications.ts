import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions/v2';

export interface SendPushNotificationParams {
  recipientUid: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export const notificationService = {
  async sendPushNotification({ recipientUid, title, body, data }: SendPushNotificationParams) {
    logger.info(`Sending push notification to ${recipientUid}: ${title}`);
    
    const db = getFirestore();
    const messaging = getMessaging();
    
    try {
      // Get user's FCM token
      const userDoc = await db.collection('users').doc(recipientUid).get();
      
      if (!userDoc.exists) {
        logger.warn(`User ${recipientUid} not found, skipping notification`);
        return;
      }
      
      const userData = userDoc.data();
      const fcmToken = userData?.fcmToken;
      
      if (!fcmToken) {
        logger.warn(`No FCM token for user ${recipientUid}, skipping notification`);
        return;
      }
      
      // Send notification
      const message = {
        token: fcmToken,
        notification: {
          title,
          body,
        },
        data: data || {},
        android: {
          notification: {
            priority: 'high' as const,
            channelId: 'chat_messages',
          },
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title,
                body,
              },
              badge: 1,
              sound: 'default',
            },
          },
        },
      };
      
      const response = await messaging.send(message);
      logger.info(`Push notification sent successfully: ${response}`);
      
    } catch (error) {
      logger.error(`Failed to send push notification to ${recipientUid}:`, error);
      
      // If token is invalid, remove it from user document
      if (error instanceof Error && error.message.includes('registration-token-not-registered')) {
        try {
          await db.collection('users').doc(recipientUid).update({
            fcmToken: null,
          });
          logger.info(`Removed invalid FCM token for user ${recipientUid}`);
        } catch (updateError) {
          logger.error(`Failed to remove invalid token for ${recipientUid}:`, updateError);
        }
      }
    }
  },
};