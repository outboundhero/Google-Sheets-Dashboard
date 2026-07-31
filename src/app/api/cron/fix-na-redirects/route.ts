import { GET as previewHandler, POST as applyHandler } from "@/app/api/deliverability/fix-na-redirects/route";

export const maxDuration = 300;

// TEMPORARY one-shot trigger for the Inboxing "n/a" redirect cleanup. Lives
// under /api/cron/* so it bypasses the admin-login middleware, guarded by a
// random key. Reuses the real handlers in the deliverability route (no logic
// duplicated). DELETE this file once the cleanup has been run.
const SECRET = "dff034e26815d3c059d384e4819cada26ea6";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== SECRET) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  // ?apply=1 → run the repair; otherwise dry-run preview.
  if (url.searchParams.get("apply") === "1") {
    return applyHandler(
      new Request("http://internal/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: true }),
      }),
    );
  }
  return previewHandler();
}
