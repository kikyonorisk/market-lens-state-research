# 扶摇主链路与可选 iFinD MCP 补充

## 扶摇 API

所有请求从服务端发出，使用 `X-api-key` 认证；密钥仅来自 Sites secret 或未提交的本地环境文件，不传给浏览器。

| 数据 | 扶摇接口 | Market Lens 用途 |
| --- | --- | --- |
| 指数快照 | `/api/a-share-index/prices/snapshot` | 沪深 300、中证 1000、创业板指行情结构 |
| 指数历史日线 | `/api/a-share-index/prices/historical` | 指数图表与近 5 个交易日大小盘相对表现 |
| A 股快照 | `/api/a-share/prices/snapshot?limit=100&offset=…` | 分页汇总市场宽度和全市场成交额 |
| 涨停股票池 | `/api/a-share/special-data/limit-up-pool` | 情绪维度涨停家数 |
| 跌停股票池 | `/api/a-share/special-data/limit-down-pool` | 情绪维度跌停家数 |

指数接口与字段说明以扶摇官方[指数数据文档](https://fuyao.aicubes.cn/docs/api-reference/a-share-index/)及[限涨停数据文档](https://fuyao.aicubes.cn/docs/api-reference/limit-up-data/)为准。接口失败、业务错误、缺时点、过期或未来时间戳不会被解释为正常数据。

## 覆盖和评分规则

- 全市场快照必须取齐所有分页，页间总数和数据时点须一致，证券代码不能缺失或重复；任一页失败时不从部分样本推算宽度或成交额。
- 市场宽度只在全市场快照完整且至少 95% 证券有有效涨跌幅时计算；上涨占比使用上涨家数 ÷（上涨家数 + 下跌家数），平盘和无涨跌幅证券不进入分母。
- 流动性从扶摇完整全市场快照汇总当日成交额。可选 iFinD 日频成交额历史用于计算此前最近 20 个有效交易日均值；仅在两者单位可核对、基准新鲜且扶摇快照时点达到上海时间 15:00 后评分。盘中保持 partial、不评分。
- 风格轮动按中证 1000 与沪深 300 各自近 5 个交易日收益率之差计算；历史时点缺失、超过 7 天或相差超过 36 小时时不评分。
- 情绪按扶摇涨停/跌停股票池总数计算；股票池时点超过 36 小时或未来异常时不评分。
- 扶摇是行情结构、市场宽度、风格和情绪的唯一主来源；iFinD 不覆盖这些维度。iFinD 仅补充流动性历史基准及事件资讯。

## iFinD 可选补充（本次生产 MVP 默认关闭）

iFinD 已完成本地 adapter 探索并保留实现与自动化测试；因线上 MCP 稳定性未达到生产要求，本次 MVP 不将其作为生产依赖。只有显式设置 `IFIND_ENABLED=true` 才执行 MCP 请求；缺省或 `false` 时不发起请求、不显示 iFinD 调用故障，也不改变扶摇和 Hard Gate。当前线上流动性为扶摇当日成交额 partial、无 20 日均值且不评分；事件和估值 unavailable。

- 市场数据 MCP 工具：`get_security_indicators`，查询同花顺沪深全 A（`700008.TI`）每日成交金额；源字段单位为元。适配器请求最多 45 个日历日，解析有效交易日数据后取当前日期之前最近 20 个有效记录求均值，不让 iFinD 当前日成交额替换扶摇当前全市场成交额。
- 新闻 MCP 工具：`search_news`，页面只需要标题、日期、来源和可能存在的来源 URL。即使服务响应包含资讯正文，适配器也会丢弃正文，不放入公开 evidence、API、Research citation 或发给 LLM；LLM 仅根据标题作简短中性归纳。MCP 提供单条日期时与采集时点分开显示；没有日期时只显示检索时点，不推断发布时间。事件只作为背景证据，不进入 Market State 评分。新闻数据来自授权 iFinD MCP，展示受数据许可范围约束；未确认全文展示许可前不得展示全文。
- 流动性同日交叉核验：仅在扶摇快照为收盘后时点时比较 iFinD 同日全 A 成交额；相对差异超过 5% 标记 conflict、保留双源数值/来源/时点并把分数置空。iFinD 历史基准缺少 20 个有效日、过旧、格式不可识别或调用失败时不评分。
- iFinD 是显式 opt-in 的可选源。关闭时完全不调用；未来启用后遇到缺少 Authorization、超时、空结果或协议错误时，对应维度保持 unavailable/partial，不将技术细节暴露给普通用户；扶摇的行情结构、宽度、风格及情绪链路不受影响，绝不使用 demo 补位。
- 市场历史数据缓存 45 分钟，新闻结果缓存 5 分钟；MCP 单次连接/调用共用独立 12 秒超时，不会共享或取消扶摇请求的 signal。
- 当前没有接估值工具；宏观 EDB 查询和个股行情不属于这次增量。iFinD 对话研究中的事实仍须由数据 evidence 支撑。

## 本地与托管配置

- Sites：在受保护的运行时环境变量中配置 `MARKET_DATA_MODE=fuyao` 和 secret `FUYAO_API_KEY`。
- 启用 iFinD 时，分别把 MCP 配置中的市场数据服务、新闻服务 `Authorization` header 值设为 secret `IFIND_MARKET_AUTHORIZATION`、`IFIND_NEWS_AUTHORIZATION`。不要添加 Bearer 前缀或把授权值写入配置文件、文档、日志或仓库。
- AI Research：配置 `AI_API_BASE_URL`、secret `AI_API_KEY`、`AI_MODEL`；当前 DeepSeek 的 base URL/model 见 `.dev.vars.example`。
- Worker 本地预览使用未提交的 `.dev.vars`；原生 Node 服务可读取未提交的 `.env`。
- 不把密钥放入源码、README、测试结果、浏览器 bundle 或 Git；请求失败时明确显示不可用，不回退到 demo。
