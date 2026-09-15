# Agent Server 测试结构

Server 测试使用 Node.js 内置 `node:test`，TypeScript 由 `tsx` 加载。根仓库的
`Script/Test/run_typescript_tests.mjs` 负责递归发现测试，因此分层目录中的
`*.test.ts` 与历史顶层测试都会被执行。

## 目录约定

```text
tests/
├── fixtures/       # 无副作用的共享夹具与测试替身
├── helpers/        # 测试专用构造器、断言和临时资源管理
├── unit/           # 单模块、纯逻辑或窄边界测试
├── integration/    # 跨模块、存储、RPC、连接器和运行时协作测试
├── contracts/      # API、插件、工具 schema 与兼容性契约
├── regression/     # 难以归入单模块的历史缺陷回归
└── *.test.ts       # 待逐步迁移的兼容区
```

`unit/`、`integration/` 和 `contracts/` 下继续按 `src/modules` 的业务名称分组，
例如 `unit/mon/device-tools.test.ts`。新测试不得继续放在顶层兼容区。

## 边界

- 单元测试不访问真实网络、用户数据库或常驻服务。
- 集成测试使用独立临时目录、临时数据库和可回收进程。
- 真实外部服务或设备测试必须使用显式的 live 命令，不进入默认 CI。
- 通用夹具放入 `fixtures/`；只有具备复用价值时才增加 `helpers/`。
- 文件必须以 `.test.ts`、`.test.mts`、`.test.js`、`.test.mjs` 等受支持后缀命名。

## 入口

- `npm run test:server`：构建官方连接器后，递归运行 packages 与 Server 测试。
- `npm run test:architecture`：检查架构规则和测试发现器本身。
- `npm run test:command-live`：显式运行需要本机命令能力的 live 测试。

测试发现器会打印各根目录发现数量，并在没有发现任何测试时失败。新增目录不需要
再修改 `package.json` glob。

