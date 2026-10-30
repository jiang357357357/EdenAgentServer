import path from 'node:path'
import { SharedDirectorySelection, type SharedDirectoryAccess, type SharedDirectorySnapshot } from './directory-selection.ts'
import type { SharedPostureSelection } from './posture-selection.ts'

/** Separate local synchronization selections, preserving the existing LAN record. */
export class SharedPostureDirectories implements SharedDirectoryAccess {
  private readonly lan: SharedDirectorySelection
  private readonly cloud: SharedDirectorySelection
  constructor(root: string, accountKey: string, private readonly posture: SharedPostureSelection) {
    this.lan = new SharedDirectorySelection(path.join(root, 'selected-directory.json'), accountKey)
    this.cloud = new SharedDirectorySelection(path.join(root, 'selected-directory-cloud.json'), accountKey)
  }
  private selected() { return this.posture.read().mode === 'lan' ? this.lan : this.cloud }
  read(): SharedDirectorySnapshot {
    const saved = this.selected().read()
    return { ...saved, revision: `${this.posture.read().revision}:${saved.revision}` }
  }
  select(root: string, expectedRevision: string): SharedDirectorySnapshot {
    if (this.read().revision !== expectedRevision) throw new Error('共享目录或姿态已改变，请刷新后重试')
    const selection = this.selected()
    selection.select(root, selection.read().revision)
    return this.read()
  }
  assert(snapshot: SharedDirectorySnapshot) {
    const current = this.read()
    if (current.path !== snapshot.path || current.revision !== snapshot.revision || current.status !== snapshot.status)
      throw new Error('共享目录或姿态在操作期间发生变化，请重新提交')
  }
  seedExisting(roots: string[]) { if (this.posture.read().mode === 'lan') this.lan.seedExisting(roots) }
}
