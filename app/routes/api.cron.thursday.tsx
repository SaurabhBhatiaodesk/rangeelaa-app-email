import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateCron } from "../lib/cron-auth.server";
import { getCronTimeZone } from "../lib/cron-schedule.server";
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

  const timeZone = getCronTimeZone();

  // The client requires that a Thursday invoice is only ever sent by someone
  // explicitly clicking "Run Thursday Cycle" in the app. This endpoint is
  // reachable by any cron/scheduler configured against it, so it must never
  // be able to send live emails on its own, regardless of env vars or query
  // params — there is intentionally no live-mode escape hatch here anymore.
  if (!dryRun) {
    return Response.json({
      ok: true,
      dryRun,
      skipped: true,
      timeZone,
      message:
        "Thursday live cron is permanently disabled: the Thursday cycle can only be run manually from the app.",
    });
  }

  const result = await runThursdayCycle(auth.admin, {
    dryRun: true,
    shop: auth.shop,
  });
  return Response.json(result, { status: result.ok ? 200 : 207 });
}

/** GET/POST /api/cron/thursday — Heroku Scheduler / external cron */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handle(request);

export const action = async ({ request }: ActionFunctionArgs) =>
  handle(request);
