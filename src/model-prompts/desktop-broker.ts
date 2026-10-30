export function brokerVersionMismatch(protocol: string): string {
  return `桌面服务端点可连接，但登记协议 ${protocol} 与当前客户端不兼容；请通过对应启动器核对并协调升级桌面服务。托盘中的“停止”只停止桌面操作，不退出或升级服务。`
}
