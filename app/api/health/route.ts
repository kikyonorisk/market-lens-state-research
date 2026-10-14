import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { ok: true, mode: env.MARKET_DATA_MODE || "fuyao" },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }
  );
}
