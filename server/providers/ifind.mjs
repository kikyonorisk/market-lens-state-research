const DEFAULT_MARKET_MCP_URL = "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-mcp";
const DEFAULT_NEWS_MCP_URL = "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-news-mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_TIMEOUT_MS = 25_000;
const HISTORY_LOOKBACK_DAYS = 45;
const REQUIRED_HISTORY_SESSIONS = 20;
const HISTORY_CACHE_MS = 45 * 60_000;
const NEWS_CACHE_MS = 5 * 60_000;

const resourceCache = new Map();
let requestId = 0;

function normalizeAuthorization(value) {
  const raw = typeof value === "string" ? value : "";
  const outerWhitespace = raw !== raw.trim();
  const containsNewline = /[\r\n]/.test(raw);
  let normalized = raw.trim();
  const quoteWrapped = (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'"));
  if (quoteWrapped) normalized = normalized.slice(1, -1).trim();
  return {
    value: normalized,
    present: normalized.length > 0,
    trimmed: normalized !== raw,
    outerWhitespace,
    containsNewline,
    quoteWrapped
  };
}

function endpointDetails(url) {
  try {
    const parsed = new URL(url);
    return { endpoint_host: parsed.hostname, endpoint_port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) };
  } catch {
    return { endpoint_host: null, endpoint_port: null };
  }
}

function safeDiagnosticText(value, authorizationValue = "") {
  let text = String(value ?? "");
  const secret = String(authorizationValue ?? "");
  if (secret) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/https?:\/\/\S+/gi, "[URL_REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[TOKEN_REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[KEY_REDACTED]")
    .replace(/([?&](?:token|secret|api[_-]?key|authorization|auth|signature|credential|cookie)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/(authorization|cookie)\s*[:=]\s*[^,;\s]+/gi, "$1=[REDACTED]")
    .slice(0, 300);
}

function emitIfindDiagnostic({ provider, stage, operation, url, startedAt, status = null, error = null, timeout = false, authorizationPresent = false, authorizationHeaderAdded = false, authorizationValue = "", extra = {} }) {
  const details = endpointDetails(url);
  const event = {
    type: "ifind_diagnostic",
    provider,
    stage,
    ...(operation ? { operation } : {}),
    elapsed_ms: Math.max(0, Math.round(Date.now() - startedAt)),
    http_status: status,
    error_name: error?.name ? safeDiagnosticText(error.name, authorizationValue) : null,
    error_message: error?.message ? safeDiagnosticText(error.message, authorizationValue) : null,
    cause_code: error?.cause?.code ? safeDiagnosticText(error.cause.code, authorizationValue) : null,
    timeout: Boolean(timeout),
    authorization_present: Boolean(authorizationPresent),
    authorization_header_added: Boolean(authorizationHeaderAdded),
    ...details,
    ...extra
  };
  console.log(JSON.stringify(event));
}

function shanghaiDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const part = key => parts.find(item => item.type === key)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function mcpJson(text, contentType, id) {
  const candidates = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try { candidates.push(JSON.parse(line.slice(5).trim())); } catch { /* Ignore keepalive and non-JSON frames. */ }
    }
  } else {
    try { candidates.push(JSON.parse(text)); } catch { /* Checked below without exposing response text. */ }
  }
  return candidates.find(item => item && item.jsonrpc === "2.0" && (id === undefined || item.id === id)) || null;
}

async function postMcp({ provider, url, authorization, payload, expectedId, operation, controller, startedAt, sessionId = null }) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
  };
  if (authorization) headers.Authorization = authorization;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const authorizationHeaderAdded = Object.hasOwn(headers, "Authorization");
  let response = null;
  let body = "";
  try {
    response = await fetch(url, {
      method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal
    });
    body = await response.text();
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
    emitIfindDiagnostic({
      provider, stage: "fetch", operation, url, startedAt, status: response?.status ?? null,
      error, timeout: timedOut, authorizationPresent: Boolean(authorization), authorizationHeaderAdded,
      authorizationValue: authorization
    });
    throw error;
  }

  emitIfindDiagnostic({
    provider, stage: "fetch", operation, url, startedAt, status: response.status,
    authorizationPresent: Boolean(authorization), authorizationHeaderAdded, authorizationValue: authorization
  });
  if (!response.ok) {
    const error = Object.assign(new Error(`HTTP ${response.status}`), { name: "HttpStatusError" });
    emitIfindDiagnostic({
      provider, stage: "http", operation, url, startedAt, status: response.status,
      error, authorizationPresent: Boolean(authorization), authorizationHeaderAdded, authorizationValue: authorization
    });
    throw new Error(`iFinD MCP HTTP ${response.status}`);
  }

  if (!body.trim() && expectedId === undefined) {
    emitIfindDiagnostic({
      provider, stage: "jsonrpc", operation, url, startedAt, status: response.status,
      authorizationPresent: Boolean(authorization), authorizationHeaderAdded, authorizationValue: authorization
    });
    return { message: null, response, authorizationHeaderAdded };
  }
  const message = mcpJson(body, response.headers.get("content-type") || "", expectedId);
  if (!message) {
    const error = Object.assign(new Error("Invalid JSON-RPC response"), { name: "McpProtocolError" });
    emitIfindDiagnostic({
      provider, stage: "jsonrpc", operation, url, startedAt, status: response.status,
      error, authorizationPresent: Boolean(authorization), authorizationHeaderAdded, authorizationValue: authorization
    });
    throw new Error("iFinD MCP returned an invalid protocol response");
  }
  if (message.error) {
    const error = Object.assign(new Error("JSON-RPC error response"), { name: "JsonRpcError" });
    emitIfindDiagnostic({
      provider, stage: "jsonrpc", operation, url, startedAt, status: response.status,
      error, authorizationPresent: Boolean(authorization), authorizationHeaderAdded,
      authorizationValue: authorization,
      extra: { jsonrpc_error_code: Number.isFinite(message.error.code) ? message.error.code : null }
    });
    throw new Error("iFinD MCP protocol error");
  }
  emitIfindDiagnostic({
    provider, stage: "jsonrpc", operation, url, startedAt, status: response.status,
    authorizationPresent: Boolean(authorization), authorizationHeaderAdded, authorizationValue: authorization
  });
  return { message, response, authorizationHeaderAdded };
}

async function probeToolsList({ provider, url, authorization, timeoutMs }) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 4_000));
  let sessionId = null;
  let lastStatus = null;
  let lastHeaderAdded = false;
  const send = async (payload, expectedId, operation) => {
    const result = await postMcp({ provider, url, authorization, payload, expectedId, operation, controller, startedAt, sessionId });
    lastStatus = result.response.status;
    lastHeaderAdded = result.authorizationHeaderAdded;
    sessionId = result.response.headers.get("mcp-session-id") || sessionId;
    return result;
  };
  try {
    const initId = ++requestId;
    const initResponse = await send({
      jsonrpc: "2.0", id: initId, method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: "market-lens-diagnostic", version: "1.0.0" }
      }
    }, initId, "tools-list.initialize");
    const init = initResponse.message;
    if (!init?.result?.protocolVersion) throw new Error("iFinD MCP initialization was incomplete");
    await send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, undefined, "tools-list.initialized");
    const listId = ++requestId;
    const listResponse = await send({ jsonrpc: "2.0", id: listId, method: "tools/list", params: {} }, listId, "tools/list");
    const listed = listResponse.message;
    if (!Array.isArray(listed?.result?.tools)) throw new Error("iFinD MCP tools/list response was incomplete");
    emitIfindDiagnostic({
      provider, stage: "jsonrpc", operation: "tools/list", url, startedAt, status: lastStatus,
      authorizationPresent: Boolean(authorization), authorizationHeaderAdded: lastHeaderAdded,
      authorizationValue: authorization,
      extra: { tools_list_count: listed.result.tools.length }
    });
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
    if (error?.message === "iFinD MCP initialization was incomplete" || error?.message === "iFinD MCP tools/list response was incomplete") {
      const protocolError = Object.assign(new Error("MCP diagnostic response was incomplete"), { name: "McpProtocolError" });
      emitIfindDiagnostic({
        provider, stage: "jsonrpc", operation: "tools/list", url, startedAt,
        status: lastStatus, error: protocolError, timeout: timedOut,
        authorizationPresent: Boolean(authorization), authorizationHeaderAdded: lastHeaderAdded,
        authorizationValue: authorization
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function invokeMcpTool({ provider, url, authorization, tool, arguments: toolArguments, timeoutMs = MCP_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId = null;
  let lastHttpStatus = null;
  try {
    const send = async (payload, expectedId) => {
      const startedAt = Date.now();
      const responseResult = await postMcp({
        provider, url, authorization, payload, expectedId, operation: payload.method || "notifications/initialized",
        controller, startedAt, sessionId
      });
      const response = responseResult.response;
      lastHttpStatus = response.status;
      sessionId = response.headers.get("mcp-session-id") || sessionId;
      return responseResult.message;
    };

    const initId = ++requestId;
    const init = await send({
      jsonrpc: "2.0", id: initId, method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: "market-lens", version: "1.0.0" }
      }
    }, initId);
    if (!init?.result?.protocolVersion) throw new Error("iFinD MCP initialization was incomplete");
    await send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const callId = ++requestId;
    const toolCallStartedAt = Date.now();
    const result = await send({
      jsonrpc: "2.0", id: callId, method: "tools/call",
      params: { name: tool, arguments: toolArguments }
    }, callId);
    const toolCallHttpStatus = lastHttpStatus;
    if (!result?.result || result.result.isError) {
      const error = Object.assign(new Error("MCP tool returned an error"), { name: "McpToolError" });
      emitIfindDiagnostic({
        provider, stage: "tools-call", operation: tool, url, startedAt: toolCallStartedAt, status: toolCallHttpStatus,
        error, authorizationPresent: Boolean(authorization), authorizationHeaderAdded: true, authorizationValue: authorization
      });
      throw new Error("iFinD MCP tool call failed");
    }
    const text = result.result.content?.find(item => item.type === "text")?.text;
    if (typeof text !== "string" || !text.trim()) {
      const error = Object.assign(new Error("Tool response contained no text result"), { name: "McpToolError" });
      emitIfindDiagnostic({
        provider, stage: "tools-call", operation: tool, url, startedAt: toolCallStartedAt, status: toolCallHttpStatus,
        error, authorizationPresent: Boolean(authorization), authorizationHeaderAdded: true, authorizationValue: authorization
      });
      throw new Error("iFinD MCP tool returned no text result");
    }
    try {
      const payload = JSON.parse(text);
      emitIfindDiagnostic({
        provider, stage: "tools-call", operation: tool, url, startedAt: toolCallStartedAt, status: toolCallHttpStatus,
        authorizationPresent: Boolean(authorization), authorizationHeaderAdded: true, authorizationValue: authorization
      });
      return payload;
    } catch (error) {
      if (error instanceof SyntaxError) {
        const safeError = Object.assign(new Error("Tool response was not valid JSON"), { name: "McpToolError" });
        emitIfindDiagnostic({
          provider, stage: "tools-call", operation: tool, url, startedAt: toolCallStartedAt, status: toolCallHttpStatus,
          error: safeError, authorizationPresent: Boolean(authorization), authorizationHeaderAdded: true, authorizationValue: authorization
        });
        throw new Error("iFinD MCP tool returned an unsupported result format");
      }
      throw error;
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error("iFinD MCP request timed out");
    }
    if (error instanceof Error && /^iFinD MCP/.test(error.message)) throw error;
    throw new Error("iFinD MCP request failed");
  } finally {
    await probeToolsList({ provider, url, authorization, timeoutMs }).catch(() => {});
    clearTimeout(timer);
  }
}

async function cachedResource(key, ttlMs, load) {
  const existing = resourceCache.get(key);
  if (existing?.data && Date.now() - existing.fetchedAt < ttlMs) return structuredClone(existing.data);
  if (existing?.inFlight) return structuredClone(await existing.inFlight);

  const inFlight = load();
  resourceCache.set(key, { inFlight });
  try {
    const data = await inFlight;
    resourceCache.set(key, { data, fetchedAt: Date.now(), inFlight: null });
    return structuredClone(data);
  } catch (error) {
    if (resourceCache.get(key)?.inFlight === inFlight) resourceCache.delete(key);
    throw error;
  }
}

function parseDateCell(value) {
  const text = String(value ?? "").trim();
  const compact = text.match(/^(20\d{2})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const separated = text.match(/^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!separated) return null;
  return `${separated[1]}-${separated[2].padStart(2, "0")}-${separated[3].padStart(2, "0")}`;
}

function amountYuan(value) {
  const text = String(value ?? "").trim().replace(/[\s,，￥¥]/g, "");
  if (!text || /^(?:--|—|-|null|暂无)$/i.test(text)) return null;
  const number = Number(text.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i)?.[0]);
  if (!Number.isFinite(number) || number < 0) return null;
  if (text.includes("万亿")) return number * 1e12;
  if (text.includes("亿元") || text.endsWith("亿")) return number * 1e8;
  if (text.includes("万元") || text.endsWith("万")) return number * 1e4;
  return number;
}

function successfulToolPayload(payload) {
  return payload && typeof payload === "object" && payload.data &&
    (payload.code === undefined || payload.code === 0 || payload.code === 1) &&
    !/error|fail/i.test(String(payload.msg || ""));
}

function extractTurnoverRows(payload) {
  if (!successfulToolPayload(payload) || typeof payload.data.answer !== "string") return [];
  const lines = payload.data.answer.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => line.includes("证券代码") && line.includes("证券简称") && line.includes("日期") && line.includes("成交金额"));
  if (headerIndex < 0) return [];
  const records = new Map();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (cells.length < 4 || !cells[1].includes("沪深全A")) continue;
    const date = parseDateCell(cells[2]);
    const value = amountYuan(cells[3]);
    if (!date || value === null) continue;
    records.set(date, { date, valueYuan: value, symbol: cells[0], name: cells[1] });
  }
  return [...records.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function formatDateCompact(value) {
  return value.replaceAll("-", "");
}

function periodFor(now) {
  const end = shanghaiDate(now);
  const start = shanghaiDate(now - HISTORY_LOOKBACK_DAYS * 86_400_000);
  return { start, end };
}

function liquidityEvidence(records, period) {
  const latest = records.at(-1) || null;
  const asOf = latest?.date || null;
  const facts = latest ? [{
    label: "iFinD 全A最近交易日成交额", value: Number((latest.valueYuan / 1e8).toFixed(2)), unit: "亿元",
    sourceField: `${latest.symbol} 成交金额`, source: "iFinD MCP · 同花顺沪深全A",
    asOf: latest.date, method: "iFinD 日频证券指标返回值；原始字段单位为元。"
  }] : [];
  return {
    id: "liquidity", label: "流动性", status: records.length ? "partial" : "unavailable",
    title: records.length ? "20日基准待与当日成交合并" : "iFinD未返回有效成交额序列",
    summary: records.length
      ? `iFinD 返回 ${records.length} 个有效交易日成交额记录；等待与扶摇当日全市场成交额按同日口径合并。`
      : "iFinD 日频成交额序列为空或格式不可识别；不生成均值或分数。",
    score: null, facts, historyRows: records, source: "iFinD MCP · 同花顺沪深全A",
    asOf, method: `get_security_indicators（日频成交金额），请求区间 ${period.start} 至 ${period.end}；仅接受沪深全A证券实体，至少需要最近 ${REQUIRED_HISTORY_SESSIONS} 个完整有效历史交易日。`
  };
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|api.?key|auth|sign|credential|session|cookie)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function normalizeNewsItems(payload) {
  if (!successfulToolPayload(payload)) return [];
  let rows = payload.data.result ?? payload.data.data;
  if (typeof rows === "string") {
    try { rows = JSON.parse(rows); } catch { return []; }
  }
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 8).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const title = String(item["资讯标题"] || item["标题"] || "").trim().slice(0, 200);
    if (!title) return [];
    return [{
      title,
      source: String(item["信息来源"] || "iFinD 财经资讯").trim().slice(0, 100),
      url: safeSourceUrl(item.URL || item["URL"] || item["资讯链接"]),
      publishedAt: String(item["发布时间"] || item["发布日期"] || item["日期"] || "").trim().slice(0, 80),
      heat: Number.isFinite(Number(item["资讯热度"])) ? Number(item["资讯热度"]) : null
    }];
  });
}

function eventsEvidence(items, retrievedAt, period) {
  const facts = items.map(item => ({
    label: item.title, value: item.title,
    unit: "资讯标题", sourceField: item.publishedAt ? "search_news.资讯标题 / 日期" : "search_news.资讯标题",
    source: `iFinD MCP · ${item.source}`, asOf: retrievedAt,
    ...(item.url ? { url: item.url } : {}),
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    method: `iFinD 财经新闻检索；检索区间 ${period.start} 至 ${period.end}。${item.publishedAt ? `MCP 返回单条日期：${item.publishedAt}；` : "MCP 未返回单条发布时间；"}采集时点为 ${retrievedAt}。`
  }));
  return {
    id: "events", label: "重要事件",
    status: facts.length ? "available" : "unavailable",
    title: facts.length ? "近期政策与市场资讯" : "未检索到可用事件",
    summary: facts.length
      ? `iFinD MCP 返回 ${facts.length} 条相关资讯标题；页面仅展示标题、日期、来源和链接。AI 归纳只基于标题，不展示新闻全文或推断市场影响方向。`
      : "iFinD MCP 未返回可用的政策/新闻片段；这不代表没有重要事件。",
    score: null, facts, source: "iFinD MCP 财经新闻检索", asOf: facts.length ? retrievedAt : null,
    method: `search_news；检索区间 ${period.start} 至 ${period.end}；事件维度不参与方向评分。`
  };
}

async function loadLiquidity(env, now, timeoutMs, authorization) {
  if (!authorization) throw new Error("not_configured");
  const url = env.IFIND_MARKET_MCP_URL || DEFAULT_MARKET_MCP_URL;
  const period = periodFor(now);
  return cachedResource(`liquidity:${url}`, HISTORY_CACHE_MS, async () => {
    const payload = await invokeMcpTool({
      provider: "market", url, authorization, tool: "get_security_indicators",
      timeoutMs,
      arguments: {
        market: "指数",
        query: `同花顺沪深全A ${formatDateCompact(period.start)}-${formatDateCompact(period.end)} 每个交易日成交金额（日频），请按日期逐行返回原始成交金额与证券代码，不要汇总。`
      }
    });
    const records = extractTurnoverRows(payload).filter(record => record.date <= period.end);
    return liquidityEvidence(records, period);
  });
}

async function loadEvents(env, now, timeoutMs, authorization) {
  if (!authorization) throw new Error("not_configured");
  const url = env.IFIND_NEWS_MCP_URL || DEFAULT_NEWS_MCP_URL;
  const period = periodFor(now);
  return cachedResource(`events:${url}`, NEWS_CACHE_MS, async () => {
    const payload = await invokeMcpTool({
      provider: "news", url, authorization, tool: "search_news",
      timeoutMs,
      arguments: {
        query: "近期中国宏观政策、货币财政、金融监管及可能影响A股市场的重要事件；仅返回标题、日期、来源和原始链接，不返回资讯全文。",
        time_start: period.start, time_end: period.end, size: 5
      }
    });
    return eventsEvidence(normalizeNewsItems(payload), new Date(now).toISOString(), period);
  });
}

function unavailableDimension(id, label, reason) {
  return {
    id, label, status: "unavailable", title: "iFinD数据不可用", summary: reason,
    score: null, facts: [], source: "iFinD MCP", asOf: null, method: "未计算"
  };
}

async function settleDimension(id, label, env, load, now, timeoutMs) {
  const key = id === "liquidity" ? "MARKET" : "NEWS";
  const provider = key === "MARKET" ? "market" : "news";
  const url = env[`IFIND_${key}_MCP_URL`] || (provider === "market" ? DEFAULT_MARKET_MCP_URL : DEFAULT_NEWS_MCP_URL);
  const authorization = normalizeAuthorization(env[`IFIND_${key}_AUTHORIZATION`]);
  const configTime = Date.now();
  emitIfindDiagnostic({
    provider, stage: "fetch", operation: "authorization-config", url, startedAt: configTime,
    authorizationPresent: authorization.present, authorizationHeaderAdded: false, authorizationValue: authorization.value,
    extra: {
      authorization_trimmed: authorization.trimmed,
      authorization_outer_whitespace: authorization.outerWhitespace,
      authorization_contains_newline: authorization.containsNewline,
      authorization_quote_wrapped: authorization.quoteWrapped
    }
  });
  if (!authorization.present) {
    return {
      dimension: unavailableDimension(id, label, "对应 iFinD MCP 授权未配置；不使用演示数据补位。"),
      toolCall: { name: id === "liquidity" ? "iFinD MCP · get_security_indicators" : "iFinD MCP · search_news", status: "not_configured", detail: "未配置该服务的运行时授权。" }
    };
  }
  try {
    const dimension = await load(env, now, timeoutMs, authorization.value);
    const available = dimension.facts.length > 0;
    return {
      dimension,
      toolCall: {
        name: id === "liquidity" ? "iFinD MCP · get_security_indicators" : "iFinD MCP · search_news",
        status: available ? "success" : "empty",
        detail: id === "liquidity"
          ? `${dimension.historyRows?.length || 0} 个有效日频记录；历史均值与当日扶摇成交额合并后再评分。`
          : available ? `返回 ${dimension.facts.length} 条资讯标题；不展示新闻全文。` : "没有可展示的真实资讯标题。"
      }
    };
  } catch (error) {
    const timedOut = error.message === "iFinD MCP request timed out";
    return {
      dimension: unavailableDimension(id, label, timedOut ? "iFinD MCP 请求超时；扶摇主链路不受影响。" : "iFinD MCP 请求失败或返回格式不可用；扶摇主链路不受影响。"),
      toolCall: {
        name: id === "liquidity" ? "iFinD MCP · get_security_indicators" : "iFinD MCP · search_news",
        status: "failed", detail: timedOut ? "请求超时，未使用演示数据。" : "调用失败，未使用演示数据。"
      }
    };
  }
}

export async function getIfindEvidence(env = process.env, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : MCP_TIMEOUT_MS;
  const [liquidity, events] = await Promise.all([
    settleDimension("liquidity", "流动性", env, loadLiquidity, now, timeoutMs),
    settleDimension("events", "重要事件", env, loadEvents, now, timeoutMs)
  ]);
  const configured = normalizeAuthorization(env.IFIND_MARKET_AUTHORIZATION).present ||
    normalizeAuthorization(env.IFIND_NEWS_AUTHORIZATION).present;
  return {
    configured,
    dimensions: { liquidity: liquidity.dimension, events: events.dimension },
    toolCalls: [liquidity.toolCall, events.toolCall],
    researchContext: null,
    warning: [liquidity, events].some(item => item.toolCall.status === "failed" || item.toolCall.status === "not_configured")
      ? "iFinD 是可选增强源；未配置或调用失败时保留扶摇主链路，缺失维度不使用演示数据。"
      : null
  };
}

export function clearIfindCache() {
  resourceCache.clear();
}
