import type { AdminGraphql } from "./cycle-shared.server";

export type ShippingProfileRate = {
  amount: string;
  currencyCode: string;
  methodName: string;
  profileName: string;
};

type RateTier = {
  min: number;
  max?: number;
  amount: string;
};

export type ShippingRateTable = Record<string, RateTier[]>;

export const DEFAULT_SHIPPING_RATE_TABLE: ShippingRateTable = {
  CA: [
    { min: 1, max: 1, amount: "17.39" },
    { min: 2, max: 2, amount: "19.52" },
    { min: 3, max: 3, amount: "19.75" },
    { min: 4, max: 4, amount: "19.99" },
    { min: 5, max: 9, amount: "23.26" },
    { min: 10, max: 14, amount: "27.26" },
    { min: 15, max: 19, amount: "29.26" },
    { min: 20, amount: "32.26" },
  ],
  US: [
    { min: 1, max: 1, amount: "18.99" },
    { min: 2, max: 2, amount: "21.99" },
    { min: 3, max: 3, amount: "23.99" },
    { min: 4, max: 4, amount: "25.99" },
    { min: 5, max: 9, amount: "31.79" },
    { min: 10, max: 14, amount: "44.93" },
    { min: 15, max: 19, amount: "47.93" },
    { min: 20, amount: "51.93" },
  ],
};

export const DEFAULT_SHIPPING_RATE_TABLE_TEXT = JSON.stringify(
  DEFAULT_SHIPPING_RATE_TABLE,
  null,
  2,
);

export async function resolveShippingRateFromProfiles(
  _admin: AdminGraphql,
  destination: {
    countryCode: string | null;
    provinceCode?: string | null;
    itemCount: number;
  },
  rateTableValue?: string | null,
): Promise<ShippingProfileRate> {
  const countryCode = (destination.countryCode || "").toUpperCase();
  if (!countryCode) {
    throw new Error("Cannot resolve shipping rate without shipping country");
  }

  const table = parseShippingRateTable(rateTableValue)[countryCode];
  if (!table) {
    throw new Error(`No tiered shipping rate configured for ${countryCode}`);
  }

  const itemCount = Math.max(0, Math.floor(destination.itemCount));
  if (itemCount < 1) {
    throw new Error(
      `Cannot resolve shipping rate for ${destination.itemCount} item(s)`,
    );
  }

  const tier = table.find(
    (rate) => itemCount >= rate.min && (!rate.max || itemCount <= rate.max),
  );
  if (!tier) {
    throw new Error(
      `No tiered shipping rate matched ${itemCount} item(s) for ${countryCode}`,
    );
  }

  return {
    amount: tier.amount,
    currencyCode: "CAD",
    methodName: `${countryCode} tiered shipping`,
    profileName: "Thursday shipping rate table",
  };
}

export function parseShippingRateTable(value?: string | null): ShippingRateTable {
  const trimmed = (value || "").trim();
  if (!trimmed) return DEFAULT_SHIPPING_RATE_TABLE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Shipping rate table must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Shipping rate table must be a JSON object");
  }

  const table: ShippingRateTable = {};
  for (const [rawCountryCode, rawTiers] of Object.entries(parsed)) {
    const countryCode = rawCountryCode.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw new Error(`Invalid shipping country code: ${rawCountryCode}`);
    }
    if (!Array.isArray(rawTiers) || rawTiers.length === 0) {
      throw new Error(`Shipping rates for ${countryCode} must be a non-empty array`);
    }

    table[countryCode] = rawTiers.map((rawTier, index) => {
      if (!rawTier || typeof rawTier !== "object" || Array.isArray(rawTier)) {
        throw new Error(`Shipping tier ${index + 1} for ${countryCode} must be an object`);
      }

      const tier = rawTier as { min?: unknown; max?: unknown; amount?: unknown };
      const min = Number(tier.min);
      const max =
        tier.max === undefined || tier.max === null || tier.max === ""
          ? undefined
          : Number(tier.max);
      const amountNumber = Number(tier.amount);

      if (!Number.isInteger(min) || min < 1) {
        throw new Error(`Shipping tier ${index + 1} for ${countryCode} has an invalid min`);
      }
      if (max !== undefined && (!Number.isInteger(max) || max < min)) {
        throw new Error(`Shipping tier ${index + 1} for ${countryCode} has an invalid max`);
      }
      if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
        throw new Error(`Shipping tier ${index + 1} for ${countryCode} has an invalid amount`);
      }

      return {
        min,
        ...(max ? { max } : {}),
        amount: amountNumber.toFixed(2),
      };
    });
  }

  return table;
}
