/**
 * 宿主自有模型提示词清单。具体文本按领域存放在本目录；工具描述与工具定义同处，
 * 第三方插件、技能、MCP 和连接器提供的原始说明不在宿主中文化范围内。
 */
export const HOST_PROMPT_DOMAINS = [
  'session',
  'actors',
  'director',
  'memory',
  'self-awake',
  'handoff',
  'jobs',
  'plugin-hooks',
  'connectors',
  'tool-descriptions',
  'skills',
  'subagents',
  'plugin-development',
] as const
