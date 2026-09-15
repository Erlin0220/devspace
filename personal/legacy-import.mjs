// Explicit one-time import, never loaded by the Runtime. Future stable upgrades
// preserve Personal state directly and do not revisit historical configuration.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { access, rm } from 'node:fs/promises';
import { atomicJson, readJson, secureStateDirectory, stateHome } from './state.mjs';
import { runWindowsDesktop } from './desktop/platform.mjs';
import { repositoryRoot } from './upgrade.mjs';

const officialKeys = ['host', 'port', 'allowedRoots', 'publicBaseUrl', 'allowedHosts', 'stateDir', 'worktreeRoot', 'artifactsEnabled', 'artifactMaxFileBytes', 'agentDir', 'subagents'];
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
async function legacyDesktop(legacyDir, ownerToken) {
  if (process.platform !== 'win32' || !ownerToken || !await access(join(legacyDir, 'desktop/bin/devspace-launcher.exe')).then(() => true, () => false)) return { environment: {}, tasks: [] };
  const identity = createHash('sha256').update(ownerToken).digest('hex').slice(0, 16);
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class PersonalArgv{[DllImport("shell32.dll",SetLastError=true)]public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)]string s,out int n);[DllImport("kernel32.dll")]public static extern IntPtr LocalFree(IntPtr p);}'
$result=@{environment=@{};tasks=@()}
foreach($part in @('runtime','tray')) {
  $name='com.devspace.'+$env:PERSONAL_LEGACY_ID+'.'+$part
  $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if(!$task){continue}
  if(@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne $env:PERSONAL_LEGACY_LAUNCHER){throw 'Unknown legacy task owner'}
  $result.tasks+=@{name=$name;running=($task.State -eq 'Running');executable=$task.Actions[0].Execute;xml=(Export-ScheduledTask -TaskName $name)}
  if($part -ne 'runtime'){continue}
  $count=0;$pointer=[PersonalArgv]::CommandLineToArgvW(('placeholder.exe '+$task.Actions[0].Arguments),[ref]$count)
  if($pointer -eq [IntPtr]::Zero){throw 'Unable to parse legacy arguments'}
  try{$args=@();for($i=0;$i -lt $count;$i++){$args+=[Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($pointer,$i*[IntPtr]::Size))}
    for($i=0;$i -lt ($args.Count-1);$i++){if($args[$i] -eq '--env'){$pair=$args[++$i].Split('=',2);if($pair.Count -eq 2){$result.environment[$pair[0]]=$pair[1]}}}
  }finally{[void][PersonalArgv]::LocalFree($pointer)}
}
$result|ConvertTo-Json -Depth 5 -Compress
`;
  // The subprocess result is consumed locally, never logged or returned by the CLI.
  return JSON.parse(await runWindowsDesktop(script, { env: { PERSONAL_LEGACY_ID: identity, PERSONAL_LEGACY_LAUNCHER: join(legacyDir, 'desktop/bin/devspace-launcher.exe') } }));
}
export async function importLegacy(home = stateHome(), { legacyDir = process.env.DEVSPACE_CONFIG_DIR ?? join(homedir(), '.devspace'), sourceRoot = repositoryRoot, desktop } = {}) {
  await secureStateDirectory(home);
  if ((await readJson(join(home, 'legacy-import.json'), null))?.complete) return { unchanged: true };
  const config = await readJson(join(legacyDir, 'config.json'));
  const auth = await readJson(join(legacyDir, 'auth.json'));
  const existing = await readJson(join(home, 'personal.json'), null);
  if (existing) throw new Error('Personal settings already exist; refusing to overwrite them during historical import');
  const previousAuth = await readJson(join(home, 'auth.json'), null);
  const launch = desktop ?? await legacyDesktop(legacyDir, auth.ownerToken);
  const environment = { ...process.env, ...launch.environment };
  const apiToken = previousAuth?.apiToken ?? environment.DEVSPACE_API_TOKEN;
  if (typeof apiToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(apiToken)) throw new Error('Existing API token could not be identified safely; no configuration was changed');
  const runtimeEnv = Object.fromEntries(Object.entries(launch.environment).filter(([key, value]) => typeof value === 'string' && /^DEVSPACE_/.test(key)
    && !/^DEVSPACE_(API_TOKEN|CONFIG_DIR|OAUTH_OWNER_TOKEN|CODEGRAPH|BASIC_MEMORY)/.test(key)));
  const ownerToken = environment.DEVSPACE_OAUTH_OWNER_TOKEN ?? auth.ownerToken;
  const backup = join(home, 'legacy-backup');
  await secureStateDirectory(backup);
  await atomicJson(join(backup, 'config.json'), config, { createOnly: true });
  await atomicJson(join(backup, 'auth.json'), auth, { createOnly: true });
  await atomicJson(join(backup, 'desktop.json'), launch, { createOnly: true });
  const personal = { schema: 1, runtimeConfigDir: resolve(legacyDir), sourceRoot: resolve(sourceRoot), runtimeEnv,
    codegraph: { enabled: config.codegraphEnabled === true, command: config.codegraphCommand, args: config.codegraphArgs,
      startupTimeoutMs: config.codegraphStartupTimeoutMs, toolTimeoutMs: config.codegraphToolTimeoutMs } };
  try {
    await atomicJson(join(home, 'auth.json'), { apiToken });
    await atomicJson(join(home, 'personal.json'), personal);
    await atomicJson(join(legacyDir, 'config.json'), pick(config, officialKeys));
    await atomicJson(join(legacyDir, 'auth.json'), { ownerToken });
    const result = { complete: true, apiTokenPreserved: true, codegraphEnabled: personal.codegraph.enabled,
      removedLegacyFields: Object.keys(config).filter(key => !officialKeys.includes(key)).length + Object.keys(auth).filter(key => key !== 'ownerToken').length,
      tasks: launch.tasks.map(({ name, executable, running }) => ({ name, executable, running })), backup };
    await atomicJson(join(home, 'legacy-import.json'), result); return result;
  } catch (error) {
    await atomicJson(join(legacyDir, 'config.json'), config); await atomicJson(join(legacyDir, 'auth.json'), auth);
    if (previousAuth) await atomicJson(join(home, 'auth.json'), previousAuth); else await rm(join(home, 'auth.json'), { force: true });
    await rm(join(home, 'personal.json'), { force: true }); throw error;
  }
}
