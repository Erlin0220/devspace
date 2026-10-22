// Generates the single owner's private browser authorization code. Never prints
// it: only the server-side hash and a sealed envelope leave stdout.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, publicEncrypt, randomBytes, createCipheriv } from 'node:crypto';
import { sha256 } from './upstream.mjs';
const { values } = parseArgs({ options: { recipient: { type: 'string' }, rotate: { type: 'boolean', default: false } } });
const recipient = createPublicKey({ key: JSON.parse(values.recipient), format: 'jwk' });
const root = join(homedir(), '.personal-fleet-network');
await mkdir(root, { recursive: true, mode: 0o700 });
const file = join(root, 'owner.json'); let auth;
try { auth = JSON.parse(await readFile(file, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!auth || values.rotate) { auth = { ownerCode: randomBytes(32).toString('base64url') };
  if (values.rotate) { const next = file + '.' + randomBytes(8).toString('hex') + '.next';
    await writeFile(next, JSON.stringify(auth, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(next, file);
  } else await writeFile(file, JSON.stringify(auth, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
if (!/^[a-zA-Z0-9_-]{43}$/.test(auth.ownerCode ?? '')) throw Error('Invalid private owner code');
const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(JSON.stringify(auth)), cipher.final(), cipher.getAuthTag()]);
console.log(JSON.stringify({ ownerHash: await sha256(auth.ownerCode), envelope: { key: publicEncrypt({ key: recipient, oaepHash: 'sha256' }, key).toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') } }));
