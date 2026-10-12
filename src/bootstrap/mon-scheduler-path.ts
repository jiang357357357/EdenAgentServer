import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const moduleSchema = z.object({ id: z.string(), root: z.string().trim().min(1), config: z.string().trim().min(1).default('.monconfig') })
const workspaceSchema = z.object({ modules: z.array(moduleSchema).default([]) })

/** Both source and portable installations declare their own MonOs module here. */
export function workspaceSchedulerStateFile(workspaceRoot: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!workspaceRoot) return undefined
  const root = path.resolve(workspaceRoot), manifest = path.join(root, '.monworkspace')
  if (!existsSync(path.join(root, '.monconfig')) || !existsSync(manifest)) throw new Error('Mon 服务认证必须来自已锚定的当前工作区')
  let modules: z.infer<typeof moduleSchema>[]
  try { modules = workspaceSchema.parse(JSON.parse(readFileSync(manifest, 'utf8'))).modules }
  catch { throw new Error(`Mon 模块清单无法读取或格式无效：${manifest}`) }
  const schedulers = modules.filter(module => module.id === 'baseos')
  if (!schedulers.length) return undefined
  if (schedulers.length !== 1) throw new Error(`Mon 模块清单存在重复的 baseos：${manifest}`)
  const module = schedulers[0]!, moduleRoot = realpathSync(path.resolve(root, module.root))
  const configFile = path.resolve(moduleRoot, module.config)
  const configured = monOsDataDirectory(configFile)
  // This is the same override and relative-path base used by MonOs AppConfig.
  const directory = env.MONOS_DATA_DIR ?? configured ?? 'Data/SelfAwake'
  if (!directory.trim()) throw new Error(`MonOs 自醒 DATA_DIR 不得为空：${configFile}`)
  return path.join(path.resolve(moduleRoot, directory), 'state.json')
}

/** Preserve MonOs INI semantics, including comments, case and relative paths. */
function monOsDataDirectory(filename: string): string | undefined {
  let contents: string
  try { contents = readFileSync(filename, 'utf8') }
  catch { throw new Error(`无法读取当前工作区的 MonOs 配置：${filename}`) }
  let section = '', directory: string | undefined
  for (const [index, raw] of contents.split(/\r?\n/).entries()) {
    const line = stripComment(raw).trim()
    if (!line) continue
    if (line.startsWith('[')) {
      if (!line.endsWith(']') || !line.slice(1, -1).trim()) throw new Error(`MonOs 配置节格式无效：${filename}:${index + 1}`)
      section = line.slice(1, -1).trim().toLowerCase()
      continue
    }
    const equals = line.indexOf('=')
    if (equals < 1 || !line.slice(0, equals).trim()) throw new Error(`MonOs 配置需要 KEY=VALUE：${filename}:${index + 1}`)
    if (section === 'self_awake' && line.slice(0, equals).trim().toUpperCase() === 'DATA_DIR') directory = line.slice(equals + 1).trim()
  }
  return directory
}

function stripComment(line: string): string {
  let single = false, double = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (character === "'" && !double) single = !single
    else if (character === '"' && !single) double = !double
    else if ((character === '#' || character === ';') && !single && !double && (index === 0 || /\s/.test(line[index - 1]!))) return line.slice(0, index)
  }
  return line
}
