import { spawnSync } from "node:child_process";
import { join } from "node:path";

const databaseUrl = ensurePrismaSslMode(process.env.DATABASE_URL);
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
}

const runner = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);

const result = spawnSync(runner, process.argv.slice(2), {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);

function ensurePrismaSslMode(databaseUrl) {
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
