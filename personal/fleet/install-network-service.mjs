// Explicit deployment helper. Neither the Worker nor the Personal Runtime calls
// this file. It creates only a new, user-owned Fleet tunnel service.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, stat, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const { values } = parseArgs({ options: {
  device: { type: 'string' }, cloudflared: { type: 'string' }, 'token-file': { type: 'string' },
} });
const id = values.device;
if (!/^[a-z][a-z0-9-]{0,47}$/.test(id ?? '')) throw Error('Supply --device with a stable device id');
for (const key of ['cloudflared', 'token-file']) {
  if (!values[key] || !isAbsolute(values[key]) || /[\r\n\0]/.test(values[key])) throw Error(`Supply absolute --${key}`);
}
const root = join(homedir(), '.personal-fleet-network', id);
await mkdir(root, { recursive: true, mode: 0o700 });
const binary = await realpath(values.cloudflared), token = await realpath(values['token-file']);
if (!(await stat(binary)).isFile() || !(await stat(token)).isFile()) throw Error('Expected executable and token files');
if (await realpath(dirname(token)) !== await realpath(root)) throw Error('Keep the token in this device’s private network directory');
if (process.platform !== 'win32' && ((await stat(token)).mode & 0o077)) throw Error('Token file must have private permissions (0600)');
const args = ['tunnel', '--no-autoupdate', '--logfile', join(root, 'tunnel.log'), 'run', '--token-file', token];
const absent = async file => {
  try { await access(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  throw Error('Service configuration already exists; inspect the existing service before changing it');
};
let service;
if (process.platform === 'darwin') {
  service = `com.personal-fleet.${id}.tunnel`;
  const file = join(homedir(), 'Library', 'LaunchAgents', service + '.plist');
  await absent(file);
  const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const strings = [binary, ...args].map(s => `<string>${xml(s)}</string>`).join('');
  await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${service}</string><key>ProgramArguments</key><array>${strings}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(root, 'service.out.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root, 'service.err.log'))}</string></dict></plist>`, { flag: 'wx', mode: 0o600 });
  execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
  execFileSync('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${service}`]);
} else if (process.platform === 'win32') {
  service = `PersonalFleet-${id}-Tunnel`;
  const launcher = join(root, 'run-tunnel-hidden.vbs'); await absent(launcher);
  const quote = s => `"${s.replaceAll('"', '""')}"`;
  const command = [binary, ...args].map(quote).join(' ');
  await writeFile(launcher, `Set shell = CreateObject("WScript.Shell")\r\nWScript.Quit shell.Run(${quote(command)}, 0, True)\r\n`, { flag: 'wx' });
  const ps = s => `'${s.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop';if(Get-ScheduledTask -TaskName ${ps(service)} -ErrorAction SilentlyContinue){throw 'Service already exists'};$a=New-ScheduledTaskAction -Execute "$env:WINDIR\\System32\\wscript.exe" -Argument ${ps(`//B //Nologo "${launcher}"`)};$t=New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name);$s=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1);Register-ScheduledTask -TaskName ${ps(service)} -Action $a -Trigger $t -Settings $s -RunLevel Limited | Out-Null;Start-ScheduledTask -TaskName ${ps(service)}`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
} else throw Error('This deployment helper supports macOS and Windows only');
await writeFile(join(root, 'service.json'), JSON.stringify({ deviceId: id, service, binary, tokenFile: token }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ deviceId: id, service, networkDirectory: root }));
