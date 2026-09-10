# Eden Agent Server

Eden Agent 的 TypeScript / Node.js 宿主，包含业务模块、JSON-RPC 服务及官方连接器插件。

本仓库作为主项目的 `Server/` Git 子模块使用。共享基础包位于主项目 `packages/`，构建脚本、锁文件和工程约束也由主项目管理；单独克隆本仓库不构成完整构建环境。

## 开发

```sh
git clone --recurse-submodules https://github.com/jiang357357357/opencode-assistant.git
cd opencode-assistant
npm ci --ignore-scripts
npm run build:server
```

在主项目根目录运行类型检查和测试：

```sh
npm run typecheck:server
npm run test:server
```

修改服务端后先在本仓库提交并推送，再在主项目提交 `Server` 子模块指针。共享 SDK 等改动需要与主项目配套提交。

## 历史

当前 TS 实现在原 Rust 仓库历史之上继续提交。旧版本由主项目 `Archive/2026-09-09-rust-runtime/Server` 固定到原提交，不随当前 Server 更新。
