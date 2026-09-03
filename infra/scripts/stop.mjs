#!/usr/bin/env node
/**
 * Stop every worker/API process this repo started.
 *
 * `pkill -f` does not reach Windows processes from Git Bash, which is how four stale workers ended
 * up polling the same task queues at once and producing a genuinely confusing mix of passing and
 * failing runs. This is cross-platform and matches on the repo path.
 */
import { execSync } from 'node:child_process';

const patterns = ['src/main.ts', '@sdlc/worker', '@sdlc/api'];

function killWindows() {
  const script = `
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -and (${patterns
        .map((p) => `$_.CommandLine -like '*${p}*'`)
        .join(' -or ')}) } |
      ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; "killed $($_.ProcessId)" } catch {} }
  `;
  return execSync(`powershell -NoProfile -Command "${script.replace(/\n\s*/g, ' ').replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  });
}

function killPosix() {
  let output = '';
  for (const pattern of patterns) {
    try {
      output += execSync(`pkill -f "${pattern}" && echo "killed ${pattern}"`, { encoding: 'utf8' });
    } catch {
      /* nothing matched */
    }
  }
  return output;
}

try {
  const result = process.platform === 'win32' ? killWindows() : killPosix();
  console.log(result.trim() || 'no running processes matched');
} catch (error) {
  console.error(`stop failed: ${error.message}`);
  process.exit(1);
}
