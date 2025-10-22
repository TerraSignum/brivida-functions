"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calendarService = void 0;
const v2_1 = require("firebase-functions/v2");
const firestore_1 = require("firebase-admin/firestore");
const crypto_1 = require("crypto");
exports.calendarService = {
    async ensureIcsToken(uid) {
        v2_1.logger.info(`Ensuring ICS token for user ${uid}`);
        const db = (0, firestore_1.getFirestore)();
        const userRef = db.collection('users').doc(uid);
        return db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error('User not found');
            }
            const userData = userDoc.data();
            if ((userData === null || userData === void 0 ? void 0 : userData.icsToken) && typeof userData.icsToken === 'string') {
                v2_1.logger.info(`Existing ICS token found for user ${uid}`);
                return userData.icsToken;
            }
            const token = (0, crypto_1.randomBytes)(16).toString('hex');
            transaction.update(userRef, {
                icsToken: token,
                updatedAt: new Date(),
            });
            v2_1.logger.info(`Generated new ICS token for user ${uid}: ${token}`);
            return token;
        });
    },
    async findUserByIcsToken(token) {
        v2_1.logger.info(`Looking up user by ICS token: ${token}`);
        const db = (0, firestore_1.getFirestore)();
        try {
            const query = await db
                .collection('users')
                .where('icsToken', '==', token)
                .limit(1)
                .get();
            if (query.empty) {
                v2_1.logger.warn(`No user found with ICS token: ${token}`);
                return null;
            }
            const userDoc = query.docs[0];
            v2_1.logger.info(`Found user ${userDoc.id} for ICS token`);
            return userDoc.id;
        }
        catch (error) {
            v2_1.logger.error('Error finding user by ICS token', error);
            return null;
        }
    },
    async getCalendarEvents(ownerUid) {
        v2_1.logger.info(`Fetching calendar events for user ${ownerUid}`);
        const db = (0, firestore_1.getFirestore)();
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
            }));
            v2_1.logger.info(`Found ${events.length} calendar events for user ${ownerUid}`);
            return events;
        }
        catch (error) {
            v2_1.logger.error('Error fetching calendar events', error);
            return [];
        }
    },
    generateIcsContent(events) {
        v2_1.logger.info(`Generating ICS content for ${events.length} events`);
        const header = this.generateIcsHeader();
        const eventContent = events.map(event => this.generateIcsEvent(event)).join('');
        const footer = 'END:VCALENDAR\r\n';
        v2_1.logger.info('ICS content generated successfully');
        return header + eventContent + footer;
    },
    generateIcsHeader() {
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
    generateIcsEvent(event) {
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
    getEventTitleAndDescription(event) {
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
        if (event.location) {
            description += `\\nLocation: ${event.location.lat},${event.location.lng}`;
        }
        if (event.bufferBefore > 0 || event.bufferAfter > 0) {
            description += `\\nBuffer: ${event.bufferBefore}min before, ${event.bufferAfter}min after`;
        }
        return { title, description };
    },
    formatIcsDateTime(date) {
        return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    },
    getIcsHeaders() {
        return {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': 'attachment; filename="brivida-calendar.ics"',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
        };
    },
};
//# sourceMappingURL=calendar.js.map