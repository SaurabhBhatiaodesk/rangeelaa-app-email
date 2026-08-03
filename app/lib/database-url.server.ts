export function ensurePrismaSslMode(databaseUrl: string | undefined) {
  if (!databaseUrl) return databaseUrl;

  try {
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      return databaseUrl;
    }

    const hostname = url.hostname.toLowerCase();
    const isLocal =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1";

    if (isLocal || url.searchParams.has("sslmode")) {
      return databaseUrl;
    }

    url.searchParams.set("sslmode", "require");
    return url.toString();
  } catch {
    return databaseUrl;
  }
}
