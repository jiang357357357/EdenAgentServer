import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { modelEndpointSchema } from '@eden/api'

const absolutePath = z.string().min(1).refine(path.isAbsolute, 'Expected an absolute path')
const configSchema = z.object({ authFile: absolutePath, coreBaseUrl: modelEndpointSchema,
  scheduleStateFile: absolutePath.optional() }).strict()

/** Explicit realm-local references avoid choosing a different installed Mon account. */
export function monServiceConfig(origin: 'mon' | 'local', dataRoot: string, env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; scheduleStateFile?: string | undefined } {
  if (origin !== 'mon') return { env }
  const filename = path.join(dataRoot, 'mon-service.json')
  if (!existsSync(filename)) return { env }
  const config = configSchema.parse(JSON.parse(readFileSync(filename, 'utf8')))
  // Explicit environment identity must stay an atomic override, not mix two accounts.
  if (env.MON_SERVICE_SHARED_SECRET || env.MON_SERVICE_USER_ID) return { env }
  const auth = parseEnv(readFileSync(config.authFile, 'utf8'))
  return { env: { ...env, MON_SERVICE_SHARED_SECRET: auth.MON_SERVICE_SHARED_SECRET,
    MON_SERVICE_USER_ID: auth.MON_SERVICE_USER_ID, MON_CORE_BASE_URL: env.MON_CORE_BASE_URL ?? config.coreBaseUrl },
    scheduleStateFile: config.scheduleStateFile }
}
