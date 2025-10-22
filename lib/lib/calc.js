"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extrasHoursFromIds = extrasHoursFromIds;
exports.getBaseHours = getBaseHours;
exports.discountPercent = discountPercent;
exports.getCancellationTier = getCancellationTier;
exports.computeAmounts = computeAmounts;
exports.cancellationSplit = cancellationSplit;
exports.generateRecurringDates = generateRecurringDates;
exports.validatePricingInputs = validatePricingInputs;
const EXTRA_HOURS = {
    windows_in: 1.0,
    windows_in_out: 2.0,
    kitchen_deep: 0.5,
    ironing_small: 0.5,
    ironing_large: 1.0,
    balcony: 0.5,
    laundry: 1.0,
};
const BASE_HOURS = {
    S: 3.0,
    M: 4.0,
    L: 5.0,
    XL: 6.0,
    GT250: 0,
};
const HOURLY_RATE_EUR = 15.0;
const MATERIAL_FEE_EUR = 7.0;
const EXPRESS_MULTIPLIER = 1.20;
const MAX_TOTAL_HOURS = 8.0;
function extrasHoursFromIds(ids) {
    return ids.reduce((sum, id) => sum + (EXTRA_HOURS[id] || 0), 0);
}
function getBaseHours(category) {
    return BASE_HOURS[category] || 0;
}
function discountPercent(occurrenceIndex) {
    if (occurrenceIndex >= 5)
        return 15;
    if (occurrenceIndex >= 2)
        return 10;
    return 0;
}
function getCancellationTier(hoursUntilJob) {
    if (hoursUntilJob >= 48)
        return "FREE";
    if (hoursUntilJob >= 24)
        return "P25";
    return "P50";
}
function computeAmounts({ baseHours, extras, materialProvidedByPro, isExpress, occurrenceIndex, }) {
    const extrasHours = extrasHoursFromIds(extras);
    const totalHours = Math.min(baseHours + extrasHours, MAX_TOTAL_HOURS);
    const actualBaseHours = totalHours - extrasHours >= 0 ? baseHours : totalHours - extrasHours;
    const actualExtrasHours = totalHours - actualBaseHours;
    const baseAmount = totalHours * HOURLY_RATE_EUR;
    const materialAmount = materialProvidedByPro ? MATERIAL_FEE_EUR : 0;
    const discount = discountPercent(occurrenceIndex);
    const amountBeforeDiscount = baseAmount + materialAmount;
    const discountedBaseAmount = baseAmount * (1 - discount / 100);
    const amountAfterDiscount = discountedBaseAmount + materialAmount;
    const amountTotal = amountAfterDiscount * (isExpress ? EXPRESS_MULTIPLIER : 1.0);
    const platformBaseShare = discountedBaseAmount * 0.15;
    const platformExpressBonus = isExpress ? baseAmount * 0.05 : 0;
    const platformEur = platformBaseShare + platformExpressBonus;
    const proBaseShare = discountedBaseAmount * 0.85;
    const proExpressBonus = isExpress ? baseAmount * 0.15 : 0;
    const proEur = proBaseShare + proExpressBonus + materialAmount;
    return {
        baseHours: actualBaseHours,
        extrasHours: actualExtrasHours,
        totalHours,
        materialAmount,
        discount,
        amountBeforeDiscount,
        amountAfterDiscount,
        amountTotal,
        platformEur,
        proEur,
        baseAmount,
        discountedBaseAmount,
        platformBaseShare,
        platformExpressBonus,
        proBaseShare,
        proExpressBonus,
    };
}
function cancellationSplit({ baseHours, extrasHours, materialAmount, isExpress, occurrenceIndex, tier, }) {
    const totalHours = Math.min(baseHours + extrasHours, MAX_TOTAL_HOURS);
    const baseAmount = totalHours * HOURLY_RATE_EUR;
    const discount = discountPercent(occurrenceIndex);
    const discountedBaseAmount = baseAmount * (1 - discount / 100);
    const amountAfterDiscount = discountedBaseAmount + materialAmount;
    const amountTotal = amountAfterDiscount * (isExpress ? EXPRESS_MULTIPLIER : 1.0);
    let proPercentage;
    switch (tier) {
        case "FREE":
            proPercentage = 0;
            break;
        case "P25":
            proPercentage = 0.25;
            break;
        case "P50":
            proPercentage = 0.50;
            break;
        default:
            proPercentage = 0;
    }
    const payoutToProEur = amountTotal * proPercentage;
    const refundToCustomerEur = amountTotal - payoutToProEur;
    const platformNormalShare = (amountTotal - refundToCustomerEur) * 0.15;
    const platformShareEur = Math.max(0, platformNormalShare);
    return {
        payoutToProEur,
        refundToCustomerEur,
        platformShareEur,
        originalTotal: amountTotal,
    };
}
function generateRecurringDates(startDate, recurrenceType, maxMonthsAhead = 3) {
    if (recurrenceType === "none")
        return [];
    const dates = [];
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + maxMonthsAhead);
    let currentDate = new Date(startDate);
    let intervalDays = 0;
    switch (recurrenceType) {
        case "weekly":
            intervalDays = 7;
            break;
        case "biweekly":
            intervalDays = 14;
            break;
        case "monthly":
            intervalDays = 30;
            break;
    }
    while (currentDate <= endDate && dates.length < 12) {
        currentDate = new Date(currentDate);
        currentDate.setDate(currentDate.getDate() + intervalDays);
        if (currentDate <= endDate) {
            dates.push(new Date(currentDate));
        }
    }
    return dates;
}
function validatePricingInputs({ category, extras, occurrenceIndex, }) {
    const errors = [];
    if (!BASE_HOURS[category] && category !== "GT250") {
        errors.push(`Invalid category: ${category}`);
    }
    if (occurrenceIndex < 1) {
        errors.push("Occurrence index must be >= 1");
    }
    const invalidExtras = extras.filter(id => !(id in EXTRA_HOURS));
    if (invalidExtras.length > 0) {
        errors.push(`Invalid extra services: ${invalidExtras.join(", ")}`);
    }
    const totalHours = getBaseHours(category) + extrasHoursFromIds(extras);
    if (totalHours > MAX_TOTAL_HOURS) {
        errors.push(`Total hours (${totalHours}) exceeds maximum (${MAX_TOTAL_HOURS})`);
    }
    return {
        valid: errors.length === 0,
        errors,
    };
}
//# sourceMappingURL=calc.js.map