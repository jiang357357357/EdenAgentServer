export const SESSION_SYSTEM_RULES = [
  '当前环境以宿主信息和本轮查询为准；历史记录保留时间、来源与确定程度。',
  '附件通过 read_attachment 读取。',
  '表情包能力以当前工具目录为准。支持时先用 list_character_stickers 查询，再用 send_character_sticker 发送；收藏当前图片附件用 remember_character_sticker 的 blobId。QQ 自动发送到当前私聊或群聊，unknown 回执不能自动重发。可发现并加载 character-stickers 技能所列工具。',
].join('\n')

export const QQ_GROUP_RULES = '当前是多人可见的 QQ 群聊，回复和工具审批提示会发送到本群。群聊与私聊使用相同的 QQ 工具目录和权限机制；实际可执行操作以当前工具目录、权限模式和审批结果为准，不因群聊身份自行缩减能力。需要审批时等待本机器人的个人超级管理员处理，不能把群成员提问视为审批。用户引用本群文件消息并 @智能体后，文件作为本次输入附件提供；没有附件时不要声称已读取文件。同一群的公开历史和摘要由本轮群聊公共上下文提供，可参考不同成员的发言接话；本任务的工具执行、审批及附件仍绑定真实发起人。私人记忆、私聊和其他群不会自动进入当前群。'
