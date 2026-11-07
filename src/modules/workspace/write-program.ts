export const writeProgram = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
// Match local-file-target.ts in the host; the worker also checks redirects after approval.
async function resolveTarget(filename) {
  if (filename.includes('\0')) throw new Error('Invalid file path');
  let existing = filename;
  const missing = [];
  for (;;) {
    try {
      const canonical = await fs.realpath(existing);
      if (missing.length && !(await fs.stat(canonical)).isDirectory()) throw new Error('File parent is not a directory');
      return path.join(canonical, ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await fs.lstat(existing);
        throw new Error('File path contains a dangling symbolic link');
      } catch (missingError) { if (missingError.code !== 'ENOENT') throw missingError; }
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}
export default async function({ request: input, approvedTarget }, context) {
  const root = context.workspaceRoot;
  const within = name => { const relative = path.relative(root, name); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  const requested = path.resolve(root, input.path);
  const filename = await resolveTarget(requested);
  if (approvedTarget !== undefined) {
    if (filename !== approvedTarget) throw new Error('File target changed after permission request');
  } else if (!within(requested) || !within(filename)) throw new Error('Write path escapes workspace');
  let old, mode = 0o600;
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Existing file is not a small regular file');
    old = await fs.readFile(filename);
    mode = stat.mode & 0o777;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (input.expectedSha256 && (!old || hash(old) !== input.expectedSha256)) throw new Error('File changed since it was read');
  if (input.createOnly && old !== undefined) throw new Error('File already exists');
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(path.dirname(filename));
  if (parent !== path.dirname(filename) || await resolveTarget(requested) !== filename) throw new Error('File target changed after permission request');
  const temporary = path.join(parent, '.eden-write-' + randomUUID());
  try {
    await fs.writeFile(temporary, input.content, { mode, flag: 'wx' });
    if (input.createOnly) { await fs.link(temporary, filename); await fs.unlink(temporary); }
    else await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
  return { path: input.path, bytes: Buffer.byteLength(input.content), sha256: hash(input.content) };
}
`
