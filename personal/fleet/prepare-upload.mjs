// Prepare a reviewable Cloudflare connector execute payload for an EXISTING
// Fleet Worker. Does not read secrets or deploy anything. Initial namespace
// migrations must be created explicitly from wrangler.jsonc first.
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw Error('Supply --output private-review-file.json');
const config = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
const bundle = await readFile(new URL('./.build/worker.js', import.meta.url));
const hash = createHash('sha256').update(bundle).digest('hex');
const metadata = { main_module: 'worker.js', compatibility_date: config.compatibility_date,
  bindings: [...config.durable_objects.bindings.map(b => ({ type: 'durable_object_namespace', name: b.name, class_name: b.class_name })),
    ...config.kv_namespaces.map(b => ({ type: 'kv_namespace', name: b.binding, namespace_id: b.id }))],
  keep_bindings: ['secret_text'], observability: config.observability, tags: ['personal-fleet'] };
const code = `async () => {
 const zipped=Uint8Array.from(atob(${JSON.stringify(gzipSync(bundle).toString('base64'))}),c=>c.charCodeAt(0));
 const bytes=await new Response(new Blob([zipped]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 if(hash!==${JSON.stringify(hash)})throw Error('Build digest mismatch');
 const b='FleetUpgrade'+Date.now(),metadata=${JSON.stringify(metadata)},source=new TextDecoder().decode(bytes);
 const body=['--'+b,'Content-Disposition: form-data; name="metadata"','Content-Type: application/json','',JSON.stringify(metadata),'--'+b,'Content-Disposition: form-data; name="worker.js"; filename="worker.js"','Content-Type: application/javascript+module','',source,'--'+b+'--',''].join('\\r\\n');
 const r=await cloudflare.request({method:'PUT',path:'/accounts/'+accountId+'/workers/scripts/'+${JSON.stringify(config.name)},body,contentType:'multipart/form-data; boundary='+b,rawBody:true});
 return {success:r.success,status:r.status,errors:r.errors,id:r.result?.id,migration_tag:r.result?.migration_tag,bundleSha256:hash};
}`;
const output = JSON.stringify({ account_id: config.account_id, code });
await writeFile(values.output, output, { mode: 0o600 });
console.log(JSON.stringify({ output: values.output, characters: output.length, bundleSha256: hash }));
