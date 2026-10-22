// Keeps the host credential private; stdout contains only a sealed envelope for
// the selected Cloudflare connection. Reuses the same credential on reruns.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, publicEncrypt, randomBytes, createCipheriv } from 'node:crypto';
const { values } = parseArgs({ options: { recipient: { type: 'string' } } });
const recipient = createPublicKey({ key: JSON.parse(values.recipient), format: 'jwk' });
const root = join(homedir(), '.personal-fleet-network');
await mkdir(root, { recursive: true, mode: 0o700 });
const file = join(root, 'client.json'); let auth;
try { auth = JSON.parse(await readFile(file, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!auth) {
  auth = { endpoint: 'https://personal-devspace-fleet.568920429.xyz/mcp', apiToken: randomBytes(32).toString('base64url') };
  await writeFile(file, JSON.stringify(auth, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
if (typeof auth.apiToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(auth.apiToken)) throw Error('Invalid private Fleet credential');
const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ apiToken: auth.apiToken })), cipher.final(), cipher.getAuthTag()]);
console.log(JSON.stringify({ key: publicEncrypt({ key: recipient, oaepHash: 'sha256' }, key).toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') }));
