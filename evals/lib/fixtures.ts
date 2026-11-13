/**
 * Fixture materialization.
 *
 * A fixture is a directory with two parts:
 *   repo/     files committed as the clean baseline
 *   change/   optional files copied over afterwards and left uncommitted (or
 *             staged / committed — see `fixture.json`)
 *
 * Each trial materializes a fresh temporary git repo, so runs never share
 * state. That matters more than it looks: a stale index or leftover file shows
 * up as model noise, and you cannot debug noise.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { FixtureMeta } from './types';

const exec = promisify(execFile);

export const EVALS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(EVALS_DIR);
/** The extension package itself: `extensions/designer/` next to `evals/`. */
export const EXTENSION_PATH = join(REPO_ROOT, "extensions", "designer");
export const FIXTURES_DIR = join(EVALS_DIR, 'fixtures');
export const WORKSPACE_DIR = join(EVALS_DIR, 'workspace');
export const EVALS_FILE = join(EVALS_DIR, 'evals.json');

const GIT_IDENTITY = ['-c', 'user.name=eval', '-c', 'user.email=eval@local'];

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', [...GIT_IDENTITY, ...args], { cwd });
}

/** Recursively merge `src` into `dst`. Own implementation so directory-merge
 *  semantics do not depend on `fs.cp` version differences. */
async function copyTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await writeFile(to, await readFile(from));
  }
}

/** Every file under `root` as POSIX relative paths (git's spelling). */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  await walk(root);
  return out.sort();
}

export type MaterializedFixture = {
  /** The repo root: where `.git` lives. */
  dir: string;
  /** Where the run starts: `dir`, or `dir/<meta.cwd>` for a monorepo case. */
  cwd: string;
  /** Files the change/ overlay touches, empty for a plain baseline fixture. */
  changedFiles: string[];
  meta: FixtureMeta;
};

export async function materializeFixture(
  name: string,
  dir: string,
): Promise<MaterializedFixture> {
  const src = join(FIXTURES_DIR, name);
  const meta = JSON.parse(await readFile(join(src, 'fixture.json'), 'utf8')) as FixtureMeta;

  // Deterministic paths mean a rerun lands on the previous trial's repo. Wipe
  // it: a stale `.git` makes the baseline commit fail with "nothing to commit".
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await copyTree(join(src, 'repo'), dir);

  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'base']);

  let changedFiles: string[] = [];
  try {
    changedFiles = await listFiles(join(src, 'change'));
  } catch {
    // No overlay: the fixture is the baseline and nothing else.
  }
  if (changedFiles.length > 0) {
    await copyTree(join(src, 'change'), dir);
    if (meta.staged || meta.commitChange) await git(dir, ['add', '--', ...changedFiles]);
    if (meta.commitChange) await git(dir, ['commit', '-qm', 'change']);
  }

  return { dir, cwd: meta.cwd ? join(dir, meta.cwd) : dir, changedFiles, meta };
}
