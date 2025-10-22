// PG-17/18: Enhanced Pricing Calculation Library for Cloud Functions
export type ExtraId =
  | "windows_in"
  | "windows_in_out"
  | "kitchen_deep"
  | "ironing_small"
  | "ironing_large"
  | "balcony"
  | "laundry";

export type JobCategory = "S" | "M" | "L" | "XL" | "GT250";

export type RecurrenceType = "none" | "weekly" | "biweekly" | "monthly";

export type CancellationTier = "FREE" | "P25" | "P50";

// Hours mapping for extras
const EXTRA_HOURS: Record<ExtraId, number> = {
  windows_in: 1.0,
  windows_in_out: 2.0,
  kitchen_deep: 0.5,
  ironing_small: 0.5,
  ironing_large: 1.0,
  balcony: 0.5,
  laundry: 1.0,
};

// Base hours by category
const BASE_HOURS: Record<JobCategory, number> = {
  S: 3.0,   // ≤ 60 m²
  M: 4.0,   // 61-120 m²
  L: 5.0,   // 121-200 m²
  XL: 6.0,  // 201-250 m²
  GT250: 0, // Custom - handled separately
};

// Constants
const HOURLY_RATE_EUR = 15.0;
const MATERIAL_FEE_EUR = 7.0;
const EXPRESS_MULTIPLIER = 1.20;
const MAX_TOTAL_HOURS = 8.0;

/**
 * Calculate total extra hours from extra service IDs
 */
export function extrasHoursFromIds(ids: ExtraId[]): number {
  return ids.reduce((sum, id) => sum + (EXTRA_HOURS[id] || 0), 0);
}

/**
 * Get base hours for a category
 */
export function getBaseHours(category: JobCategory): number {
  return BASE_HOURS[category] || 0;
}

/**
 * Calculate recurring discount percentage based on occurrence index
 */
export function discountPercent(occurrenceIndex: number): number {
  if (occurrenceIndex >= 5) return 15;
  if (occurrenceIndex >= 2) return 10;
  return 0;
}

/**
 * Determine cancellation tier based on hours until scheduled time
 */
export function getCancellationTier(hoursUntilJob: number): CancellationTier {
  if (hoursUntilJob >= 48) return "FREE";
  if (hoursUntilJob >= 24) return "P25";
  return "P50";
}

/**
 * Main pricing calculation function
 */
export function computeAmounts({
  baseHours,
  extras,
  materialProvidedByPro,
  isExpress,
  occurrenceIndex,
}: {
  baseHours: number;
  extras: ExtraId[];
  materialProvidedByPro: boolean;
  isExpress: boolean;
  occurrenceIndex: number;
}) {
  const extrasHours = extrasHoursFromIds(extras);
  
  // Cap total hours at 8
  const totalHours = Math.min(baseHours + extrasHours, MAX_TOTAL_HOURS);
  const actualBaseHours = totalHours - extrasHours >= 0 ? baseHours : totalHours - extrasHours;
  const actualExtrasHours = totalHours - actualBaseHours;

  // Base amount calculation
  const baseAmount = totalHours * HOURLY_RATE_EUR;
  const materialAmount = materialProvidedByPro ? MATERIAL_FEE_EUR : 0;
  
  // Discount calculation (only on base + extras, not material)
  const discount = discountPercent(occurrenceIndex);
  const amountBeforeDiscount = baseAmount + materialAmount;
  const discountedBaseAmount = baseAmount * (1 - discount / 100);
  const amountAfterDiscount = discountedBaseAmount + materialAmount;
  
  // Express calculation (20% on total after discount)
  const amountTotal = amountAfterDiscount * (isExpress ? EXPRESS_MULTIPLIER : 1.0);
  
  // Platform/Pro split calculation
  // Platform: 15% of discounted base + 5% express bonus on original base
  // Pro: 85% of discounted base + 15% express bonus on original base + 100% material
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
    // Additional breakdown for UI
    baseAmount,
    discountedBaseAmount,
    platformBaseShare,
    platformExpressBonus,
    proBaseShare,
    proExpressBonus,
  };
}

/**
 * Calculate cancellation split based on tier and amounts
 */
export function cancellationSplit({
  baseHours,
  extrasHours,
  materialAmount,
  isExpress,
  occurrenceIndex,
  tier,
}: {
  baseHours: number;
  extrasHours: number;
  materialAmount: number;
  isExpress: boolean;
  occurrenceIndex: number;
  tier: CancellationTier;
}) {
  const totalHours = Math.min(baseHours + extrasHours, MAX_TOTAL_HOURS);
  const baseAmount = totalHours * HOURLY_RATE_EUR;
  const discount = discountPercent(occurrenceIndex);
  const discountedBaseAmount = baseAmount * (1 - discount / 100);
  const amountAfterDiscount = discountedBaseAmount + materialAmount;
  const amountTotal = amountAfterDiscount * (isExpress ? EXPRESS_MULTIPLIER : 1.0);

  let proPercentage: number;
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
  
  // Platform keeps its normal share only on non-refunded portion
  const platformNormalShare = (amountTotal - refundToCustomerEur) * 0.15;
  const platformShareEur = Math.max(0, platformNormalShare);

  return {
    payoutToProEur,
    refundToCustomerEur,
    platformShareEur,
    originalTotal: amountTotal,
  };
}

/**
 * Generate recurring job dates based on type and start date
 */
export function generateRecurringDates(
  startDate: Date,
  recurrenceType: RecurrenceType,
  maxMonthsAhead: number = 3
): Date[] {
  if (recurrenceType === "none") return [];

  const dates: Date[] = [];
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
      intervalDays = 30; // Approximate
      break;
  }

  while (currentDate <= endDate && dates.length < 12) { // Max 12 occurrences
    currentDate = new Date(currentDate);
    currentDate.setDate(currentDate.getDate() + intervalDays);
    
    if (currentDate <= endDate) {
      dates.push(new Date(currentDate));
    }
  }

  return dates;
}

/**
 * Validate pricing inputs
 */
export function validatePricingInputs({
  category,
  extras,
  occurrenceIndex,
}: {
  category: JobCategory;
  extras: ExtraId[];
  occurrenceIndex: number;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

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