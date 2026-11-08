import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../lib/config.mjs';

test('lifecycle selects only the managed service processes', () => {
  const check = `
    . '${path.join(ROOT, 'scripts/manage-services.ps1')}'
    function Check($p,$expected) { if ((Get-ManagedServiceKind $p) -ne $expected) { throw 'Wrong process selected' } }
    Check ([pscustomobject]@{Name='QQ.exe';ExecutablePath='C:\\QQ.exe';CommandLine='QQ.exe'}) $null
    Check ([pscustomobject]@{Name='node.exe';ExecutablePath='C:\\node.exe';CommandLine='node other-project/server.mjs'}) $null
    Check ([pscustomobject]@{Name='node.exe';ExecutablePath=$snowNode;CommandLine='node.exe index.mjs'}) 'SnowLuma'
    Check ([pscustomobject]@{Name='node.exe';ExecutablePath='C:\\node.exe';CommandLine=('node "'+$bridgeEntry+'"')}) 'Bridge'
    Check ([pscustomobject]@{Name='node.exe';ExecutablePath='C:\\node.exe';CommandLine=('node "'+$dshEntry+'" web --no-open')}) 'DSH'
    Check ([pscustomobject]@{Name='node.exe';ExecutablePath='C:\\node.exe';CommandLine=('node "'+$dshEntry+'" headless')}) $null
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', check], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});
