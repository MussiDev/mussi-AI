import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

export class KeyMissingError extends SecretsError {
  constructor(message: string) {
    super(message);
    this.name = 'KeyMissingError';
  }
}

const HEX64 = /^[0-9a-fA-F]{64}$/;
const IS_WINDOWS = process.platform === 'win32';

/** Real path of the nearest existing ancestor, with the missing segments re-appended. */
function realpathLoose(p: string): string {
  const missing: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch (e) {
      const parent = path.dirname(current);
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw e;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Data directory: AGENTS_OFFICE_HOME or <home>/.agents-office; its real path must be strictly inside home's real path. */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const homeReal = realpathLoose(home);
  const override = env['AGENTS_OFFICE_HOME'];
  const dir = realpathLoose(override ? override : path.join(path.resolve(home), '.agents-office'));
  const rel = path.relative(homeReal, dir);
  const inside = rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  if (!inside) {
    throw new SecretsError(`Data directory ${dir} must be inside the home directory ${homeReal}`);
  }
  return dir;
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

/** Refuses group/other permission bits. No-op on Windows, which has no mode bits. */
export function assertSecureMode(
  mode: number,
  target: string,
  kind: 'file' | 'directory',
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return;
  if ((mode & 0o077) !== 0) {
    throw new SecretsError(
      `${kind === 'file' ? 'Secret file' : 'Data directory'} ${target} has mode ${octal(mode)}; group/other access is not allowed (expected ${kind === 'file' ? '600' : '700'})`,
    );
  }
}

function checkMode(target: string, kind: 'file' | 'directory'): void {
  assertSecureMode(fs.statSync(target).mode, target, kind);
}

function ensureDir(dataDir: string): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  checkMode(dataDir, 'directory');
}

function readSecret(file: string): string {
  checkMode(file, 'file');
  const content = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!HEX64.test(content)) {
    throw new SecretsError(`Secret file ${file} must contain exactly 64 hexadecimal characters`);
  }
  return content;
}

/** Creates the file atomically with 0600; returns null when it already exists. */
function createSecret(file: string): string | null {
  const value = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw e;
  }
  return value;
}

function loadOrCreate(file: string): string {
  if (fs.existsSync(file)) return readSecret(file);
  return createSecret(file) ?? readSecret(file);
}

export function loadOrCreateToken(dataDir: string): string {
  ensureDir(dataDir);
  return loadOrCreate(path.join(dataDir, 'token'));
}

export function loadKey(dataDir: string, opts: { dbExists: boolean }): string {
  ensureDir(dataDir);
  const file = path.join(dataDir, 'db.key');
  if (!fs.existsSync(file) && opts.dbExists) {
    throw new KeyMissingError(
      `Database key file ${file} is missing while the database exists; creating a new key would make the stored data unreadable`,
    );
  }
  return loadOrCreate(file);
}

export function tokenMatches(expected: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
