import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { answerResearch, isProhibitedQuery, planResearch, violatesOutputBoundary } from "../server/ai.mjs";
import { assessMarket, clearMarketCache, getMarket, makeDemoMarket, mergeIfindEvidence, MIN_CORE_DIMENSIONS } from "../server/market.mjs";
import { clearFuyaoDataCache, getFuyaoMarket } from "../server/providers/fuyao.mjs";
import { clearIfindCache, getIfindEvidence } from "../server/providers/ifind.mjs";

const environmentKeys = [
  "MARKET_DATA_MODE", "FUYAO_API_KEY", "FUYAO_BASE_URL",
  "IFIND_ENABLED", "IFIND_MARKET_AUTHORIZATION", "IFIND_NEWS_AUTHORIZATION", "IFIND_MARKET_MCP_URL", "IFIND_NEWS_MCP_URL",
  "AI_API_BASE_URL", "AI_API_KEY", "AI_MODEL"
];
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;

after(() => {
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  clearMarketCache();
  clearFuyaoDataCache();
  clearIfindCache();
});

beforeEach(() => {
  console.log = () => {};
  clearMarketCache();
  clearFuyaoDataCache();
  clearIfindCache();
});

function setEnvironment(values) {
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, values);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function recentMarketDates(endDate, count) {
  const dates = [];
  const date = new Date(`${endDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  while (dates.length < count) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return dates.reverse();
}

function turnoverRows(endDate, currentAmount = "15000亿元") {
  return [
    ...recentMarketDates(endDate, 21).map(date => ({ date, amount: "10000亿元" })),
    { date: endDate, amount: currentAmount }
  ];
}

function ifindPayloads({ rows = [], news = [] } = {}) {
  return {
    market: { code: 1, msg: "success", data: { answer: [
      "|证券代码|证券简称|日期|成交金额（单位：元）|", "|---|---|---|---|",
      ...rows.map(row => `|700008.TI|同花顺沪深全A|${row.date}|${row.amount}|`)
    ].join("\n") } },
    news: { code: 1, msg: "success", data: { data: JSON.stringify(news) } }
  };
}

function mockIfindFetch(payloads, observe = () => {}) {
  return async (input, options = {}) => {
    const url = String(input);
    const request = JSON.parse(options.body || "{}");
    observe({ method: request.method, authorization: options.headers?.Authorization });
    if (request.method === "initialize") return new Response(JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }
    }), { headers: { "Content-Type": "application/json", "Mcp-Session-Id": "fixture-session" } });
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "tools/list") return jsonResponse({
      jsonrpc: "2.0", id: request.id, result: { tools: [] }
    });
    if (request.method === "tools/call") {
      const payload = url.endsWith("/market") ? payloads.market : payloads.news;
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
    }
    throw new Error("Unexpected iFinD MCP request");
  };
}

function ifindTestEnvironment(extra = {}) {
  return {
    IFIND_ENABLED: "true",
    IFIND_MARKET_AUTHORIZATION: "test-market-auth",
    IFIND_NEWS_AUTHORIZATION: "test-news-auth",
    IFIND_MARKET_MCP_URL: "https://ifind.test/market",
    IFIND_NEWS_MCP_URL: "https://ifind.test/news",
    ...extra
  };
}

function modelResponse(value, status = 200) {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return jsonResponse({ choices: [{ message: { content } }] }, status);
}

function fuyaoFixtureFetch(now, observe = () => {}) {
  const stockRows = Array.from({ length: 100 }, (_, index) => ({
    thscode: `T${String(index).padStart(6, "0")}.SH`,
    price_change_ratio_pct: index < 60 ? 1 : index < 95 ? -1 : 0,
    turnover: 50_000_000
  }));
  return async input => {
    const url = new URL(String(input));
    observe(url);
    if (url.pathname === "/api/a-share-index/prices/snapshot") return jsonResponse({ code: 0, data: {
      timestamp: now, item: [
        { thscode: "000300.SH", last_price: 3900, price_change_ratio_pct: 0.4 },
        { thscode: "000852.SH", last_price: 6200, price_change_ratio_pct: -0.8 },
        { thscode: "399006.SZ", last_price: 2400, price_change_ratio_pct: 0.2 }
      ]
    } });
    if (url.pathname === "/api/a-share/prices/snapshot") {
      const offset = Number(url.searchParams.get("offset"));
      return jsonResponse({ code: 0, data: {
        timestamp: now, total: stockRows.length,
        item: stockRows.slice(offset, offset + Number(url.searchParams.get("limit")))
      } });
    }
    if (url.pathname === "/api/a-share-index/prices/historical") {
      const item = [100, 101, 102, 103, 104, 105].map((close_price, index) => ({
        date_ms: now - (5 - index) * 24 * 60 * 60 * 1000,
        close_price
      }));
      return jsonResponse({ code: 0, data: { item } });
    }
    if (url.pathname.includes("limit-up-pool") || url.pathname.includes("limit-down-pool")) {
      const total = url.pathname.includes("limit-up-pool") ? 8 : 3;
      return jsonResponse({ code: 0, data: {
        timestamp: now, pagination: { total, pages: 1 },
        item: Array.from({ length: total }, (_, index) => ({ thscode: `POOL${index}` }))
      } });
    }
    throw new Error(`Unexpected Fuyao endpoint: ${url.pathname}`);
  };
}

function configuredModel() {
  return { AI_API_BASE_URL: "https://model.test/v1", AI_API_KEY: "test-only", AI_MODEL: "test-model" };
}

function stylePlan() {
  return { topic: "风格轮动", scope: "dimension", steps: ["读取指数近 5 日收益", "核对同一时点"], dimensions: ["structure", "style"] };
}

function safeExplanation() {
  return {
    interpretations: [{
      text: "近期指数与风格信号并不完全一致，指数截面不能代表全市场内部表现。",
      evidenceIds: ["E01", "E04"]
    }],
    uncertainties: ["这只是对当前证据的归纳，不说明因果关系。"]
  };
}

test("状态规则：演示样本可计算，缺失市场宽度时拒绝生成整体状态", () => {
  const market = makeDemoMarket();
  const result = assessMarket(market);
  assert.equal(result.state, "震荡分化");
  assert.equal(result.availableCore, 5);

  market.dimensions.breadth.score = null;
  market.dimensions.breadth.facts = [];
  const insufficient = assessMarket(market);
  assert.equal(insufficient.state, "证据不足");
  assert.equal(insufficient.confidence, null);
  assert.equal(insufficient.majorTension, "证据不足，暂不形成市场状态判断");
  assert.deepEqual(insufficient.switchConditions, []);
  assert.equal(insufficient.requiredCore, MIN_CORE_DIMENSIONS);
});

test("状态硬门槛：少于 3 个有效维度，哪怕残留旧分数也不形成方向判断", () => {
  const market = makeDemoMarket();
  market.dimensions.style.status = "stale";
  market.dimensions.liquidity.status = "invalid_time";
  market.dimensions.sentiment.status = "conflict";
  const result = assessMarket(market);
  assert.equal(result.availableCore, 2);
  assert.equal(result.state, "证据不足");
  assert.equal(result.majorTension, "证据不足，暂不形成市场状态判断");
  assert.deepEqual(result.switchConditions, []);
});

test("状态规则：偏强/偏弱证据组合会生成对应状态和重新评估条件", () => {
  const recovery = makeDemoMarket();
  for (const key of ["structure", "breadth", "style", "liquidity", "sentiment"]) recovery.dimensions[key].score = 1;
  recovery.dimensions.breadth.score = 2;
  recovery.dimensions.breadth.facts.find(item => item.label === "上涨占比").value = 60;
  const repaired = assessMarket(recovery);
  assert.equal(repaired.state, "风险偏好修复");
  assert.equal(repaired.confidence, 90);
  assert.ok(repaired.switchConditions.length > 0);

  const contraction = makeDemoMarket();
  for (const key of ["structure", "breadth", "style", "liquidity", "sentiment"]) contraction.dimensions[key].score = -1;
  contraction.dimensions.breadth.score = -2;
  contraction.dimensions.breadth.facts.find(item => item.label === "上涨占比").value = 25;
  const weakened = assessMarket(contraction);
  assert.equal(weakened.state, "风险偏好收缩");
  assert.equal(weakened.confidence, 90);
  assert.ok(weakened.switchConditions.length > 0);
});

test("iFinD MCP 正常：历史成交补齐20日均值并与扶摇收盘成交评分，事件有真实来源", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const snapshotAt = new Date(`${today}T07:15:00.000Z`).toISOString();
  setEnvironment(ifindTestEnvironment());
  globalThis.fetch = mockIfindFetch(ifindPayloads({
    rows: turnoverRows(today),
    news: [{ "资讯标题": "宏观政策公开信息", "资讯内容": "有关部门发布政策信息，具体影响仍需结合后续数据观察。", "日期": "2026-10-14 10:00:00", "资讯热度": 3, URL: "https://news.example/item?token=fixture-secret", "信息来源": "公开资讯源" }]
  }));

  const evidence = await getIfindEvidence(process.env, { now: Date.parse(snapshotAt) });
  assert.equal(evidence.dimensions.liquidity.status, "partial");
  assert.equal(evidence.dimensions.liquidity.historyRows.length, 22);
  assert.equal(evidence.dimensions.events.status, "available");
  assert.equal(evidence.dimensions.events.facts[0].value, "宏观政策公开信息");
  assert.doesNotMatch(JSON.stringify(evidence.dimensions.events), /具体影响仍需结合后续数据观察/);
  assert.equal(evidence.dimensions.events.facts[0].url, "https://news.example/item");
  assert.equal(evidence.dimensions.events.asOf, snapshotAt);
  assert.equal(evidence.dimensions.events.facts[0].publishedAt, "2026-10-14 10:00:00");
  assert.match(evidence.dimensions.events.facts[0].method, /采集时点/);

  const market = { dimensions: { liquidity: {
    label: "流动性", status: "partial", score: null, asOf: snapshotAt,
    source: "扶摇 A 股全市场行情快照", facts: [{ label: "全市场成交额", value: 15000, unit: "亿元", sourceField: "turnover（全 A 股逐证券求和）", source: "扶摇 A 股全市场行情快照", asOf: snapshotAt }]
  } } };
  mergeIfindEvidence(market, evidence);
  assert.equal(market.dimensions.liquidity.score, 2);
  assert.equal(market.dimensions.liquidity.status, "positive");
  assert.equal(market.dimensions.liquidity.facts.find(item => item.label === "20 日平均成交额").value, 10000);
  assert.equal(market.dimensions.liquidity.facts.find(item => item.label === "成交额 / 20 日均值").value, 1.5);
});

test("iFinD 诊断：安全 trim 授权值、确认 Header 已加入且日志不含凭证", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const snapshotAt = new Date(`${today}T07:15:00.000Z`).toISOString();
  const marketCredential = "diag-market-secret-DO-NOT-LOG";
  const newsCredential = "diag-news-secret-DO-NOT-LOG";
  setEnvironment(ifindTestEnvironment({
    IFIND_MARKET_AUTHORIZATION: `  "${marketCredential}"\r\n`,
    IFIND_NEWS_AUTHORIZATION: `\t${newsCredential} \n`
  }));
  const observedHeaders = [];
  const logs = [];
  const originalLog = console.log;
  globalThis.fetch = mockIfindFetch(ifindPayloads({
    rows: turnoverRows(today), news: [{ "资讯标题": "诊断测试标题", "日期": today }]
  }), call => observedHeaders.push(call.authorization));
  console.log = value => logs.push(String(value));
  try {
    const result = await getIfindEvidence(process.env, { now: Date.parse(snapshotAt) });
    assert.equal(result.dimensions.events.status, "available");
  } finally {
    console.log = originalLog;
  }

  assert.ok(observedHeaders.includes(marketCredential));
  assert.ok(observedHeaders.includes(newsCredential));
  const entries = logs.map(line => JSON.parse(line)).filter(item => item.type === "ifind_diagnostic");
  assert.ok(entries.some(item => item.provider === "market" && item.authorization_present && item.authorization_header_added));
  assert.ok(entries.some(item => item.provider === "news" && item.authorization_present && item.authorization_header_added));
  assert.ok(entries.some(item => item.operation === "tools/list" && item.http_status === 200));
  assert.ok(entries.some(item => item.provider === "market" && item.authorization_quote_wrapped && item.authorization_contains_newline));
  assert.ok(entries.some(item => item.provider === "news" && item.authorization_outer_whitespace && item.authorization_contains_newline));
  assert.doesNotMatch(logs.join("\n"), /diag-market-secret|diag-news-secret|DO-NOT-LOG/);
});

test("iFinD 诊断：保留脱敏的 HTTP 与 fetch/cause 分类，不记录响应原文或凭证", async () => {
  setEnvironment(ifindTestEnvironment());
  const logs = [];
  const originalLog = console.log;
  console.log = value => logs.push(String(value));
  try {
    globalThis.fetch = async () => jsonResponse({ error: "response-secret-must-not-be-logged" }, 401);
    await getIfindEvidence(process.env, { timeoutMs: 100 });
    const unauthorized = logs.map(line => JSON.parse(line));
    assert.ok(unauthorized.some(item => item.stage === "http" && item.http_status === 401 && item.error_message === "HTTP 401"));
    assert.doesNotMatch(logs.join("\n"), /response-secret-must-not-be-logged/);

    logs.length = 0;
    globalThis.fetch = async () => {
      const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    };
    await getIfindEvidence(process.env, { timeoutMs: 100 });
    const networkFailure = logs.map(line => JSON.parse(line));
    assert.ok(networkFailure.some(item => item.stage === "fetch" && item.error_name === "TypeError" && item.error_message === "fetch failed" && item.cause_code === "ECONNRESET"));

    logs.length = 0;
    globalThis.fetch = async (_input, options = {}) => {
      const request = JSON.parse(options.body || "{}");
      return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: -32042, message: "sensitive response text" } });
    };
    await getIfindEvidence(process.env, { timeoutMs: 100 });
    const protocolFailure = logs.map(line => JSON.parse(line));
    assert.ok(protocolFailure.some(item => item.stage === "jsonrpc" && item.http_status === 200 && item.jsonrpc_error_code === -32042));
    assert.doesNotMatch(logs.join("\n"), /sensitive response text/);

    logs.length = 0;
    globalThis.fetch = (_input, { signal }) => new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
    await getIfindEvidence(process.env, { timeoutMs: 10 });
    const timeoutFailure = logs.map(line => JSON.parse(line));
    assert.ok(timeoutFailure.some(item => item.stage === "fetch" && item.timeout === true));
  } finally {
    console.log = originalLog;
  }
});

test("iFinD MCP 超时：独立标记失败，不产生空壳或演示事实", async () => {
  setEnvironment(ifindTestEnvironment());
  globalThis.fetch = (_input, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  const result = await getIfindEvidence(process.env, { timeoutMs: 10 });
  assert.equal(result.dimensions.liquidity.status, "unavailable");
  assert.equal(result.dimensions.events.status, "unavailable");
  assert.deepEqual(result.dimensions.liquidity.facts, []);
  assert.ok(result.toolCalls.every(call => call.status === "failed"));
});

test("iFinD MCP 空结果：流动性和事件均 unavailable，不用演示值补位", async () => {
  setEnvironment(ifindTestEnvironment());
  globalThis.fetch = mockIfindFetch(ifindPayloads({
    rows: [], news: []
  }));
  const result = await getIfindEvidence(process.env);
  assert.equal(result.dimensions.liquidity.status, "unavailable");
  assert.equal(result.dimensions.liquidity.score, null);
  assert.deepEqual(result.dimensions.liquidity.facts, []);
  assert.equal(result.dimensions.events.status, "unavailable");
  assert.deepEqual(result.dimensions.events.facts, []);
  assert.ok(result.toolCalls.every(call => call.status === "empty"));
});

test("iFinD 与扶摇同日成交冲突：保留双源事实并暂停流动性评分", () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const snapshotAt = new Date(`${today}T07:15:00.000Z`).toISOString();
  const market = { dimensions: { liquidity: {
    label: "流动性", status: "partial", score: null, asOf: snapshotAt,
    source: "扶摇 A 股全市场行情快照", facts: [{ label: "全市场成交额", value: 15000, unit: "亿元", sourceField: "turnover（全 A 股逐证券求和）", source: "扶摇", asOf: snapshotAt }]
  } } };
  const evidence = { dimensions: { liquidity: {
    source: "iFinD MCP", historyRows: turnoverRows(today, "20000亿元").map(row => ({
      date: row.date, valueYuan: Number(row.amount.replace("亿元", "")) * 1e8, symbol: "700008.TI", name: "同花顺沪深全A"
    }))
  } } };
  mergeIfindEvidence(market, evidence);
  assert.equal(market.dimensions.liquidity.status, "conflict");
  assert.equal(market.dimensions.liquidity.score, null);
  assert.ok(market.dimensions.liquidity.facts.some(item => item.source === "扶摇"));
  assert.ok(market.dimensions.liquidity.facts.some(item => item.source?.includes("iFinD")));
  assert.match(market.dimensions.liquidity.summary, /超过 5%/);
});

test("iFinD 不可用时扶摇主链路保持有效且不回退演示数据", async () => {
  const now = Date.now();
  setEnvironment(ifindTestEnvironment({ MARKET_DATA_MODE: "fuyao", FUYAO_API_KEY: "test-fuyao-only" }));
  const fuyaoFetch = fuyaoFixtureFetch(now);
  globalThis.fetch = async (input, options) => {
    if (String(input).startsWith("https://ifind.test/")) return jsonResponse({ error: "unavailable" }, 503);
    return fuyaoFetch(input, options);
  };
  const result = await getMarket();
  assert.equal(result.demo, false);
  for (const key of ["structure", "breadth", "style", "sentiment"]) assert.ok(Number.isFinite(result.dimensions[key].score), key);
  assert.equal(result.dimensions.events.status, "unavailable");
  assert.equal(result.toolCalls.filter(call => call.name.startsWith("iFinD")).length, 0);
  assert.doesNotMatch(JSON.stringify({ warnings: result.warnings, toolCalls: result.toolCalls }), /iFinD|MCP|HTTP|failed|timeout|ECONN/);
  assert.ok(result.assessment.state !== "证据不足");
});

test("生产默认关闭 iFinD：凭证存在也不发 MCP 请求，缺失维度不显示技术错误或伪造事实", async () => {
  const now = Date.now();
  const requests = [];
  const env = {
    MARKET_DATA_MODE: "fuyao", FUYAO_API_KEY: "test-fuyao-only",
    IFIND_MARKET_AUTHORIZATION: "configured-but-disabled-market",
    IFIND_NEWS_AUTHORIZATION: "configured-but-disabled-news",
    IFIND_MARKET_MCP_URL: "https://ifind.test/market",
    IFIND_NEWS_MCP_URL: "https://ifind.test/news",
    ...configuredModel()
  };
  setEnvironment(env);
  const fuyaoFetch = fuyaoFixtureFetch(now);
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "ifind.test") requests.push(url.href);
    return fuyaoFetch(input, options);
  };

  const market = await getMarket(env);
  assert.equal(requests.length, 0);
  assert.equal(market.demo, false);
  assert.equal(market.dimensions.liquidity.status, "partial");
  assert.equal(market.dimensions.liquidity.score, null);
  assert.ok(market.dimensions.liquidity.facts.some(item => item.label === "全市场成交额" && item.source.includes("扶摇")));
  assert.ok(!market.dimensions.liquidity.facts.some(item => /20 日平均|20日均值|成交额 \/ 20 日均值/.test(item.label)));
  assert.equal(market.dimensions.events.status, "unavailable");
  assert.deepEqual(market.dimensions.events.facts, []);
  assert.equal(market.dimensions.valuation.status, "unavailable");
  assert.equal(market.dimensions.valuation.source, "未接入数据源");
  assert.deepEqual(market.dimensions.valuation.facts, []);
  assert.ok(!(market.toolCalls || []).some(call => /iFinD/i.test(call.name || "")));
  assert.doesNotMatch(JSON.stringify({ warnings: market.warnings, providerMessage: market.providerMessage }), /iFinD|MCP|ECONN|timeout|失败/);
  assert.equal(market.assessment.availableCore >= 3, true);

  const result = await answerResearch("有哪些值得关注的政策事件？", market, {
    topic: "事件观察", scope: "dimension", steps: ["检查当前可用事件 evidence"], dimensions: ["events"]
  }, env);
  assert.equal(result.aiMode, "证据不足");
  assert.deepEqual(result.citations, []);
  assert.match(result.answer, /证据当前不可用/);
  assert.equal(requests.length, 0);
});

test("Research 引用真实 iFinD 事件 evidence 与清理后的来源链接", async () => {
  setEnvironment({ ...ifindTestEnvironment(), ...configuredModel() });
  const payloads = ifindPayloads({ news: [{
    "资讯标题": "宏观政策公开信息", "资讯内容": "有关部门发布政策信息，具体影响仍需结合后续数据观察。", "日期": "2026-10-14 10:00:00",
    URL: "https://news.example/item?token=fixture-secret", "信息来源": "公开资讯源"
  }] });
  const ifindFetch = mockIfindFetch(payloads);
  globalThis.fetch = async (input, options) => {
    if (String(input).startsWith("https://ifind.test/")) return ifindFetch(input, options);
    const request = JSON.parse(options.body);
    assert.doesNotMatch(request.messages[1].content, /news\.example/);
    assert.doesNotMatch(request.messages[1].content, /具体影响仍需结合后续数据观察/);
    return modelResponse({ interpretations: [{
      text: "这条资讯可作为政策背景继续核验，单条检索结果不足以判断市场影响方向。", evidenceIds: ["E01"]
    }], uncertainties: ["工具没有提供单条发布时间，因此只采用检索时点。"] });
  };
  const ifind = await getIfindEvidence();
  const market = makeDemoMarket();
  market.dimensions.events = ifind.dimensions.events;
  market.assessment = assessMarket(market);
  const result = await answerResearch("近期有哪些政策新闻？", market, {
    topic: "近期事件", scope: "dimension", steps: ["读取 iFinD 事件 evidence"], dimensions: ["events"]
  }, process.env);
  assert.equal(result.aiMode, "真实 LLM");
  assert.ok(result.citations.some(item => item.source.includes("iFinD MCP")));
  assert.equal(result.citations[0].url, "https://news.example/item");
  assert.equal(result.citations[0].publishedAt, "2026-10-14 10:00:00");
  assert.equal(result.citations[0].value, "宏观政策公开信息");
  assert.doesNotMatch(result.answer, /具体影响仍需结合后续数据观察/);
  assert.match(result.answer, /E01/);
});

test("扶摇未配置凭证时保持无演示回退", async () => {
  setEnvironment({ MARKET_DATA_MODE: "fuyao" });
  const result = await getFuyaoMarket();
  assert.equal(result.demo, false);
  assert.equal(result.providerStatus, "not_configured");
  assert.deepEqual(result.indexes, []);
});

test("扶摇指数、分页、日线和涨跌停请求独立重试；单路中止不取消其他数据链路", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  const now = Date.now();
  const baseFetch = fuyaoFixtureFetch(now);
  const attempts = new Map();
  const signals = new Set();
  const failOnce = new Set(["index", "market:0", "history:000852.SH", "pool:limit-up-pool"]);
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    signals.add(options.signal);
    const key = url.pathname === "/api/a-share-index/prices/snapshot" ? "index"
      : url.pathname === "/api/a-share/prices/snapshot" ? `market:${url.searchParams.get("offset")}`
        : url.pathname === "/api/a-share-index/prices/historical" ? `history:${url.searchParams.get("thscode")}`
          : `pool:${url.pathname.split("/").at(-1)}`;
    const count = (attempts.get(key) || 0) + 1;
    attempts.set(key, count);
    if (failOnce.has(key) && count === 1) throw new DOMException("The operation was aborted", "AbortError");
    return baseFetch(input);
  };

  const result = await getFuyaoMarket();
  assert.equal(attempts.get("index"), 2);
  assert.equal(attempts.get("market:0"), 2);
  assert.equal(attempts.get("history:000852.SH"), 2);
  assert.equal(attempts.get("pool:limit-up-pool"), 2);
  assert.equal(signals.size, [...attempts.values()].reduce((sum, count) => sum + count, 0));
  assert.ok(Number.isFinite(result.dimensions.structure.score));
  assert.ok(Number.isFinite(result.dimensions.breadth.score));
  assert.ok(Number.isFinite(result.dimensions.style.score));
  assert.ok(Number.isFinite(result.dimensions.sentiment.score));
});

test("扶摇资源缓存按数据集分层、并发合并请求，且最近有效快照有明确时限", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  const now = Date.now();
  const requests = new Map();
  const track = url => {
    const key = url.pathname === "/api/a-share-index/prices/snapshot" ? "index"
      : url.pathname === "/api/a-share/prices/snapshot" ? "market"
        : url.pathname === "/api/a-share-index/prices/historical" ? `history:${url.searchParams.get("thscode")}`
          : `pool:${url.pathname.split("/").at(-1)}`;
    requests.set(key, (requests.get(key) || 0) + 1);
  };
  globalThis.fetch = fuyaoFixtureFetch(now, track);

  const [first, concurrent] = await Promise.all([getFuyaoMarket(), getFuyaoMarket()]);
  assert.deepEqual(concurrent.dimensions.breadth.score, first.dimensions.breadth.score);
  assert.equal(requests.get("index"), 1);
  assert.equal(requests.get("market"), 1);
  assert.equal(requests.get("history:000300.SH"), 1);
  assert.equal(requests.get("history:000852.SH"), 1);
  assert.equal(requests.get("history:399006.SZ"), 1);
  assert.equal(requests.get("pool:limit-up-pool"), 1);
  assert.equal(requests.get("pool:limit-down-pool"), 1);

  const originalNow = Date.now;
  try {
    Date.now = () => now + 121_000;
    let failedCalls = 0;
    const failedPaths = [];
    globalThis.fetch = async input => { failedCalls += 1; failedPaths.push(new URL(String(input)).pathname); throw new TypeError("upstream unavailable"); };
    const recentFallback = await getFuyaoMarket();
    assert.equal(failedCalls, 2, "only the two-minute index snapshot TTL should have expired");
    assert.equal(recentFallback.usedLastKnownGood, true);
    assert.ok(recentFallback.warnings.some(item => item.includes("最近有效快照") && item.includes(new Date(now).toISOString())));
    assert.ok(recentFallback.dimensions.structure.summary.includes("最近有效快照"));
    assert.ok(Number.isFinite(recentFallback.dimensions.breadth.score));

    Date.now = () => now + 245_000;
    const callsBeforeFourMinuteRefresh = failedCalls;
    const fourMinuteFallback = await getFuyaoMarket();
    assert.equal(fourMinuteFallback.usedLastKnownGood, true);
    assert.equal(failedCalls - callsBeforeFourMinuteRefresh, 8, `four-minute market and pool TTLs expire; 45-minute history remains cached (${failedPaths.join(", ")})`);

    Date.now = () => now + 4 * 60 * 60_000;
    const expired = await getFuyaoMarket();
    expired.assessment = assessMarket(expired);
    assert.equal(expired.dimensions.structure.score, null);
    assert.equal(expired.dimensions.breadth.score, null);
    assert.equal(expired.dimensions.style.score, null);
    assert.equal(expired.dimensions.sentiment.score, null);
    assert.equal(expired.assessment.state, "证据不足");
    assert.equal(expired.assessment.majorTension, "证据不足，暂不形成市场状态判断");
  } finally {
    Date.now = originalNow;
  }
});

test("生产默认模式为扶摇；没有凭证时显示证据不足而不是演示行情", async () => {
  setEnvironment({});
  clearMarketCache();
  const result = await getMarket();
  assert.equal(result.mode, "fuyao");
  assert.equal(result.demo, false);
  assert.equal(result.assessment.state, "证据不足");
  assert.equal(result.dimensions.structure.status, "unavailable");
});

test("扶摇上游失败不回退演示，近期市场缓存供 Research 复用", async () => {
  setEnvironment({ MARKET_DATA_MODE: "fuyao", FUYAO_API_KEY: "test-only" });
  clearMarketCache();
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return jsonResponse({ code: 401, message: "unauthorized" }, 401);
  };
  const result = await getMarket();
  assert.equal(result.demo, false);
  assert.equal(result.providerStatus, "failed");
  assert.equal(result.indexes.length, 3);
  assert.ok(result.indexes.every(index => index.last === null && index.quoteStatus === "unavailable"));
  assert.ok(result.warnings.some(warning => warning.includes("HTTP 401")));

  const firstRequestCount = requestCount;
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    const cached = await getMarket();
    assert.equal(cached.demo, false);
    assert.equal(requestCount, firstRequestCount);
  } finally {
    Date.now = realNow;
    clearMarketCache();
  }
});

test("扶摇有效快照与日线映射到指数卡、图表和风格指标", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  const now = Date.now();
  const closes = {
    "000300.SH": [100, 101, 101, 102, 103, 104],
    "000852.SH": [100, 100, 99, 98, 98, 97],
    "399006.SZ": [100, 101, 102, 101, 102, 103]
  };
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/snapshot")) return jsonResponse({ code: 0, data: {
      timestamp: now,
      item: [
        { thscode: "000300.SH", last_price: 3900, price_change_ratio_pct: 0.4 },
        { thscode: "000852.SH", last_price: 6200, price_change_ratio_pct: -0.8 },
        { thscode: "399006.SZ", last_price: 2400, price_change_ratio_pct: 0.2 }
      ]
    } });
    const code = url.searchParams.get("thscode");
    const item = closes[code].map((close_price, index) => ({
      date_ms: now - (5 - index) * 24 * 60 * 60 * 1000,
      close_price
    }));
    return jsonResponse({ code: 0, data: { item } });
  };

  const result = await getFuyaoMarket();
  assert.equal(result.indexes.length, 3);
  assert.equal(result.indexes[0].last, 3900);
  assert.equal(result.chartSeries.length, 6);
  assert.equal(result.dimensions.structure.score, 0);
  assert.equal(result.dimensions.style.score, -1);
});

test("扶摇分页全市场快照与涨跌停池可产生真实口径的宽度、成交事实和情绪", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  const now = Date.now();
  const stockRows = Array.from({ length: 202 }, (_, index) => ({
    thscode: `T${String(index).padStart(6, "0")}.SH`,
    price_change_ratio_pct: index < 80 ? 1 : index < 180 ? -1 : 0,
    turnover: 50_000_000
  }));
  const seenOffsets = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === "/api/a-share-index/prices/snapshot") {
      return jsonResponse({ code: 0, data: { timestamp: now, item: [
        { thscode: "000300.SH", last_price: 3900, price_change_ratio_pct: 0.4 },
        { thscode: "000852.SH", last_price: 6200, price_change_ratio_pct: -0.8 },
        { thscode: "399006.SZ", last_price: 2400, price_change_ratio_pct: 0.2 }
      ] } });
    }
    if (url.pathname === "/api/a-share/prices/snapshot") {
      const offset = Number(url.searchParams.get("offset")); seenOffsets.push(offset);
      return jsonResponse({ code: 0, data: {
        timestamp: now, total: stockRows.length,
        item: stockRows.slice(offset, offset + Number(url.searchParams.get("limit")))
      } });
    }
    if (url.pathname === "/api/a-share-index/prices/historical") {
      const item = [100, 101, 102, 103, 104, 105].map((close_price, index) => ({
        date_ms: now - (5 - index) * 24 * 60 * 60 * 1000, close_price
      }));
      return jsonResponse({ code: 0, data: { timestamp: now, item } });
    }
    if (url.pathname.includes("limit-up-pool") || url.pathname.includes("limit-down-pool")) {
      const total = url.pathname.includes("limit-up-pool") ? 4 : 6;
      return jsonResponse({ code: 0, data: {
        timestamp: now, pagination: { total, pages: 1 },
        item: Array.from({ length: total }, (_, index) => ({ thscode: `POOL${index}` }))
      } });
    }
    throw new Error(`Unexpected Fuyao endpoint: ${url.pathname}`);
  };

  const result = await getFuyaoMarket();
  assert.equal(result.demo, false);
  assert.deepEqual(seenOffsets.sort((a, b) => a - b), [0, 100, 200]);
  assert.equal(result.dimensions.breadth.status, "neutral");
  assert.equal(result.dimensions.breadth.facts.find(item => item.label === "上涨家数").value, 80);
  assert.equal(result.dimensions.breadth.facts.find(item => item.label === "下跌家数").value, 100);
  assert.equal(result.dimensions.liquidity.status, "partial");
  assert.equal(result.dimensions.liquidity.facts[0].value, 101);
  assert.equal(result.dimensions.liquidity.score, null);
  assert.equal(result.dimensions.sentiment.facts.find(item => item.label === "涨停家数").value, 4);
  assert.equal(result.dimensions.sentiment.facts.find(item => item.label === "跌停家数").value, 6);
});

test("扶摇全市场分页缺页时宽度和成交额均不可用，不拼接或补造数据", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  const now = Date.now();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === "/api/a-share/prices/snapshot") {
      const offset = Number(url.searchParams.get("offset"));
      const item = offset === 0 ? Array.from({ length: 100 }, (_, index) => ({
        thscode: `T${index}.SH`, price_change_ratio_pct: 1, turnover: 100
      })) : [];
      return jsonResponse({ code: 0, data: { timestamp: now, total: 101, item } });
    }
    if (url.pathname === "/api/a-share-index/prices/snapshot") {
      return jsonResponse({ code: 0, data: { timestamp: now, item: [] } });
    }
    if (url.pathname === "/api/a-share-index/prices/historical") return jsonResponse({ code: 0, data: { item: [] } });
    return jsonResponse({ code: 0, data: { timestamp: now, pagination: { total: 0, pages: 1 }, item: [] } });
  };
  const result = await getFuyaoMarket();
  assert.equal(result.demo, false);
  assert.equal(result.dimensions.breadth.status, "unavailable");
  assert.equal(result.dimensions.breadth.facts.length, 0);
  assert.equal(result.dimensions.liquidity.status, "unavailable");
  assert.equal(result.dimensions.liquidity.facts.length, 0);
  assert.ok(result.warnings.some(warning => warning.includes("全市场行情快照失败")));
});

test("扶摇未来快照不产生状态分数或未来的总更新时间", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  const futureTimestamp = Date.now() + 60 * 60 * 1000;
  globalThis.fetch = async url => {
    if (String(url).includes("/snapshot")) return jsonResponse({ code: 0, data: {
      timestamp: futureTimestamp,
      item: [
        { thscode: "000300.SH", last_price: 3900, price_change_ratio_pct: 0.4 },
        { thscode: "000852.SH", last_price: 6200, price_change_ratio_pct: -0.8 },
        { thscode: "399006.SZ", last_price: 2400, price_change_ratio_pct: 0.2 }
      ]
    } });
    return jsonResponse({ code: 0, data: { item: [] } });
  };

  const result = await getFuyaoMarket();
  assert.equal(result.dimensions.structure.status, "invalid_time");
  assert.equal(result.dimensions.structure.score, null);
  assert.equal(result.asOf, null);
});

test("扶摇过期快照保留时点但不展示为当前报价或参与评分", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  const old = Date.now() - 40 * 60 * 60 * 1000;
  globalThis.fetch = async url => {
    if (String(url).includes("/snapshot")) return jsonResponse({ code: 0, data: {
      timestamp: old,
      item: [{ thscode: "000300.SH", last_price: 3900, price_change_ratio_pct: 0.4 }]
    } });
    return jsonResponse({ code: 0, data: { item: [] } });
  };

  const result = await getFuyaoMarket();
  assert.equal(result.dimensions.structure.status, "stale");
  assert.equal(result.dimensions.structure.score, null);
  assert.equal(result.indexes[0].quoteStatus, "stale");
  assert.ok(result.asOf);
});

test("扶摇缺少有效快照时点时不评分，也不把报价作为当前行情展示", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  globalThis.fetch = async url => {
    if (String(url).includes("/snapshot")) return jsonResponse({ code: 0, data: {
      timestamp: "not-a-date",
      item: [{ thscode: "000300.SH", last_price: 3900, price_change_ratio_pct: 0.4 }]
    } });
    return jsonResponse({ code: 0, data: { item: [] } });
  };

  const result = await getFuyaoMarket();
  assert.equal(result.dimensions.structure.status, "unavailable");
  assert.equal(result.dimensions.structure.score, null);
  assert.equal(result.indexes[0].quoteStatus, "unavailable");
  assert.equal(result.asOf, null);
});

test("扶摇未来历史日线不参与风格计算", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  const now = Date.now();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/snapshot")) return jsonResponse({ code: 0, data: {
      timestamp: now,
      item: [
        { thscode: "000300.SH", last_price: 3900, price_change_ratio_pct: 0.4 },
        { thscode: "000852.SH", last_price: 6200, price_change_ratio_pct: -0.8 }
      ]
    } });
    const code = url.searchParams.get("thscode");
    const item = code === "399006.SZ" ? [] : [100, 101, 102, 103, 104, 105].map((close_price, index) => ({
      date_ms: now + 60 * 60 * 1000 + index,
      close_price
    }));
    return jsonResponse({ code: 0, data: { item } });
  };

  const result = await getFuyaoMarket();
  assert.equal(result.dimensions.style.status, "invalid_time");
  assert.equal(result.dimensions.style.score, null);
  assert.ok(result.warnings.some(warning => warning.includes("历史日线时点在未来")));
});

test("扶摇不同步的指数日线不生成相对风格结论", async () => {
  setEnvironment({ FUYAO_API_KEY: "test-only" });
  const now = Date.now();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/snapshot")) return jsonResponse({ code: 0, data: {
      timestamp: now,
      item: [
        { thscode: "000300.SH", last_price: 3900, price_change_ratio_pct: 0.4 },
        { thscode: "000852.SH", last_price: 6200, price_change_ratio_pct: -0.8 }
      ]
    } });
    const code = url.searchParams.get("thscode");
    const offset = code === "000852.SH" ? 3 * 24 * 60 * 60 * 1000 : 0;
    const item = code === "399006.SZ" ? [] : [100, 101, 102, 103, 104, 105].map((close_price, index) => ({
      date_ms: now - offset - (5 - index) * 24 * 60 * 60 * 1000,
      close_price
    }));
    return jsonResponse({ code: 0, data: { item } });
  };

  const result = await getFuyaoMarket();
  assert.equal(result.dimensions.style.status, "unavailable");
  assert.equal(result.dimensions.style.title, "指数历史时点不同步");
  assert.equal(result.dimensions.style.score, null);
});

test("程序级合规拦截：买卖、推荐、仓位、目标/止损、预测与收益承诺", () => {
  const blocked = [
    "现在买哪只股票？", "推荐一只股票给我", "帮我选股", "应该几成仓？", "我现在要加仓吗？",
    "给这只股票一个目标价", "止损设在哪里？", "明天会不会涨？", "中证指数会涨吗？",
    "未来大概率下跌吗？", "未来一周收益能保证吗？", "承诺收益并保证盈利可以吗？"
  ];
  for (const question of blocked) assert.equal(isProhibitedQuery(question), true, question);
  const allowedQuestions = [
    "当前市场状态和主要矛盾如何？", "市场宽度和上涨覆盖面有什么特征？",
    "近期大小盘风格轮动有什么差异？", "行业相对表现该如何结合证据解读？",
    "流动性与历史成交基准有什么差异？", "涨跌停结构反映怎样的市场情绪？",
    "哪些宏观政策事件值得继续核验？", "与历史阶段相比风险变量组合有什么变化？",
    "买入意愿与卖出压力近期如何变化？", "帮我分析股票市场的市场宽度。"
  ];
  for (const question of allowedQuestions) assert.equal(isProhibitedQuery(question), false, question);

  const prohibitedOutputs = [
    "建议买入这只个股。", "应卖出持仓。", "可以把仓位提高。", "目标价应设为关键压力位。",
    "止损位设在关键支撑附近。", "未来必然上涨。", "明日市场大概率下跌。", "保证未来收益。"
  ];
  for (const output of prohibitedOutputs) assert.equal(violatesOutputBoundary(output), true, output);

  const allowedOutputs = [
    "指数与市场宽度信号并不一致。", "不提供个股推荐、买卖建议或仓位意见。",
    "本研究不判断未来走势。", "历史收益不保证未来收益。", "止损相关字段暂缺。",
    "买入意愿有所回升，卖出压力增加；这描述的是市场情绪，不构成交易建议。",
    "上涨家数与下跌家数同时变化，宽度信号需要结合其他证据。",
    "行业相对表现应按现有证据归纳，不从宽基指数直接外推。",
    "事件标题可作为背景线索，不能单独说明因果关系。",
    "研究计划建议继续观察宽度。买入意愿有所变化，卖出压力仍需结合证据。"
  ];
  for (const output of allowedOutputs) assert.equal(violatesOutputBoundary(output), false, output);
});

test("AI Research 合法主题端到端回归：八类问题均完成 Plan、证据读取、解释与引用", async () => {
  setEnvironment(configuredModel());
  const cases = [
    { question: "当前市场状态和主要矛盾如何？", topic: "市场状态", scope: "overall", dimensions: ["structure", "breadth", "style"], text: "指数结构与市场宽度信号暂未一致，当前证据体现为阶段性分化。" },
    { question: "市场宽度和上涨覆盖面有什么特征？", topic: "市场宽度", dimensions: ["breadth"], text: "上涨覆盖面与宽基表现并不完全同步，市场内部参与度需要单独观察。" },
    { question: "近期大小盘风格轮动有什么差异？", topic: "风格轮动", dimensions: ["style", "structure"], text: "中小盘相对大盘偏弱，风格证据呈现大小盘分化。" },
    { question: "行业相对表现该如何结合证据解读？", topic: "行业观察", dimensions: ["industry"], text: "行业相对表现只能按提供的行业证据概括，不从宽基指数直接外推。" },
    { question: "流动性与历史成交基准有什么差异？", topic: "流动性", dimensions: ["liquidity"], text: "成交活跃度相对历史参照偏弱，但单一维度不足以说明整体状态。" },
    { question: "涨跌停结构反映怎样的市场情绪？", topic: "市场情绪", dimensions: ["sentiment"], text: "涨停与跌停结构提供情绪线索，但不代表全部投资者预期。" },
    { question: "哪些宏观政策事件值得继续核验？", topic: "事件观察", dimensions: ["events"], text: "资讯标题提供政策背景，标题本身不足以判断因果影响。" },
    { question: "与历史阶段相比风险变量组合有什么变化？", topic: "历史比较", scope: "history", dimensions: ["historicalStates"], text: "历史阶段的信号组合存在差异，当前样本口径仍需继续核验。" }
  ];
  let activeCase = 0;
  let modelCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    modelCalls += 1;
    if (request.messages[0].content.includes("研究问题解析器")) {
      const item = cases[activeCase];
      return modelResponse({
        topic: item.topic, scope: item.scope || "dimension", steps: ["读取对应结构化 evidence", "核对来源与时点"], dimensions: item.dimensions
      });
    }
    return modelResponse({ interpretations: [{ text: cases[activeCase].text, evidenceIds: ["E01"] }], uncertainties: [] });
  };

  for (const item of cases) {
    assert.equal(isProhibitedQuery(item.question), false, item.question);
    const plan = await planResearch(item.question, process.env);
    assert.equal(plan.prohibited, false, item.question);
    const market = makeDemoMarket();
    market.dimensions.industry = { id: "industry", label: "行业观察", status: "available", facts: [{ label: "行业证据", value: "fixture" }], source: "测试 evidence" };
    market.dimensions.historicalStates = { id: "historicalStates", label: "历史比较", status: "available", facts: [{ label: "历史阶段 evidence", value: "fixture" }], source: "测试 evidence" };
    market.dimensions.events = { id: "events", label: "事件观察", status: "available", facts: [{ label: "政策事件标题", value: "宏观政策公开信息" }], source: "iFinD MCP" };
    market.assessment = assessMarket(market);
    const result = await answerResearch(item.question, market, plan, process.env);
    assert.equal(result.aiMode, "真实 LLM", item.question);
    assert.match(result.answer, /【工具事实】[\s\S]*【AI 归纳】/);
    assert.ok(result.citations.length > 0, item.question);
    assert.match(result.answer, /E01/, item.question);
    activeCase += 1;
  }
  assert.equal(modelCalls, 16);
});

test("AI Research：真实 LLM 先生成取数计划，再按结构化证据生成解释", async () => {
  setEnvironment(configuredModel());
  const requests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://model.test/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-only");
    const request = JSON.parse(options.body); requests.push(request);
    return modelResponse(requests.length === 1 ? stylePlan() : safeExplanation());
  };
  const market = makeDemoMarket();
  market.assessment = assessMarket(market);
  const history = [{ question: "先解释主要差异", answer: "上一轮的证据说明，仅供上下文。" }];

  const plan = await planResearch("那小盘风格为何偏弱？", process.env, history);
  assert.equal(plan.topic, "风格轮动");
  assert.deepEqual(plan.dimensions, ["structure", "style"]);
  assert.match(requests[0].messages[0].content, /不得回答市场事实/);
  assert.match(requests[0].messages[1].content, /上一轮的证据说明/);

  const result = await answerResearch("那小盘风格为何偏弱？", market, plan, process.env, history);
  assert.equal(result.aiMode, "真实 LLM");
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages[0].content, /不做任何数值运算/);
  assert.match(requests[1].messages[1].content, /"evidence"/);
  assert.match(result.answer, /【工具事实】/);
  assert.match(result.answer, /【AI 归纳】/);
  assert.match(result.answer, /E01/);
  assert.ok(result.citations.some(item => item.sourceField === "price_change_ratio_pct"));
  assert.match(result.disclaimer, /不构成投资建议/);
});

test("AI Research：模型计划 JSON 偶发无效时仅重试一次并继续标准流程", async () => {
  setEnvironment(configuredModel());
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    if (request.messages[0].content.includes("研究问题解析器")) {
      return calls === 1 ? modelResponse("额外说明，不是 JSON") : modelResponse(stylePlan());
    }
    return modelResponse(safeExplanation());
  };
  const question = "为什么小盘风格相对偏弱？";
  const plan = await planResearch(question, process.env);
  const market = makeDemoMarket(); market.assessment = assessMarket(market);
  const result = await answerResearch(question, market, plan, process.env);
  assert.equal(result.aiMode, "真实 LLM");
  assert.equal(calls, 3);
  assert.ok(result.citations.length > 0);
});

test("AI Research：DeepSeek 瞬时失败最多重试一次，重试使用独立 signal", async () => {
  setEnvironment(configuredModel());
  const signals = [];
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    signals.push(options.signal);
    if (calls === 1) throw new TypeError("fetch failed");
    return modelResponse(stylePlan());
  };
  const plan = await planResearch("为什么小盘风格相对偏弱？", process.env);
  assert.equal(plan.modelUnavailable, undefined);
  assert.equal(calls, 2);
  assert.notEqual(signals[0], signals[1]);
});

test("AI Research：模型重试仍失败时明确暂不可用且不生成结论", async () => {
  setEnvironment(configuredModel());
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new DOMException("The operation was aborted", "AbortError");
  };
  const plan = await planResearch("为什么小盘风格相对偏弱？", process.env);
  const result = await answerResearch("为什么小盘风格相对偏弱？", null, plan, process.env);
  assert.equal(calls, 2);
  assert.equal(result.aiMode, "模型暂不可用");
  assert.match(result.answer, /模型暂不可用/);
  assert.doesNotMatch(result.answer, /【AI 归纳】/);
  assert.deepEqual(result.citations, []);
});

test("AI Research：一个并发模型请求瞬时中断不取消另一个请求", async () => {
  setEnvironment(configuredModel());
  const signals = new Map();
  const attempts = new Map();
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const question = JSON.parse(request.messages[1].content).currentQuestion;
    const attempt = (attempts.get(question) || 0) + 1;
    attempts.set(question, attempt);
    signals.set(`${question}:${attempt}`, options.signal);
    if (question.includes("中断")) throw new DOMException("The operation was aborted", "AbortError");
    return modelResponse(stylePlan());
  };
  const [interrupted, normal] = await Promise.all([
    planResearch("中断请求后研究小盘风格", process.env),
    planResearch("研究小盘风格表现", process.env)
  ]);
  assert.equal(interrupted.modelUnavailable, true);
  assert.equal(normal.modelUnavailable, undefined);
  assert.equal(attempts.get("中断请求后研究小盘风格"), 2);
  assert.equal(attempts.get("研究小盘风格表现"), 1);
  assert.notEqual(signals.get("中断请求后研究小盘风格:1"), signals.get("研究小盘风格表现:1"));
  assert.equal(signals.get("研究小盘风格表现:1").aborted, false);
});

test("AI Research：证据数值核验使用与模型相同的展示精度", async () => {
  setEnvironment(configuredModel());
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.messages[0].content.includes("研究问题解析器")) return modelResponse(stylePlan());
    return modelResponse({
      interpretations: [{ text: "沪深300当日涨跌幅为1.2346%。", evidenceIds: ["E01"] }],
      uncertainties: []
    });
  };
  const market = makeDemoMarket();
  market.dimensions.structure.facts[0].value = 1.234567;
  market.assessment = assessMarket(market);
  const question = "沪深300当日涨跌幅是多少？";
  const plan = await planResearch(question, process.env);
  const result = await answerResearch(question, market, plan, process.env);
  assert.equal(result.aiMode, "真实 LLM");
  assert.match(result.answer, /1\.2346%/);
});

test("AI Research：定性问题的数值误差触发一次安全重答而不误杀合法研究", async () => {
  setEnvironment(configuredModel());
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    if (request.messages[0].content.includes("研究问题解析器")) return modelResponse(stylePlan());
    if (calls === 2) return modelResponse({
      interpretations: [{ text: "相对表现差异约为2.52个百分点。", evidenceIds: ["E04"] }],
      uncertainties: []
    });
    assert.match(request.messages[1].content, /定性解释/);
    return modelResponse(safeExplanation());
  };
  const question = "近期指数与风格信号有哪些差异？";
  const plan = await planResearch(question, process.env);
  const market = makeDemoMarket(); market.assessment = assessMarket(market);
  const result = await answerResearch(question, market, plan, process.env);
  assert.equal(result.aiMode, "真实 LLM");
  assert.equal(calls, 3);
  assert.match(result.answer, /【AI 归纳】/);
  assert.match(result.answer, /E01/);
});

test("AI Research：重答仍含未核验数字时仅省略该解释句并明确提示", async () => {
  setEnvironment(configuredModel());
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    if (request.messages[0].content.includes("研究问题解析器")) return modelResponse(stylePlan());
    if (calls === 2) return modelResponse({
      interpretations: [{ text: "相对差异约为2.52个百分点。", evidenceIds: ["E04"] }],
      uncertainties: []
    });
    return modelResponse({
      interpretations: [
        { text: "相对差异约为2.52个百分点。", evidenceIds: ["E04"] },
        { text: "现有证据显示两类风格表现并不同步。", evidenceIds: ["E04"] }
      ],
      uncertainties: ["具体数值仍需逐项核对。"]
    });
  };
  const question = "近期指数与风格之间有什么关系？";
  const plan = await planResearch(question, process.env);
  const market = makeDemoMarket(); market.assessment = assessMarket(market);
  const result = await answerResearch(question, market, plan, process.env);
  assert.equal(result.aiMode, "真实 LLM");
  assert.match(result.answer, /含未核验数值的解释句已省略/);
  assert.match(result.answer, /两类风格表现并不同步/);
  assert.doesNotMatch(result.answer, /2\.52/);
  assert.equal(calls, 3);
});

test("AI Research：允许精度范围内的四舍五入与百分比格式，明显不符时降级保留定性内容", async () => {
  setEnvironment(configuredModel());
  let explanation = "上涨占比为36%，上涨家数为1,870只。";
  let explanationSystem = "";
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.messages[0].content.includes("研究问题解析器")) {
      return modelResponse({ topic: "市场宽度", scope: "dimension", steps: ["读取市场宽度证据"], dimensions: ["breadth"] });
    }
    explanationSystem = request.messages[0].content;
    return modelResponse({ interpretations: [{ text: explanation, evidenceIds: ["E03", "E01"] }], uncertainties: [] });
  };

  const market = makeDemoMarket(); market.assessment = assessMarket(market);
  const question = "市场宽度目前呈现什么特征？";
  const plan = await planResearch(question, process.env);
  const sourced = await answerResearch(question, market, plan, process.env);
  assert.equal(sourced.aiMode, "真实 LLM");
  assert.match(sourced.answer, /36%/);
  assert.match(sourced.answer, /1,?870只/);
  assert.match(explanationSystem, /合理四舍五入/);

  explanation = "上涨占比为60%，整体呈现分化。";
  const unsupported = await answerResearch(question, market, plan, process.env);
  assert.equal(unsupported.aiMode, "真实 LLM");
  assert.match(unsupported.answer, /整体呈现分化/);
  assert.match(unsupported.answer, /未核验数值的解释句已省略/);
  assert.doesNotMatch(unsupported.answer, /60%/);
});

test("AI Research：同口径成交额可做等值常见单位转换，不能凭空改写金额", async () => {
  setEnvironment(configuredModel());
  let explanation = "全市场成交额约为1.24万亿元。";
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.messages[0].content.includes("研究问题解析器")) {
      return modelResponse({ topic: "流动性", scope: "dimension", steps: ["核对当日成交额"], dimensions: ["liquidity"] });
    }
    return modelResponse({ interpretations: [{ text: explanation, evidenceIds: ["E01"] }], uncertainties: [] });
  };
  const market = makeDemoMarket(); market.assessment = assessMarket(market);
  const question = "当前全市场成交额是多少？";
  const plan = await planResearch(question, process.env);
  const result = await answerResearch(question, market, plan, process.env);
  assert.equal(result.aiMode, "真实 LLM");
  assert.match(result.answer, /1\.24万亿元/);

  explanation = "全市场成交额约为9.99万亿元。";
  const degraded = await answerResearch(question, market, plan, process.env);
  assert.equal(degraded.aiMode, "数值核验降级");
  assert.doesNotMatch(degraded.answer, /9\.99/);
});

test("AI Research：禁答问题在模型规划与行情取数前被拦截", async () => {
  setEnvironment(configuredModel());
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse(stylePlan()); };
  const plan = await planResearch("现在买哪只股票？", process.env);
  const result = await answerResearch("现在买哪只股票？", null, plan, process.env);
  assert.equal(plan.prohibited, true);
  assert.equal(result.aiMode, "程序级合规拦截");
  assert.deepEqual(result.toolCalls, []);
  assert.equal(calls, 0);
});

test("AI Research：二次合规检查丢弃不合规模型文本，不作为回答展示", async () => {
  setEnvironment(configuredModel());
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return modelResponse(calls === 1 ? stylePlan() : {
      interpretations: [{ text: "建议买入个股，明天必涨。", evidenceIds: ["E01"] }], uncertainties: []
    });
  };
  const market = makeDemoMarket(); market.assessment = assessMarket(market);
  const plan = await planResearch("为什么小盘风格走弱？", process.env);
  const result = await answerResearch("为什么小盘风格走弱？", market, plan, process.env);
  assert.equal(result.aiMode, "输出合规拦截");
  assert.equal(result.answer, "模型回复触及金融合规边界，内容已丢弃。");
  assert.doesNotMatch(result.answer, /建议买入|必涨/);
  assert.equal(calls, 2);
});

test("AI Research：证据不足硬门槛在解释模型调用前阻止方向性回答", async () => {
  setEnvironment(configuredModel());
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse(stylePlan()); };
  const market = makeDemoMarket();
  market.dimensions.breadth.score = null;
  market.dimensions.breadth.facts = [];
  market.assessment = assessMarket(market);
  const plan = { ...stylePlan(), scope: "overall", dimensions: ["structure", "breadth", "style", "liquidity", "sentiment"] };
  const result = await answerResearch("当前市场整体状态如何？", market, plan, process.env);
  assert.equal(result.aiMode, "证据门槛拦截");
  assert.equal(result.answer, "证据不足，暂不形成市场状态判断");
  assert.deepEqual(result.citations, []);
  assert.equal(calls, 0);
});

test("AI Research：未配置或上游失败时明确不可用，不退回规则模板", async () => {
  setEnvironment({});
  const unavailablePlan = await planResearch("小盘风格为何偏弱？", process.env);
  const unconfigured = await answerResearch("小盘风格为何偏弱？", null, unavailablePlan, process.env);
  assert.equal(unconfigured.aiMode, "未配置");
  assert.match(unconfigured.answer, /未生成规则模板回答/);

  setEnvironment(configuredModel());
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? modelResponse(stylePlan()) : jsonResponse({ error: "unavailable" }, 503);
  };
  const market = makeDemoMarket(); market.assessment = assessMarket(market);
  const plan = await planResearch("小盘风格为何偏弱？", process.env);
  const failed = await answerResearch("小盘风格为何偏弱？", market, plan, process.env);
  assert.equal(failed.aiMode, "模型暂不可用");
  assert.match(failed.answer, /模型暂不可用/);
  assert.equal(calls, 3);
  await assert.rejects(() => answerResearch("  ", market, plan, process.env), /请输入研究问题/);
});
