import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { getMarket, clearMarketCache } from "./market.mjs";
import { answerResearch, planResearch } from "./ai.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const localEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function loadLocalEnv() {
  let source;
  try {
    source = await readFile(localEnvPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

await loadLocalEnv();

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request, limit = 12_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求内容过长。"), { statusCode: 413 });
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("请求 JSON 格式无效。"), { statusCode: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("请求内容必须是 JSON 对象。"), { statusCode: 400 });
  }
  return body;
}

async function serveStatic(urlPath, response) {
  const pathname = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
    response.writeHead(403); response.end("Forbidden"); return;
  }
  try {
    const content = await readFile(target);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(target)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true, mode: process.env.MARKET_DATA_MODE || "fuyao" });
    }
    if (request.method === "GET" && url.pathname === "/api/market") {
      if (url.searchParams.has("refresh")) clearMarketCache();
      return sendJson(response, 200, await getMarket(process.env));
    }
    if (request.method === "POST" && url.pathname === "/api/research") {
      const body = await readBody(request);
      if (typeof body.question !== "string") {
        throw Object.assign(new Error("question 必须是字符串。"), { statusCode: 400 });
      }
      const history = Array.isArray(body.history) ? body.history : [];
      const plan = await planResearch(body.question, process.env, history);
      if (plan.prohibited || plan.unavailable || plan.modelUnavailable) {
        return sendJson(response, 200, await answerResearch(body.question, null, plan, process.env, history));
      }
      const market = await getMarket(process.env);
      const result = await answerResearch(body.question, market, plan, process.env, history);
      return sendJson(response, 200, result);
    }
    if (request.method === "GET") return await serveStatic(url.pathname, response);
    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : error.message === "请输入研究问题。" ? 400 : 503;
    sendJson(response, status, { error: error.message || "请求失败" });
  }
});

const port = Number(process.env.PORT || 4173);
server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`Market Lens listening on http://localhost:${listeningPort} (mode=${process.env.MARKET_DATA_MODE || "fuyao"})`);
});
