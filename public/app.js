const dimensionOrder = ["structure", "breadth", "style", "liquidity", "sentiment", "valuation", "events"];
const dimensionIcons = { structure: "⌁", breadth: "◷", style: "↗", liquidity: "≈", sentiment: "✳", valuation: "◉", events: "▤" };
const statusLabels = { positive: "偏强", negative: "偏弱", mixed: "分化", neutral: "中性", partial: "部分可用", available: "可用（不评分）", unavailable: "待接入", stale: "数据过期", conflict: "数据冲突", invalid_time: "时间异常" };
const stateCopy = { "风险偏好修复": "偏强信号正在扩散", "风险偏好收缩": "风险信号需要持续观察", "震荡分化": "多维信号暂未一致", "证据不足": "等待关键数据补齐" };
let currentMarket = null;
let toastTimer = null;
let researchHistory = [];
let researchInFlight = false;
const byId = id => document.getElementById(id);
const number = (value, digits = 2) => Number.isFinite(value) ? value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
const signed = (value, unit = "%") => Number.isFinite(value) ? (value > 0 ? "+" : "") + number(value) + unit : "—";

function formatDate(value, includeTime = true) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(date);
}
function showToast(message) {
  const toast = byId("toast"); toast.textContent = message; toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}
function setText(id, value) { byId(id).textContent = value; }
function sourceLink(value, label, className = "") {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const link = element("a", className, label);
    link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer";
    return link;
  } catch { return null; }
}

function renderBanner(market) {
  const banner = byId("data-banner"), messages = (market.warnings || []).slice();
  if (market.demo) messages.unshift("演示环境：以下为构造样本，不是实时行情。");
  if (!market.demo && market.providerMessage) messages.unshift(market.providerMessage);
  banner.hidden = messages.length === 0;
  setText("banner-message", messages.join(" "));
  setText("banner-mode", market.demo ? "DEMO DATA" : market.providerStatus === "ready" ? "LIVE DATA" : "PARTIAL DATA");
}
function renderAssessment(market) {
  const assessment = market.assessment || {}, state = assessment.state || "证据不足";
  setText("state-heading", state);
  setText("state-chip-label", state === "证据不足" ? "暂停研判" : "阶段性观察");
  setText("state-rationale", assessment.rationale || "当前没有足够数据生成结论。");
  setText("state-aside-copy", stateCopy[state] || "多维信号交叉验证");
  setText("coverage-label", "核心维度 " + (assessment.availableCore || 0) + " / 5");
  const confidence = Number.isFinite(assessment.confidence) ? assessment.confidence : null;
  setText("confidence-text", confidence === null ? "不可计算" : confidence + "%");
  byId("confidence-bar").style.width = (confidence || 0) + "%";
  byId("state-chip").className = "state-chip " + (state === "风险偏好修复" ? "positive" : state === "风险偏好收缩" ? "negative" : "");
  setText("updated-at", formatDate(market.asOf));
  setText("as-of-date", market.asOf ? formatDate(market.asOf, false) : "等待数据");
  setText("market-clock", market.demo ? "构造演示样本" : market.providerStatus === "partial" ? "部分数据可用" : ["failed", "not_configured"].includes(market.providerStatus) ? "数据源未就绪" : "数据已更新");
  setText("major-tension", assessment.majorTension || "暂无证据支持整体归纳。");
  const list = byId("switch-list"); list.replaceChildren();
  for (const condition of assessment.switchConditions || []) { const item = document.createElement("li"); item.textContent = condition; list.append(item); }
  if (state === "证据不足" && !(assessment.switchConditions || []).length) {
    const item = document.createElement("li"); item.textContent = "证据门槛未通过，暂不生成状态切换条件。"; list.append(item);
  }
}
function renderIndexes(market) {
  const container = byId("index-list"); container.replaceChildren();
  const indexes = market.indexes || [];
  if (!indexes.length) {
    const item = document.createElement("div"); item.className = "index-item";
    item.innerHTML = "<div><span class=\"index-name\">主要指数</span><span class=\"index-code\">等待授权数据</span></div><div class=\"index-value\">—</div>";
    container.append(item); return;
  }
  for (const index of indexes) {
    const item = document.createElement("div"); item.className = "index-item";
    const name = document.createElement("div"), label = document.createElement("span"), code = document.createElement("span");
    label.className = "index-name"; label.textContent = index.name; code.className = "index-code"; code.textContent = index.code; name.append(label, code);
    const value = document.createElement("div"); value.className = "index-value";
    const quoteStatus = index.quoteStatus || "current";
    const invalidQuote = quoteStatus !== "current";
    const price = document.createElement("span"); price.textContent = invalidQuote ? "—" : number(index.last, 2);
    const change = document.createElement("span"); change.className = "index-change " + (invalidQuote ? "flat" : index.changePct > 0 ? "up" : index.changePct < 0 ? "down" : "flat");
    change.textContent = invalidQuote ? (statusLabels[quoteStatus] || "时点待核") : signed(index.changePct);
    value.append(price, change); item.append(name, value); container.append(item);
  }
}
function renderDimensions(market) {
  const grid = byId("evidence-grid"); grid.replaceChildren();
  for (const key of dimensionOrder) {
    const dimension = market.dimensions && market.dimensions[key]; if (!dimension) continue;
    const card = document.createElement("article");
    card.className = "evidence-card " + (dimension.status === "unavailable" || dimension.status === "stale" || dimension.status === "conflict" || dimension.status === "invalid_time" ? "unavailable" : "");
    const top = document.createElement("div"); top.className = "card-top";
    const name = document.createElement("span"); name.className = "card-name";
    const icon = document.createElement("i"); icon.className = "dimension-icon"; icon.textContent = dimensionIcons[key] || "•";
    const label = document.createElement("span"); label.textContent = dimension.label; name.append(icon, label);
    const status = document.createElement("span"); status.className = "card-status " + dimension.status;
    const dot = document.createElement("i"), statusLabel = document.createElement("span"); statusLabel.textContent = statusLabels[dimension.status] || "待确认";
    status.append(dot, statusLabel); top.append(name, status);
    const title = document.createElement("h3"); title.className = "card-title"; title.textContent = dimension.title || "暂无数据";
    const summary = document.createElement("p"); summary.className = "card-summary"; summary.textContent = dimension.summary || "暂无可展示的字段。";
    const foot = document.createElement("div"); foot.className = "card-foot";
    const source = document.createElement("span"); source.className = "card-source"; source.textContent = dimension.source || "来源待确认";
    const link = document.createElement("button"); link.type = "button"; link.className = "card-link";
    link.dataset.dimension = key; link.setAttribute("aria-label", "查看" + dimension.label + "证据");
    link.textContent = "查看证据 ↗";
    foot.append(source, link); card.append(top, title, summary, foot); grid.append(card);
  }
}
function drawChart(market) {
  const canvas = byId("index-chart"), empty = byId("chart-empty"), ctx = canvas.getContext("2d"), rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio)); canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.scale(ratio, ratio); ctx.clearRect(0, 0, rect.width, rect.height);
  const series = (market.indexes || []).map((index, i) => {
    const points = (index.series || []).map(point => typeof point === "number" ? point : point.close).filter(Number.isFinite);
    const first = points[0]; return { name: index.name, values: first ? points.map(value => value / first * 100) : [], color: ["#7895ad", "#d19769", "#6da080"][i] };
  }).filter(item => item.values.length > 1);
  if (!series.length) { empty.hidden = false; byId("chart-legend").hidden = true; setText("chart-summary", "没有取得历史序列，图表不会以样本补齐。"); return; }
  empty.hidden = true; byId("chart-legend").hidden = false;
  const values = series.flatMap(item => item.values); let min = Math.min(...values), max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const pad = { left: 4, right: 5, top: 13, bottom: 19 }, width = rect.width - pad.left - pad.right, height = rect.height - pad.top - pad.bottom;
  ctx.strokeStyle = "#edf0ec"; ctx.lineWidth = 1; ctx.font = "9px ui-monospace, monospace"; ctx.fillStyle = "#a0aaa2";
  for (let i = 0; i < 4; i++) {
    const y = pad.top + height * i / 3; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(rect.width - pad.right, y); ctx.stroke();
    ctx.fillText((max - (max - min) * i / 3).toFixed(1), pad.left + 2, y - 3);
  }
  for (const item of series) {
    ctx.beginPath(); ctx.strokeStyle = item.color; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.lineCap = "round";
    item.values.forEach((value, index) => {
      const x = pad.left + width * index / Math.max(1, item.values.length - 1), y = pad.top + height * (max - value) / (max - min);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  const count = Math.max(...series.map(item => item.values.length));
  setText("chart-summary", count + " 个收盘点 · 起点归一化为 100 · " + (market.demo ? "演示序列" : "指数历史日线"));
  setText("chart-source", market.demo ? "构造演示样本" : "扶摇指数历史日线");
}
function element(tag, className, content) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (content !== undefined) node.textContent = content; return node;
}
function addTraceField(parent, label, value, isCode = false) {
  const wrapper = element("div", "trace-field"); wrapper.append(element("span", "", label));
  wrapper.append(isCode ? element("code", "", value) : element("strong", "", value)); parent.append(wrapper);
}
function drawerSection(title, description) {
  const section = element("section", "drawer-section"); section.append(element("h3", "", title));
  if (description) section.append(element("p", "", description)); return section;
}
function openDrawer(dimensionKey = null) {
  if (!currentMarket) return;
  const drawer = byId("evidence-drawer"), body = byId("drawer-content"); body.replaceChildren();
  setText("drawer-title", dimensionKey ? (currentMarket.dimensions[dimensionKey] || {}).label || "证据详情" : "证据溯源");
  const keys = dimensionKey ? [dimensionKey] : dimensionOrder;
  for (const key of keys) {
    const item = currentMarket.dimensions && currentMarket.dimensions[key]; if (!item) continue;
    const section = drawerSection(item.label, item.summary);
    addTraceField(section, "判断类型", item.status === "conflict" ? "不确定 / 原始字段冲突，已暂停评分" : item.status === "stale" ? "不确定 / 数据过期，已排除出评分" : item.status === "invalid_time" ? "不确定 / 数据时点在未来，已排除出评分" : item.status === "unavailable" ? "不确定 / 数据不可用" : "归纳判断");
    addTraceField(section, "数据来源", item.source || "待配置");
    addTraceField(section, "数据时点", formatDate(item.asOf));
    addTraceField(section, "计算口径", item.method || "未计算");
    if (item.facts && item.facts.length) {
      for (const fact of item.facts) {
        addTraceField(section, fact.label, String(fact.value ?? "缺失") + (fact.unit || ""));
        addTraceField(section, fact.label + " · 原始字段", fact.sourceField || "未提供", true);
        addTraceField(section, fact.label + " · 字段来源/时点", (fact.source || item.source || "未知") + " · " + formatDate(fact.asOf || item.asOf));
        if (fact.publishedAt) addTraceField(section, fact.label + " · 资讯日期（iFinD）", fact.publishedAt);
        if (fact.method) addTraceField(section, fact.label + " · 计算说明", fact.method);
        const source = sourceLink(fact.url, "查看 iFinD 原始来源");
        if (source) section.append(source);
      }
    } else {
      section.append(element("div", "drawer-empty", item.status === "unavailable" ? "数据尚未取得，因此没有原始字段可供追溯；系统不会用其他数据源或演示值替代。" : "当前维度暂无单项原始字段。"));
    }
    body.append(section);
  }
  if (!dimensionKey) {
    const assessment = currentMarket.assessment || {}, section = drawerSection("整体状态推导", assessment.rationale);
    addTraceField(section, "状态", assessment.state || "证据不足");
    addTraceField(section, "置信度", Number.isFinite(assessment.confidence) ? assessment.confidence + "%" : "不可计算");
    addTraceField(section, "可用核心维度", (assessment.availableCore || 0) + " / " + (assessment.requiredCore || 3) + " 最低门槛，最多 5 个");
    addTraceField(section, "主要矛盾", assessment.majorTension || "—"); body.prepend(section);
  }
  drawer.hidden = false; byId("drawer-backdrop").hidden = false; document.body.style.overflow = "hidden"; byId("close-drawer").focus();
}
function closeDrawer() { byId("evidence-drawer").hidden = true; byId("drawer-backdrop").hidden = true; document.body.style.overflow = ""; }
function renderResearch(result) {
  const container = byId("research-result"); container.replaceChildren(); container.hidden = false;
  const heading = element("div", "result-heading"); heading.append(element("strong", "", "研究结果"));
  heading.append(element("span", "result-label", result.classification + " · " + result.aiMode)); container.append(heading);
  const plan = element("div", "result-plan"); plan.append(element("strong", "", "取数计划"));
  const ordered = document.createElement("ol");
  (result.plan || []).forEach(line => ordered.append(element("li", "", line)));
  if (!(result.plan || []).length) ordered.append(element("li", "", "未生成计划；请检查 AI Research 配置或合规拦截提示。"));
  plan.append(ordered); container.append(plan);
  const toolCalls = result.toolCalls || [];
  if (toolCalls.length) {
    const tools = element("div", "result-tools"); tools.append(element("strong", "", "数据调用结果"));
    const labels = { demo: "演示样本", success: "已返回", partial: "部分可用", not_configured: "未配置", empty: "无有效字段", failed: "调用失败" };
    for (const call of toolCalls) {
      const row = element("div", "result-tool");
      const name = element("span", "result-tool-name", call.name || "数据工具");
      const status = element("span", "result-tool-status " + (call.status || "empty"), labels[call.status] || "待确认");
      row.append(name, status);
      if (call.detail) row.append(element("span", "result-tool-detail", call.detail));
      tools.append(row);
    }
    container.append(tools);
  }
  container.append(element("div", "result-answer", result.answer));
  if (result.citations && result.citations.length) {
    const citations = element("div", "result-citations");
    for (const citation of result.citations.slice(0, 6)) {
      const value = citation.value === null ? "缺失" : String(citation.value) + (citation.unit || "");
      const chip = sourceLink(citation.url, citation.label + " " + value, "citation-chip") || element("span", "citation-chip", citation.label + " " + value);
      chip.title = [citation.source, citation.sourceField, citation.publishedAt ? "资讯日期 " + citation.publishedAt : citation.asOf ? "检索时点 " + formatDate(citation.asOf) : "时点缺失"].filter(Boolean).join(" · ");
      citations.append(chip);
    }
    container.append(citations);
  }
  container.append(element("div", "result-disclaimer", result.disclaimer)); setText("ai-mode-tag", result.aiMode);
}
async function loadMarket(refresh = false) {
  const button = byId("refresh-button"); button.disabled = true; button.style.opacity = ".55";
  try {
    const response = await fetch("/api/market" + (refresh ? "?refresh=1" : ""), { cache: "no-store" });
    if (!response.ok) throw new Error("数据加载失败（" + response.status + "）");
    currentMarket = await response.json(); renderBanner(currentMarket); renderAssessment(currentMarket);
    renderIndexes(currentMarket); renderDimensions(currentMarket); drawChart(currentMarket);
  } catch (error) { showToast(error.message || "无法连接服务。"); }
  finally { button.disabled = false; button.style.opacity = ""; }
}
async function submitResearch(event) {
  event.preventDefault();
  if (researchInFlight) return;
  const input = byId("research-question"), submit = byId("research-submit"), question = input.value.trim();
  if (!question) { input.focus(); showToast("先写下你想研究的问题。"); return; }
  researchInFlight = true;
  submit.disabled = true; submit.textContent = "正在整理…";
  try {
    const body = JSON.stringify({ question, history: researchHistory.slice(-4) });
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch("/api/research", {
          method: "POST", headers: { "Content-Type": "application/json" }, body
        });
        break;
      } catch (error) {
        const retryable = error?.name === "AbortError" || error instanceof TypeError || /operation was aborted|network|connection/i.test(String(error?.message || ""));
        if (!retryable || attempt === 1) throw new Error("研究请求暂时中断，未形成结论；请稍后重试。");
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "研究请求失败。");
    renderResearch(result);
    if (result.aiMode === "真实 LLM") {
      researchHistory.push({ question: question.slice(0, 500), answer: String(result.answer || "").slice(0, 1000) });
      researchHistory = researchHistory.slice(-6);
    }
  } catch (error) { showToast(error.message || "研究服务暂不可用。"); }
  finally { researchInFlight = false; submit.disabled = false; submit.innerHTML = "开始研究 <span>↗</span>"; }
}
function initialize() {
  setText("footer-year", String(new Date().getFullYear()));
  byId("refresh-button").addEventListener("click", () => loadMarket(true));
  byId("evidence-grid").addEventListener("click", event => { const card = event.target.closest("[data-dimension]"); if (card) openDrawer(card.dataset.dimension); });
  byId("open-trace").addEventListener("click", () => openDrawer());
  document.querySelectorAll("[data-open-assessment]").forEach(button => button.addEventListener("click", () => openDrawer()));
  byId("close-drawer").addEventListener("click", closeDrawer); byId("drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !byId("evidence-drawer").hidden) closeDrawer(); });
  byId("research-form").addEventListener("submit", submitResearch);
  document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => {
    byId("research-question").value = button.dataset.prompt; byId("research-question").focus();
  }));
  window.addEventListener("resize", () => { if (currentMarket) drawChart(currentMarket); });
  loadMarket();
}
initialize();
