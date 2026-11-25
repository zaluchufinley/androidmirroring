// Small process helper: run a program, collect stdout + stderr together (like Core.swift's `shell`).

import { spawn } from 'node:child_process';

/**
 * Resolves with { status, out } and never rejects: a program that cannot be started gives status -1.
 * `timeout` (ms) kills a program that hangs.
 */
export function run(exe, args, { timeout = 0 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (status) => { if (!done) { done = true; clearTimeout(timer); resolve({ status, out }); } };
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ status: -1, out: String(e) });
      return;
    }
    const timer = timeout > 0 ? setTimeout(() => { child.kill(); finish(-2); }, timeout) : null;
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', (e) => { out += String(e); finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
  });
}

/** Spawns a long-running program (the server on the phone) and returns the child; output goes to `onData`. */
export function spawnLogged(exe, args, onData) {
  const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => onData(d.toString('utf8')));
  child.stderr.on('data', (d) => onData(d.toString('utf8')));
  return child;
}
