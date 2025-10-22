"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLocale = normalizeLocale;
exports.getNotificationMessage = getNotificationMessage;
exports.formatJobChanges = formatJobChanges;
const firebase_functions_1 = require("firebase-functions");
const SUPPORTED_LOCALES = ['de', 'en', 'es', 'fr', 'pt'];
const NOTIFICATION_TEMPLATES = {
    'lead.new': {
        titleKey: 'notifications.push.lead.new.title',
        bodyKey: 'notifications.push.lead.new.body',
        title: {
            de: 'Neue Anfrage verfügbar',
            en: 'New request available',
            es: 'Nueva solicitud disponible',
            fr: 'Nouvelle demande disponible',
            pt: 'Novo pedido disponível',
        },
        body: {
            de: 'Neue Reinigungsanfrage in {city}',
            en: 'Cleaning request near {city}',
            es: 'Solicitud de limpieza cerca de {city}',
            fr: 'Demande de nettoyage près de {city}',
            pt: 'Pedido de limpeza perto de {city}',
        },
    },
    'lead.accepted': {
        titleKey: 'notifications.push.lead.accepted.title',
        bodyKey: 'notifications.push.lead.accepted.body',
        title: {
            de: 'Anfrage angenommen',
            en: 'Request accepted',
            es: 'Solicitud aceptada',
            fr: 'Demande acceptée',
            pt: 'Pedido aceito',
        },
        body: {
            de: 'Ein Profi hat Ihre Anfrage angenommen.',
            en: 'A professional accepted your request.',
            es: 'Un profesional aceptó tu solicitud.',
            fr: 'Un professionnel a accepté votre demande.',
            pt: 'Um profissional aceitou o seu pedido.',
        },
    },
    'lead.declined': {
        titleKey: 'notifications.push.lead.declined.title',
        bodyKey: 'notifications.push.lead.declined.body',
        title: {
            de: 'Anfrage abgelehnt',
            en: 'Request declined',
            es: 'Solicitud rechazada',
            fr: 'Demande refusée',
            pt: 'Pedido recusado',
        },
        body: {
            de: 'Ein Profi konnte Ihre Anfrage nicht übernehmen.',
            en: 'A professional declined your request.',
            es: 'Un profesional rechazó tu solicitud.',
            fr: 'Un professionnel a refusé votre demande.',
            pt: 'Um profissional recusou o seu pedido.',
        },
    },
    'job.assigned.customer': {
        titleKey: 'notifications.push.job.assigned.customer.title',
        bodyKey: 'notifications.push.job.assigned.customer.body',
        title: {
            de: 'Auftrag bestätigt',
            en: 'Booking confirmed',
            es: 'Reserva confirmada',
            fr: 'Réservation confirmée',
            pt: 'Reserva confirmada',
        },
        body: {
            de: 'Ihre Reinigung ist geplant für {date}.',
            en: 'Your cleaning is scheduled for {date}.',
            es: 'Tu limpieza está programada para {date}.',
            fr: 'Votre nettoyage est prévu pour {date}.',
            pt: 'A sua limpeza está agendada para {date}.',
        },
    },
    'job.assigned.pro': {
        titleKey: 'notifications.push.job.assigned.pro.title',
        bodyKey: 'notifications.push.job.assigned.pro.body',
        title: {
            de: 'Neuer Auftrag',
            en: 'New booking',
            es: 'Nueva reserva',
            fr: 'Nouvelle réservation',
            pt: 'Nova reserva',
        },
        body: {
            de: 'Sie haben einen neuen Auftrag am {date}.',
            en: 'You have a new job on {date}.',
            es: 'Tienes un nuevo trabajo el {date}.',
            fr: 'Vous avez une nouvelle mission le {date}.',
            pt: 'Você tem um novo trabalho em {date}.',
        },
    },
    'job.changed': {
        titleKey: 'notifications.push.job.changed.title',
        bodyKey: 'notifications.push.job.changed.body',
        title: {
            de: 'Auftrag aktualisiert',
            en: 'Booking updated',
            es: 'Reserva actualizada',
            fr: 'Réservation mise à jour',
            pt: 'Reserva atualizada',
        },
        body: {
            de: 'Geänderte Details: {changes}',
            en: 'Updated details: {changes}',
            es: 'Detalles actualizados: {changes}',
            fr: 'Détails mis à jour : {changes}',
            pt: 'Detalhes atualizados: {changes}',
        },
    },
    'job.cancelled': {
        titleKey: 'notifications.push.job.cancelled.title',
        bodyKey: 'notifications.push.job.cancelled.body',
        title: {
            de: 'Auftrag storniert',
            en: 'Booking cancelled',
            es: 'Reserva cancelada',
            fr: 'Réservation annulée',
            pt: 'Reserva cancelada',
        },
        body: {
            de: 'Ihr Auftrag wurde storniert.',
            en: 'Your booking was cancelled.',
            es: 'Tu reserva fue cancelada.',
            fr: 'Votre réservation a été annulée.',
            pt: 'A sua reserva foi cancelada.',
        },
    },
    'job.reminder24h.customer': {
        titleKey: 'notifications.push.job.reminder24h.customer.title',
        bodyKey: 'notifications.push.job.reminder24h.customer.body',
        title: {
            de: 'Erinnerung: Reinigung morgen',
            en: 'Reminder: Cleaning tomorrow',
            es: 'Recordatorio: limpieza mañana',
            fr: 'Rappel : nettoyage demain',
            pt: 'Lembrete: limpeza amanhã',
        },
        body: {
            de: 'Ihre Reinigung ist morgen um {time} geplant.',
            en: 'Your cleaning is tomorrow at {time}.',
            es: 'Tu limpieza es mañana a las {time}.',
            fr: 'Votre nettoyage est prévu demain à {time}.',
            pt: 'A sua limpeza é amanhã às {time}.',
        },
    },
    'job.reminder24h.pro': {
        titleKey: 'notifications.push.job.reminder24h.pro.title',
        bodyKey: 'notifications.push.job.reminder24h.pro.body',
        title: {
            de: 'Erinnerung: Auftrag morgen',
            en: 'Reminder: Job tomorrow',
            es: 'Recordatorio: trabajo mañana',
            fr: 'Rappel : mission demain',
            pt: 'Lembrete: trabalho amanhã',
        },
        body: {
            de: 'Sie haben morgen um {time} einen Auftrag.',
            en: 'You have a job tomorrow at {time}.',
            es: 'Tienes un trabajo mañana a las {time}.',
            fr: 'Vous avez une mission demain à {time}.',
            pt: 'Você tem um trabalho amanhã às {time}.',
        },
    },
    'job.reminder1h.customer': {
        titleKey: 'notifications.push.job.reminder1h.customer.title',
        bodyKey: 'notifications.push.job.reminder1h.customer.body',
        title: {
            de: 'Erinnerung: Reinigung in 1 Stunde',
            en: 'Reminder: Cleaning in 1 hour',
            es: 'Recordatorio: limpieza en 1 hora',
            fr: 'Rappel : nettoyage dans 1 heure',
            pt: 'Lembrete: limpeza em 1 hora',
        },
        body: {
            de: 'Ihre Reinigung startet in etwa 1 Stunde.',
            en: 'Your cleaning starts in about 1 hour.',
            es: 'Tu limpieza empieza en aproximadamente 1 hora.',
            fr: 'Votre nettoyage commence dans environ 1 heure.',
            pt: 'A sua limpeza começa em cerca de 1 hora.',
        },
    },
    'job.reminder1h.pro': {
        titleKey: 'notifications.push.job.reminder1h.pro.title',
        bodyKey: 'notifications.push.job.reminder1h.pro.body',
        title: {
            de: 'Erinnerung: Auftrag in 1 Stunde',
            en: 'Reminder: Job in 1 hour',
            es: 'Recordatorio: trabajo en 1 hora',
            fr: 'Rappel : mission dans 1 heure',
            pt: 'Lembrete: trabalho em 1 hora',
        },
        body: {
            de: 'Ihr Auftrag beginnt in etwa 1 Stunde.',
            en: 'Your job starts in about 1 hour.',
            es: 'Tu trabajo empieza en aproximadamente 1 hora.',
            fr: 'Votre mission commence dans environ 1 heure.',
            pt: 'O seu trabalho começa em cerca de 1 hora.',
        },
    },
    'payment.captured': {
        titleKey: 'notifications.push.payment.captured.title',
        bodyKey: 'notifications.push.payment.captured.body',
        title: {
            de: 'Zahlung eingegangen',
            en: 'Payment received',
            es: 'Pago recibido',
            fr: 'Paiement reçu',
            pt: 'Pagamento recebido',
        },
        body: {
            de: 'Wir haben Ihre Zahlung über {amount} erfasst.',
            en: 'We captured your payment of {amount}.',
            es: 'Registramos tu pago de {amount}.',
            fr: 'Nous avons encaissé votre paiement de {amount}.',
            pt: 'Registámos o seu pagamento de {amount}.',
        },
    },
    'payment.released': {
        titleKey: 'notifications.push.payment.released.title',
        bodyKey: 'notifications.push.payment.released.body',
        title: {
            de: 'Auszahlung freigegeben',
            en: 'Payout released',
            es: 'Pago liberado',
            fr: 'Versement effectué',
            pt: 'Pagamento liberado',
        },
        body: {
            de: 'Ihre Auszahlung über {amount} wurde freigegeben.',
            en: 'Your payout of {amount} was released.',
            es: 'Se liberó tu pago de {amount}.',
            fr: 'Votre versement de {amount} a été effectué.',
            pt: 'O seu pagamento de {amount} foi liberado.',
        },
    },
    'payment.refunded': {
        titleKey: 'notifications.push.payment.refunded.title',
        bodyKey: 'notifications.push.payment.refunded.body',
        title: {
            de: 'Zahlung erstattet',
            en: 'Payment refunded',
            es: 'Pago reembolsado',
            fr: 'Paiement remboursé',
            pt: 'Pagamento reembolsado',
        },
        body: {
            de: 'Wir haben {amount} zurückerstattet.',
            en: 'We refunded {amount}.',
            es: 'Reembolsamos {amount}.',
            fr: 'Nous avons remboursé {amount}.',
            pt: 'Reembolsámos {amount}.',
        },
    },
    'dispute.opened': {
        titleKey: 'notifications.push.dispute.opened.title',
        bodyKey: 'notifications.push.dispute.opened.body',
        title: {
            de: 'Neue Streitigkeit',
            en: 'Dispute opened',
            es: 'Disputa abierta',
            fr: 'Litige ouvert',
            pt: 'Disputa aberta',
        },
        body: {
            de: 'Für Ihren Auftrag wurde eine Streitigkeit eröffnet.',
            en: 'A dispute was opened for your booking.',
            es: 'Se abrió una disputa para tu reserva.',
            fr: 'Un litige a été ouvert pour votre réservation.',
            pt: 'Foi aberta uma disputa para a sua reserva.',
        },
    },
    'dispute.response': {
        titleKey: 'notifications.push.dispute.response.title',
        bodyKey: 'notifications.push.dispute.response.body',
        title: {
            de: 'Neue Antwort in Streitigkeit',
            en: 'New dispute response',
            es: 'Nueva respuesta en la disputa',
            fr: 'Nouvelle réponse au litige',
            pt: 'Nova resposta na disputa',
        },
        body: {
            de: 'Es gibt eine neue Antwort in Ihrer Streitigkeit.',
            en: 'There is a new response in your dispute.',
            es: 'Hay una nueva respuesta en tu disputa.',
            fr: 'Il y a une nouvelle réponse dans votre litige.',
            pt: 'Existe uma nova resposta na sua disputa.',
        },
    },
    'dispute.decision': {
        titleKey: 'notifications.push.dispute.decision.title',
        bodyKey: 'notifications.push.dispute.decision.body',
        title: {
            de: 'Streitigkeit beendet',
            en: 'Dispute resolved',
            es: 'Disputa resuelta',
            fr: 'Litige résolu',
            pt: 'Disputa resolvida',
        },
        body: {
            de: 'Ihre Streitigkeit wurde entschieden.',
            en: 'We added a decision to your dispute.',
            es: 'Se tomó una decisión en tu disputa.',
            fr: 'Une décision a été prise pour votre litige.',
            pt: 'Foi tomada uma decisão na sua disputa.',
        },
    },
    'chat.newMessage': {
        titleKey: 'notifications.push.chat.newMessage.title',
        bodyKey: 'notifications.push.chat.newMessage.body',
        title: {
            de: 'Neue Nachricht',
            en: 'New message',
            es: 'Nuevo mensaje',
            fr: 'Nouveau message',
            pt: 'Nova mensagem',
        },
        body: {
            de: 'Sie haben eine neue Nachricht erhalten.',
            en: 'You received a new message.',
            es: 'Has recibido un nuevo mensaje.',
            fr: 'Vous avez reçu un nouveau message.',
            pt: 'Você recebeu uma nova mensagem.',
        },
    },
};
const JOB_CHANGE_LABELS = {
    date: {
        de: 'Termin aktualisiert',
        en: 'Date updated',
        es: 'Fecha actualizada',
        fr: 'Date mise à jour',
        pt: 'Data atualizada',
    },
    address: {
        de: 'Adresse aktualisiert',
        en: 'Address updated',
        es: 'Dirección actualizada',
        fr: 'Adresse mise à jour',
        pt: 'Endereço atualizado',
    },
    status: {
        de: 'Status aktualisiert',
        en: 'Status updated',
        es: 'Estado actualizado',
        fr: 'Statut mis à jour',
        pt: 'Status atualizado',
    },
};
function normalizeLocale(locale) {
    if (!locale) {
        return 'en';
    }
    const lower = locale.toLowerCase();
    for (const supported of SUPPORTED_LOCALES) {
        if (lower === supported || lower.startsWith(`${supported}-`)) {
            return supported;
        }
    }
    return 'en';
}
function getNotificationMessage(locale, templateKey, templateParams = {}) {
    var _a, _b;
    const template = NOTIFICATION_TEMPLATES[templateKey];
    if (!template) {
        firebase_functions_1.logger.warn('Missing notification template', { templateKey });
        return {
            title: 'Notification',
            body: 'You have a new notification.',
            titleKey: 'notifications.push.fallback.title',
            bodyKey: 'notifications.push.fallback.body',
            locale: 'en',
            params: {},
        };
    }
    const targetLocale = normalizeLocale(locale);
    const params = resolveTemplateParams(templateParams, targetLocale, templateKey);
    const titleTemplate = (_a = template.title[targetLocale]) !== null && _a !== void 0 ? _a : template.title.en;
    const bodyTemplate = (_b = template.body[targetLocale]) !== null && _b !== void 0 ? _b : template.body.en;
    return {
        title: applyParams(titleTemplate, params),
        body: applyParams(bodyTemplate, params),
        titleKey: template.titleKey,
        bodyKey: template.bodyKey,
        locale: targetLocale,
        params,
    };
}
function formatJobChanges(locale, changeKeys) {
    if (changeKeys.length === 0) {
        return '';
    }
    const values = changeKeys
        .map((key) => {
        var _a;
        const dictionary = JOB_CHANGE_LABELS[key];
        if (!dictionary) {
            return key;
        }
        return (_a = dictionary[locale]) !== null && _a !== void 0 ? _a : dictionary.en;
    })
        .filter((value) => value && value.trim().length > 0);
    if (values.length === 0) {
        return '';
    }
    return joinWithConjunction(values, locale);
}
function resolveTemplateParams(rawParams, locale, templateKey) {
    const resolved = {};
    for (const [key, value] of Object.entries(rawParams)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (typeof value === 'function') {
            resolved[key] = value(locale);
        }
        else if (value instanceof Date) {
            resolved[key] = formatDateForLocale(value, locale);
        }
        else {
            resolved[key] = String(value);
        }
    }
    if (templateKey.startsWith('payment.') && rawParams.amountNumeric !== undefined) {
        const numericValue = rawParams.amountNumeric;
        if (typeof numericValue === 'number') {
            resolved.amount = formatCurrency(numericValue, locale);
        }
    }
    return resolved;
}
function applyParams(template, params) {
    let output = template;
    for (const [key, value] of Object.entries(params)) {
        const token = `{${key}}`;
        if (output.includes(token)) {
            output = output.split(token).join(value);
        }
    }
    return output;
}
function formatDateForLocale(input, locale) {
    try {
        return new Intl.DateTimeFormat(locale, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        }).format(input);
    }
    catch (error) {
        firebase_functions_1.logger.warn('Date formatting failed, using ISO string', { error });
        return input.toISOString();
    }
}
function formatCurrency(amount, locale) {
    try {
        return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: 'EUR',
            maximumFractionDigits: 2,
        }).format(amount);
    }
    catch (error) {
        firebase_functions_1.logger.warn('Currency formatting failed, using fallback string', { error });
        return `${amount.toFixed(2)} €`;
    }
}
function joinWithConjunction(values, locale) {
    var _a, _b, _c;
    if (values.length <= 1) {
        return (_a = values[0]) !== null && _a !== void 0 ? _a : '';
    }
    const conjunctionWord = {
        de: 'und',
        en: 'and',
        es: 'y',
        fr: 'et',
        pt: 'e',
    };
    const word = (_b = conjunctionWord[locale]) !== null && _b !== void 0 ? _b : conjunctionWord.en;
    if (values.length === 2) {
        return `${values[0]} ${word} ${values[1]}`;
    }
    const leading = values.slice(0, -1).join(', ');
    const last = (_c = values.at(-1)) !== null && _c !== void 0 ? _c : '';
    return `${leading}, ${word} ${last}`;
}
//# sourceMappingURL=notification_localization.js.map