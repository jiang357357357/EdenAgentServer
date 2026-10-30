import path from 'node:path'

/** Local-world models are downloaded separately and never borrowed from Core. */
export function defaultMemoryModelPath(dataRoot: string): string {
  return path.resolve(dataRoot, 'models/bge-small-zh-v1.5')
}
