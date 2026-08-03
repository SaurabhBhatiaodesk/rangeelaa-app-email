import { PrismaClient } from "@prisma/client";

import { ensurePrismaSslMode } from "./lib/database-url.server";

process.env.DATABASE_URL = ensurePrismaSslMode(process.env.DATABASE_URL);

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
