# Market Lens｜AI 驱动的股票市场大势研判

Market Lens 面向 A 股投资研究场景，把宽基指数、市场宽度、风格、流动性和情绪证据组织成市场状态、主要矛盾与重新评估条件。它不预测涨跌，不提供个股推荐、买卖或仓位建议。

## 用户与产品设计

目标用户是需要快速理解“市场当前处于什么状态、判断由什么支撑、什么变化会推翻判断”的研究者。首页按一个连续任务组织：市场状态 → 七维证据卡 → 状态切换条件 → 原始字段溯源 → 自然语言继续研究。五个核心维度参与状态规则；估值和事件作为补充证据，不因缺少数据而被误称为“正常”。

## 架构选择与职责

选择“数据适配器 + 确定性规则引擎 + 受约束 LLM”的分层架构，是为了让金融事实可追溯、评分可复核，并在模型或可选数据源故障时安全降级。市场事实与 AI 归纳分开，模型不能通过自然语言输出覆盖程序计算结果。

| 组件 | 职责 |
| --- | --- |
| 扶摇 | 主行情源：指数快照/历史日线、全市场宽度与成交额、涨跌停情绪；失败或数据不完整时相应证据不可用，不以样本补位 |
| iFinD MCP（后续可选扩展） | 本地已完成适配探索，保留 `get_security_indicators` 与 `search_news` adapter 和测试；因线上 MCP 稳定性未达到生产要求，本次 MVP 默认关闭，部署和运行均不依赖 iFinD |
| DeepSeek（可选配置的 LLM） | 解析问题生成 Research Plan；在数据工具完成取数后，基于结构化 evidence 做简短解释并引用 evidence ID；不计算指标、不创作金融事实、不提供投资建议 |
| 程序规则 | 校验来源字段、单位、完整度和时点；计算收益、涨跌占比、20 日成交均值、维度分数、Market State、置信度、主要矛盾与切换条件；执行 Hard Gate 和输入/输出合规检查 |

这使扶摇保持生产核心链路的单一主来源，DeepSeek 不成为事实计算或 Market State 的单点依赖。研究解释只可使用当前真实可用、通过校验的 evidence；缺失维度不进入模型 evidence，也不会由 iFinD 或演示值补写。本次 MVP 中事件和估值为 unavailable，流动性只展示扶摇当日成交额并标记 partial、不参与评分。iFinD 新闻 adapter 保留为后续扩展；未来启用时仍受授权范围约束，未确认全文许可前不得展示新闻正文。

## 本地运行

要求 Node.js 22.13 或更高版本。

    npm run install:ci
    npm run dev

打开 `http://localhost:5173`。Web Worker 的本地预览通过 Cloudflare/Vinext 运行；需要真实/模型接口时，把 `.dev.vars.example` 复制为未提交的 `.dev.vars` 并填入本机授权值。若只需验证原生 Node 版 API：

    node server/index.mjs

然后打开 `http://localhost:4173`。语法检查和自动化回归：

    npm run check
    npm test
    npm run lint
    npm run build

`npm run build` 构建 Worker 版本；本地构建产物可用 `npm start` 预览。最终自动化与线上验收结果见 `docs/test-plan.md` 和 `docs/ai-usage-and-validation.md`。

### 当前线上状态（2026-10-14）

Market Lens Site v20 已公开访问；生产环境以扶摇为核心数据源。iFinD 虽保留本地 adapter、字段处理和测试，但因线上 MCP 稳定性未达到生产要求，本次 MVP 默认关闭，部署和运行均不依赖它；普通用户不会看到 iFinD 技术错误。行情结构、市场宽度、风格轮动与可用情绪证据使用扶摇真实数据；流动性显示当日成交额但因缺少同口径 20 日历史基准而标为 partial、不参与评分；事件与估值保持 unavailable，不以演示数据补位。

Site v19 上固定的 8 条合法 Research 连续两轮均为 8/8 完整通过，8 条违规输入为 8/8 程序级拦截，扶摇刷新为 5/5 正常并维持 4/5 核心维度及有效市场宽度。已知边界：更宽泛的合法 Research 偶尔可能因 DeepSeek 上游不可用而安全停止生成结论；系统不会伪造解释。这属于可接受的 P1 可用性风险，不是 P0。当前匿名发布验收与完整测试结果见 `docs/test-plan.md` 和 `docs/ai-usage-and-validation.md`。

## AI 角色与边界

- 程序根据已验证的原始字段计算指标、维度评分、数据覆盖和状态切换条件；AI 只解释结构化证据。
- 普通研究请求由真实 LLM 先生成取数计划，再复用首页共享的已校验市场快照；聚合快照有效期 3 分钟，之后按各扶摇数据集 TTL 刷新。证据事实由服务端计算、组装和引用，LLM 不计算或补造金融事实。
- 买卖、荐股、仓位、目标价、止损、确定性涨跌和收益承诺等意图在数据调用前由程序拦截；模型输出还会经过二次合规与数值检查。
- 模型未配置、调用失败或输出校验不通过时，明确提示不可用/已拦截，不回退到规则模板伪装成 AI 回答。
- 事实、程序归纳和数据不确定性分开展示。置信度是数据覆盖与信号一致性的规则分，不是概率、准确率或收益承诺。
- 核心维度少于 3 个，或市场宽度证据无效时，硬门槛禁止生成 Market State、主要矛盾和状态切换判断。

## 数据与环境变量

默认 `MARKET_DATA_MODE=fuyao`。扶摇适配器读取指数快照与历史日线、分页全市场快照和涨跌停股票池；数据缺失、分页不完整、冲突或过期时，对应维度标为不可用，不以演示样本补位。显式设置 `MARKET_DATA_MODE=demo` 仅用于开发/测试，页面会标示演示数据。

生产版本的行情结构、市场宽度、风格轮动和可用情绪证据来自扶摇。流动性显示扶摇当日全市场成交额，但缺同口径 20 日历史基准时标记 partial、`score=null`；事件与估值保持 unavailable。iFinD 适配器保留但默认关闭，只有显式设置 `IFIND_ENABLED=true` 才会作为后续可选增强源调用；关闭或不可用时不会生成 iFinD 技术错误供普通用户查看，也不会影响扶摇或 Hard Gate。Hard Gate 仍要求至少 3 个有效核心维度且市场宽度有效。

可选环境变量：

| 名称 | 用途 |
| --- | --- |
| `MARKET_DATA_MODE` | `fuyao`（默认）或显式开发/测试模式 `demo` |
| `FUYAO_API_KEY` | 扶摇服务端 API Key |
| `FUYAO_BASE_URL` | 扶摇 API 基础地址；缺省使用官方地址 |
| `IFIND_ENABLED` | 默认关闭；仅显式设为 `true` 才启用可选 iFinD provider。本次生产 MVP 不设置为 true |
| `IFIND_MARKET_AUTHORIZATION` | 可选；iFinD 日频成交额 MCP 的 Authorization header 值，服务端使用 |
| `IFIND_NEWS_AUTHORIZATION` | 可选；iFinD 新闻 MCP 的 Authorization header 值，服务端使用 |
| `IFIND_MARKET_MCP_URL` / `IFIND_NEWS_MCP_URL` | 可选；默认使用对应官方 MCP 地址，仅用于部署端点变更时覆盖 |
| `AI_API_BASE_URL` | OpenAI-compatible Chat Completions 服务地址；DeepSeek 可用 `https://api.deepseek.com` |
| `AI_API_KEY` | 模型服务密钥，服务端使用 |
| `AI_MODEL` | 模型名称；当前配置示例为 `deepseek-flash` |

托管环境通过 Sites 受保护运行时环境变量注入凭证；本地 Worker 预览使用未提交的 `.dev.vars`，原生 Node 版可从未提交的 `.env` 读取。任何 iFinD Authorization 值都必须作为 secret；本次部署即使保留既有 iFinD secrets，也会因默认关闭而不读取或调用它们。不得把 token、认证头、带凭证 URL 写进前端、README、截图、日志、测试记录或仓库。字段契约见 `docs/data-provider-integration.md`。

首页与 Research 共用 3 分钟聚合缓存；底层扶摇资源分别缓存：指数快照 2 分钟、全市场分页和涨跌停池 4 分钟、历史日线 45 分钟。并发请求按资源合并；每次扶摇 HTTP 请求使用独立 AbortController、接口独立超时和最多一次重试。刷新动作重新检查数据，但不会绕过仍有效的底层缓存。若刷新失败，只在 freshness 时限内使用最近有效快照，并显示“部分数据”、原始来源时点和最近有效快照提示；超过 freshness 时限则数据不可用并由既有 Hard Gate 阻止形成状态判断。

## 异常处理与已知边界

上游失败、缺字段、分页不完整、冲突、非法数值、时间缺失、未来时间戳或数据过期时，相应维度会不可用并退出评分；扶摇模式不会回退到演示样本。没有市场宽度或核心维度不足时，状态、主要矛盾和切换条件均受硬门槛阻止。当前没有用户登录、持仓画像、个股筛选、交易、回测、实时推送或历史状态数据库。

已知限制：行业和历史状态数据库尚未接入独立实时证据工具；若对应证据缺失，Research 必须说明证据不足，不能根据宽基或新闻标题虚构行业/历史事实。事件标题的可展示范围尚未获得超出授权字段清单的许可确认，因此不显示任何新闻正文。

## 部署

Site 运行于 Cloudflare Workers。`.openai/hosting.json` 保存 Site 标识；不要手工替换 `project_id`。发布和源码同步使用当前工作区提供的 Sites 工作流，并按当前 Site 的公开访问策略管理发布。扶摇和模型凭证仅存 Sites 运行时 secret，不进入源代码或构建产物。独立的 Node 版也保留，可在支持 Node 的平台部署。

## 文档

- `docs/requirements-and-scope.md`：题目要求与 MVP 验收映射
- `docs/market-state-rules.md`：指标、阈值、状态和置信度规则
- `docs/data-provider-integration.md`：扶摇主链路与可选 iFinD MCP 字段契约
- `docs/ai-prompt-and-boundaries.md`：提示词、拒答与模型降级边界
- `docs/test-plan.md`：自动化和手工验收记录
- `docs/ai-usage-and-validation.md`：AI 参与环节与验证记录
- `docs/deployment.md`：部署与账号依赖
