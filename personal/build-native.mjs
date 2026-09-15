import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateHome, privateDirectory } from './state.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
async function run(command, args, options = {}) {
  await new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`${command} exited ${code}`)));
  });
}
export async function peDetails(path) {
  const bytes = await readFile(path);
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid PE image');
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 256 >= bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid PE header');
  const optional = pe + 24;
  return { machine: bytes.readUInt16LE(pe + 4), subsystem: bytes.readUInt16LE(optional + 68),
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}
async function nativeSourceDigest() {
  const digest = createHash('sha256');
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'target') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { digest.update(path.slice(root.length).replaceAll('\\', '/')); digest.update((await readFile(path, 'utf8')).replaceAll('\r\n', '\n')); }
    }
  }
  await walk(join(root, 'personal/native'));
  digest.update((await readFile(new URL('./build-native.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n'));
  return digest.digest('hex');
}
async function reuseNative(bin) {
  const sourceDigest = await nativeSourceDigest();
  const cache = join(stateHome(), 'build-cache', `${process.platform}-${process.arch}-${sourceDigest}`);
  try {
    const manifest = JSON.parse(await readFile(join(cache, 'native-build.json'), 'utf8'));
    if (manifest.sourceDigest !== sourceDigest) return null;
    const files = process.platform === 'win32' ? ['personal-launcher.exe', 'personal-devspace-tray.exe'] : ['personal-devspace-tray'];
    for (const file of files) if (createHash('sha256').update(await readFile(join(cache, file))).digest('hex') !== manifest.artifacts[file]?.sha256) return null;
    for (const file of [...files, 'native-build.json']) await copyFile(join(cache, file), join(bin, file));
    return { ...manifest, reused: true };
  } catch { return null; }
}
async function cacheNative(bin, artifacts) {
  const sourceDigest = await nativeSourceDigest(); const manifest = { sourceDigest, artifacts };
  await writeFile(join(bin, 'native-build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const cache = join(stateHome(), 'build-cache', `${process.platform}-${process.arch}-${sourceDigest}`);
  try { await privateDirectory(cache); for (const file of [...Object.keys(artifacts), 'native-build.json']) await copyFile(join(bin, file), join(cache, file)); }
  catch { console.warn('Native binaries built successfully; optional build cache is unavailable'); }
  return manifest;
}
export async function buildNative() {
  const bin = join(root, 'personal', 'bin'); await mkdir(bin, { recursive: true });
  if (['win32', 'darwin'].includes(process.platform)) { const cached = await reuseNative(bin); if (cached) return cached; }
  if (process.platform === 'win32') {
    const zig = process.env.ZIG ?? 'zig';
    const cargo = process.env.CARGO ?? 'cargo';
    const crate = join(root, 'personal', 'native', 'tray');
    await run(zig, ['cc', join(root, 'personal/native/windows-launcher.c'), '-target', 'x86_64-windows-gnu', '-municode', '-Wl,--subsystem,windows', '-Os', '-s', '-o', join(bin, 'personal-launcher.exe'), '-lshell32']);
    const env = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(root, 'build/personal-tray'),
      CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS: 'fallback' };
    if (env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER) {
      const linker = join(root, 'build/personal-linker'); await mkdir(linker, { recursive: true });
      await run(zig, ['cc', join(root, 'personal/native/zig-as.c'), '-target', 'x86_64-windows-gnu', '-municode', '-Os', '-s', '-o', join(linker, 'as.exe')]);
      env.PERSONAL_ZIG = zig;
      env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS, '-C', `link-arg=-B${linker}/`].filter(Boolean).join('\x1f');
    }
    if (!(await access(join(crate, 'Cargo.lock')).then(() => true, () => false))) {
      await run(cargo, ['generate-lockfile', '--offline'], { cwd: crate, env });
    }
    await run(cargo, ['test', '--release', '--locked'], { cwd: crate, env });
    await run(cargo, ['build', '--release', '--locked'], { cwd: crate, env });
    await copyFile(join(env.CARGO_TARGET_DIR, 'release/personal-devspace-tray.exe'), join(bin, 'personal-devspace-tray.exe'));
    const evidence = {};
    for (const file of ['personal-launcher.exe', 'personal-devspace-tray.exe']) {
      evidence[file] = await peDetails(join(bin, file));
      if (evidence[file].machine !== 0x8664 || evidence[file].subsystem !== 2) throw new Error('Native desktop binaries must be x64 GUI applications');
    }
    return cacheNative(bin, evidence);
  }
  if (process.platform === 'darwin') {
    await run('/usr/bin/swiftc', ['-swift-version', '5', '-O', '-framework', 'AppKit', join(root, 'personal/native/PersonalDevSpaceTray.swift'), '-o', join(bin, 'personal-devspace-tray')]);
    const bytes = await readFile(join(bin, 'personal-devspace-tray'));
    return cacheNative(bin, { 'personal-devspace-tray': { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } });
  }
  return { platform: process.platform, nativeTray: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildNative(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
