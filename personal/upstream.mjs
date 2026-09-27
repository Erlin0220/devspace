import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function readUpstreamBaseline(root = repositoryRoot) {
  const value = JSON.parse(await readFile(join(root, 'personal', 'upstream.json'), 'utf8'));
  if (typeof value?.version !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(value.tag ?? '')
      || !/^[a-f0-9]{40}$/.test(value.commit ?? '')) {
    throw new Error('Invalid Personal upstream baseline');
  }
  return value;
}
