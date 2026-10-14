import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let serverProcess;
let baseUrl;
let startupOutput = "";

before(async () => {
  serverProcess = spawn(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: "0",
      MARKET_DATA_MODE: "demo",
      FUYAO_API_KEY: "",
      FUYAO_BASE_URL: "",
      IFIND_MARKET_AUTHORIZATION: "",
      IFIND_NEWS_AUTHORIZATION: "",
      AI_API_BASE_URL: "",
      AI_API_KEY: "integration-test-sentinel",
      AI_MODEL: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      serverProcess.stdout.off("data", onData);
      if (error) reject(error);
      else {
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      }
    };
    const onData = chunk => {
      startupOutput += chunk.toString();
      const match = startupOutput.match(/listening on http:\/\/localhost:(\d+)/);
      if (match) finish(null, Number(match[1]));
    };
    const timer = setTimeout(() => finish(new Error(`服务启动超时：${startupOutput}`)), 5000);
    serverProcess.stdout.on("data", onData);
    serverProcess.stderr.on("data", chunk => { startupOutput += chunk.toString(); });
    serverProcess.once("error", error => finish(error));
    serverProcess.once("exit", code => finish(new Error(`服务提前退出（${code}）：${startupOutput}`)));
  });
});

after(async () => {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const exited = once(serverProcess, "exit");
  serverProcess.kill("SIGTERM");
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
  if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
});

test("HTTP：首页返回应用、安全响应头和静态资源", async () => {
  const response = await fetch(baseUrl + "/");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(html, /Market Lens/);

  const script = await fetch(baseUrl + "/app.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
});

test("Research 前端防重复提交，网络中断只做一次独立重试且不共享 AbortController", async () => {
  const source = await readFile(path.join(projectRoot, "public/app.js"), "utf8");
  assert.match(source, /let researchInFlight = false/);
  assert.match(source, /if \(researchInFlight\) return/);
  assert.match(source, /attempt < 2/);
  assert.match(source, /error\?\.name === "AbortError"/);
  assert.doesNotMatch(source, /new AbortController/);
});

test("HTTP：健康与市场 API 报告演示模式，不回显配置秘密", async () => {
  const health = await fetch(baseUrl + "/api/health");
  const healthBody = await health.json();
  assert.deepEqual(healthBody, { ok: true, mode: "demo" });
  assert.doesNotMatch(JSON.stringify(healthBody), /integration-test-sentinel/);

  const marketResponse = await fetch(baseUrl + "/api/market");
  const market = await marketResponse.json();
  assert.equal(marketResponse.status, 200);
  assert.equal(market.demo, true);
  assert.equal(market.assessment.state, "震荡分化");
  assert.deepEqual(Object.keys(market.dimensions).sort(), [
    "breadth", "events", "liquidity", "sentiment", "structure", "style", "valuation"
  ]);
  assert.ok(market.toolCalls.some(call => call.status === "demo"));
  assert.doesNotMatch(JSON.stringify(market), /integration-test-sentinel/);
});

test("HTTP：AI 未配置时清楚提示不可用，不伪装生成计划或模板回答", async () => {
  const response = await fetch(baseUrl + "/api/research", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "为什么小盘风格偏弱？" })
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.aiMode, "未配置");
  assert.deepEqual(result.plannedDimensions, []);
  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.citations, []);
  assert.match(result.answer, /未生成规则模板回答/);
  assert.match(result.disclaimer, /不构成投资建议/);
  assert.doesNotMatch(JSON.stringify(result), /integration-test-sentinel/);
});

test("HTTP：禁答问题在数据刷新前拦截且不触发工具调用", async () => {
  const response = await fetch(baseUrl + "/api/research", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "明天一定涨吗？" })
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.aiMode, "程序级合规拦截");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.citations, []);
  assert.match(result.answer, /不能提供.*确定性涨跌/);
});

test("HTTP：仓位与个股推荐意图均在调用数据源之前拦截", async () => {
  const response = await fetch(baseUrl + "/api/research", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "推荐一只股票，并告诉我应该几成仓？" })
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.aiMode, "程序级合规拦截");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.citations, []);
});

test("HTTP：研究请求校验区分坏 JSON、错误类型、空问题与超限", async () => {
  const send = body => fetch(baseUrl + "/api/research", {
    method: "POST", headers: { "Content-Type": "application/json" }, body
  });
  assert.equal((await send("{")).status, 400);
  assert.equal((await send("[]")).status, 400);
  assert.equal((await send('{"question":9}')).status, 400);
  assert.equal((await send('{"question":"  "}')).status, 400);
  assert.equal((await send("x".repeat(12_001))).status, 413);
});

test("HTTP：未知路径与不支持的方法不会伪装成功", async () => {
  assert.equal((await fetch(baseUrl + "/missing-page")).status, 404);
  const method = await fetch(baseUrl + "/api/health", { method: "DELETE" });
  assert.equal(method.status, 405);
  assert.deepEqual(await method.json(), { error: "Method not allowed" });
});
