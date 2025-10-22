import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HttpsError } from 'firebase-functions/v2/https';

jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn().mockReturnValue({
    value: () => 'test-key',
  }),
}));

describe('location service helpers', () => {
  const originalFetch = globalThis.fetch;

  const mockFetchResponse = (body: unknown) => {
    const response = {
      json: async () => body,
    } as any;

    globalThis.fetch = jest
      .fn()
      .mockImplementation(() => Promise.resolve(response)) as unknown as typeof fetch;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('calculateEta', () => {
    it('returns duration and distance when Distance Matrix API responds OK', async () => {
      const { calculateEta } = await import('../lib/location');

      mockFetchResponse({
        status: 'OK',
        rows: [
          {
            elements: [
              {
                status: 'OK',
                duration: { text: '18 mins', value: 1080 },
                distance: { text: '12 km', value: 12000 },
              },
            ],
          },
        ],
      });

      const result = await calculateEta(52.52, 13.405, 52.5, 13.4);

      expect(result).toEqual({
        duration: '18 mins',
        distance: '12 km',
        durationValue: 1080,
        distanceValue: 12000,
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('distancematrix')
      );
    });

    it('throws HttpsError when Distance Matrix API responds with error status', async () => {
      const { calculateEta } = await import('../lib/location');

      mockFetchResponse({
        status: 'OVER_QUERY_LIMIT',
        error_message: 'Too many requests',
      });

      await expect(
        calculateEta(1, 2, 3, 4)
      ).rejects.toThrowError(HttpsError);
    });

    it('throws HttpsError when route element is missing', async () => {
      const { calculateEta } = await import('../lib/location');

      mockFetchResponse({
        status: 'OK',
        rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }],
      });

      await expect(calculateEta(1, 2, 3, 4)).rejects.toMatchObject({
        code: 'unavailable',
        message: 'ETA service unavailable',
      });
    });
  });

  describe('geocodeAddress', () => {
    it('returns formatted address and coordinates when Geocoding API responds OK', async () => {
      const { geocodeAddress } = await import('../lib/location');

      mockFetchResponse({
        status: 'OK',
        results: [
          {
            formatted_address: 'Brandenburg Gate, Berlin, Germany',
            geometry: { location: { lat: 52.5163, lng: 13.3777 } },
            address_components: [
              { long_name: 'Berlin', types: ['locality'] },
              { long_name: 'Berlin', types: ['administrative_area_level_2'] },
            ],
          },
        ],
      });

      const result = await geocodeAddress('Brandenburg Gate');

      expect(result).toEqual({
        formattedAddress: 'Brandenburg Gate, Berlin, Germany',
        lat: 52.5163,
        lng: 13.3777,
        city: 'Berlin',
        district: 'Berlin',
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('geocode')
      );
    });

    it('throws HttpsError when Geocoding API responds with error status', async () => {
      const { geocodeAddress } = await import('../lib/location');

      mockFetchResponse({
        status: 'REQUEST_DENIED',
        error_message: 'Invalid key',
      });

      await expect(geocodeAddress('Invalid')).rejects.toThrowError(HttpsError);
    });

    it('throws HttpsError when no results are returned', async () => {
      const { geocodeAddress } = await import('../lib/location');

      mockFetchResponse({
        status: 'OK',
        results: [],
      });

      await expect(geocodeAddress('Nowhere')).rejects.toMatchObject({
        code: 'unavailable',
        message: 'Geocoding service unavailable',
      });
    });
  });
});
