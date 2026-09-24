import type { RuntimeOrigin } from "@eden/api"

export type AccountStartupStage =
  | "account.metadata"
  | "account.import"
  | "account.services"
  | "account.background"

export class AccountStartupError extends Error {
  constructor(
    readonly stage: AccountStartupStage,
    cause: unknown,
  ) {
    super(`Account startup failed during ${stage}`, { cause })
    this.name = "AccountStartupError"
  }
}

function sensitiveMessage(message: string): string {
  return message
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, "$1[redacted]")
    .replace(/([?&](?:access_?token|token|api_?key|password|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[digest]")
    .slice(0, 800)
}

function failureReason(error: unknown): { reason: string; errorName: string; errorCode?: string; message: string } {
  const source = error instanceof AccountStartupError ? error.cause : error
  const message = source instanceof Error ? source.message : String(source)
  const known = new Map<string, string>([
    ["Persisted account directory identity mismatch", "persisted_directory_identity_mismatch"],
    ["Invalid account runtime identity", "invalid_account_identity"],
    ["Account partition identity mismatch", "partition_identity_mismatch"],
    ["Historical attachment file is missing; account import was not committed", "historical_attachment_missing"],
    ["Account import contains unresolved references", "unresolved_references"],
    ["Invalid historical blob digest", "invalid_historical_blob_digest"],
  ])
  const code =
    source && typeof source === "object" && "code" in source && typeof source.code === "string"
      ? source.code.slice(0, 80)
      : undefined
  return {
    reason: known.get(message) ?? "account_runtime_error",
    errorName: source instanceof Error ? source.name : "UnknownError",
    ...(code ? { errorCode: code } : {}),
    message: sensitiveMessage(message),
  }
}

export function startupStage(origin: RuntimeOrigin, stage: string, accountDirectory?: string): string {
  return JSON.stringify({
    event: "server.startup",
    origin,
    stage,
    pid: process.pid,
    time: new Date().toISOString(),
    ...(accountDirectory ? { account: accountDirectory.slice(0, 12) } : {}),
  })
}

export function accountStartupFailure(
  origin: RuntimeOrigin,
  fallbackStage: AccountStartupStage | "account.resume",
  accountDirectory: string,
  error: unknown,
): string {
  return JSON.stringify({
    event: "server.account.failure",
    origin,
    stage: error instanceof AccountStartupError ? error.stage : fallbackStage,
    account: accountDirectory.slice(0, 12),
    pid: process.pid,
    time: new Date().toISOString(),
    retainedForRecovery: true,
    ...failureReason(error),
  })
}
