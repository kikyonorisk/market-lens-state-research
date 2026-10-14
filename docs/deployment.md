# Site 部署与运行配置

## 托管形态

Market Lens 的 Sites 版本以 Vinext 构建，在 Cloudflare Workers 上运行。页面静态资源仍从 `public/` 提供；`/api/health`、`/api/market` 和 `/api/research` 由 Worker 执行，复用 `server/` 中的状态规则、数据适配器和 AI 边界逻辑。`.openai/hosting.json` 中的 `project_id` 由 Sites 工作流维护，不能手工更换。

当前默认配置是 `MARKET_DATA_MODE=fuyao`。没有有效扶摇凭证时显示数据不可用/证据不足，不回退到 demo。`MARKET_DATA_MODE=demo` 仅用于显式开发或测试。iFinD adapter 为可选扩展，`IFIND_ENABLED` 缺省关闭；本次 MVP 不依赖其 secrets、网络或服务可用性。当前 Site 保持原有私有访问策略；本次发布不得修改访问范围。

## 本地预览和 Node 备选

Sites Worker 本地预览：

    npm run install:ci
    npm run dev

普通 Node 服务备选（不需要安装第三方依赖）：

    node server/index.mjs

Node 服务默认监听 `0.0.0.0:4173`，也可从未提交的 `.env` 加载变量；Sites Worker 本地预览使用未提交的 `.dev.vars`。两类文件都不应提交。

## 受保护环境变量

托管环境须使用 Sites 运行时环境变量功能，不要写入前端、源码、`hosting.json`、README、日志或测试记录。扶摇 API Key 和模型 API Key 必须标记为 secret。设置 `MARKET_DATA_MODE=fuyao` 后，没有 Key 或上游失败时应用会显示证据不足，不会回退到演示数值。未配置模型或模型失败时，AI Research 明确显示不可用，不会伪装成规则模板回答。

| 变量 | 是否必须 | 用途 |
| --- | --- | --- |
| `MARKET_DATA_MODE` | 否 | `fuyao` 或显式开发/测试用 `demo`；默认 `fuyao` |
| `FUYAO_API_KEY` | 扶摇模式必需 | 扶摇 API 凭证 |
| `FUYAO_BASE_URL` | 否 | 扶摇 API 基础地址 |
| `IFIND_ENABLED` | 否 | 默认关闭；只有显式设为 `true` 才启用可选 iFinD provider；本次生产保持关闭 |
| `IFIND_MARKET_AUTHORIZATION` | 否 | iFinD 市场 MCP Authorization 值；仅作成交额历史补充，必须保存为 secret |
| `IFIND_NEWS_AUTHORIZATION` | 否 | iFinD 新闻 MCP Authorization 值；仅作事件补充，必须保存为 secret |
| `IFIND_MARKET_MCP_URL` / `IFIND_NEWS_MCP_URL` | 否 | iFinD MCP 地址覆盖项；默认官方服务地址 |
| `AI_API_BASE_URL` | 使用 AI Research 时必需 | OpenAI-compatible Chat Completions API 地址 |
| `AI_API_KEY` | 使用 AI Research 时必需 | 模型服务密钥；Sites 中以 secret 保存 |
| `AI_MODEL` | 使用 AI Research 时必需 | 模型名称 |

生产默认不调用 iFinD；流动性保持扶摇当日成交额 partial/no score，事件和估值 unavailable。未来显式启用 iFinD 后，它仍只是非必需增强源，绝不替代扶摇主链路。不得把生产行情明细或授权信息写进测试样本或 README。

## 发布检查

- 本次私有最终收尾执行 `npm run check`、`npm test`（44/44）、`npm run lint`、`npm run build`；功能部署为 Site v14，文档同步为 v15。
- 验证 `/api/health`、`/api/market`、`/api/research` 主链路和禁答/请求错误场景。
- iFinD 为 optional 且生产默认关闭；本次验收不配置或调用 iFinD。隔离 adapter 的正常、失败、空数据、冲突场景由自动化测试覆盖。
- 确认运行时 secret 不出现在 API 响应、客户端 bundle、构建归档或日志。
- 保留现有自定义 allowlist 私有访问（当前 1 个允许账号、0 外部访客）；本次部署不更改访问范围，线上验收在已登录授权会话中完成。
- Hard Gate、失败/过期数据、违规意图和模型输出二次检查由 `docs/test-plan.md` 自动化用例覆盖并记录线上主链路验收。
