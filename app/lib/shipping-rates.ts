import {
  type AdminGraphql,
  graphqlJson,
} from "./cycle-shared.server";

export type ShippingProfileRate = {
  amount: string;
  currencyCode: string;
  methodName: string;
  profileName: string;
};

type DeliveryRateCandidate = ShippingProfileRate & {
  amountNumber: number;
  conditions: DeliveryRateCondition[];
};

const DELIVERY_PROFILE_FIRST = 10;
const LOCATION_ZONE_FIRST = 20;
const METHOD_DEFINITION_FIRST = 25;

export async function resolveShippingRateFromProfiles(
  admin: AdminGraphql,
  destination: {
    countryCode: string | null;
    provinceCode?: string | null;
    itemCount: number;
  },
): Promise<ShippingProfileRate> {
  const countryCode = (destination.countryCode || "").toUpperCase();
  const provinceCode = (destination.provinceCode || "").toUpperCase();
  if (!countryCode) {
    throw new Error("Cannot resolve Shopify shipping rate without shipping country");
  }
  let json;
  try {
    json = await graphqlJson(
      admin,
      `#graphql
        query ThursdayShippingRatesFromProfiles(
          $profileFirst: Int!
          $zoneFirst: Int!
          $methodFirst: Int!
        ) {
          deliveryProfiles(first: $profileFirst, merchantOwnedOnly: true) {
            edges {
              node {
                name
                profileLocationGroups {
                  locationGroupZones(first: $zoneFirst) {
                    edges {
                      node {
                        zone {
                          countries {
                            code {
                              countryCode
                              restOfWorld
                            }
                            provinces {
                              code
                            }
                          }
                        }
                        methodDefinitions(first: $methodFirst) {
                          edges {
                            node {
                              active
                              name
                              methodConditions {
                                field
                                operator
                                conditionCriteria {
                                  __typename
                                  ... on MoneyV2 {
                                    amount
                                    currencyCode
                                  }
                                  ... on Weight {
                                    value
                                    unit
                                  }
                                }
                              }
                              rateProvider {
                                __typename
                                ... on DeliveryRateDefinition {
                                  price {
                                    amount
                                    currencyCode
                                  }
                                }
                                ... on DeliveryParticipant {
                                  fixedFee {
                                    amount
                                    currencyCode
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
      {
        profileFirst: DELIVERY_PROFILE_FIRST,
        zoneFirst: LOCATION_ZONE_FIRST,
        methodFirst: METHOD_DEFINITION_FIRST,
      },
    );
  } catch (error) {
    if (!isDeliveryProfilesAccessDenied(error)) {
      throw error;
    }

    throw new Error(
      "Shopify denied access to deliveryProfiles. Approve the app's read_shipping permission, then rerun the Thursday invoice cycle. No fallback rate was used.",
    );
  }

  const candidates = collectDeliveryRateCandidates(
    json.data?.deliveryProfiles?.edges ?? [],
    { countryCode, provinceCode, itemCount: destination.itemCount },
  );

  if (candidates.length === 0) {
    throw new Error(
      `No active Shopify shipping profile rate found for ${countryCode}`,
    );
  }

  const profileName = process.env.THURSDAY_SHIPPING_PROFILE_NAME?.trim();
  const matchingProfile = profileName
    ? candidates.filter(
        (candidate) =>
          candidate.profileName.toLowerCase() === profileName.toLowerCase(),
      )
    : candidates;

  if (matchingProfile.length === 0) {
    throw new Error(
      `No active Shopify shipping profile named "${profileName}" found for ${countryCode}`,
    );
  }

  const methodName = process.env.THURSDAY_SHIPPING_METHOD_NAME?.trim();
  const matchingMethod = methodName
    ? matchingProfile.filter(
        (candidate) =>
          candidate.methodName.toLowerCase() === methodName.toLowerCase(),
      )
    : matchingProfile;

  if (matchingMethod.length === 0) {
    const profileHint = profileName ? ` in profile "${profileName}"` : "";
    throw new Error(
      `No active Shopify shipping profile rate named "${methodName}"${profileHint} found for ${countryCode}`,
    );
  }

  const conditionMatched = matchingMethod.filter((candidate) =>
    conditionsMatchItemCount(candidate.conditions, destination.itemCount),
  );
  const conditionless = matchingMethod.filter(
    (candidate) => candidate.conditions.length === 0,
  );
  const matchedRates =
    conditionMatched.length > 0 ? conditionMatched : conditionless;

  if (matchedRates.length === 0) {
    const positiveFallbackRates = matchingMethod.filter(
      (candidate) => candidate.amountNumber > 0,
    );
    if (positiveFallbackRates.length === 0) {
      throw new Error(
        `No Shopify shipping profile rate matched ${destination.itemCount} physical item(s) for ${countryCode}`,
      );
    }
    const selectedFallback = selectLowestRate(positiveFallbackRates);
    return {
      amount: selectedFallback.amount,
      currencyCode: selectedFallback.currencyCode,
      methodName: selectedFallback.methodName,
      profileName: selectedFallback.profileName,
    };
  }

  const exactPaidRates = conditionMatched.filter(
    (candidate) => candidate.amountNumber > 0,
  );
  const defaultPaidRates = conditionless.filter(
    (candidate) => candidate.amountNumber > 0,
  );
  const anyPaidRates = matchingMethod.filter(
    (candidate) => candidate.amountNumber > 0,
  );
  const selectableRates =
    exactPaidRates.length > 0
      ? exactPaidRates
      : defaultPaidRates.length > 0
        ? defaultPaidRates
        : anyPaidRates;

  if (selectableRates.length === 0) {
    throw new Error(
      `Shopify shipping profile returned only zero-dollar rates for ${destination.itemCount} physical item(s) to ${countryCode}`,
    );
  }

  const selected = selectLowestRate(selectableRates);

  return {
    amount: selected.amount,
    currencyCode: selected.currencyCode,
    methodName: selected.methodName,
    profileName: selected.profileName,
  };
}

function selectLowestRate(candidates: DeliveryRateCandidate[]): DeliveryRateCandidate {
  return [...candidates].sort((a, b) => a.amountNumber - b.amountNumber)[0]!;
}

function isDeliveryProfilesAccessDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /access denied/i.test(message) && /deliveryProfiles/i.test(message);
}

function collectDeliveryRateCandidates(
  profileEdges: Array<{ node?: Record<string, unknown> }>,
  destination: { countryCode: string; provinceCode: string; itemCount: number },
): DeliveryRateCandidate[] {
  const candidates: DeliveryRateCandidate[] = [];

  for (const profileEdge of profileEdges) {
    const profile = profileEdge.node;
    if (!profile) continue;

    const profileName = String(profile.name || "Shipping profile");
    const locationGroups = Array.isArray(profile.profileLocationGroups)
      ? profile.profileLocationGroups
      : [];

    for (const locationGroup of locationGroups as Array<Record<string, unknown>>) {
      const zoneEdges =
        (
          locationGroup.locationGroupZones as {
            edges?: Array<{ node?: Record<string, unknown> }>;
          }
        )?.edges ?? [];

      for (const zoneEdge of zoneEdges) {
        const zoneNode = zoneEdge.node;
        if (!zoneNode || !zoneMatchesDestination(zoneNode, destination)) {
          continue;
        }

        const methodEdges =
          (
            zoneNode.methodDefinitions as {
              edges?: Array<{ node?: Record<string, unknown> }>;
            }
          )?.edges ?? [];

        for (const methodEdge of methodEdges) {
          const method = methodEdge.node;
          if (!method?.active) continue;

          const rate = extractRateProviderPrice(method.rateProvider);
          if (!rate) continue;

          const amountNumber = Number(rate.amount);
          if (!Number.isFinite(amountNumber)) continue;

          candidates.push({
            amount: amountNumber.toFixed(2),
            currencyCode: rate.currencyCode,
            methodName: String(method.name || "Shipping"),
            profileName,
            amountNumber,
            conditions: parseDeliveryConditions(method.methodConditions),
          });
        }
      }
    }
  }

  return candidates;
}

type DeliveryRateCondition = {
  field: string;
  operator: string;
  value: number | null;
};

function parseDeliveryConditions(value: unknown): DeliveryRateCondition[] {
  if (!Array.isArray(value)) return [];

  return value.map((condition) => {
    const node = condition as {
      field?: string;
      operator?: string;
      conditionCriteria?: {
        amount?: string;
        value?: number;
      };
    };
    const rawValue =
      node.conditionCriteria?.value ?? Number(node.conditionCriteria?.amount);
    return {
      field: String(node.field || ""),
      operator: String(node.operator || ""),
      value: Number.isFinite(rawValue) ? Number(rawValue) : null,
    };
  });
}

function conditionsMatchItemCount(
  conditions: DeliveryRateCondition[],
  itemCount: number,
): boolean {
  if (conditions.length === 0) return true;

  return conditions.every((condition) => {
    if (condition.value === null) return false;

    if (condition.field !== "TOTAL_WEIGHT") {
      return false;
    }

    switch (condition.operator) {
      case "GREATER_THAN_OR_EQUAL_TO":
        return itemCount >= condition.value;
      case "GREATER_THAN":
        return itemCount > condition.value;
      case "LESS_THAN_OR_EQUAL_TO":
        return itemCount <= condition.value;
      case "LESS_THAN":
        return itemCount < condition.value;
      case "EQUAL_TO":
        return itemCount === condition.value;
      default:
        return false;
    }
  });
}

function zoneMatchesDestination(
  zoneNode: Record<string, unknown>,
  destination: { countryCode: string; provinceCode: string },
): boolean {
  const zone = zoneNode.zone as { countries?: Array<Record<string, unknown>> };
  const countries = zone?.countries ?? [];

  return countries.some((country) => {
    const code = country.code as
      | { countryCode?: string | null; restOfWorld?: boolean | null }
      | undefined;

    if (code?.restOfWorld) return true;
    if ((code?.countryCode || "").toUpperCase() !== destination.countryCode) {
      return false;
    }

    const provinces = Array.isArray(country.provinces)
      ? (country.provinces as Array<{ code?: string | null }>)
      : [];

    if (provinces.length === 0 || !destination.provinceCode) return true;
    return provinces.some(
      (province) =>
        (province.code || "").toUpperCase() === destination.provinceCode,
    );
  });
}

function extractRateProviderPrice(
  rateProvider: unknown,
): { amount: string; currencyCode: string } | null {
  const provider = rateProvider as
    | {
        __typename?: string;
        price?: { amount?: string; currencyCode?: string };
        fixedFee?: { amount?: string; currencyCode?: string } | null;
      }
    | null
    | undefined;

  const price =
    provider?.__typename === "DeliveryRateDefinition"
      ? provider.price
      : provider?.fixedFee;

  if (!price?.amount || !price.currencyCode) return null;
  return {
    amount: price.amount,
    currencyCode: price.currencyCode,
  };
}
