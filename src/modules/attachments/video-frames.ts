import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '@eden/execution'

/** A bounded visual preview; audio and the remainder of a long clip are not represented. */
export async function videoFrames(bytes: Buffer, signal: AbortSignal) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'eden-video-frames-'))
  try {
    const source = path.join(directory, 'input.mp4')
    await writeFile(source, bytes, { mode: 0o600 })
    let result
    try {
      result = await runProcess({ executable: 'ffmpeg', args: ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source,
        '-an', '-vf', 'fps=1/5,scale=640:-2:force_original_aspect_ratio=decrease', '-frames:v', '3', '-q:v', '6',
        path.join(directory, 'frame-%02d.jpg')], input: '', timeoutMs: 30000, maxOutputBytes: 65536, signal })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('视频预览需要本机安装 FFmpeg 并加入 PATH')
      throw error
    }
    if (result.exitCode !== 0) throw new Error(`视频解码失败：${result.stderr.slice(0, 2000)}`)
    const names = (await readdir(directory)).filter(name => /^frame-\d\d\.jpg$/.test(name)).sort().slice(0, 3)
    if (!names.length) throw new Error('视频中没有可提取的画面')
    const frames = []
    for (const [index, name] of names.entries()) {
      signal.throwIfAborted()
      const image = await readFile(path.join(directory, name))
      frames.push({ timeSeconds: index * 5, data: image.toString('base64') })
    }
    return frames
  } finally { await rm(directory, { recursive: true, force: true }) }
}
