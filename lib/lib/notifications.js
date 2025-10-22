"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationService = void 0;
const firestore_1 = require("firebase-admin/firestore");
const messaging_1 = require("firebase-admin/messaging");
const v2_1 = require("firebase-functions/v2");
exports.notificationService = {
    async sendPushNotification({ recipientUid, title, body, data }) {
        v2_1.logger.info(`Sending push notification to ${recipientUid}: ${title}`);
        const db = (0, firestore_1.getFirestore)();
        const messaging = (0, messaging_1.getMessaging)();
        try {
            const userDoc = await db.collection('users').doc(recipientUid).get();
            if (!userDoc.exists) {
                v2_1.logger.warn(`User ${recipientUid} not found, skipping notification`);
                return;
            }
            const userData = userDoc.data();
            const fcmToken = userData === null || userData === void 0 ? void 0 : userData.fcmToken;
            if (!fcmToken) {
                v2_1.logger.warn(`No FCM token for user ${recipientUid}, skipping notification`);
                return;
            }
            const message = {
                token: fcmToken,
                notification: {
                    title,
                    body,
                },
                data: data || {},
                android: {
                    notification: {
                        priority: 'high',
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
            v2_1.logger.info(`Push notification sent successfully: ${response}`);
        }
        catch (error) {
            v2_1.logger.error(`Failed to send push notification to ${recipientUid}:`, error);
            if (error instanceof Error && error.message.includes('registration-token-not-registered')) {
                try {
                    await db.collection('users').doc(recipientUid).update({
                        fcmToken: null,
                    });
                    v2_1.logger.info(`Removed invalid FCM token for user ${recipientUid}`);
                }
                catch (updateError) {
                    v2_1.logger.error(`Failed to remove invalid token for ${recipientUid}:`, updateError);
                }
            }
        }
    },
};
//# sourceMappingURL=notifications.js.map