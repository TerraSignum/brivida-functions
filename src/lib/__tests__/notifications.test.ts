import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { notificationService } from '../notifications';
import { logger } from 'firebase-functions/v2';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

jest.mock('firebase-functions/v2', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(),
}));

describe('notificationService.sendPushNotification', () => {
  type DocSnapshot = { exists: boolean; data?: () => any };

  let firestoreDoc: any;
  let firestoreCollection: any;
  let firestore: any;
  let messaging: any;

  const getFirestoreMock = getFirestore as jest.Mock;
  const getMessagingMock = getMessaging as jest.Mock;
  const loggerInfo = logger.info as jest.Mock;
  const loggerWarn = logger.warn as jest.Mock;
  const loggerError = logger.error as jest.Mock;

  const setupFirestore = (docData: DocSnapshot) => {
    const getMock = jest.fn(async () => docData);

    const updateMock = jest.fn(async () => undefined);

    firestoreDoc = {
      get: getMock,
      update: updateMock,
    };

    firestoreCollection = {
      doc: jest.fn(() => firestoreDoc),
    };

    firestore = {
      collection: jest.fn(() => firestoreCollection),
    };

    getFirestoreMock.mockReturnValue(firestore);
  };

  const setupMessaging = (implementation?: () => Promise<any>) => {
    messaging = {
      send: jest.fn(implementation || (() => Promise.resolve('msg-1'))),
    };

    getMessagingMock.mockReturnValue(messaging);
  };

  beforeEach(() => {
    jest.resetModules();
    getFirestoreMock.mockReset();
    getMessagingMock.mockReset();
    loggerInfo.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('sends a push notification when user and token are available', async () => {
    setupFirestore({ exists: true, data: () => ({ fcmToken: 'token-123' }) });
    setupMessaging();

    await notificationService.sendPushNotification({
      recipientUid: 'user-1',
      title: 'Hello',
      body: 'World',
      data: { foo: 'bar' },
    });

    expect(firestore.collection).toHaveBeenCalledWith('users');
    expect(firestoreCollection.doc).toHaveBeenCalledWith('user-1');
    expect(messaging.send).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token-123',
      notification: {
        title: 'Hello',
        body: 'World',
      },
      data: { foo: 'bar' },
    }));
    expect(firestoreDoc.update).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith('Push notification sent successfully: msg-1');
  });

  it('skips when user document does not exist', async () => {
    setupFirestore({ exists: false });
    setupMessaging();

    await notificationService.sendPushNotification({
      recipientUid: 'missing-user',
      title: 'Test',
      body: 'Body',
    });

    expect(loggerWarn).toHaveBeenCalledWith('User missing-user not found, skipping notification');
    expect(messaging.send).not.toHaveBeenCalled();
  });

  it('skips when user has no FCM token', async () => {
    setupFirestore({ exists: true, data: () => ({}) });
    setupMessaging();

    await notificationService.sendPushNotification({
      recipientUid: 'user-2',
      title: 'No Token',
      body: 'Body',
    });

    expect(loggerWarn).toHaveBeenCalledWith('No FCM token for user user-2, skipping notification');
    expect(messaging.send).not.toHaveBeenCalled();
  });

  it('removes invalid token when messaging rejects with registration error', async () => {
    setupFirestore({ exists: true, data: () => ({ fcmToken: 'bad-token' }) });
    setupMessaging(() => Promise.reject(new Error('registration-token-not-registered')));

    await notificationService.sendPushNotification({
      recipientUid: 'user-3',
      title: 'Cleanup',
      body: 'Token',
    });

    expect(loggerError).toHaveBeenCalledWith('Failed to send push notification to user-3:', expect.any(Error));
    expect(firestoreDoc.update).toHaveBeenCalledWith({ fcmToken: null });
    expect(loggerInfo).toHaveBeenCalledWith('Removed invalid FCM token for user user-3');
  });

  it('logs error without removing token for other failures', async () => {
    setupFirestore({ exists: true, data: () => ({ fcmToken: 'token-xyz' }) });
    const genericError = new Error('network failure');
    setupMessaging(() => Promise.reject(genericError));

    await notificationService.sendPushNotification({
      recipientUid: 'user-4',
      title: 'Oops',
      body: 'Error',
    });

    expect(loggerError).toHaveBeenCalledWith('Failed to send push notification to user-4:', genericError);
    expect(firestoreDoc.update).not.toHaveBeenCalled();
  });
});
