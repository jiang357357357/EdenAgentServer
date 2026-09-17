import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, renameSync, lstatSync } from "node:fs"
import path from "node:path"
import { EdenDatabase } from "@eden/store"
import {
  AccountAuthentication,
  accountKey,
  recoverSessionOwners,
  importAccountPartition,
  withoutAccount,
  type Account,
} from "../modules/accounts/index.ts"
import type { ServerConfig } from "./config.ts"
import { openRuntime, type RuntimeScope } from "./runtime-scope.ts"

export class AccountRuntimes {
  private readonly runtimes = new Map<string, Promise<RuntimeScope>>()
  private readonly privateDataRoots: string[] = []
  private readonly failedAccounts = new Set<string>()
  private closed = false
  private local: RuntimeScope | undefined
  readonly authentication: AccountAuthentication | undefined
  constructor(readonly config: ServerConfig) {
    this.authentication =
      config.origin === "mon"
        ? new AccountAuthentication(config.monIdentity?.coreBaseUrl ?? config.coreBaseUrl ?? "http://127.0.0.1:40011")
        : undefined
  }
  async start(): Promise<void> {
    if (!this.authentication) {
      this.local = await openRuntime(this.config)
      await this.local.start()
      return
    }
    this.stage("legacy.database")
    if (existsSync(this.config.databasePath)) {
      const legacy = new EdenDatabase(this.config.databasePath, "mon")
      try {
        this.stage("legacy.ownership")
        await recoverSessionOwners(legacy, this.authentication, this.config.monIdentity?.userId)
      } finally {
        legacy.close()
      }
    }
    const directory = path.join(this.config.dataRoot, "accounts")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const entries = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name),
    )
    this.privateDataRoots.push(...entries.map((entry) => path.join(directory, entry.name, "storage")))
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
      const filename = path.join(directory, entry.name, "account.json")
      if (!existsSync(filename)) continue
      try {
        const account = JSON.parse(readFileSync(filename, "utf8")) as Account
        this.validate(account)
        if (this.directoryKey(account) !== entry.name) throw new Error("Persisted account directory identity mismatch")
        await this.get(account)
      } catch {
        this.failedAccounts.add(entry.name)
        process.stderr.write(`Account runtime ${entry.name} could not resume; its data was retained for recovery.\n`)
      }
    }
    if (this.config.monIdentity)
      await this.get(this.serviceAccount()!).catch(() => {
        process.stderr.write("Service account runtime could not resume; other accounts remain available.\n")
      })
  }
  serviceAccount(): Account | undefined {
    const identity = this.config.monIdentity
    if (!identity) return undefined
    return {
      key: accountKey(identity.coreBaseUrl, identity.userId),
      userId: identity.userId,
      coreBaseUrl: identity.coreBaseUrl,
    }
  }
  async resolve(token: string): Promise<RuntimeScope> {
    if (!this.authentication) return this.local!
    return this.get(await this.authentication.verify(token))
  }
  async get(account: Account): Promise<RuntimeScope> {
    if (this.closed) throw new Error("Host is closing")
    this.validate(account)
    let pending = this.runtimes.get(account.key)
    if (!pending) {
      pending = withoutAccount(() => this.open(account))
      this.runtimes.set(account.key, pending)
      void pending.catch(() => {
        this.failedAccounts.add(this.directoryKey(account))
        if (this.runtimes.get(account.key) === pending) this.runtimes.delete(account.key)
      })
    }
    return pending
  }
  private validate(account: Account) {
    if (
      typeof account.userId !== "string" ||
      !account.userId ||
      account.userId.length > 128 ||
      typeof account.coreBaseUrl !== "string" ||
      account.key !== accountKey(this.authentication!.coreBaseUrl, account.userId) ||
      account.key !== accountKey(account.coreBaseUrl, account.userId)
    )
      throw new Error("Invalid account runtime identity")
  }
  private directoryKey(account: Account) {
    return createHash("sha256").update(account.key).digest("hex")
  }
  private async open(account: Account): Promise<RuntimeScope> {
    const root = path.join(this.config.dataRoot, "accounts", this.directoryKey(account)),
      dataRoot = path.join(root, "storage")
    if (!this.privateDataRoots.includes(dataRoot)) this.privateDataRoots.push(dataRoot)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (lstatSync(root).isSymbolicLink()) throw new Error("Account directory cannot be redirected")
    this.stage("account.import")
    importAccountPartition(this.config.dataRoot, dataRoot, account)
    this.stage("account.services")
    const workspace = path.join(root, "workspace"),
      skills = path.join(root, "skills")
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    mkdirSync(skills, { recursive: true, mode: 0o700 })
    const metadata = path.join(root, "account.json")
    writeFileSync(metadata + ".tmp", JSON.stringify(account), { mode: 0o600 })
    renameSync(metadata + ".tmp", metadata)
    const service = this.serviceAccount()?.key === account.key
    const config: ServerConfig = {
      ...this.config,
      account,
      dataRoot,
      databasePath: path.join(dataRoot, "eden-agent.db"),
      monIdentity: service ? this.config.monIdentity : undefined,
      selfAwakeScheduleFile: service ? this.config.selfAwakeScheduleFile : undefined,
      coreBaseUrl: this.authentication!.coreBaseUrl,
      defaultWorkspaceRoot: workspace,
      privateDataRoots: this.privateDataRoots,
      systemSkillRoots: [skills],
    }
    const runtime = await openRuntime(config)
    try {
      this.stage("account.background")
      await runtime.start()
      this.stage("account.ready")
    } catch (error) {
      this.failedAccounts.add(this.directoryKey(account))
      throw error
    }
    this.failedAccounts.delete(this.directoryKey(account))
    return runtime
  }
  private stage(stage: string): void {
    process.stdout.write(JSON.stringify({ event: 'server.startup', origin: this.config.origin, stage }) + '\n')
  }
  ready(): boolean {
    return !this.closed && this.failedAccounts.size === 0
  }
  defaultRuntime(): RuntimeScope {
    if (!this.local) throw new Error("Mon runtime must be selected by verified account identity")
    return this.local
  }
  async close(): Promise<void> {
    this.closed = true
    const pending = await Promise.allSettled([...this.runtimes.values()])
    const active = pending.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []))
    if (this.local) active.push(this.local)
    const results = await Promise.allSettled(active.map((runtime) => runtime.close()))
    const failures = results.filter((item) => item.status === "rejected")
    if (failures.length)
      throw new AggregateError(
        failures.map((item) => item.reason),
        "Account runtimes did not all close cleanly",
      )
  }
}
