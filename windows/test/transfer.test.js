import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { numberedName, sendFiles } from '../src/main/transfer.js';

test('numberedName adds a counter before the extension', () => {
  assert.equal(numberedName('a.pdf', 0), 'a.pdf');
  assert.equal(numberedName('a.pdf', 2), 'a (2).pdf');
  assert.equal(numberedName('notes', 1), 'notes (1)');
  assert.equal(numberedName('.bashrc', 1), '.bashrc (1)');
  assert.equal(numberedName('x.tar.gz', 1), 'x.tar (1).gz');
});

// The fake adb is a shell script, so this part is skipped on Windows (like session.test.js).
test('a dropped file never overwrites one the phone already has, and odd names are quoted for the phone shell',
  { skip: process.platform === 'win32' ? 'needs a POSIX shell' : false }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-transfer-'));
    const log = path.join(dir, 'adb.log');
    const adb = path.join(dir, 'adb');
    fs.writeFileSync(adb, `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *"test -e '/sdcard/Download/a.pdf'"*|*"test -e '/sdcard/Download/a (1).pdf'"*) exit 0;;
  *" shell "*) exit 1;;
  *) exit 0;;
esac
`, { mode: 0o755 });
    process.env.AM_ADB = adb;
    try {
      const r = await sendFiles(['/x/a.pdf', "/x/it's.txt"], 'SER', () => {});
      assert.equal(r.sentFiles, 2);
      assert.deepEqual(r.failures, []);
      const lines = fs.readFileSync(log, 'utf8').split('\n');
      assert.ok(lines.includes('-s SER push /x/a.pdf /sdcard/Download/a (2).pdf'));
      assert.ok(lines.includes("-s SER shell test -e '/sdcard/Download/it'\\''s.txt'"));
      assert.ok(lines.includes("-s SER push /x/it's.txt /sdcard/Download/it's.txt"));
    } finally {
      delete process.env.AM_ADB;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
