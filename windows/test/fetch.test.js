import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readTar } from '../scripts/fetch-scrcpy.js';

test('readTar reads regular files from a real tar archive (sizes not a multiple of 512)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-tar-'));
  const big = Buffer.alloc(1300, 7);
  fs.mkdirSync(path.join(dir, 'pkg'));
  fs.writeFileSync(path.join(dir, 'pkg', 'adb'), big);
  fs.writeFileSync(path.join(dir, 'pkg', 'LICENSE'), 'hello');
  const r = spawnSync('tar', ['-cf', 'a.tar', 'pkg'], { cwd: dir });
  assert.equal(r.status, 0);
  const files = readTar(fs.readFileSync(path.join(dir, 'a.tar')));
  assert.deepEqual(files.get('pkg/adb')(), big);
  assert.equal(files.get('pkg/LICENSE')().toString(), 'hello');
  fs.rmSync(dir, { recursive: true, force: true });
});
