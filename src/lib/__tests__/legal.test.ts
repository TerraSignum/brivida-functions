import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

import { publishLegalDoc, getLegalDoc, setUserConsent, getUserConsent } from '../legal';

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

jest.mock('firebase-admin/firestore', () => {
  const helpers = require('./helpers/fakeFirestore');
  return {
    FieldValue: helpers.FakeFieldValue,
    Timestamp: helpers.FakeTimestamp,
  };
});

jest.mock('../firestore', () => {
  const { createFakeFirestore } = require('./helpers/fakeFirestore');
  const fakeDbInstance = createFakeFirestore();
  return {
    getDb: jest.fn(() => fakeDbInstance),
    __fakeDb: fakeDbInstance,
  };
});

const { createFakeFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');
type FakeDbInstance = ReturnType<typeof createFakeFirestore>;

const firestoreMock = jest.requireMock('../firestore') as {
  getDb: jest.Mock;
  __fakeDb: FakeDbInstance;
};
const fakeDb = firestoreMock.__fakeDb;

type AuthContext = NonNullable<CallableRequest<unknown>['auth']>;
type AuthArg = AuthContext | null | undefined;

const { enforceAdminRole } = jest.requireMock('../auth') as {
  enforceAdminRole: jest.MockedFunction<(auth: AuthArg) => Promise<void>>;
};
const enforceAdminRoleMock = enforceAdminRole;

const loggerInfo = logger.info as jest.Mock;

type RequestAuth = {
  uid: string;
  token?: Record<string, unknown>;
};

function makeRequest<TData>(data: TData, auth?: RequestAuth | null): CallableRequest<TData> {
  return {
    data,
    auth: auth ? ({ uid: auth.uid, token: auth.token ?? {} } as AuthContext) : null,
  } as CallableRequest<TData>;
}

describe('legal functions', () => {
  beforeEach(() => {
    fakeDb.reset();
    jest.clearAllMocks();
    enforceAdminRoleMock.mockReset();
    enforceAdminRoleMock.mockResolvedValue();
  });

  describe('publishLegalDoc', () => {
    it('stores a new legal document when admin publishes unique version', async () => {
      const request = makeRequest(
        {
          type: 'terms' as const,
          version: 'v1.2',
          language: 'de' as const,
          content: 'Terms content',
          title: 'Allgemeine Geschäftsbedingungen',
          htmlContent: '<p>Terms content</p>',
        },
        { uid: 'admin-1' },
      );

      const result = await publishLegalDoc(request);

      expect(result.success).toBe(true);
      const docs = await fakeDb.collection('legalDocs').get();
      expect(docs.size).toBe(1);
      const stored = docs.docs[0].data();
      expect(stored).toMatchObject({
        type: 'terms',
        version: 'v1.2',
        language: 'de',
        content: 'Terms content',
        title: 'Allgemeine Geschäftsbedingungen',
        htmlContent: '<p>Terms content</p>',
        isActive: true,
        publishedBy: 'admin-1',
      });
      expect(stored.publishedAt).toBeInstanceOf(Date);
      expect(loggerInfo).toHaveBeenCalledWith(
        '🔥 FUNCTIONS: Publishing legal document',
        expect.objectContaining({ type: 'terms', version: 'v1.2', language: 'de' }),
      );
    });

    it('rejects duplicate version for same language and type', async () => {
      await fakeDb.collection('legalDocs').doc('doc-1').set({
        type: 'privacy',
        version: 'v1.0',
        language: 'en',
        content: 'Existing privacy policy',
        title: 'Privacy',
        isActive: true,
      });

      const request = makeRequest(
        {
          type: 'privacy' as const,
          version: 'v1.0',
          language: 'en' as const,
          content: 'Updated content',
          title: 'Privacy',
        },
        { uid: 'admin-1' },
      );

      await expect(publishLegalDoc(request)).rejects.toMatchObject({ code: 'already-exists' });
    });

    it('requires semantic version format', async () => {
      const request = makeRequest(
        {
          type: 'terms' as const,
          version: '1.0',
          language: 'de' as const,
          content: 'Content',
          title: 'AGB',
        },
        { uid: 'admin-1' },
      );

      await expect(publishLegalDoc(request)).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects non-admins', async () => {
      const error = new HttpsError('permission-denied', 'Not admin');
      enforceAdminRoleMock.mockRejectedValueOnce(error);

      const request = makeRequest(
        {
          type: 'terms' as const,
          version: 'v1.0',
          language: 'de' as const,
          content: 'Content',
          title: 'AGB',
        },
        { uid: 'user-1' },
      );

      await expect(publishLegalDoc(request)).rejects.toBe(error);
    });
  });

  describe('getLegalDoc', () => {
    it('returns the latest active document for language and type', async () => {
      await fakeDb.collection('legalDocs').doc('older').set({
        type: 'terms',
        version: 'v1.0',
        language: 'en',
        content: 'Old content',
        title: 'Terms',
        isActive: true,
        publishedAt: FakeTimestamp.fromDate(new Date('2023-01-01T00:00:00Z')),
      });

      await fakeDb.collection('legalDocs').doc('newer').set({
        type: 'terms',
        version: 'v1.1',
        language: 'en',
        content: 'New content',
        title: 'Terms',
        isActive: true,
        publishedAt: FakeTimestamp.fromDate(new Date('2024-01-01T00:00:00Z')),
      });

      const response = await getLegalDoc(makeRequest({ type: 'terms' as const, language: 'en' as const }));

      expect(response.success).toBe(true);
      expect(response.document).toMatchObject({
        version: 'v1.1',
        content: 'New content',
      });
    });

    it('throws not-found when document missing', async () => {
      await expect(
        getLegalDoc(makeRequest({ type: 'privacy' as const, language: 'fr' as const })),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('setUserConsent', () => {
    beforeEach(async () => {
      await fakeDb.collection('legalDocs').doc('terms-v1').set({
        type: 'terms',
        version: 'v2.0',
        language: 'de',
        isActive: true,
      });

      await fakeDb.collection('legalDocs').doc('privacy-v1').set({
        type: 'privacy',
        version: 'v3.0',
        language: 'de',
        isActive: true,
      });
    });

    it('records consent for authenticated user when versions exist', async () => {
      const result = await setUserConsent(
        makeRequest(
          {
            tosVersion: 'v2.0',
            privacyVersion: 'v3.0',
            consentedIp: '203.0.113.1',
            consentedLang: 'de' as const,
          },
          { uid: 'user-123' },
        ),
      );

      expect(result).toMatchObject({ success: true, userId: 'user-123' });

      const consentDoc = await fakeDb.collection('userConsents').doc('user-123').get();
      expect(consentDoc.exists).toBe(true);
      expect(consentDoc.data()).toMatchObject({
        userId: 'user-123',
        tosVersion: 'v2.0',
        privacyVersion: 'v3.0',
        consentedIp: '203.0.113.1',
        consentedLang: 'de',
      });
      expect(consentDoc.data()?.consentedAt).toBeInstanceOf(Date);
      expect(loggerInfo).toHaveBeenCalledWith(
        '✅ User consent recorded successfully',
        expect.objectContaining({
          userId: 'user-123',
          tosVersion: 'v2.0',
          privacyVersion: 'v3.0',
          consentedLang: 'de',
        }),
      );
    });

    it('validates presence of required fields', async () => {
      await expect(
        setUserConsent(
          makeRequest(
            {
              tosVersion: 'v2.0',
              privacyVersion: 'v3.0',
              consentedIp: '',
              consentedLang: 'de',
            },
            { uid: 'user-123' },
          ),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('requires authentication', async () => {
      await expect(
        setUserConsent(
          makeRequest(
            {
              tosVersion: 'v2.0',
              privacyVersion: 'v3.0',
              consentedIp: '203.0.113.1',
              consentedLang: 'de' as const,
            },
            null,
          ),
        ),
      ).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('rejects unknown legal versions', async () => {
      await expect(
        setUserConsent(
          makeRequest(
            {
              tosVersion: 'v9.9',
              privacyVersion: 'v3.0',
              consentedIp: '203.0.113.1',
              consentedLang: 'de' as const,
            },
            { uid: 'user-123' },
          ),
        ),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('getUserConsent', () => {
    beforeEach(async () => {
      await fakeDb.collection('userConsents').doc('user-123').set({
        userId: 'user-123',
        tosVersion: 'v2.0',
        privacyVersion: 'v3.0',
        consentedAt: FakeTimestamp.fromDate(new Date('2024-06-01T12:00:00Z')),
        consentedIp: '198.51.100.4',
        consentedLang: 'de',
        updatedAt: FakeTimestamp.fromDate(new Date('2024-06-02T12:00:00Z')),
      });
    });

    it('returns consent data for requesting user', async () => {
      const response = await getUserConsent(makeRequest({}, { uid: 'user-123' }));

      expect(response.success).toBe(true);
      expect(response.hasConsent).toBe(true);
      expect(response.consent).toMatchObject({
        userId: 'user-123',
        tosVersion: 'v2.0',
        privacyVersion: 'v3.0',
        consentedIp: '198.51.100.4',
        consentedLang: 'de',
      });
    });

    it('indicates missing consent gracefully', async () => {
      const response = await getUserConsent(makeRequest({}, { uid: 'user-999' }));

      expect(response.success).toBe(true);
      expect(response.hasConsent).toBe(false);
      expect(response.consent).toBeNull();
    });

    it('requires authentication', async () => {
      await expect(getUserConsent(makeRequest({}, null))).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });
  });
});
