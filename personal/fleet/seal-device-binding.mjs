// Run explicitly on the owning device during deployment. Only an encrypted
// envelope leaves stdout; the existing Runtime token is never printed.
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, publicEncrypt, randomBytes, createCipheriv } from 'node:crypto';

const { values: v } = parseArgs({ options: Object.fromEntries(
  ['device', 'name', 'platform', 'endpoint', 'runtime', 'recipient'].map(k => [k, { type: 'string' }])) });
if (!/^[a-z][a-z0-9-]{0,47}$/.test(v.device ?? '') || !v.name || v.platform !== process.platform.replace('win32', 'windows')) throw Error('Supply this device’s id, name and native platform');
const endpoint = new URL(v.endpoint), runtime = new URL(v.runtime);
if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/mcp' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('Expected HTTPS /mcp endpoint');
if (runtime.protocol !== 'http:' || runtime.hostname !== '127.0.0.1' || runtime.pathname !== '/' || runtime.username || runtime.password || runtime.search || runtime.hash) throw Error('Runtime must be the local loopback origin');
const recipient = createPublicKey({ key: JSON.parse(v.recipient), format: 'jwk' });
const root = join(homedir(), '.personal-fleet-network', v.device);
const auth = JSON.parse(await readFile(join(homedir(), '.devspace-personal', 'auth.json'), 'utf8'));
if (typeof auth.apiToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(auth.apiToken)) throw Error('Configure a private Personal Runtime API token first');
const response = await fetch(new URL('/personal-healthz', runtime), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
if (!response.ok) throw Error('Local Runtime is unavailable');
const health = await response.json();
if (health.name !== 'personal-devspace' || !/^[a-f0-9]{20}$/.test(health.owner ?? '')) throw Error('Unexpected local Runtime identity');
await mkdir(root, { recursive: true, mode: 0o700 });
const file = join(root, 'binding.json'); let binding;
try { binding = JSON.parse(await readFile(file, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (binding && (binding.id !== v.device || binding.endpoint !== endpoint.href || binding.runtimeOwner !== health.owner || binding.platform !== v.platform)) throw Error('Existing binding changed; review and explicitly rebind this device');
if (!binding) {
  binding = { id: v.device, name: v.name, platform: v.platform, bindingId: randomBytes(24).toString('base64url'), runtimeOwner: health.owner, endpoint: endpoint.href };
  await writeFile(file, JSON.stringify(binding, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ ...binding, apiToken: auth.apiToken })), cipher.final(), cipher.getAuthTag()]);
console.log(JSON.stringify({ key: publicEncrypt({ key: recipient, oaepHash: 'sha256' }, key).toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') }));
