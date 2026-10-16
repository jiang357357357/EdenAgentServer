export const sharedWorkspaceUsage = `# 共享资料库
共享资料库内置于伊甸园，无需连接器或 MCP。目录由用户在共享资料库页面独立选择、绑定和修改权限，与会话工作区分开。
用 query_shared_workspace 查询：action=status 查看目录、绑定和同步状态，action=spaces 查看可见资料库，action=files 查看所选目录绑定库的同步索引。
文件通过 read_shared_file、write_shared_file、edit_shared_file 读写，path 为库内相对路径，无需切换工作区；读取支持字节 offset/limit 分页。
删除或重命名普通文件使用 delete_shared_file、rename_shared_file，要求编辑权限、审批和版本校验。仅支持 1 MiB 以内文件，不递归删除目录，也不覆盖已有目标。
删除和重命名会传播给资料库成员。工具先保存不参与同步的独立副本，恢复使用 restore_shared_file 的 recoveryId；恢复不覆盖现有文件，重命名后的新路径仍保留。
已同步表示完成过同步，空库也可以已同步；索引存在不保证文件已下载，实际读取以工具结果为准。
替换或编辑前读取当前内容，失败后读取最新内容再决定是否重试；提交时宿主检查编辑权限、审批、文件版本及目录绑定。
本地写入成功不代表对端收到；用 query_shared_workspace 核实同步、离线、暂停或冲突状态。`
