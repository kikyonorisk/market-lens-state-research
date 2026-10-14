const DEFAULT_BASE = "https://fuyao.aicubes.cn";
const INDEXES = [
  { code: "000300.SH", name: "沪深 300", key: "hs300" },
  { code: "000852.SH", name: "中证 1000", key: "zz1000" },
  { code: "399006.SZ", name: "创业板指", key: "chinext" }
];
const STOCK_PAGE_SIZE = 100;
const MAX_STOCK_PAGES = 80;
const PAGE_CONCURRENCY = 3;
const MAX_CONCURRENT_REQUESTS = 4;
const REQUEST_RETRIES = 1;
const RETRY_DELAY_MS = 300;
const CACHE_POLICY = Object.freeze({
  indexSnapshot: { ttlMs: 2 * 60_000, maxStaleMs: 15 * 60_000, timeoutMs: 18_000 },
  fullMarket: { ttlMs: 4 * 60_000, maxStaleMs: 20 * 60_000, timeoutMs: 25_000 },
  limitPool: { ttlMs: 4 * 60_000, maxStaleMs: 20 * 60_000, timeoutMs: 25_000 },
  history: { ttlMs: 45 * 60_000, maxStaleMs: 3 * 60 * 60_000, timeoutMs: 30_000 }
});
let activeRequests = 0;
const requestQueue = [];
const resourceCache = new Map();

async function acquireRequestSlot() {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests += 1;
    return;
  }
  await new Promise(resolve => requestQueue.push(resolve));
}

function releaseRequestSlot() {
  const next = requestQueue.shift();
  if (next) next();
  else activeRequests -= 1;
}

function requestError(error, controller, url, timeoutMs) {
  const pathname = new URL(String(url)).pathname;
  const wasAborted = /operation was aborted|\baborted\b/i.test(error?.message || "");
  if (controller.signal.aborted) {
    return Object.assign(new Error(`扶摇请求超时（${pathname}，${Math.round(timeoutMs / 1000)} 秒）`), { retryable: true });
  }
  if (error?.name === "AbortError" || error?.name === "TimeoutError" || wasAborted) {
    return Object.assign(new Error(`扶摇请求中止（${pathname}）`), { retryable: true });
  }
  if (error?.status) {
    const retryable = [408, 425, 429].includes(error.status) || error.status >= 500;
    return Object.assign(new Error(`扶摇请求失败（${pathname}，HTTP ${error.status}）`), { retryable });
  }
  const retryable = error?.retryable ?? (error instanceof TypeError || error instanceof SyntaxError);
  return Object.assign(new Error(error?.message || `扶摇请求失败（${pathname}）`), { retryable });
}

async function fetchJson(url, apiKey, { timeoutMs = 18_000, retries = REQUEST_RETRIES } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await acquireRequestSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { "X-api-key": apiKey, Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      if (payload?.code !== 0) {
        const error = new Error(payload?.message || `业务错误 code=${payload?.code}`);
        error.retryable = false;
        throw error;
      }
      return payload.data;
    } catch (error) {
      lastError = requestError(error, controller, url, timeoutMs);
    } finally {
      clearTimeout(timer);
      releaseRequestSlot();
    }
    if (attempt < retries && lastError.retryable) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    } else {
      break;
    }
  }
  throw lastError;
}

async function loadCachedResource(key, policy, loader) {
  const now = Date.now();
  const cached = resourceCache.get(key);
  if (cached?.data !== undefined && now - cached.fetchedAt <= policy.ttlMs) {
    return { data: cached.data, fetchedAt: cached.fetchedAt, cacheState: "cached" };
  }

  const fallback = error => {
    const latest = resourceCache.get(key);
    if (latest?.data !== undefined && Date.now() - latest.fetchedAt <= policy.maxStaleMs) {
      return {
        data: latest.data,
        fetchedAt: latest.fetchedAt,
        cacheState: "last-known-good",
        fallbackReason: error?.message || "上游刷新失败"
      };
    }
    throw error;
  };

  if (cached?.inFlight) {
    try {
      return await cached.inFlight;
    } catch (error) {
      return fallback(error);
    }
  }

  const request = Promise.resolve().then(loader).then(data => {
    const fetchedAt = Date.now();
    resourceCache.set(key, { data, fetchedAt, inFlight: null });
    return { data, fetchedAt, cacheState: "live" };
  });
  resourceCache.set(key, { data: cached?.data, fetchedAt: cached?.fetchedAt, inFlight: request });
  try {
    return await request;
  } catch (error) {
    return fallback(error);
  } finally {
    const latest = resourceCache.get(key);
    if (latest?.inFlight === request) {
      if (latest.data === undefined) resourceCache.delete(key);
      else resourceCache.set(key, { data: latest.data, fetchedAt: latest.fetchedAt, inFlight: null });
    }
  }
}

export function clearFuyaoDataCache() {
  resourceCache.clear();
}

function unavailableDimension(id, label, reason, source = "未接入数据源") {
  return {
    id, label, status: "unavailable", title: "暂无可用数据", summary: reason,
    score: null, facts: [], source, asOf: null, method: "未计算"
  };
}

function pctReturn(series, sessions = 5) {
  const rows = (series || []).filter(row => Number.isFinite(row.close_price) && row.close_price > 0);
  if (rows.length <= sessions) return null;
  const start = rows[rows.length - sessions - 1].close_price;
  const end = rows.at(-1).close_price;
  return start ? (end / start - 1) * 100 : null;
}

function latestHistoryTime(series) {
  const times = (series || []).map(row => new Date(row.date_ms).getTime()).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function formatSourceTime(value) {
  const timestamp = timestampMs(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "时点缺失";
}

function shanghaiMidnight(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const part = key => parts.find(item => item.type === key)?.value;
  return Date.parse(`${part("year")}-${part("month")}-${part("day")}T00:00:00+08:00`);
}

async function fetchStockSnapshotPage(base, apiKey, offset) {
  const url = new URL(`${base}/api/a-share/prices/snapshot`);
  url.searchParams.set("limit", String(STOCK_PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  return fetchJson(url, apiKey, { timeoutMs: CACHE_POLICY.fullMarket.timeoutMs });
}

async function fetchFullMarketSnapshot(base, apiKey) {
  const first = await fetchStockSnapshotPage(base, apiKey, 0);
  const total = first?.total;
  if (!Number.isInteger(total) || total < 0 || !Array.isArray(first.item)) {
    throw new Error("全市场快照分页字段无效；宽度与成交额不纳入研判。");
  }
  const pages = Math.max(1, Math.ceil(total / STOCK_PAGE_SIZE));
  if (pages > MAX_STOCK_PAGES) throw new Error(`全市场快照共需 ${pages} 页，超过安全上限 ${MAX_STOCK_PAGES} 页。`);
  const responses = [first];
  for (let pageStart = 1; pageStart < pages; pageStart += PAGE_CONCURRENCY) {
    const offsets = Array.from({ length: Math.min(PAGE_CONCURRENCY, pages - pageStart) }, (_, index) => (pageStart + index) * STOCK_PAGE_SIZE);
    const pageResults = await Promise.allSettled(offsets.map(offset => fetchStockSnapshotPage(base, apiKey, offset)));
    const failure = pageResults.find(result => result.status === "rejected");
    if (failure) throw new Error(`全市场快照分页失败：${failure.reason?.message || "未知错误"}`);
    for (const result of pageResults) responses.push(result.value);
  }

  if (responses.some(page => page.total !== total || !Array.isArray(page.item))) {
    throw new Error("全市场快照分页总数不一致；宽度与成交额不纳入研判。");
  }
  const rows = responses.flatMap(page => page.item);
  const codes = rows.map(row => row?.thscode).filter(value => typeof value === "string");
  if (rows.length !== total || codes.length !== total || new Set(codes).size !== total) {
    throw new Error(`全市场快照不完整（返回 ${rows.length} / ${total} 条）；宽度与成交额不纳入研判。`);
  }
  const times = responses.map(page => timestampMs(page.timestamp)).filter(Number.isFinite);
  if (times.length !== responses.length || Math.max(...times) - Math.min(...times) > 5 * 60 * 1000) {
    throw new Error("全市场分页时点缺失或不一致；宽度与成交额不纳入研判。");
  }
  return { rows, total, timestamp: Math.max(...times) };
}

async function fetchPool(base, apiKey, pool, dateMs) {
  const endpoint = pool === "limit-up" ? "limit-up-pool" : "limit-down-pool";
  const firstUrl = new URL(`${base}/api/a-share/special-data/${endpoint}`);
  firstUrl.searchParams.set("date_ms", String(dateMs));
  firstUrl.searchParams.set("page", "1");
  firstUrl.searchParams.set("size", "200");
  const first = await fetchJson(firstUrl, apiKey, { timeoutMs: CACHE_POLICY.limitPool.timeoutMs });
  const pagination = first?.pagination;
  if (!Number.isInteger(pagination?.total) || !Number.isInteger(pagination?.pages) || !Array.isArray(first.item)) {
    throw new Error(`${pool}池分页字段无效。`);
  }
  if (pagination.pages < 1 || pagination.pages > 10) throw new Error(`${pool}池分页数超出安全范围。`);
  const responses = [first];
  for (let page = 2; page <= pagination.pages; page++) {
    const url = new URL(`${base}/api/a-share/special-data/${endpoint}`);
    url.searchParams.set("date_ms", String(dateMs));
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", "200");
    responses.push(await fetchJson(url, apiKey, { timeoutMs: CACHE_POLICY.limitPool.timeoutMs }));
  }
  const rows = responses.flatMap(response => response.item || []);
  if (responses.some(response => response.pagination?.total !== pagination.total) || rows.length !== pagination.total) {
    throw new Error(`${pool}池分页数据不完整。`);
  }
  const times = responses.map(response => timestampMs(response.timestamp)).filter(Number.isFinite);
  if (!times.length || Math.max(...times) > Date.now() + 5 * 60 * 1000) throw new Error(`${pool}池时点无效。`);
  return { count: pagination.total, timestamp: Math.min(...times) };
}

function deriveFullMarketDimensions(snapshot) {
  const { rows, total, timestamp } = snapshot;
  const asOf = new Date(timestamp).toISOString();
  const stale = Date.now() - timestamp > 36 * 60 * 60 * 1000;
  const quoted = rows.filter(row => Number.isFinite(row?.price_change_ratio_pct));
  const advancing = quoted.filter(row => row.price_change_ratio_pct > 0).length;
  const declining = quoted.filter(row => row.price_change_ratio_pct < 0).length;
  const unchanged = quoted.length - advancing - declining;
  const quoteCoverage = total ? quoted.length / total : 0;
  let breadth = unavailableDimension("breadth", "市场宽度",
    stale ? "全市场快照已超过 36 小时，保留来源信息但不纳入评分。" : `全市场快照涨跌字段覆盖 ${(quoteCoverage * 100).toFixed(1)}%；覆盖不足 95% 时不计算宽度。`,
    "扶摇 A 股全市场行情快照");
  if (!stale && quoteCoverage >= 0.95 && advancing + declining > 0) {
    const upRatio = advancing / (advancing + declining) * 100;
    const score = upRatio >= 60 ? 2 : upRatio >= 50 ? 1 : upRatio >= 40 ? 0 : upRatio >= 30 ? -1 : -2;
    breadth = {
      id: "breadth", label: "市场宽度", status: score > 0 ? "positive" : score < 0 ? "negative" : "neutral",
      title: upRatio < 40 ? "上涨覆盖面偏窄" : upRatio >= 60 ? "上涨覆盖面较广" : "上涨覆盖面中性",
      summary: `全市场快照中上涨 ${advancing} 家、下跌 ${declining} 家、平盘 ${unchanged} 家；有涨跌幅记录的覆盖率 ${(quoteCoverage * 100).toFixed(1)}%。`,
      score, facts: [
        { label: "上涨家数", value: advancing, unit: "家", sourceField: "advancing_count", source: "扶摇 A 股全市场行情快照", asOf },
        { label: "下跌家数", value: declining, unit: "家", sourceField: "declining_count", source: "扶摇 A 股全市场行情快照", asOf },
        { label: "平盘家数", value: unchanged, unit: "家", sourceField: "unchanged_count", source: "扶摇 A 股全市场行情快照", asOf },
        { label: "涨跌幅字段覆盖", value: Number((quoteCoverage * 100).toFixed(2)), unit: "%", sourceField: "quoted_count / total", source: "扶摇 A 股全市场行情快照", asOf },
        { label: "上涨占比", value: Number(upRatio.toFixed(2)), unit: "%", sourceField: "advancing_count / (advancing_count + declining_count)", source: "Market Lens 计算", asOf, method: "上涨家数 ÷（上涨家数 + 下跌家数）× 100%；平盘与缺少涨跌幅的证券不进入分母。" }
      ], source: "扶摇 A 股全市场行情快照", asOf,
      method: "仅在全市场证券代码分页完整且涨跌幅覆盖率至少 95% 时计分；≥60%:+2，50–60%:+1，40–50%:0，30–40%:-1，<30%:-2。"
    };
  }

  const turnoverRows = rows.filter(row => Number.isFinite(row?.turnover) && row.turnover >= 0);
  const turnoverCoverage = total ? turnoverRows.length / total : 0;
  const marketTurnover = turnoverRows.reduce((sum, row) => sum + row.turnover, 0) / 100_000_000;
  const liquidity = unavailableDimension("liquidity", "流动性",
    stale ? "全市场成交额快照已超过 36 小时，不纳入研判。" : "已取得当日全市场成交额；缺少同口径 20 日均值，因此不计算流动性分数。",
    "扶摇 A 股全市场行情快照");
  if (!stale && total > 0 && turnoverCoverage >= 0.95) {
    liquidity.status = "partial";
    liquidity.title = "当日成交可用，均值待补";
    liquidity.summary = `全市场当日成交额合计 ${marketTurnover.toFixed(2)} 亿元（字段覆盖 ${(turnoverCoverage * 100).toFixed(1)}%）；缺少同口径 20 日均值，不计算流动性分数。`;
    liquidity.facts = [{ label: "全市场成交额", value: Number(marketTurnover.toFixed(2)), unit: "亿元", sourceField: "turnover（全 A 股逐证券求和）", source: "扶摇 A 股全市场行情快照", asOf }];
    liquidity.asOf = asOf;
    liquidity.method = "全市场证券分页完整后，对原始成交额（元）求和并换算为亿元；20 日均值未取得，故 score=null。";
  }
  return { breadth, liquidity };
}

function deriveSentimentDimension(upPool, downPool) {
  const asOf = new Date(Math.min(upPool.timestamp, downPool.timestamp)).toISOString();
  const limitUp = upPool.count, limitDown = downPool.count;
  const score = limitUp > limitDown * 2 ? 1 : limitDown > limitUp ? -1 : 0;
  const ratio = limitDown > 0 ? Number((limitUp / limitDown).toFixed(2)) : null;
  const facts = [
    { label: "涨停家数", value: limitUp, unit: "家", sourceField: "limit_up_count", source: "扶摇涨停股票池", asOf },
    { label: "跌停家数", value: limitDown, unit: "家", sourceField: "limit_down_count", source: "扶摇跌停股票池", asOf }
  ];
  if (ratio !== null) facts.push({ label: "涨停 / 跌停", value: ratio, unit: "倍", sourceField: "limit_up_count / limit_down_count", source: "Market Lens 计算", asOf });
  return {
    id: "sentiment", label: "市场情绪", status: score > 0 ? "positive" : score < 0 ? "negative" : "neutral",
    title: score > 0 ? "涨停家数占优" : score < 0 ? "跌停家数占优" : "涨跌停结构中性",
    summary: `扶摇涨停池 ${limitUp} 家，跌停池 ${limitDown} 家；按交易日股票池计数，不等同于完整投资者情绪。`,
    score, facts, source: "扶摇涨停 / 跌停股票池", asOf,
    method: "按来源分页 total 计数；涨停数 > 跌停数 2 倍:+1，跌停数 > 涨停数:-1，其他:0。"
  };
}

export async function getFuyaoMarket(env = process.env) {
  const apiKey = env.FUYAO_API_KEY;
  const base = (env.FUYAO_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
  const dimensions = {
    structure: unavailableDimension("structure", "行情结构", "指数数据获取失败。"),
    breadth: unavailableDimension("breadth", "市场宽度", "全市场分页快照尚未成功取得。"),
    style: unavailableDimension("style", "风格轮动", "指数历史数据获取失败。"),
    liquidity: unavailableDimension("liquidity", "流动性", "全市场分页快照尚未成功取得；不会用指数成交额代替。"),
    sentiment: unavailableDimension("sentiment", "市场情绪", "扶摇涨停 / 跌停股票池尚未成功取得。"),
    valuation: unavailableDimension("valuation", "估值观察", "未配置估值指标。"),
    events: unavailableDimension("events", "重要事件", "本次 MVP 未启用授权事件数据源；不使用演示内容补位。", "事件数据源未启用")
  };

  if (!apiKey) {
    return {
      mode: "fuyao", demo: false, providerStatus: "not_configured",
      providerMessage: "扶摇 API Key 未配置。真实数据模式不会显示演示样本。",
      asOf: null, dimensions, indexes: [],
      chartSeries: [], warnings: ["设置 FUYAO_API_KEY 后可获取指数快照与历史日线。"]
    };
  }

  const snapshotUrl = new URL(`${base}/api/a-share-index/prices/snapshot`);
  snapshotUrl.searchParams.set("thscodes", INDEXES.map(item => item.code).join(","));
  const end = Date.now();
  const start = end - 45 * 24 * 60 * 60 * 1000;
  const historyTasks = INDEXES.map(async item => {
    const url = new URL(`${base}/api/a-share-index/prices/historical`);
    url.searchParams.set("thscode", item.code);
    url.searchParams.set("interval", "1d");
    url.searchParams.set("start", String(start));
    url.searchParams.set("end", String(end));
    const cached = await loadCachedResource(`history:${base}:${item.code}`, CACHE_POLICY.history,
      () => fetchJson(url, apiKey, { timeoutMs: CACHE_POLICY.history.timeoutMs }));
    return { ...item, ...cached };
  });

  const [snapshotResult, historyResults, marketSnapshotResult] = await Promise.allSettled([
    loadCachedResource(`indexSnapshot:${base}`, CACHE_POLICY.indexSnapshot,
      () => fetchJson(snapshotUrl, apiKey, { timeoutMs: CACHE_POLICY.indexSnapshot.timeoutMs })),
    Promise.allSettled(historyTasks),
    loadCachedResource(`fullMarket:${base}`, CACHE_POLICY.fullMarket, () => fetchFullMarketSnapshot(base, apiKey))
  ]);
  const warnings = [];
  let snapshots = [];
  let snapshotTime = null;
  let usedLastKnownGood = false;
  if (snapshotResult.status === "fulfilled") {
    snapshots = snapshotResult.value.data?.item || [];
    snapshotTime = snapshotResult.value.data?.timestamp || null;
    if (snapshotResult.value.cacheState === "last-known-good") {
      usedLastKnownGood = true;
      warnings.push(`扶摇指数快照刷新失败（${snapshotResult.value.fallbackReason}），使用最近有效快照；来源实际时点 ${formatSourceTime(snapshotTime)}。`);
    }
  } else {
    warnings.push(`扶摇指数快照失败：${snapshotResult.reason?.message || "未知错误"}`);
  }

  let marketSnapshot = null;
  if (marketSnapshotResult.status === "fulfilled") {
    marketSnapshot = marketSnapshotResult.value.data;
    Object.assign(dimensions, deriveFullMarketDimensions(marketSnapshot));
    if (marketSnapshotResult.value.cacheState === "last-known-good") {
      usedLastKnownGood = true;
      const sourceAsOf = new Date(marketSnapshot.timestamp).toISOString();
      for (const key of ["breadth", "liquidity"]) {
        if (dimensions[key].asOf) dimensions[key].summary += ` 最近有效快照；来源实际时点 ${sourceAsOf}。`;
      }
      warnings.push(`扶摇全市场分页快照刷新失败（${marketSnapshotResult.value.fallbackReason}），使用最近有效快照；来源实际时点 ${sourceAsOf}。`);
    }
    if (dimensions.breadth.status === "unavailable") warnings.push("扶摇全市场行情快照的覆盖率或时点不足，市场宽度已标为 unavailable。");
    if (dimensions.liquidity.facts.length === 0) warnings.push("扶摇全市场成交额字段覆盖不足或快照已过期，流动性已标为 unavailable。");
  } else {
    warnings.push(`扶摇全市场行情快照失败：${marketSnapshotResult.reason?.message || "未知错误"}`);
  }

  const historyByCode = new Map();
  const historySettled = historyResults.status === "fulfilled" ? historyResults.value : [];
  historySettled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      historyByCode.set(result.value.code, { ...result.value.data, cacheState: result.value.cacheState });
      if (result.value.cacheState === "last-known-good") {
        usedLastKnownGood = true;
        const sourceTime = latestHistoryTime(result.value.data?.item);
        const sourceAsOf = Number.isFinite(sourceTime) ? new Date(sourceTime).toISOString() : "时点缺失";
        warnings.push(`扶摇${INDEXES[index].name}历史日线刷新失败（${result.value.fallbackReason}），使用最近有效快照；来源实际时点 ${sourceAsOf}。`);
      }
    }
    else warnings.push(`${INDEXES[index].name}历史日线失败：${result.reason?.message || "未知错误"}`);
  });

  const poolTimestamp = marketSnapshot?.timestamp || timestampMs(snapshotTime) || Date.now();
  const poolDateMs = shanghaiMidnight(poolTimestamp);
  const [limitUpResult, limitDownResult] = await Promise.allSettled([
    loadCachedResource(`limitPool:${base}:limit-up:${poolDateMs}`, CACHE_POLICY.limitPool,
      () => fetchPool(base, apiKey, "limit-up", poolDateMs)),
    loadCachedResource(`limitPool:${base}:limit-down:${poolDateMs}`, CACHE_POLICY.limitPool,
      () => fetchPool(base, apiKey, "limit-down", poolDateMs))
  ]);
  for (const [label, result] of [["涨停股票池", limitUpResult], ["跌停股票池", limitDownResult]]) {
    if (result.status === "fulfilled" && result.value.cacheState === "last-known-good") {
      usedLastKnownGood = true;
      const sourceAsOf = Number.isFinite(result.value.data?.timestamp)
        ? new Date(result.value.data.timestamp).toISOString() : "时点缺失";
      warnings.push(`扶摇${label}刷新失败（${result.value.fallbackReason}），使用最近有效快照；来源实际时点 ${sourceAsOf}。`);
    }
  }
  if (limitUpResult.status === "fulfilled" && limitDownResult.status === "fulfilled") {
    const upPool = limitUpResult.value.data;
    const downPool = limitDownResult.value.data;
    const upAge = Date.now() - upPool.timestamp;
    const downAge = Date.now() - downPool.timestamp;
    if (Math.max(upAge, downAge) > 36 * 60 * 60 * 1000) {
      dimensions.sentiment = unavailableDimension("sentiment", "市场情绪", "涨跌停股票池超过 36 小时，保留原始来源但不纳入评分。", "扶摇涨停 / 跌停股票池");
      dimensions.sentiment.status = "stale";
      warnings.push("扶摇涨跌停股票池数据已过期，市场情绪已排除在状态计算外。");
    } else if (Math.min(upAge, downAge) < -5 * 60 * 1000) {
      dimensions.sentiment = unavailableDimension("sentiment", "市场情绪", "涨跌停股票池时点晚于当前时间超过 5 分钟。", "扶摇涨停 / 跌停股票池");
      dimensions.sentiment.status = "invalid_time";
      warnings.push("扶摇涨跌停股票池时点异常，市场情绪已排除在状态计算外。");
    } else {
      dimensions.sentiment = deriveSentimentDimension(upPool, downPool);
      if (limitUpResult.value.cacheState === "last-known-good" || limitDownResult.value.cacheState === "last-known-good") {
        const upAsOf = new Date(upPool.timestamp).toISOString();
        const downAsOf = new Date(downPool.timestamp).toISOString();
        dimensions.sentiment.summary += ` 最近有效快照；涨停池实际时点 ${upAsOf}，跌停池实际时点 ${downAsOf}。`;
      }
    }
  } else {
    const poolError = [limitUpResult, limitDownResult].find(result => result.status === "rejected");
    warnings.push(`扶摇涨跌停股票池失败：${poolError?.reason?.message || "未知错误"}`);
  }

  const snapshotMs = snapshotTime ? new Date(snapshotTime).getTime() : NaN;
  const snapshotIso = Number.isFinite(snapshotMs) ? new Date(snapshotMs).toISOString() : null;
  const snapshotStatus = !snapshotIso ? "unavailable"
    : snapshotMs > Date.now() + 5 * 60 * 1000 ? "invalid_time"
      : Date.now() - snapshotMs > 36 * 60 * 60 * 1000 ? "stale" : "current";

  const indexes = INDEXES.map(index => {
    const quote = snapshots.find(item => item.thscode === index.code) || {};
    const history = historyByCode.get(index.code)?.item || [];
    const series = history.filter(row => Number.isFinite(new Date(row.date_ms).getTime()) &&
      Number.isFinite(row.close_price) && row.close_price > 0);
    const last = Number.isFinite(quote.last_price) && quote.last_price > 0 ? quote.last_price : null;
    return {
      code: index.code, name: index.name,
      last,
      changePct: last !== null && Number.isFinite(quote.price_change_ratio_pct) ? quote.price_change_ratio_pct : null,
      return5dPct: pctReturn(history),
      turnover: Number.isFinite(quote.turnover) && quote.turnover >= 0 ? quote.turnover : null,
      asOf: snapshotIso, quoteStatus: snapshotStatus,
      historyAsOf: Number.isFinite(latestHistoryTime(history)) ? new Date(latestHistoryTime(history)).toISOString() : null,
      series: series.slice(-30).map(row => ({
        date: new Date(row.date_ms).toISOString().slice(0, 10),
        close: row.close_price
      }))
    };
  });

  const withQuote = indexes.filter(item => item.changePct !== null);
  if (withQuote.length) {
    const avgChange = withQuote.reduce((sum, item) => sum + item.changePct, 0) / withQuote.length;
    const greenCount = withQuote.filter(item => item.changePct > 0).length;
    const unavailableTime = snapshotStatus === "unavailable";
    const invalidTime = snapshotStatus === "invalid_time";
    const stale = snapshotStatus === "stale";
    const quoteUsedFallback = snapshotResult.status === "fulfilled" && snapshotResult.value.cacheState === "last-known-good";
    dimensions.structure = {
      id: "structure", label: "行情结构", status: unavailableTime ? "unavailable" : invalidTime ? "invalid_time" : stale ? "stale" : greenCount === withQuote.length ? "positive" : greenCount === 0 ? "negative" : "mixed",
      title: unavailableTime ? "缺少有效数据时点" : invalidTime ? "数据时点异常" : stale ? "最近快照已过期" : greenCount === withQuote.length ? "指数同步走强" : greenCount === 0 ? "指数同步走弱" : "指数表现分化",
      summary: unavailableTime ? "快照缺少可解析的来源时点，保留返回字段但不纳入整体研判。" : invalidTime ? "快照时点晚于当前时间超过 5 分钟，保留来源记录但不纳入整体研判。" : stale ? "快照距今超过 36 小时，保留原始值供查看，不纳入整体研判。" : "三类代表指数平均涨跌 " + (avgChange >= 0 ? "+" : "") + avgChange.toFixed(2) + "%。这是指数截面，不代表全市场宽度。",
      score: snapshotStatus !== "current" ? null : avgChange > 0.3 ? 1 : avgChange < -0.3 ? -1 : 0,
      facts: withQuote.map(item => ({ label: `${item.name}涨跌幅`, value: item.changePct, unit: "%", sourceField: "price_change_ratio_pct", source: "扶摇指数行情快照", asOf: item.asOf })),
      source: "扶摇指数行情快照", asOf: snapshotIso,
      method: "三类指数当日涨跌幅并列观察；不推算个股上涨占比。"
    };
    if (quoteUsedFallback) dimensions.structure.summary += ` 最近有效快照；来源实际时点 ${formatSourceTime(snapshotIso)}。`;
    if (unavailableTime) warnings.push("指数快照缺少有效时间戳，已保留字段但排除在状态计算外。");
    else if (invalidTime) warnings.push("指数快照时点在未来，已标记异常并排除在状态计算外。");
    else if (stale) warnings.push("指数快照距今超过 36 小时，已标为过期并排除在状态计算外。");
  }

  const hs300 = indexes.find(item => item.code === "000300.SH");
  const small = indexes.find(item => item.code === "000852.SH");
  if (hs300?.return5dPct !== null && small?.return5dPct !== null) {
    const relative = small.return5dPct - hs300.return5dPct;
    const hs300HistoryMs = latestHistoryTime(historyByCode.get("000300.SH")?.item);
    const smallHistoryMs = latestHistoryTime(historyByCode.get("000852.SH")?.item);
    const historyTimeMissing = !Number.isFinite(hs300HistoryMs) || !Number.isFinite(smallHistoryMs);
    const historyTimeFuture = !historyTimeMissing && Math.max(hs300HistoryMs, smallHistoryMs) > Date.now() + 5 * 60 * 1000;
    const historyStale = !historyTimeMissing && (Date.now() - hs300HistoryMs > 7 * 24 * 60 * 60 * 1000 || Date.now() - smallHistoryMs > 7 * 24 * 60 * 60 * 1000);
    const historyOutOfSync = !historyTimeMissing && Math.abs(hs300HistoryMs - smallHistoryMs) > 36 * 60 * 60 * 1000;
    const styleStatus = historyTimeMissing ? "unavailable" : historyTimeFuture ? "invalid_time" : historyStale ? "stale" : historyOutOfSync ? "unavailable" : "current";
    const styleAsOf = historyTimeMissing ? null : new Date(Math.min(hs300HistoryMs, smallHistoryMs)).toISOString();
    const styleInvalid = styleStatus !== "current";
    dimensions.style = {
      id: "style", label: "风格轮动", status: styleInvalid ? styleStatus : relative > 0.5 ? "positive" : relative < -0.5 ? "negative" : "neutral",
      title: historyTimeMissing ? "缺少有效历史时点" : historyTimeFuture ? "历史数据时点异常" : historyStale ? "历史序列已过期" : historyOutOfSync ? "指数历史时点不同步" : relative > 0.5 ? "小盘相对占优" : relative < -0.5 ? "大盘相对占优" : "大小盘差异有限",
      summary: historyTimeMissing ? "缺少可解析的日线时点，风格差异不纳入整体研判。" : historyTimeFuture ? "历史日线时点晚于当前时间超过 5 分钟，已排除评分。" : historyStale ? "历史日线最近数据超过 7 天，保留原始序列供查看，不纳入整体研判。" : historyOutOfSync ? "沪深 300 与中证 1000 的最近日线时点相差超过 36 小时，不做跨指数比较。" : "近 5 个交易日中证 1000 相对沪深 300 " + (relative >= 0 ? "+" : "") + relative.toFixed(2) + " 个百分点。",
      score: styleInvalid ? null : relative > 0.5 ? 1 : relative < -0.5 ? -1 : 0,
      facts: [
        { label: "沪深 300 近 5 日", value: hs300.return5dPct, unit: "%", sourceField: "close_price", source: "扶摇指数历史日线", asOf: hs300.historyAsOf },
        { label: "中证 1000 近 5 日", value: small.return5dPct, unit: "%", sourceField: "close_price", source: "扶摇指数历史日线", asOf: small.historyAsOf },
        { label: "相对强弱", value: relative, unit: "百分点", sourceField: "计算值", source: "Market Lens 计算", asOf: styleAsOf }
      ],
      source: "扶摇指数历史日线", asOf: styleAsOf,
      method: "各自最近 5 个交易日收盘价收益率相减；未做风险调整。"
    };
    const historyUsedFallback = ["000300.SH", "000852.SH"].some(code => historyByCode.get(code)?.cacheState === "last-known-good");
    if (historyUsedFallback) {
      dimensions.style.summary += ` 最近有效快照；沪深 300 实际时点 ${formatSourceTime(hs300.historyAsOf)}，中证 1000 实际时点 ${formatSourceTime(small.historyAsOf)}。`;
    }
    if (historyTimeMissing) warnings.push("指数历史日线缺少有效时点，风格指标已排除在状态计算外。");
    else if (historyTimeFuture) warnings.push("指数历史日线时点在未来，风格指标已排除在状态计算外。");
    else if (historyStale) warnings.push("指数历史日线超过 7 天，风格指标已标为过期并排除在状态计算外。");
    else if (historyOutOfSync) warnings.push("两类指数的历史时点不同步，风格指标已排除在状态计算外。");
  }

  const hasIndexValues = indexes.some(item => item.last !== null);
  const hasCurrentIndexes = indexes.some(item => item.last !== null && item.quoteStatus === "current");
  const providerMessage = hasCurrentIndexes
    ? "扶摇指数与可授权的全市场行情链路已尝试接入；未取得或不完整的维度会明确标为 unavailable。"
    : hasIndexValues
      ? "已收到指数原始值，但快照时点异常或过期，未作为当前行情展示。"
      : "扶摇数据暂不可用。";
  return {
    mode: "fuyao", demo: false, providerStatus: hasIndexValues ? "partial" : "failed",
    providerMessage, usedLastKnownGood,
    asOf: snapshotStatus === "invalid_time" || snapshotStatus === "unavailable" ? null : snapshotIso,
    dimensions, indexes, chartSeries: hs300?.series || [], warnings,
    rawTrace: {
      provider: "扶摇 REST API", endpoints: [
        "/api/a-share-index/prices/snapshot",
        "/api/a-share-index/prices/historical",
        "/api/a-share/prices/snapshot?limit=100&offset=…",
        "/api/a-share/special-data/limit-up-pool",
        "/api/a-share/special-data/limit-down-pool"
      ], indexCodes: INDEXES.map(item => item.code)
    }
  };
}
