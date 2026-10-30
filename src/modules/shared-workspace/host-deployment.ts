import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostAdministrator } from './contracts.ts'

async function templateFile(name: string) {
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(directory, name), path.resolve(directory, '../../../../dist/server', name)]
  let template: string | undefined
  for (const filename of candidates) {
    try {
      const info = await stat(filename)
      if (!info.isFile() || info.size > 512 * 1024) throw new Error('共享主机运行模板大小无效')
      template = await readFile(filename, 'utf8')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!template) throw new Error('共享主机运行模板尚未构建，请更新配套 AgentServer')
  return template
}

export async function createHostDeployment(administrator: HostAdministrator) {
  const template = await templateFile('shared-workspace-host.mjs')
  const setup = Buffer.from(JSON.stringify({ schemaVersion: 1, capability: 'workspace.publish.v2', administrators: [administrator] })).toString('base64url')
  const content = `// EDEN SharedWorkspace host. Deploying client identity: public key only.\nprocess.env.EDEN_SHARED_HOST_BOOTSTRAP = '${setup}';\n${template}`
  return { fileName: 'eden-shared-host.mjs' as const, contentBase64: Buffer.from(content).toString('base64'),
    command: 'node ./eden-shared-host.mjs --data ./shared-host-data --public-address http://主机IP:40195' }
}

export function hostInstallerTemplate() { return templateFile('shared-workspace-install.mjs') }
