export const STICKER_GUIDE = `# 角色表情包
先用 list_character_stickers 查询当前角色的表情库，再用 send_character_sticker 发送。库存以本次查询为准，不沿用旧记忆中的数量。
需要新素材时，可用 web_search、browser_inspect 等当前可用工具寻找图片链接，再用 remember_character_sticker 收藏。imageUrl 可来自联网查找或用户提供的真实 HTTP(S) 图片地址；附件先用 read_attachment 获取本轮 blobId。两种来源只选一种。
收藏时填写名称、画面描述、情绪、用途和别名。支持 PNG/JPEG/GIF/WebP，最多 10 MiB。删除用 delete_character_sticker。
不确定工具是否可用时先查 list_tools；需要参数再用 load_tools 查看。权限由宿主审批判断，不因说明未展开就说“没有权限”。
App 与 QQ 共用当前角色的库，发送到当前会话；群操作按宿主授权执行。发送以工具回执为准，success 不代表已读；unknown 先核实，不自动重发。表情包可配合文字回应。
`
