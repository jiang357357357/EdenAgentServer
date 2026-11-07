import type { JsonValue } from '@eden/api'

export function connectorEventContext(eventId: string): string {
  return `请通过连接器工具读取并处理事件 ${eventId}。`
}

export function connectorEventPrompt(request: JsonValue): string {
  return `连接器产生了新事件。先用 read_connector_events 按 eventId 读取详情，从结果取得 connectorId；调用 list_connectors({connectorId}) 查看该实例声明的 queries、actions 和输入结构。根据实际任务使用声明的能力名：先查询当前状态，再决定是否执行动作，不要猜测未声明的能力。需要时用 load_tools 加载工具说明。写操作结果未知时不要盲目重试；只有确有需要时才与用户联系，不要仅为触发事件发送聊天消息。事件信息：${JSON.stringify(request)}`
}
