// Server-side stand-in for the browser fetch the execution runner uses: maps
// the runner's API paths straight onto the imported route handlers, so the
// auto-runner cron executes the EXACT same code path as the UI — no session,
// no logic fork (precedent: attach-queue cron invoking the attach route).
// Paths outside the mapped set 404 loudly instead of escaping to the network.
import type { FetchLike } from "./execute-runner";

type RouteModule = Record<string, (req: Request) => Promise<Response>>;

const ROUTES: Record<string, () => Promise<unknown>> = {
  "/api/replacement/churn-guard": () => import("@/app/api/replacement/churn-guard/route"),
  "/api/replacement/record": () => import("@/app/api/replacement/record/route"),
  "/api/replacement/attach-queue": () => import("@/app/api/replacement/attach-queue/route"),
  "/api/replacement/notify-failure": () => import("@/app/api/replacement/notify-failure/route"),
  "/api/deliverability/move-domains": () => import("@/app/api/deliverability/move-domains/route"),
  "/api/deliverability/move-finalize": () => import("@/app/api/deliverability/move-finalize/route"),
  "/api/deliverability/bulk-tags": () => import("@/app/api/deliverability/bulk-tags/route"),
  "/api/deliverability/change-redirect": () => import("@/app/api/deliverability/change-redirect/route"),
  "/api/deliverability/attach-domains-to-campaign": () => import("@/app/api/deliverability/attach-domains-to-campaign/route"),
  "/api/deliverability/send-to-sheet": () => import("@/app/api/deliverability/send-to-sheet/route"),
  "/api/deliverability/whitelist/queue": () => import("@/app/api/deliverability/whitelist/queue/route"),
  "/api/deliverability/remove-from-campaigns": () => import("@/app/api/deliverability/remove-from-campaigns/route"),
};

const jsonError = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

export const internalFetch: FetchLike = async (input, init) => {
  const abs = input.startsWith("http") ? input : `http://internal${input}`;
  const path = new URL(abs).pathname;
  const load = ROUTES[path];
  if (!load) return jsonError(404, `no internal route for ${path}`);
  const mod = (await load()) as RouteModule;
  const method = (init?.method || "GET").toUpperCase();
  const handler = mod[method];
  if (typeof handler !== "function") return jsonError(405, `${method} not supported for ${path}`);
  return handler(new Request(abs, init));
};
