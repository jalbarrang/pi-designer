/**
 * Spawn one headless pi run and capture its JSONL transcript.
 *
 * Isolation settings matter more than they look:
 *   -ne         disable discovered extensions (your global skills/tools do not
 *               get to make an eval pass or fail)
 *   -e <path>   load exactly designer, by absolute path
 *   --no-mcp    no MCP servers connect
 *   --offline   no startup network calls (less latency, less noise)
 *   --no-approve  do not trust project-local `.pi` in the fixture
 *   -nc         no AGENTS.md/CLAUDE.md: your global instructions do not steer
 *               the case, and the fixtures carry none of their own
 *   -ns         no discovered skills: the fixtures carry none, so the baseline
 *               starts with the same (empty) skill list as the extension runs.
 *   --session-dir  keep the session file for debugging
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PiRun = {
  status: 'ok' | 'crashed' | 'timeout';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  command: string;
};

export type PiCommandArgs = {
  /** Absolute path to the extension directory, or undefined to omit it. */
  extensionPath?: string;
  /** Pin the model for a comparable benchmark. */
  model?: string;
  sessionDir: string;
  prompt: string;
};

export function buildPiCommand(args: PiCommandArgs): string[] {
  return [
    '--mode',
    'json',
    '--offline',
    '--no-extensions',
    '--no-mcp',
    '--no-approve',
    '--no-context-files',
    '--no-skills',
    '--session-dir',
    args.sessionDir,
    ...(args.extensionPath ? ['--extension', args.extensionPath] : []),
    ...(args.model ? ['--model', args.model] : []),
    args.prompt,
  ];
}

const KILL_GRACE_MS = 5_000;

/**
 * macOS TCC guards these three folders. A baseline agent hunting for a tool can
 * run `find / -maxdepth 4`, which enumerates them and makes macOS show the user
 * a "blocked access" prompt. The sandbox denies first, so the child gets EPERM
 * and the user gets no notification.
 *
 * Narrow on purpose: `allow default` keeps `/tmp`, `~/.pi` and `~/.impeccable`
 * working, which is everything a run needs.
 */
const PROTECTED_HOME_DIRS = ['Downloads', 'Desktop', 'Documents'] as const;

function sandboxProfile(): string | null {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return null;
  const denied = PROTECTED_HOME_DIRS.map((name) => `(subpath "${join(homedir(), name)}")`).join(' ');
  return `(version 1)(allow default)(deny file-read* file-write* ${denied})`;
}

export function runPi(command: string[], cwd: string, timeoutMs: number): Promise<PiRun> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const profile = sandboxProfile();
    const full = profile ? ['/usr/bin/sandbox-exec', '-p', profile, 'pi', ...command] : ['pi', ...command];
    const child = spawn(full[0], full.slice(1), {
      cwd,
      env: { ...process.env, PI_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);
    timer.unref();

    child.on('error', (cause) => {
      clearTimeout(timer);
      resolve({
        status: 'crashed',
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}\nspawn failed: ${cause.message}`,
        command: shellQuote(full),
      });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const status = timedOut ? 'timeout' : exitCode === 0 ? 'ok' : 'crashed';
      resolve({
        status,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        command: shellQuote(full),
      });
    });
  });
}

export function shellQuote(args: string[]): string {
  return args
    .map((arg) => (/^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(' ');
}
