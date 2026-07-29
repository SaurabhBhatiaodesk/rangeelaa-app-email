import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateCron } from "../lib/cron-auth.server";
import { runFridayReset } from "../lib/friday-reset.server";

async function handle(request: Request) {
  const auth = await authenticateCron(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const dryRun =
    url.searchParams.get("dryRun") === "1" ||
    url.searchParams.get("dry_run") === "1";

  const result = await runFridayReset(auth.admin, { dryRun, shop: auth.shop });
  return Response.json(result, { status: result.ok ? 200 : 207 });
}

/** GET/POST /api/cron/friday — Friday midnight CST via scheduler */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handle(request);

export const action = async ({ request }: ActionFunctionArgs) =>
  handle(request);
