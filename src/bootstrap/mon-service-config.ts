import { existsSync, readFileSync, accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { modelEndpointSchema } from '@eden/api'

const filePath = z.string().trim().min(1).max(4096)
const configSchema = z.object({ deploymentRoot: filePath.optional(), authFile: filePath, coreBaseUrl: modelEndpointSchema,
  scheduleStateFile: filePath.optional() }).strict()

function readable(filename: string, configFile: string, field: string) {
  try { accessSync(filename, constants.R_OK); if (!statSync(filename).isFile()) throw new Error('not a file') }
  catch { throw new Error(`Mon 配置 ${configFile} 的 ${field} 不存在、不是文件或不可读：${filename}；请修正部署路径`) }
}

function validateIdentity(env: NodeJS.ProcessEnv, source: string) {
  const missing = ['MON_SERVICE_SHARED_SECRET', 'MON_SERVICE_USER_ID'].filter(key => !env[key]?.trim())
  if (missing.length) throw new Error(`Mon 认证配置 ${source} 缺少 ${missing.join('、')}；认证字段必须来自同一套部署`)
}

/** Explicit realm-local references avoid choosing a different installed Mon account. */
export function monServiceConfig(origin: 'mon' | 'local', dataRoot: string, env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; scheduleStateFile?: string | undefined } {
  if (origin !== 'mon') return { env }
  // An explicit environment identity overrides the entire file binding, including stale paths.
  if (env.MON_SERVICE_SHARED_SECRET !== undefined || env.MON_SERVICE_USER_ID !== undefined) {
    validateIdentity(env, '环境变量'); return { env }
  }
  const filename = path.join(dataRoot, 'mon-service.json')
  if (!existsSync(filename)) return { env }
  let config: z.infer<typeof configSchema>
  try { config = configSchema.parse(JSON.parse(readFileSync(filename, 'utf8'))) }
  catch { throw new Error(`Mon 服务配置无法读取或格式无效：${filename}；请检查 deploymentRoot、authFile、coreBaseUrl 和 scheduleStateFile`) }
  const root = path.resolve(path.dirname(filename), config.deploymentRoot ?? '.')
  const authFile = path.resolve(root, config.authFile)
  readable(authFile, filename, 'authFile')
  let auth: NodeJS.ProcessEnv
  try { auth = parseEnv(readFileSync(authFile, 'utf8')) }
  catch { throw new Error(`Mon 认证文件无法解析：${authFile}`) }
  validateIdentity(auth, authFile)
  const scheduleStateFile = config.scheduleStateFile ? path.resolve(root, config.scheduleStateFile) : undefined
  if (scheduleStateFile) readable(scheduleStateFile, filename, 'scheduleStateFile')
  return { env: { ...env, MON_SERVICE_SHARED_SECRET: auth.MON_SERVICE_SHARED_SECRET,
    MON_SERVICE_USER_ID: auth.MON_SERVICE_USER_ID, MON_CORE_BASE_URL: env.MON_CORE_BASE_URL ?? config.coreBaseUrl },
    scheduleStateFile }
}
