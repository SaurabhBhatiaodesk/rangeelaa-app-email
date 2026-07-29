import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateCron } from "../lib/cron-auth.server";
import { runThursdayCycle } from "../lib/thursday-cycle.server";

async function handle(request: Request) {
  const auth = await authenticateCron(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const dryRun =
    url.searchParams.get("dryRun") === "1" ||
    url.searchParams.get("dry_run") === "1";

  const result = await runThursdayCycle(auth.admin, {
    dryRun,
    shop: auth.shop,
  });
  return Response.json(result, { status: result.ok ? 200 : 207 });
}

/** GET/POST /api/cron/thursday — Heroku Scheduler / external cron */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handle(request);

export const action = async ({ request }: ActionFunctionArgs) =>
  handle(request);
