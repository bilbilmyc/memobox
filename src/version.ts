import packageInfo from "../package.json";
/** CLI、MCP 共用 npm 包版本，防止手动常量漂移。 */
export const VERSION = packageInfo.version;
