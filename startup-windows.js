import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const PUBLISHER = '北京春田知韵科技有限公司';
// All scripts are constant. Untrusted paths/ports travel only through environment values.
export const WINDOWS_QUERIES = Object.freeze({
  processes: `@(Get-CimInstance Win32_Process -Filter "Name='Doubao.exe'" -Property Name,ExecutablePath | Select-Object Name,ExecutablePath) | ConvertTo-Json -Compress`,
  installs: `$out=@(); foreach($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')) { Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^(豆包|Doubao)' } | ForEach-Object { if($_.InstallLocation){ $out += [IO.Path]::Combine($_.InstallLocation,'Doubao.exe'); $out += [IO.Path]::Combine($_.InstallLocation,'app','Doubao.exe') } } }; @($out) | ConvertTo-Json -Compress`,
  validate: `$p=$env:DSH_DOUBAO_PATH; $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($p)); if($drive.DriveType -ne [IO.DriveType]::Fixed){throw 'Only a fixed local drive is permitted'}; $i=Get-Item -LiteralPath $p -Force -ErrorAction Stop; if($i.PSIsContainer){throw 'Not a file'}; $cursor=$i; while($null -ne $cursor){ if(($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse point rejected'}; if($cursor -is [IO.FileInfo]){$cursor=$cursor.Directory}else{$cursor=$cursor.Parent} }; $s=Get-AuthenticodeSignature -LiteralPath $p; @{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject} | ConvertTo-Json -Compress`,
  port: `$items=@(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq [int]$env:DSH_DOUBAO_PORT }); @($items | ForEach-Object { $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess) -Property Name,ExecutablePath; @{address=$_.LocalAddress;name=$p.Name;path=$p.ExecutablePath} }) | ConvertTo-Json -Compress`,
});
const array = x => x == null ? [] : Array.isArray(x) ? x : [x];
export function isLocalExecutable(value) {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !value.includes('\0') && !value.slice(2).includes(':') && path.win32.basename(value).toLowerCase() === 'doubao.exe';
}
export function trustedSignature(signature) {
  const subject = signature?.subject ?? '';
  return signature?.status === 'Valid' && subject.split(/,\s*/).includes(`O=${PUBLISHER}`) && subject.split(/,\s*/).includes('SERIALNUMBER=91110102MACQD9K640');
}
export function createWindowsStartup({ run = exec, spawnProcess = spawn, env = process.env } = {}) {
  async function query(script, extra = {}) {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    if (!/^[A-Za-z]:[\\/]/.test(systemRoot) || systemRoot.slice(2).includes(':')) throw new Error('Invalid Windows system root');
    const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; ${script}`], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8', env: { ...env, ...extra } });
    return stdout.trim() ? JSON.parse(stdout) : null;
  }
  async function validate(executablePath) {
    if (!isLocalExecutable(executablePath)) return { valid: false, code: 'INVALID_PATH' };
    try {
      const signature = await query(WINDOWS_QUERIES.validate, { DSH_DOUBAO_PATH: executablePath });
      return trustedSignature(signature) ? { valid: true } : { valid: false, code: 'UNTRUSTED_SIGNATURE' };
    } catch { return { valid: false, code: 'PATH_VALIDATION_FAILED' }; }
  }
  return {
    validate,
    async discover() {
      const processes = array(await query(WINDOWS_QUERIES.processes));
      const installed = array(await query(WINDOWS_QUERIES.installs));
      const candidates = processes.filter(p => p.ExecutablePath).map(p => ({ path: p.ExecutablePath, source: 'process' }));
      candidates.push(...installed.filter(p => typeof p === 'string').map(p => ({ path: p, source: 'registry' })));
      for (const base of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
        for (const suffix of ['Doubao/Doubao.exe', 'Doubao/app/Doubao.exe', 'Programs/Doubao/Doubao.exe', 'Programs/Doubao/app/Doubao.exe']) candidates.push({ path: path.win32.join(base, suffix), source: 'common-directory' });
      }
      return { running: processes.length > 0, candidates: candidates.filter((c, i, all) => isLocalExecutable(c.path) && all.findIndex(x => x.path.toLowerCase() === c.path.toLowerCase()) === i) };
    },
    async inspectPort(port) {
      // A query failure is unknown, never proof that the port is free.
      try {
        const owners = array(await query(WINDOWS_QUERIES.port, { DSH_DOUBAO_PORT: String(port) }));
        if (!owners.length) return { state: 'free' };
        for (const owner of owners) {
          if (!['127.0.0.1', '::1'].includes(owner.address) || owner.name?.toLowerCase() !== 'doubao.exe' || !(await validate(owner.path)).valid) return { state: 'conflict' };
        }
        return { state: 'owned', path: owners[0].path };
      } catch (error) {
        // The filtered full listener query distinguishes an empty result from failure.
        throw Object.assign(new Error('Unable to verify debugging port ownership'), { code: 'PORT_QUERY_FAILED', cause: error });
      }
    },
    async launch(executablePath, port) {
      const child = spawnProcess(executablePath, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { shell: false, detached: true, windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    },
  };
}
