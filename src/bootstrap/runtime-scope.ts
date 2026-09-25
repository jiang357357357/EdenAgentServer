import { AccountAuthentication } from "../modules/accounts/index.ts"
import { recoverSessionOwners } from "../modules/accounts/index.ts"
import { UiPreferenceRepository } from "../modules/ui-preferences/index.ts"
import { uiPreferenceRoutes } from "../transport/rpc/ui-preferences.routes.ts"
import { operationRoutes } from "../transport/rpc/operation.routes.ts"
import { commandRoutes } from "../transport/rpc/command.routes.ts"
import { mcpRoutes } from "../transport/rpc/mcp.routes.ts"
import { connectorRoutes } from "../transport/rpc/connector.routes.ts"
import { mediaRoutes } from "../transport/rpc/media.routes.ts"
import { voiceRoutes } from "../transport/rpc/voice.routes.ts"
import { subagentRoutes } from "../transport/rpc/subagent.routes.ts"
import { pluginAssetRoutes } from "../transport/rpc/plugin-assets.routes.ts"
import { pluginMarketRoutes } from "../transport/rpc/plugin-market.routes.ts"
import { skillRoutes } from "../transport/rpc/skill.routes.ts"
import { SelfAwakeHttp } from "../transport/http/self-awake.ts"
import { QqChannelHttp } from "../transport/http/qq-channel.ts"
import { notificationRoutes } from "../transport/rpc/notification.routes.ts"
import { selfAwakeRoutes } from "../transport/rpc/self-awake.routes.ts"
import { jobRoutes } from "../transport/rpc/job.routes.ts"
import { memoRoutes } from "../transport/rpc/memo.routes.ts"
import { EdenDatabase } from "@eden/store"
import { rpcMethods } from "@eden/api"
import { contractHandler } from "../transport/rpc/contract-handler.ts"
import type { ServerConfig } from "./config.ts"
import { acquireProcessLock } from "./process-lock.ts"
import { pluginRoutes } from "../transport/rpc/plugin.routes.ts"
import { permissionRoutes } from "../transport/rpc/permission.routes.ts"
import { workspaceRoutes } from "../transport/rpc/workspace.routes.ts"
import { modelRoutes } from "../transport/rpc/model.routes.ts"
import { directorRoutes } from "../transport/rpc/director.routes.ts"
import { questionRoutes } from "../transport/rpc/question.routes.ts"
import { createServices } from "./services.ts"
import { BlobHttp } from "../transport/http/blobs.ts"
import { healthHandler } from "../transport/http/health.ts"
import { memoryExtractionRoutes } from "../transport/rpc/memory-extraction.routes.ts"

export async function openRuntime(config: ServerConfig) {
  const releaseProcessLock = acquireProcessLock(config.dataRoot)
  const releaseLock = releaseProcessLock
  let database: EdenDatabase
  try {
    database = new EdenDatabase(config.databasePath, config.origin)
  } catch (error) {
    releaseLock()
    throw error
  }
  if (config.origin === "mon" && !config.account) {
    try {
      await recoverSessionOwners(
        database,
        new AccountAuthentication(config.monIdentity?.coreBaseUrl ?? "http://127.0.0.1:40011"),
        config.monIdentity?.userId,
      )
    } catch (error) {
      database.close()
      releaseLock()
      throw error
    }
  }
  if (config.account) {
    database.connection
      .prepare("INSERT OR IGNORE INTO realm_meta(key,value) VALUES('account_key',?)")
      .run(config.account.key)
    if (
      database.connection.prepare("SELECT value FROM realm_meta WHERE key='account_key'").get()?.value !==
      config.account.key
    ) {
      database.close()
      releaseLock()
      throw new Error("Account database identity mismatch")
    }
  }
  let services: ReturnType<typeof createServices>
  try {
    services = createServices(database, config)
  } catch (error) {
    database.close()
    releaseLock()
    throw error
  }
  const { plugins, permissions, sessions, workspace, models, mon, directors, companion, questions, memoryExtractions } =
    services
  const selfAwakeHttp = new SelfAwakeHttp(config.origin, services.selfAwakeBridge)
  const qqChannelHttp = new QqChannelHttp(config.origin, services.qqChannelBridge)
  const blobHttp = new BlobHttp(services.blobs, config)
  const drainServices = () => {
    services.realtimeVoice.close()
    services.scheduler.close()
    services.pluginHooks.close()
    services.selfAwake.close()
    return Promise.allSettled([
      services.mcpResults.close(),
      services.mcp.close(),
      services.connectorLifecycle.close(),
      services.speech.close(),
      services.voice.close(),
      services.subagentLifecycle.close(),
      services.packageAssets.close(),
      services.pluginMarket.close(),
      services.skills.close(),
      selfAwakeHttp.close(),
      qqChannelHttp.close(),
      services.selfAwakeActions.close(),
      memoryExtractions.close(),
      blobHttp.close(),
      plugins.close(),
      sessions.close(),
      mon.close(),
      companion.close(),
      Promise.resolve().then(() => services.media.close()),
      Promise.resolve().then(() => questions.close()),
    ])
  }
  const health = healthHandler(config.origin, () => ({
    model: Boolean(config.model),
    sessionFaults: sessions.faultCount(),
    memoryExtraction: memoryExtractions.fault === undefined,
    jobs: services.scheduler.fault === undefined,
    pluginHooks: services.pluginHooks.fault === undefined,
    subagents: services.subagentLifecycle.fault === undefined,
    selfAwake: services.selfAwake.fault === undefined && services.selfAwakeActions.fault === undefined,
  }))
  const routes = {
    "memo.job.resubmit": contractHandler(rpcMethods["memo.job.resubmit"], (input) =>
      services.memoJobRecovery.resubmit(input.id, input.expectedUpdatedAt, input.note),
    ),
    "plugin.hook.resubmit": contractHandler(rpcMethods["plugin.hook.resubmit"], (input) =>
      services.pluginHooks.resubmit(input.id, input.expectedUpdatedAt, input.note),
    ),
    "runtime.status": contractHandler(rpcMethods["runtime.status"], () => ({
      mode: "runtime",
      runtimeOrigin: config.origin,
      automaticExecution: true,
    })),
    ...operationRoutes(services.repository),
    ...commandRoutes(services.commands),
    ...mcpRoutes(services.mcp, database, services.mcpResults),
    ...connectorRoutes(
      services.connectorCatalog,
      services.connectors,
      services.connectorEvents,
      services.connectorPermissions,
      services.connectorCredentials,
    ),
    ...mediaRoutes(services.media),
    ...voiceRoutes(services.voiceConfig, services.voice, services.speech),
    ...subagentRoutes(services.subagents),
    ...memoryExtractionRoutes(memoryExtractions),
    ...memoRoutes(services.memos, services.memoNotifications),
    ...uiPreferenceRoutes(new UiPreferenceRepository(database)),
    ...notificationRoutes(services.desktopReminders),
    ...selfAwakeRoutes(services.selfAwake.repository, services.selfAwakeActions, services.selfAwake),
    ...directorRoutes(directors),
    ...jobRoutes(services.jobs),
    ...questionRoutes(questions),
    ...pluginAssetRoutes(services.packageAssets),
    ...pluginMarketRoutes(services.pluginMarket),
    ...skillRoutes(services.skills),
    ...pluginRoutes(plugins, services.pluginMarket.installed),
    ...permissionRoutes(permissions),
    ...workspaceRoutes(workspace, sessions),
    ...modelRoutes(models, sessions, config.origin === "mon" ? mon : undefined),
  }
  let closing: Promise<void> | undefined
  return {
    config,
    database,
    services,
    routes,
    blobHttp,
    selfAwakeHttp,
    qqChannelHttp,
    health,
    async start() {
      try {
        await services.skills.start()
        await memoryExtractions.start()
        await services.subagentLifecycle.start()
        sessions.resumePending()
        services.memos.recoverSchedules()
        services.selfAwakeActions.start()
        services.selfAwake.start()
        services.pluginHooks.start()
        services.scheduler.start()
        services.mon.startSync()
        services.mcp.start()
        services.connectorLifecycle.start()
      } catch (error) {
        await this.close()
        throw error
      }
    },
    close(): Promise<void> {
      closing ??= (async () => {
        const drained = await drainServices()
        database.close()
        releaseLock()
        const failures = drained.filter((result) => result.status === "rejected")
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Account runtime shutdown failed",
          )
      })()
      return closing
    },
  }
}
export type RuntimeScope = Awaited<ReturnType<typeof openRuntime>>
