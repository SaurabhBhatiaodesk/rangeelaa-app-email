/** Order tags used by Rangeela Shipping Manager */

export const TAGS = {
  PIECE_MADE: "piece-made-notified",
  LEAVING_FOR_CANADA: "leaving-for-canada-notified",
  ARRIVED_IN_CANADA: "arrived-in-canada-notified",
  READY_TO_SHIP: "ready-to-ship",

  PIECE_MADE_EMAIL_SENT: "piece-made-email-sent",
  LEAVING_EMAIL_SENT: "leaving-email-sent",
  ARRIVED_EMAIL_SENT: "arrived-email-sent",

  GROUP: "group",
  PARTIAL: "partial",
  DEPOSIT_FULFILLED: "deposit-fulfilled",

  THURSDAY_EMAIL_SENT: "thursday-email-sent",
  SHIPPING_PAID: "shipping-paid",
  HOLD_FOR_NEXT_CYCLE: "hold-for-next-cycle",
  PUSHED_TO_NEXT_WEEKEND: "pushed-to-next-weekend",
  INDIA_DIRECT: "india-direct",
} as const;

export type StatusAction =
  | "piece_made"
  | "leaving_for_canada"
  | "arrived_in_canada"
  | "deposit_fulfilled"
  | "hold_for_next_cycle";

/**
 * Klaviyo no longer supports POST /api/messages/send/ (returns 404).
 * App creates a metric event; a Klaviyo Flow (triggered by that metric)
 * sends the email that uses the template ID below.
 */
/** Metric names and subjects; keyed by status action (not tag string). */
export const KLAVIYO_STATUS_EMAIL_META = {
  piece_made: {
    metricName: "Rangeela Piece Made",
    subject: "The saree you chose is now your dress!",
  },
  leaving_for_canada: {
    metricName: "Rangeela Leaving for Canada",
    subject: "Guess who's flying to Canada? Your Rangeelaa piece!",
  },
  arrived_in_canada: {
    metricName: "Rangeela Arrived in Canada",
    subject: "Guess what just landed in Canada?",
  },
} as const;

export type StatusEmailAction = keyof typeof KLAVIYO_STATUS_EMAIL_META;

/** Metric that triggers the Thursday combined shipping invoice flow */
export const KLAVIYO_THURSDAY_METRIC =
  "Rangeela Thursday Shipping Invoice";

export function hasTag(tags: string[], tag: string): boolean {
  return tags.some((t) => t.toLowerCase() === tag.toLowerCase());
}

export function isSkirtDeposit(
  tags: string[],
  groupTag: string = TAGS.GROUP,
  partialTag: string = TAGS.PARTIAL,
): boolean {
  return hasTag(tags, groupTag) && hasTag(tags, partialTag);
}

export function normalizeTags(tags: string[] | string | null | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}
