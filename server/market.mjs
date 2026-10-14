import { getFuyaoMarket } from "./providers/fuyao.mjs";
import { getIfindEvidence } from "./providers/ifind.mjs";

const now = () => new Date().toISOString();

function fact(label, value, unit, sourceField, method, source = "构造演示样本") {
  return { label, value, unit, sourceField, method, source, asOf: now(), kind: "fact" };
}

function demoDimension(id, label, status, title, summary, score, facts, method) {
  return { id, label, status, title, summary, score, facts, method, source: "构造演示样本", asOf: now() };
}

export function makeDemoMarket() {
  const indexes = [
    { code: "000300.SH", name: "沪深 300", last: 3921.48, changePct: 0.24, return5dPct: -0.38, turnover: 346000000000, series: [3898, 3912, 3886, 3907, 3899, 3912, 3887, 3921] },
    { code: "000852.SH", name: "中证 1000", last: 6214.75, changePct: -1.16, return5dPct: -2.08, turnover: 302000000000, series: [6388, 6351, 6329, 6290, 6344, 6288, 6267, 6215] },
    { code: "399006.SZ", name: "创业板指", last: 2386.22, changePct: 0.48, return5dPct: 0.64, turnover: 188000000000, series: [2340, 2368, 2351, 2370, 2359, 2391, 2375, 2386] }
  ];
  const dimensions = {
    structure: demoDimension("structure", "行情结构", "mixed", "指数内部出现分化", "沪深 300 与创业板指微涨，中证 1000 下跌，指数表面平稳但内部表现不一。", 0, [
      fact("沪深 300 涨跌幅", 0.24, "%", "price_change_ratio_pct", "指数当日涨跌幅"),
      fact("中证 1000 涨跌幅", -1.16, "%", "price_change_ratio_pct", "指数当日涨跌幅"),
      fact("创业板指涨跌幅", 0.48, "%", "price_change_ratio_pct", "指数当日涨跌幅")
    ], "三类代表指数当日涨跌幅并列观察。"),
    breadth: demoDimension("breadth", "市场宽度", "negative", "上涨覆盖面偏窄", "上涨股票占比约 36%，下跌家数明显多于上涨家数。", -1, [
      fact("上涨家数", 1870, "家", "advancing_count", "当日上涨股票计数"),
      fact("下跌家数", 3346, "家", "declining_count", "当日下跌股票计数"),
      fact("上涨占比", 35.84, "%", "advancing_count / (advancing_count + declining_count)", "上涨家数 ÷ (上涨家数 + 下跌家数) × 100%")
    ], "上涨占比低于 40% 记为偏弱；停牌/平盘处理口径需与数据源保持一致。"),
    style: demoDimension("style", "风格轮动", "negative", "大盘相对占优", "近 5 个交易日中证 1000 相对沪深 300 落后约 1.70 个百分点。", -1, [
      fact("沪深 300 近 5 日收益", -0.38, "%", "close_price", "第五个交易日前收盘至最新收盘收益率"),
      fact("中证 1000 近 5 日收益", -2.08, "%", "close_price", "第五个交易日前收盘至最新收盘收益率"),
      fact("中证 1000 相对收益", -1.70, "百分点", "计算值", "中证 1000 收益率 − 沪深 300 收益率")
    ], "相对收益低于 -0.5 个百分点时标记大盘相对占优。"),
    liquidity: demoDimension("liquidity", "流动性", "neutral", "成交略低于 20 日均值", "全市场成交额约为 20 日均值的 0.85 倍，处于规则设定的常态区间。", 0, [
      fact("全市场成交额", 12400, "亿元", "market_turnover", "全 A 股成交额合计"),
      fact("20 日平均成交额", 14600, "亿元", "20d_average_turnover", "最近 20 个交易日全 A 股成交额均值"),
      fact("成交额 / 20 日均值", 0.85, "倍", "market_turnover / 20d_average_turnover", "当日成交额 ÷ 20 日平均成交额")
    ], "比值低于 0.8 记为流动性偏弱，0.8–1.2 视作常态区间。"),
    sentiment: demoDimension("sentiment", "市场情绪", "neutral", "涨跌停结构中性", "涨停 38 家、跌停 21 家，尚未形成明显的极端情绪信号。", 0, [
      fact("涨停家数", 38, "家", "limit_up_count", "当日触及涨停股票数"),
      fact("跌停家数", 21, "家", "limit_down_count", "当日触及跌停股票数"),
      fact("涨停 / 跌停", 1.81, "倍", "limit_up_count / limit_down_count", "涨停家数 ÷ 跌停家数")
    ], "涨跌停计数作为情绪代理变量，不等同于完整投资者情绪。"),
    valuation: demoDimension("valuation", "估值观察", "neutral", "估值分位处于中段", "宽基指数估值分位仅用于背景观察，不参与当前状态打分。", null, [
      fact("宽基估值分位示意", 42, "%", "valuation_percentile", "演示构造值；需指定估值指数及历史窗口")
    ], "演示字段，不进入市场状态评分；真实接入后须记录指数、估值口径和历史区间。"),
    events: demoDimension("events", "重要事件", "unavailable", "等待接入事件源", "本演示没有载入或核验任何实时政策与新闻，不推断“无重要事件”。", null, [], "真实扶摇模式仅在可选 iFinD MCP 返回资讯后展示事件 evidence、日期或检索时点和来源链接。")
  };
  return {
    mode: "demo", demo: true, providerStatus: "demo",
    providerMessage: "构造演示样本，不是实时行情，不用于投资判断。",
    toolCalls: [{ name: "构造演示数据集", status: "demo", detail: "本模式不请求外部市场数据。" }],
    asOf: now(), indexes,
    chartSeries: indexes[0].series.map((close, index) => ({ date: `演示 T-${indexes[0].series.length - index - 1}`, close })),
    dimensions,
    researchContext: {
      industries: [
        { name: "半导体", changePct: 1.42, status: "演示构造值" },
        { name: "券商", changePct: 0.36, status: "演示构造值" },
        { name: "消费", changePct: -0.82, status: "演示构造值" }
      ],
      historicalStates: [
        { period: "T-4", state: "震荡分化", note: "宽度回升、成交仍低于均值" },
        { period: "T-3", state: "震荡分化", note: "小盘风格相对走弱" },
        { period: "T-2", state: "风险偏好收缩", note: "下跌家数增加" },
        { period: "T-1", state: "震荡分化", note: "宽基指数企稳，内部宽度偏弱" }
      ]
    },
    rawTrace: { provider: "构造演示样本", endpoint: "无外部数据调用", sampleId: "market-lens-demo-v1" },
    warnings: ["页面中的市场数值均为构造演示样本；切换扶摇模式后，缺失数据会明确显示，不会回退到这些样本。"]
  };
}

const CORE = ["structure", "breadth", "style", "liquidity", "sentiment"];
export const MIN_CORE_DIMENSIONS = 3;
const LIQUIDITY_CROSS_SOURCE_TOLERANCE = 0.05;

export function hasSufficientMarketEvidence(market) {
  const available = CORE.filter(key => {
    const item = market?.dimensions?.[key];
    return Number.isFinite(item?.score) && !["unavailable", "stale", "conflict", "invalid_time"].includes(item.status);
  });
  const breadth = market?.dimensions?.breadth;
  const breadthValue = breadth?.facts?.find(item => item.label === "上涨占比")?.value;
  return available.length >= MIN_CORE_DIMENSIONS && Number.isFinite(breadth?.score) && Number.isFinite(breadthValue);
}

export function assessMarket(market) {
  const available = CORE.map(key => market.dimensions[key]).filter(item => Number.isFinite(item.score) && !["unavailable", "stale", "conflict", "invalid_time"].includes(item.status));
  const breadth = market.dimensions.breadth;
  const breadthValue = breadth.facts.find(item => item.label === "上涨占比")?.value;
  if (!hasSufficientMarketEvidence(market)) {
    return {
      state: "证据不足", confidence: null,
      rationale: "证据不足，暂不形成市场状态判断",
      majorTension: "证据不足，暂不形成市场状态判断",
      switchConditions: [],
      availableCore: available.length, requiredCore: MIN_CORE_DIMENSIONS
    };
  }
  const score = available.reduce((sum, item) => sum + item.score, 0) / available.length;
  const positive = available.filter(item => item.score > 0).length;
  const negative = available.filter(item => item.score < 0).length;
  const agreement = Math.max(positive, negative) / available.length;
  const coverage = available.length / CORE.length;
  const confidence = Math.min(90, Math.round(45 + coverage * 25 + agreement * 20));
  const indexAvg = market.indexes.filter(item => Number.isFinite(item.changePct));
  const averageIndexChange = indexAvg.length ? indexAvg.reduce((sum, item) => sum + item.changePct, 0) / indexAvg.length : 0;
  let state = "震荡分化";
  if (score >= 0.55 && breadthValue >= 50) state = "风险偏好修复";
  else if (score <= -0.7) state = "风险偏好收缩";
  const majorTension = indexAvg.length > 0 && breadthValue < 45 && averageIndexChange > -0.25
    ? "指数表面稳定，但上涨覆盖面偏窄；少数指数强势掩盖了多数股票走弱。"
    : negative > positive
      ? "偏弱信号多于偏强信号，成交与风格表现仍需和市场宽度一起观察。"
      : positive > negative
        ? "偏强信号占优，但需要观察市场宽度和成交能否同步确认。"
        : "多维信号暂未形成一致方向，当前结论应视为阶段性描述。";
  const switchConditions = state === "震荡分化"
    ? ["若上涨占比连续 3 个交易日高于 55%，且成交额恢复至 20 日均值以上，可重新评估为风险偏好修复。", "若上涨占比低于 30%，同时成交额低于 20 日均值的 0.7 倍、跌停家数明显增加，应重新评估风险收缩。"]
    : state === "风险偏好修复"
      ? ["若上涨占比回落至 40% 以下且成交额连续低于 20 日均值，修复判断需要重新评估。", "若中小盘相对强度转负并持续 3 个交易日，检查风格扩散是否中断。"]
      : ["若上涨占比回到 45% 以上，且成交额恢复至 20 日均值附近，风险收缩判断需要重新评估。", "若主要宽基指数同步转强并持续 3 个交易日，观察风险偏好是否修复。"];
  return {
    state, confidence,
    rationale: `可用核心维度 ${available.length}/5；方向分数均值 ${score.toFixed(2)}（区间 -2 至 +2）。`,
    majorTension, switchConditions, availableCore: available.length, requiredCore: MIN_CORE_DIMENSIONS
  };
}

function marketDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(value));
  const part = key => parts.find(item => item.type === key)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function afterMarketClose(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value));
  const hour = Number(parts.find(item => item.type === "hour")?.value);
  const minute = Number(parts.find(item => item.type === "minute")?.value);
  return hour * 60 + minute >= 15 * 60;
}

function mergeIfindLiquidity(base = {}, supplemental = {}) {
  if (!supplemental || !Array.isArray(supplemental.historyRows)) return base;
  const rows = supplemental.historyRows;
  const facts = [...(base.facts || [])];
  const current = facts.find(item => item.sourceField === "turnover（全 A 股逐证券求和）" || item.label === "全市场成交额");
  const currentValue = Number(current?.value);
  const currentAsOf = current?.asOf || base.asOf || null;
  const currentDate = marketDate(currentAsOf);
  const comparisonRows = currentDate ? rows.filter(item => item.date < currentDate) : [];
  const baseline = comparisonRows.slice(-20);
  const baselineIsFresh = baseline.length === 20 &&
    Date.parse(`${currentDate}T00:00:00Z`) - Date.parse(`${baseline.at(-1).date}T00:00:00Z`) <= 7 * 86_400_000;

  if (baselineIsFresh) {
    const averageYuan = baseline.reduce((sum, item) => sum + item.valueYuan, 0) / baseline.length;
    facts.push({
      label: "20 日平均成交额", value: Number((averageYuan / 1e8).toFixed(2)), unit: "亿元",
      sourceField: `${baseline.at(-1).symbol} 成交金额（最近 20 个有效交易日均值）`,
      source: "iFinD MCP · 同花顺沪深全A", asOf: baseline.at(-1).date,
      method: `由 ${baseline[0].date} 至 ${baseline.at(-1).date} 的 20 个有效日频成交金额求均值；原始单位元，换算为亿元。`
    });
  }

  let crossCheck = null;
  const sameDayRow = currentDate ? rows.find(item => item.date === currentDate) : null;
  if (sameDayRow && current && afterMarketClose(currentAsOf)) {
    const ifindValue = sameDayRow.valueYuan / 1e8;
    const relativeDifference = Math.abs(currentValue - ifindValue) / Math.max(Math.abs(currentValue), Math.abs(ifindValue), 1);
    crossCheck = {
      label: "iFinD 全A同日成交额", value: Number(ifindValue.toFixed(2)), unit: "亿元",
      sourceField: `${sameDayRow.symbol} 成交金额`, source: "iFinD MCP · 同花顺沪深全A",
      asOf: sameDayRow.date, method: "与扶摇全市场逐证券成交额同日交叉核验；iFinD 仅返回交易日期，不含日内时间戳。"
    };
    facts.push(crossCheck);
    if (relativeDifference > LIQUIDITY_CROSS_SOURCE_TOLERANCE) {
      return {
        ...base, status: "conflict", title: "同日成交额来源冲突", score: null, facts,
        source: "扶摇 A 股全市场行情快照 + iFinD MCP · 同花顺沪深全A",
        summary: "扶摇与 iFinD 同日成交额差异超过 5% 交叉核验容差；两源原值与各自时点均保留，流动性暂停评分并降低可信度。",
        method: `同日来源差异超过 5% 时标记冲突；当前比较日期 ${currentDate}，iFinD 仅提供交易日期，无日内更新时间。`
      };
    }
  }

  if (!baselineIsFresh) {
    const hasAnyFacts = facts.length > 0;
    return {
      ...base, status: hasAnyFacts ? "partial" : "unavailable", score: null, facts,
      title: hasAnyFacts ? "当日成交可用，20日均值待补" : "流动性基准不可用",
      summary: "iFinD 未提供足够且足够新的 20 个有效交易日成交额；保留已有真实原始字段，不计算成交额比值或评分。",
      source: facts.length ? `${base.source || "扶摇"} + iFinD MCP` : supplemental.source,
      method: "流动性评分需要同口径当日成交额和最近 20 个有效交易日均值；历史窗口不足或过期时不评分。"
    };
  }

  if (!current || !Number.isFinite(currentValue) || currentValue < 0 ||
      !["亿元", "亿"].includes(String(current.unit || ""))) {
    return {
      ...base, status: "partial", score: null, facts,
      title: "20日均值可用，当日成交不可用",
      summary: "iFinD 已补齐 20 日历史基准，但扶摇全市场当日成交额缺失或单位不可核验；不以指数成交额替代。",
      source: "iFinD MCP · 同花顺沪深全A + 扶摇",
      method: "只补历史基准，不替换扶摇当前全市场快照；缺少当日成交额时不评分。"
    };
  }

  if (!afterMarketClose(currentAsOf)) {
    return {
      ...base, status: "partial", score: null, facts,
      title: "日频基准可用，等待收盘后评分",
      summary: "20 日均值已取得；当日全市场成交快照尚未确认收盘，避免将盘中累计成交与完整日成交均值直接比较。",
      source: "扶摇 A 股全市场行情快照 + iFinD MCP · 同花顺沪深全A",
      method: "仅当扶摇当日成交快照时点达到 15:00（上海时间）后，才计算日频成交额比值。"
    };
  }

  const average = Number((baseline.reduce((sum, item) => sum + item.valueYuan, 0) / baseline.length / 1e8).toFixed(2));
  if (!(average > 0)) return { ...base, status: "unavailable", score: null, facts, title: "20日均值无效" };
  const ratio = currentValue / average;
  const score = ratio > 1.2 ? 2 : ratio >= 0.8 ? 0 : ratio < 0.6 ? -2 : -1;
  facts.push({
    label: "成交额 / 20 日均值", value: Number(ratio.toFixed(2)), unit: "倍",
    sourceField: "扶摇 market_turnover / iFinD 20d_average_turnover",
    source: "Market Lens 计算", asOf: currentAsOf,
    method: "扶摇全市场当日成交额 ÷ iFinD 同花顺沪深全A最近 20 个有效交易日成交额均值。"
  });
  return {
    ...base, status: score > 0 ? "positive" : score < 0 ? "negative" : "neutral",
    score, facts, source: "扶摇 A 股全市场行情快照 + iFinD MCP · 同花顺沪深全A",
    title: score < 0 ? "成交低于近期均值" : score > 0 ? "成交高于近期均值" : "成交处于常态区间",
    summary: `扶摇当日全市场成交额与 iFinD 最近 20 个有效交易日基准已按亿元同口径比较${crossCheck ? "；同日交叉核验差异在 5% 容差内" : ""}。`,
    method: "成交额比值 >1.2:+2；0.8–1.2:0；0.6–0.8:-1；<0.6:-2。iFinD 历史基准仅作补充，扶摇当前成交额不被覆盖。"
  };
}

export function mergeIfindEvidence(market, evidence) {
  if (!evidence || !market?.dimensions) return market;
  const supplemental = evidence.dimensions || {};
  if (supplemental.liquidity) market.dimensions.liquidity = mergeIfindLiquidity(market.dimensions.liquidity, supplemental.liquidity);
  if (supplemental.events) market.dimensions.events = supplemental.events;
  // iFinD must never replace Fuyao structure, breadth, style, or sentiment.
  return market;
}

let cached = null;
let cachedAt = 0;

export async function getMarket(env = process.env) {
  if (cached && Date.now() - cachedAt < 180_000) return cached;
  const mode = (env.MARKET_DATA_MODE || "fuyao").toLowerCase();
  const ifindEnabled = String(env.IFIND_ENABLED || "").trim().toLowerCase() === "true";
  let market;
  if (mode === "fuyao") {
    try {
      const tasks = [getFuyaoMarket(env)];
      if (ifindEnabled) tasks.push(getIfindEvidence(env));
      const results = await Promise.allSettled(tasks);
      const fuyaoResult = results[0];
      const ifindResult = results[1] || { status: "disabled" };
      if (fuyaoResult.status === "fulfilled") {
        market = fuyaoResult.value;
      } else {
        market = {
          mode: "fuyao", demo: false, providerStatus: "failed",
          providerMessage: "扶摇数据调用失败：" + (fuyaoResult.reason?.message || "未知错误"),
          asOf: null, indexes: [], chartSeries: [], warnings: ["接口失败，未使用演示数据替代。"],
          dimensions: Object.fromEntries(["structure", "breadth", "style", "liquidity", "sentiment", "valuation", "events"].map(key => [key, {
            id: key, label: key, status: "unavailable", title: "暂无可用数据", summary: "上游调用失败。",
            score: null, facts: [], source: "扶摇", asOf: null, method: "未计算"
          }]))
        };
      }
      if (ifindResult.status === "fulfilled") {
        const evidence = ifindResult.value;
        mergeIfindEvidence(market, evidence);
        if (market.dimensions.liquidity.status === "conflict") {
          market.warnings.push("扶摇与 iFinD 的同日成交额超过 5% 交叉核验容差；流动性保留双源证据并暂停评分。");
        }
        const sourceTimes = CORE.map(key => market.dimensions[key]?.asOf).filter(value =>
          value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 5 * 60 * 1000
        );
        if (sourceTimes.length) {
          const latest = sourceTimes.map(value => Date.parse(value)).reduce((a, b) => Math.max(a, b));
          if (!market.asOf || latest > Date.parse(market.asOf)) market.asOf = new Date(latest).toISOString();
        }
        if (evidence.researchContext) {
          market.researchContext = { ...(market.researchContext || {}), ...evidence.researchContext };
        }
        // Optional-provider failures are represented by unavailable/partial evidence,
        // never by transport details or raw MCP errors in the user-facing response.
      }
      const availableCore = ["structure", "breadth", "style", "liquidity", "sentiment"]
        .filter(key => Number.isFinite(market.dimensions[key]?.score)).length;
      if (availableCore >= 3 && Number.isFinite(market.dimensions.breadth?.score)) {
        market.providerStatus = market.usedLastKnownGood ? "partial" : "ready";
        market.providerMessage = market.usedLastKnownGood
          ? "核心证据达到计算门槛，但部分数据使用最近有效快照；页面不会标记为 LIVE。"
          : "已取得足够的核心市场维度，可计算阶段性状态。";
      } else if (market.providerStatus !== "failed") {
        market.providerStatus = market.indexes?.some(item => item.last !== null) ? "partial" : "not_configured";
        market.providerMessage = "核心维度不足，整体状态将显示为“证据不足”。";
      }
      const fuyaoValue = fuyaoResult.status === "fulfilled" ? fuyaoResult.value : null;
      market.toolCalls = [
        {
          name: "扶摇指数 REST API",
          status: fuyaoResult.status === "rejected" ? "failed"
            : fuyaoValue.providerStatus === "not_configured" ? "not_configured"
              : fuyaoValue.providerStatus === "failed" ? "failed"
                : fuyaoValue.usedLastKnownGood || fuyaoValue.dimensions?.structure?.score === null ? "partial" : "success",
          detail: fuyaoResult.status === "rejected" ? (fuyaoResult.reason?.message || "调用失败") : fuyaoValue.providerMessage
        },
        ...(ifindResult.status === "fulfilled"
          ? (ifindResult.value.toolCalls || []).filter(call => ["success", "partial"].includes(call.status))
          : [])
      ];
    } catch (error) {
      market = {
        mode: "fuyao", demo: false, providerStatus: "failed",
        providerMessage: `扶摇数据调用失败：${error.message || "未知错误"}`,
        toolCalls: [{ name: "扶摇指数 REST API", status: "failed", detail: "上游调用失败。" }],
        asOf: null, indexes: [], chartSeries: [], warnings: ["接口失败，未使用演示数据替代。"],
        dimensions: Object.fromEntries(["structure", "breadth", "style", "liquidity", "sentiment", "valuation", "events"].map(key => [key, {
          id: key, label: key, status: "unavailable", title: "暂无可用数据", summary: "上游调用失败。", score: null, facts: [], source: "扶摇", asOf: null, method: "未计算"
        }]))
      };
    }
  } else if (mode === "demo") {
    market = makeDemoMarket();
  } else {
    market = {
      mode, demo: false, providerStatus: "failed",
      providerMessage: "市场数据模式配置无效；系统不会回退到演示数据。",
      asOf: null, indexes: [], chartSeries: [], toolCalls: [],
      warnings: [`未知 MARKET_DATA_MODE：${mode}`],
      dimensions: Object.fromEntries(["structure", "breadth", "style", "liquidity", "sentiment", "valuation", "events"].map(key => [key, {
        id: key, label: key, status: "unavailable", title: "暂无可用数据", summary: "数据模式无效，未生成演示值。",
        score: null, facts: [], source: "无", asOf: null, method: "未计算"
      }]))
    };
  }
  market.assessment = assessMarket(market);
  cached = market;
  cachedAt = Date.now();
  return market;
}

export function clearMarketCache() {
  cached = null;
  cachedAt = 0;
}
