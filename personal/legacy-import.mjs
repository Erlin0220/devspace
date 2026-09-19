// Explicit one-time import, never loaded by the Runtime. Future stable upgrades
// preserve Personal state directly and do not revisit historical configuration.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { atomicJson, readJson, secureStateDirectory, stateHome } from './state.mjs';
import { runWindowsDesktop } from './desktop/platform.mjs';
import { repositoryRoot } from './upgrade.mjs';

const retiredConfigKeys = new Set([
  'codegraphEnabled', 'codegraphCommand', 'codegraphArgs', 'codegraphStartupTimeoutMs', 'codegraphToolTimeoutMs',
  'basicMemoryEnabled', 'basicMemoryGlobalProject', 'basicMemoryAutoProvision', 'basicMemoryProjectBasePath', 'basicMemoryTimeoutMs',
]);
const retiredAuthKeys = new Set(['apiToken', 'basicMemoryUrl', 'basicMemoryToken']);
const withoutRetired = (value, retired) => Object.fromEntries(Object.entries(value).filter(([key]) => !retired.has(key)));
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
export async function legacyTasksAction(home = stateHome(), action) {
  const legacy = await readJson(join(home, 'legacy-import.json'), null);
  if (!legacy?.complete || !legacy.tasks?.length || process.platform !== 'win32') return;
  for (const task of legacy.tasks) {
    if (!/^com\.devspace\.[a-f0-9]{16}\.(runtime|tray)$/.test(task.name) || !isAbsolute(task.executable)) {
      throw new Error('Invalid historical task ownership');
    }
    const script = `
$ErrorActionPreference='Stop'
$task=Get-ScheduledTask -TaskName $env:PERSONAL_OLD_TASK -ErrorAction SilentlyContinue
if(!$task){throw 'Historical task disappeared; refusing a partial migration'}
if(@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne $env:PERSONAL_OLD_LAUNCHER){throw 'Historical task ownership changed'}
if($env:PERSONAL_OLD_ACTION -eq 'stop') {
  if($task.State -in @('Running','Queued')){Stop-ScheduledTask -TaskName $task.TaskName}
  for($i=0;$i -lt 60;$i++){if((Get-ScheduledTask -TaskName $task.TaskName).State -notin @('Running','Queued')){break};Start-Sleep -Milliseconds 100}
  if((Get-ScheduledTask -TaskName $task.TaskName).State -in @('Running','Queued')){throw 'Historical process owner did not stop'}
} elseif($env:PERSONAL_OLD_ACTION -eq 'disable') { Disable-ScheduledTask -TaskName $task.TaskName | Out-Null }
elseif($env:PERSONAL_OLD_ACTION -eq 'restore') { Enable-ScheduledTask -TaskName $task.TaskName | Out-Null; if($env:PERSONAL_OLD_RUNNING -eq 'true'){Start-ScheduledTask -TaskName $task.TaskName} }
`;
    await runWindowsDesktop(script, { env: { PERSONAL_OLD_TASK: task.name, PERSONAL_OLD_LAUNCHER: task.executable,
      PERSONAL_OLD_ACTION: action, PERSONAL_OLD_RUNNING: String(task.running) } });
  }
}
export async function importLegacy(home = stateHome(), { legacyDir = process.env.DEVSPACE_CONFIG_DIR ?? join(homedir(), '.devspace'), sourceRoot = repositoryRoot, desktop } = {}) {
  await secureStateDirectory(home);
  const markerPath = join(home, 'legacy-import.json');
  const previous = await readJson(markerPath, null);
  if (previous?.complete) return { unchanged: true };
  const backup = previous?.backup ?? join(home, 'legacy-backup');
  let config, auth, launch;
  if (previous?.backup) {
    [config, auth, launch] = await Promise.all([
      readJson(join(backup, 'config.json')),
      readJson(join(backup, 'auth.json')),
      readJson(join(backup, 'desktop.json')),
    ]);
  } else {
    const existing = await readJson(join(home, 'personal.json'), null);
    if (existing) throw new Error('Personal settings already exist; refusing to overwrite them during historical import');
    config = await readJson(join(legacyDir, 'config.json'));
    auth = await readJson(join(legacyDir, 'auth.json'));
    launch = desktop ?? await legacyDesktop(legacyDir, auth.ownerToken);
    await secureStateDirectory(backup);
    await atomicJson(join(backup, 'config.json'), config, { createOnly: true });
    await atomicJson(join(backup, 'auth.json'), auth, { createOnly: true });
    await atomicJson(join(backup, 'desktop.json'), launch, { createOnly: true });
    await atomicJson(markerPath, { schema: 1, complete: false, phase: 'backed-up', backup,
      legacyDir: resolve(legacyDir), sourceRoot: resolve(sourceRoot), updatedAt: new Date().toISOString() });
  }
  const previousAuth = await readJson(join(home, 'auth.json'), null);
  const environment = { ...process.env, ...launch.environment };
  const apiToken = previousAuth?.apiToken ?? environment.DEVSPACE_API_TOKEN;
  if (typeof apiToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(apiToken)) throw new Error('Existing API token could not be identified safely; no configuration was changed');
  const ownerToken = environment.DEVSPACE_OAUTH_OWNER_TOKEN ?? auth.ownerToken;
  const personal = { schema: 1, runtimeConfigDir: resolve(legacyDir), sourceRoot: resolve(sourceRoot),
    codegraph: { enabled: config.codegraphEnabled === true } };
  try {
    await atomicJson(join(home, 'auth.json'), { apiToken });
    await atomicJson(join(home, 'personal.json'), personal);
    await atomicJson(markerPath, { schema: 1, complete: false, phase: 'personal-written', backup,
      legacyDir: resolve(legacyDir), sourceRoot: resolve(sourceRoot), updatedAt: new Date().toISOString() });
    await atomicJson(join(legacyDir, 'config.json'), withoutRetired(config, retiredConfigKeys));
    await atomicJson(join(legacyDir, 'auth.json'), { ...withoutRetired(auth, retiredAuthKeys), ownerToken });
    await atomicJson(markerPath, { schema: 1, complete: false, phase: 'legacy-rewritten', backup,
      legacyDir: resolve(legacyDir), sourceRoot: resolve(sourceRoot), updatedAt: new Date().toISOString() });
    const result = { complete: true, apiTokenPreserved: true, codegraphEnabled: personal.codegraph.enabled,
      removedLegacyFields: Object.keys(config).filter(key => retiredConfigKeys.has(key)).length
        + Object.keys(auth).filter(key => retiredAuthKeys.has(key)).length,
      tasks: launch.tasks.map(({ name, executable, running }) => ({ name, executable, running })), backup };
    await atomicJson(markerPath, { schema: 1, ...result, completedAt: new Date().toISOString() }); return result;
  } catch (error) {
    await atomicJson(join(legacyDir, 'config.json'), config).catch(() => {});
    await atomicJson(join(legacyDir, 'auth.json'), auth).catch(() => {});
    await atomicJson(markerPath, { schema: 1, complete: false, phase: 'failed', backup,
      legacyDir: resolve(legacyDir), sourceRoot: resolve(sourceRoot), error: error.message, updatedAt: new Date().toISOString() }).catch(() => {});
    throw error;
  }
}
