/**
 * Atomic file writes: a run that dies halfway must never leave a truncated
 * feed or manifest behind for the CDN to serve.
 *
 * Write to a sibling temp file, fsync it, then rename over the target. Rename
 * within a directory is atomic on POSIX, so readers see either the old complete
 * file or the new complete file and never a partial one.
 */

import { open, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function writeFileAtomic(targetPath, contents) {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);

  let handle;
  try {
    handle = await open(tempPath, 'wx');
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle?.close();
  }

  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

/** Stable key order and a trailing newline keep diffs and caching predictable. */
export async function writeJsonAtomic(targetPath, value) {
  await writeFileAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}
