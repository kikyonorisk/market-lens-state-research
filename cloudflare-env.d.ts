declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    MARKET_DATA_MODE?: string;
    FUYAO_API_KEY?: string;
    FUYAO_BASE_URL?: string;
    IFIND_MARKET_AUTHORIZATION?: string;
    IFIND_NEWS_AUTHORIZATION?: string;
    IFIND_MARKET_MCP_URL?: string;
    IFIND_NEWS_MCP_URL?: string;
    AI_API_BASE_URL?: string;
    AI_API_KEY?: string;
    AI_MODEL?: string;
  }
}
