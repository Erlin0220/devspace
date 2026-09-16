// Desktop helpers adapted from the fixed Team 0.2.6 snapshot. All persistent
// services are owned by Task Scheduler / launchd / systemd, never an MCP command.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { stateHome, readJson, atomicJson, secureStateDirectory } from '../state.mjs';

const exec = promisify(execFile);
const components = ['runtime', 'desktop'];
const managedComponents = [...components, 'installer'];
const xml = value => String(value).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]);
const quoted = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
export const ownerId = home => createHash('sha256').update(process.platform === 'win32' ? resolve(home).toLowerCase() : resolve(home)).digest('hex').slice(0, 20);
export const jobName = (home, component) => `com.personal-devspace.${ownerId(home)}.${component}`;
const system = executable => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', executable);

function envValue(env, name) {
  const entry = Object.entries(env).find(([key]) => key.toUpperCase() === name);
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}
export async function discoverCodexCommand(env = process.env, platform = process.platform, nodeExecutable = process.execPath) {
  const explicit = typeof env.CODEX_COMMAND === 'string' ? env.CODEX_COMMAND.trim() : '';
  const pathValue = envValue(env, 'PATH') ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  const commandNames = explicit && !isAbsolute(explicit)
    ? [explicit]
    : platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex.com', 'codex.bat'] : ['codex'];
  const candidates = [];
  if (explicit && isAbsolute(explicit)) candidates.push(explicit);
  const directories = [dirname(nodeExecutable), ...pathValue.split(separator)];
  for (const directory of directories) {
    const cleaned = directory.trim().replace(/^"(.*)"$/, '$1');
    if (!cleaned) continue;
    for (const command of commandNames) candidates.push(join(cleaned, command));
  }
  const mode = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  for (const candidate of candidates) {
    if (/\r|\n|\0/.test(candidate)) continue;
    if (await access(candidate, mode).then(() => true, () => false)) return resolve(candidate);
  }
  return undefined;
}
function managedEnvironment(home, component, codexCommand) {
  return [
    ['PERSONAL_DEVSPACE_HOME', home],
    ['DEVSPACE_API_TOKEN', ''],
    ...(component === 'runtime' && codexCommand ? [['CODEX_COMMAND', codexCommand]] : []),
  ];
}

async function native(command, args) {
  return exec(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
}
export async function runWindowsDesktop(script, { signal, timeout = 30000, env = {} } = {}) {
  const powershell = system('WindowsPowerShell/v1.0/powershell.exe');
  try { return (await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { signal, timeout, windowsHide: true, maxBuffer: 65536, env: { ...process.env, ...env } })).stdout; }
  catch (error) { if (signal?.aborted) throw Object.assign(new Error('操作已取消'), { name: 'AbortError' });
    throw new Error(`桌面操作失败 (${error.killed ? 'timeout' : error.code ?? 'unknown'})`); }
}
export async function openBrowser(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('Invalid local Control Center URL');
  if (process.platform === 'win32') await runWindowsDesktop('Start-Process -FilePath $env:PERSONAL_CONTROL_URL', { env: { PERSONAL_CONTROL_URL: url } });
  else await native(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url]);
}
export async function openLogs(home) {
  const directory = join(home, 'logs'); await mkdir(directory, { recursive: true });
  if (process.platform === 'win32') await runWindowsDesktop('Start-Process explorer.exe -ArgumentList $env:PERSONAL_LOG_DIRECTORY', { env: { PERSONAL_LOG_DIRECTORY: directory } });
  else await native(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [directory]);
}
export async function chooseFolder({ projectRoot = '', signal } = {}) {
  if (process.platform === 'win32') {
    try { return (await runWindowsDesktop(`
Add-Type -AssemblyName System.Windows.Forms
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = '选择 Personal DevSpace 项目目录'
$picker.SelectedPath = $env:PERSONAL_CURRENT_PROJECT
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
try { $owner.Show(); if ($picker.ShowDialog($owner) -eq 'OK') { $picker.SelectedPath } }
finally { $picker.Dispose(); $owner.Dispose() }
`, { signal, timeout: 300000, env: { PERSONAL_CURRENT_PROJECT: projectRoot } })).trim() || null; }
    catch (error) { if (error.name === 'AbortError') return null; throw error; }
  }
  if (process.platform === 'darwin') {
    try { return (await exec('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Personal DevSpace project directory")'], { signal, timeout: 300000 })).stdout.trim(); }
    catch (error) { if (signal?.aborted || String(error.stderr).includes('-128')) return null; throw error; }
  }
  throw new Error('请直接输入完整项目目录');
}
export async function installRecord(home = stateHome()) {
  const value = await readJson(join(home, 'install.json'));
  if (value?.schema !== 1 || value.owner !== 'personal-devspace' || !value.packageRoot || !value.node) throw new Error('Invalid Personal installation ownership');
  await access(join(value.packageRoot, 'personal', 'bin.mjs'));
  return value;
}
export function taskXml({ home, component, root, node, sid, codexCommand }) {
  if (!managedComponents.includes(component) || !/^S-1-5-[0-9-]+$/.test(sid)) throw new Error('Invalid desktop task identity');
  const label = jobName(home, component);
  const launcher = join(root, 'personal', 'bin', 'personal-launcher.exe');
  const args = ['--cwd', root, '--stdout', join(home, 'logs', `${component}.log`), '--stderr', join(home, 'logs', `${component}.error.log`),
    ...managedEnvironment(home, component, codexCommand).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--', node, join(root, 'personal', 'bin.mjs'), component];
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>PersonalDevSpace:${ownerId(home)}:${component}</Description><SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${sid})</SecurityDescriptor></RegistrationInfo>
<Triggers>${component === 'installer' ? '' : `<LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger>`}</Triggers>
<Principals><Principal id="User"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><ExecutionTimeLimit>${component === 'installer' ? 'PT30M' : 'PT0S'}</ExecutionTimeLimit>${component === 'installer' ? '' : '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>'}</Settings>
<Actions Context="User"><Exec><Command>${xml(launcher)}</Command><Arguments>${xml(args.map(quoted).join(' '))}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions></Task>\n`;
}
async function windowsTask(home, component) {
  // Do not parse localized schtasks error text (CP936 on many Windows installs).
  // A successful enumeration distinguishes absence from permission/query failures.
  const result = await runWindowsDesktop(`$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object TaskName -eq $env:PERSONAL_TASK; if($task){Export-ScheduledTask -TaskName $task.TaskName -TaskPath '\\'}else{'PERSONAL_TASK_MISSING'}`,
    { env: { PERSONAL_TASK: jobName(home, component) } });
  if (result.trim() === 'PERSONAL_TASK_MISSING') return null;
  if (!result.includes(`PersonalDevSpace:${ownerId(home)}:${component}`)) throw new Error('Task name belongs to an unknown owner');
  return result;
}
export async function registerDesktopEntries(home, root) {
  if (process.platform !== 'win32') return;
  const launcher = join(root, 'personal', 'bin', 'personal-launcher.exe');
  const icon = join(root, 'personal', 'assets', 'personal-devspace.ico');
  await access(launcher); await access(icon);
  const argumentsText = ['--cwd', root, '--stdout', join(home, 'logs', 'open.log'), '--stderr', join(home, 'logs', 'open.error.log'),
    '--env', `PERSONAL_DEVSPACE_HOME=${home}`, '--', process.execPath, join(root, 'personal', 'bin.mjs'), 'open'].map(quoted).join(' ');
  await runWindowsDesktop(`
$ErrorActionPreference='Stop'
$shell=New-Object -ComObject WScript.Shell
$folders=@([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
foreach($folder in $folders) {
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  $link=$shell.CreateShortcut((Join-Path $folder 'Personal DevSpace.lnk'))
  $link.TargetPath=$env:PERSONAL_LAUNCHER
  $link.Arguments=$env:PERSONAL_ARGUMENTS
  $link.WorkingDirectory=$env:PERSONAL_ROOT
  $link.IconLocation=$env:PERSONAL_ICON
  $link.Description='Personal DevSpace'
  $link.Save()
}
`, { env: { PERSONAL_LAUNCHER: launcher, PERSONAL_ARGUMENTS: argumentsText, PERSONAL_ROOT: root, PERSONAL_ICON: icon } });
}
export async function registerJobs(home, root, selected = components, { record = true } = {}) {
  await secureStateDirectory(home);
  await access(join(root, 'dist', 'server.js'));
  await mkdir(join(home, 'logs'), { recursive: true }); await mkdir(join(home, 'startup'), { recursive: true });
  const codexCommand = selected.includes('runtime') ? await discoverCodexCommand() : undefined;
  if (process.platform === 'win32') {
    await access(join(root, 'personal', 'bin', 'personal-launcher.exe'));
    const { stdout } = await native(system('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const sid = /S-1-5-[0-9-]+/.exec(stdout)?.[0];
    for (const component of selected) {
      await windowsTask(home, component);
      const path = join(home, 'startup', `${component}.xml`);
      await writeFile(path, `\ufeff${taskXml({ home, component, root, node: process.execPath, sid, codexCommand })}`, 'utf16le');
      await native(system('schtasks.exe'), ['/Create', '/TN', jobName(home, component), '/XML', path, '/F']);
    }
  } else if (process.platform === 'darwin') {
    const directory = join(homedir(), 'Library', 'LaunchAgents'); await mkdir(directory, { recursive: true });
    for (const component of selected) {
      const label = jobName(home, component); const path = join(directory, `${label}.plist`);
      const existing = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      if (existing && !existing.includes(`PersonalDevSpace:${ownerId(home)}`)) throw new Error('Unknown LaunchAgent owner');
      const args = [process.execPath, join(root, 'personal', 'bin.mjs'), component];
      const environment = managedEnvironment(home, component, codexCommand).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('');
      await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><!-- PersonalDevSpace:${ownerId(home)} --><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${environment}</dict><key>RunAtLoad</key><${component === 'installer' ? 'false' : 'true'}/><key>ProcessType</key><string>Interactive</string><key>StandardOutPath</key><string>${xml(join(home, 'logs', `${component}.log`))}</string><key>StandardErrorPath</key><string>${xml(join(home, 'logs', `${component}.error.log`))}</string></dict></plist>\n`, { mode: 0o600 });
    }
  } else {
    const directory = join(homedir(), '.config', 'systemd', 'user'); await mkdir(directory, { recursive: true });
    for (const component of selected) {
      const path = join(directory, `${jobName(home, component)}.service`);
      const existing = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      if (existing && !existing.includes(`PersonalDevSpace:${ownerId(home)}`)) throw new Error('Unknown systemd unit owner');
      const q = value => `"${String(value).replace(/([\\"])/g, '\\$1').replace(/%/g, '%%')}"`;
      const environment = managedEnvironment(home, component, codexCommand).map(([key, value]) => `Environment=${q(`${key}=${value}`)}\n`).join('');
      await writeFile(path, `[Unit]\nDescription=PersonalDevSpace:${ownerId(home)} ${component}\n[Service]\nType=simple\nWorkingDirectory=${q(root)}\n${environment}ExecStart=${q(process.execPath)} ${q(join(root, 'personal/bin.mjs'))} ${component}\nKillMode=control-group\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
    }
    await native('systemctl', ['--user', 'daemon-reload']);
    for (const component of selected.filter(value => value !== 'installer')) await native('systemctl', ['--user', 'enable', `${jobName(home, component)}.service`]);
  }
  if (record) await atomicJson(join(home, 'install.json'), { schema: 1, owner: 'personal-devspace', packageRoot: resolve(root), node: process.execPath });
}
export async function jobAction(home, component, action) {
  if (!managedComponents.includes(component) || !['start', 'stop', 'remove'].includes(action)) throw new Error('Invalid job action');
  if (process.platform === 'win32') {
    const task = await windowsTask(home, component);
    if (!task) { if (action === 'start') throw new Error(`Missing ${component} task; repair the desktop entry`); return; }
    if (action === 'start') return native(system('schtasks.exe'), ['/Run', '/TN', jobName(home, component)]);
    const initialState = await runWindowsDesktop('(Get-ScheduledTask -TaskName $env:PERSONAL_TASK).State.ToString()', { env: { PERSONAL_TASK: jobName(home, component) } });
    if (initialState.trim().match(/Running|Queued/i)) await native(system('schtasks.exe'), ['/End', '/TN', jobName(home, component)]);
    // Confirm OS owner has stopped; do not authorize a new process after a partial stop.
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await runWindowsDesktop('(Get-ScheduledTask -TaskName $env:PERSONAL_TASK).State.ToString()', { env: { PERSONAL_TASK: jobName(home, component) } });
      if (!state.trim().match(/Running|Queued/i)) {
        if (action === 'remove') await native(system('schtasks.exe'), ['/Delete', '/TN', jobName(home, component), '/F']);
        return;
      }
      await sleep(100);
    }
    throw new Error(`${component} owner did not stop`);
  }
  if (process.platform === 'darwin') {
    const label = jobName(home, component); const domain = `gui/${process.getuid()}`;
    const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const contents = await readFile(path, 'utf8'); if (!contents.includes(`PersonalDevSpace:${ownerId(home)}`)) throw new Error('Unknown LaunchAgent owner');
    const loaded = await native('/bin/launchctl', ['print', `${domain}/${label}`]).then(() => true, () => false);
    if (action === 'start') { if (!loaded) await native('/bin/launchctl', ['bootstrap', domain, path]); if (loaded || component === 'installer') await native('/bin/launchctl', ['kickstart', `${domain}/${label}`]); }
    else { if (loaded) await native('/bin/launchctl', ['bootout', `${domain}/${label}`]); if (action === 'remove') await rm(path); }
    return;
  }
  const unit = `${jobName(home, component)}.service`;
  const path = join(homedir(), '.config', 'systemd', 'user', unit);
  if (!(await readFile(path, 'utf8')).includes(`PersonalDevSpace:${ownerId(home)}`)) throw new Error('Unknown systemd unit owner');
  await native('systemctl', ['--user', action === 'start' ? 'start' : 'stop', unit]);
  if (action === 'remove') { await native('systemctl', ['--user', 'disable', unit]); await rm(path); await native('systemctl', ['--user', 'daemon-reload']); }
}

export async function jobRunning(home, component) {
  if (!managedComponents.includes(component)) throw new Error('Invalid job component');
  if (process.platform === 'win32') {
    if (!await windowsTask(home, component)) return false;
    const state = await runWindowsDesktop('(Get-ScheduledTask -TaskName $env:PERSONAL_TASK).State.ToString()', { env: { PERSONAL_TASK: jobName(home, component) } });
    return /Running|Queued/i.test(state);
  }
  if (process.platform === 'darwin') {
    try { await access(join(homedir(), 'Library', 'LaunchAgents', `${jobName(home, component)}.plist`)); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    return native('/bin/launchctl', ['print', `gui/${process.getuid()}/${jobName(home, component)}`]).then(result => /state = running/.test(result.stdout), error => { if ([3, 113].includes(error.code)) return false; throw error; });
  }
  return native('systemctl', ['--user', 'is-active', `${jobName(home, component)}.service`]).then(result => result.stdout.trim() === 'active', error => { if ([3, 4].includes(error.code)) return false; throw error; });
}
export const installerRunning = home => jobRunning(home, 'installer');
