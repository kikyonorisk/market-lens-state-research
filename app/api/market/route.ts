import { env } from "cloudflare:workers";
import { clearMarketCache, getMarket } from "../../../server/market.mjs";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.has("refresh")) clearMarketCache();
  const market = await getMarket(env);
  return Response.json(market, {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}
