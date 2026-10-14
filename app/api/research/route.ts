import { env } from "cloudflare:workers";
import { answerResearch, planResearch } from "../../../server/ai.mjs";
import { getMarket } from "../../../server/market.mjs";

const BODY_LIMIT = 12_000;

function failure(message: string, status: number) {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

async function readJson(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT;

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) tooLarge = true;
      if (!tooLarge) chunks.push(value);
    }
  }
  if (tooLarge) throw Object.assign(new Error("请求内容过长。"), { statusCode: 413 });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }

  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes) || "{}"); }
  catch { throw Object.assign(new Error("请求 JSON 格式无效。"), { statusCode: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("请求内容必须是 JSON 对象。"), { statusCode: 400 });
  }
  return body as { question?: unknown; history?: unknown };
}

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    if (typeof body.question !== "string") {
      return failure("question 必须是字符串。", 400);
    }

    const history = Array.isArray(body.history) ? body.history : [];
    const plan = await planResearch(body.question, env, history);
    if (plan.prohibited || plan.unavailable) {
      const result = await answerResearch(body.question, null, plan, env, history);
      return Response.json(result, {
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
      });
    }

    const market = await getMarket(env);
    const result = await answerResearch(body.question, market, plan, env, history);
    return Response.json(result, {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  } catch (error) {
    const status = Number.isInteger((error as { statusCode?: number }).statusCode)
      ? (error as { statusCode: number }).statusCode
      : (error as Error).message === "请输入研究问题。" ? 400 : 503;
    return failure((error as Error).message || "请求失败", status);
  }
}
