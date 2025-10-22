import { logger } from 'firebase-functions/v2';
import { getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'crypto';

interface CalendarEvent {
  id: string;
  ownerUid: string;
  type: 'job' | 'private' | 'availability';
  start: FirebaseFirestore.Timestamp;
  end: FirebaseFirestore.Timestamp;
  rrule?: string;
  location?: { lat: number; lng: number };
  bufferBefore: number;
  bufferAfter: number;
  visibility: 'private' | 'busy';
  jobId?: string;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt?: FirebaseFirestore.Timestamp;
}

export const calendarService = {
  /**
   * Generate or retrieve ICS token for a user
   */
  async ensureIcsToken(uid: string): Promise<string> {
    logger.info(`Ensuring ICS token for user ${uid}`);
    
    const db = getFirestore();
    const userRef = db.collection('users').doc(uid);
    
    return db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('User not found');
      }
      
      const userData = userDoc.data();
      
      // Check if token already exists
      if (userData?.icsToken && typeof userData.icsToken === 'string') {
        logger.info(`Existing ICS token found for user ${uid}`);
        return userData.icsToken;
      }
      
      // Generate new token (32 random characters)
      const token = randomBytes(16).toString('hex');
      
      // Update user document with new token
      transaction.update(userRef, {
        icsToken: token,
        updatedAt: new Date(),
      });
      
      logger.info(`Generated new ICS token for user ${uid}: ${token}`);
      return token;
    });
  },

  /**
   * Find user by ICS token
   */
  async findUserByIcsToken(token: string): Promise<string | null> {
    logger.info(`Looking up user by ICS token: ${token}`);
    
    const db = getFirestore();
    
    try {
      const query = await db
        .collection('users')
        .where('icsToken', '==', token)
        .limit(1)
        .get();
      
      if (query.empty) {
        logger.warn(`No user found with ICS token: ${token}`);
        return null;
      }
      
      const userDoc = query.docs[0];
      logger.info(`Found user ${userDoc.id} for ICS token`);
      return userDoc.id;
    } catch (error) {
      logger.error('Error finding user by ICS token', error);
      return null;
    }
  },

  /**
   * Get calendar events for a user
   */
  async getCalendarEvents(ownerUid: string): Promise<CalendarEvent[]> {
    logger.info(`Fetching calendar events for user ${ownerUid}`);
    
    const db = getFirestore();
    
    try {
      const query = await db
        .collection('calendarEvents')
        .where('ownerUid', '==', ownerUid)
        .where('type', 'in', ['job', 'private', 'availability'])
        .orderBy('start')
        .get();
      
      const events = query.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      } as CalendarEvent));
      
      logger.info(`Found ${events.length} calendar events for user ${ownerUid}`);
      return events;
    } catch (error) {
      logger.error('Error fetching calendar events', error);
      return [];
    }
  },

  /**
   * Generate ICS calendar content
   */
  generateIcsContent(events: CalendarEvent[]): string {
    logger.info(`Generating ICS content for ${events.length} events`);
    
    const header = this.generateIcsHeader();
    const eventContent = events.map(event => this.generateIcsEvent(event)).join('');
    const footer = 'END:VCALENDAR\r\n';
    
    logger.info('ICS content generated successfully');
    return header + eventContent + footer;
  },

  /**
   * Generate ICS header
   */
  generateIcsHeader(): string {
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Brivida//Calendar//EN',
      'METHOD:PUBLISH',
      'CALSCALE:GREGORIAN',
      'X-WR-CALNAME:Brivida Calendar',
      'X-WR-CALDESC:Professional cleaning service calendar',
      'X-WR-TIMEZONE:Europe/Berlin',
    ].join('\r\n') + '\r\n';
  },

  /**
   * Generate ICS event
   */
  generateIcsEvent(event: CalendarEvent): string {
    const { title, description } = this.getEventTitleAndDescription(event);
    const startFormatted = this.formatIcsDateTime(event.start.toDate());
    const endFormatted = this.formatIcsDateTime(event.end.toDate());
    const createdFormatted = this.formatIcsDateTime(event.createdAt.toDate());
    const modifiedFormatted = event.updatedAt 
      ? this.formatIcsDateTime(event.updatedAt.toDate())
      : createdFormatted;
    const timestamp = this.formatIcsDateTime(new Date());
    const eventId = `${event.id}@brivida.com`;

    let locationStr = '';
    if (event.location) {
      locationStr = `${event.location.lat},${event.location.lng}`;
    }

    return [
      'BEGIN:VEVENT',
      `UID:${eventId}`,
      `DTSTAMP:${timestamp}`,
      `DTSTART:${startFormatted}`,
      `DTEND:${endFormatted}`,
      `CREATED:${createdFormatted}`,
      `LAST-MODIFIED:${modifiedFormatted}`,
      `SUMMARY:${title}`,
      `DESCRIPTION:${description}`,
      locationStr ? `LOCATION:${locationStr}` : '',
      `STATUS:CONFIRMED`,
      `TRANSP:OPAQUE`,
      event.rrule ? `RRULE:${event.rrule}` : '',
      'END:VEVENT',
    ].filter(line => line !== '').join('\r\n') + '\r\n';
  },

  /**
   * Get event title and description based on type
   */
  getEventTitleAndDescription(event: CalendarEvent): { title: string; description: string } {
    let title = 'Brivida Event';
    let description = '';
    
    switch (event.type) {
      case 'job': {
        title = 'Job - Cleaning Service';
        const jobIdSuffix = event.jobId ? ` (Job ID: ${event.jobId})` : '';
        description = `Professional cleaning service appointment${jobIdSuffix}`;
        break;
      }
      case 'private':
        title = 'Private Event';
        description = 'Personal calendar event';
        break;
      case 'availability':
        title = 'Available for Work';
        description = 'Available time slot for cleaning service bookings';
        break;
    }

    // Add location if available
    if (event.location) {
      description += `\\nLocation: ${event.location.lat},${event.location.lng}`;
    }
    
    // Add buffers if any
    if (event.bufferBefore > 0 || event.bufferAfter > 0) {
      description += `\\nBuffer: ${event.bufferBefore}min before, ${event.bufferAfter}min after`;
    }

    return { title, description };
  },

  /**
   * Format date for ICS (YYYYMMDDTHHMMSSZ)
   */
  formatIcsDateTime(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  },

  /**
   * Get MIME type for ICS content
   */
  getIcsHeaders(): Record<string, string> {
    return {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="brivida-calendar.ics"',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    };
  },
};