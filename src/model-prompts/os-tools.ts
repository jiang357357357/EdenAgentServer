export const osToolDescriptions: Record<string, string> = {
  recall_search: '搜索长期记忆和向量集合。', recall_add_memory: '添加一条长期记忆和向量文档。',
  recall_add_memories: '批量添加长期记忆和向量文档。', recall_delete_memories: '按元数据条件删除长期记忆和向量文档。',
  memo_create: '创建备忘录或待办事项，due_at 使用 ISO 时间。', memo_update: '编辑备忘录或待办事项。',
  memo_complete: '标记备忘录或待办事项为已完成。', memo_delete: '物理删除备忘录或待办事项。', memo_list: '列出备忘录或待办事项。',
  search_music: '搜索聚合音乐，返回可供播放的歌曲链接。', list_music_platforms: '返回本机音乐服务支持的平台。',
  play_music: '播放 search_music 返回的音乐链接。', email_status: '查看外部邮箱是否已配置并可用于发信。',
  email_send: '使用 Core 当前默认外部邮箱账号发送邮件。',
}
