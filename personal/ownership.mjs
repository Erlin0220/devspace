import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const ownerId = home => createHash('sha256')
  .update(process.platform === 'win32' ? resolve(home).toLowerCase() : resolve(home))
  .digest('hex')
  .slice(0, 20);
