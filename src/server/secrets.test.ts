import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KeyMissingError,
  SecretsError,
  assertSecureMode,
  loadKey,
  loadOrCreateToken,
  resolveDataDir,
  tokenMatches,
} from './secrets.js';

const HEX64 = /^[0-9a-f]{64}$/;
const isWindows = process.platform === 'win32';
const POSIX_ONLY = 'POSIX only: Windows has no mode bits';
const LINK_SKIP_REASON = 'creating symlinks or junctions is not permitted on this machine';

let home: string;
let dataDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-secrets-'));
  dataDir = path.join(home, '.agents-office');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected function to throw');
}

describe('loadOrCreateToken', () => {
  it('creates the token file with 64 hex chars on first start (AC-33, NFR-05)', () => {
    const token = loadOrCreateToken(dataDir);
    expect(token).toMatch(HEX64);
    expect(fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim()).toBe(token);
  });

  it('gives different tokens to two fresh directories (NFR-05)', () => {
    const other = path.join(home, 'other');
    expect(loadOrCreateToken(dataDir)).not.toBe(loadOrCreateToken(other));
  });

  it('uses 32 random bytes: decoded token has 32 bytes', () => {
    expect(Buffer.from(loadOrCreateToken(dataDir), 'hex')).toHaveLength(32);
  });

  it('returns the same token on a second call and does not overwrite', () => {
    const first = loadOrCreateToken(dataDir);
    const before = fs.statSync(path.join(dataDir, 'token')).mtimeMs;
    expect(loadOrCreateToken(dataDir)).toBe(first);
    expect(fs.statSync(path.join(dataDir, 'token')).mtimeMs).toBe(before);
  });

  it('accepts a trailing newline in an existing token file', () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const value = 'ab'.repeat(32);
    fs.writeFileSync(path.join(dataDir, 'token'), value + '\n', { mode: 0o600 });
    expect(loadOrCreateToken(dataDir)).toBe(value);
  });

  it.each([
    ['too short', 'abc123'],
    ['non hex', 'zz'.repeat(32)],
    ['too long', 'ab'.repeat(33)],
    ['empty', ''],
  ])('rejects an invalid token file (%s), names the file and leaves it untouched', (_n, content) => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'token');
    fs.writeFileSync(file, content, { mode: 0o600 });
    const err = errorOf(() => loadOrCreateToken(dataDir));
    expect(err).toBeInstanceOf(SecretsError);
    expect(err.message).toContain(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
  });

  it('does not leak the file content in the error message', () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const content = 'q'.repeat(40);
    fs.writeFileSync(path.join(dataDir, 'token'), content, { mode: 0o600 });
    expect(errorOf(() => loadOrCreateToken(dataDir)).message).not.toContain(content);
  });

  it.skipIf(isWindows)(`sets directory 0700 and file 0600 (AC-33) [${POSIX_ONLY}]`, () => {
    loadOrCreateToken(dataDir);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dataDir, 'token')).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)(`refuses a token file with group/other bits [${POSIX_ONLY}]`, () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'token');
    const value = 'cd'.repeat(32);
    fs.writeFileSync(file, value);
    fs.chmodSync(file, 0o644);
    const err = errorOf(() => loadOrCreateToken(dataDir));
    expect(err).toBeInstanceOf(SecretsError);
    expect(err.message).toContain(file);
    expect(err.message).toContain('644');
    expect(err.message).not.toContain(value);
  });

  it.skipIf(isWindows)(`refuses a data directory with group/other bits [${POSIX_ONLY}]`, () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.chmodSync(dataDir, 0o755);
    const err = errorOf(() => loadOrCreateToken(dataDir));
    expect(err).toBeInstanceOf(SecretsError);
    expect(err.message).toContain(dataDir);
    expect(err.message).toContain('755');
  });
});

describe('loadKey', () => {
  it('creates the key file with 64 hex chars when no database exists (AC-38, NFR-05)', () => {
    const key = loadKey(dataDir, { dbExists: false });
    expect(key).toMatch(HEX64);
    expect(fs.readFileSync(path.join(dataDir, 'db.key'), 'utf8').trim()).toBe(key);
  });

  it('returns the same key on a second call', () => {
    const key = loadKey(dataDir, { dbExists: false });
    expect(loadKey(dataDir, { dbExists: true })).toBe(key);
  });

  it('throws KeyMissingError naming the key file when the database exists, and creates nothing (AC-39)', () => {
    const file = path.join(dataDir, 'db.key');
    const err = errorOf(() => loadKey(dataDir, { dbExists: true }));
    expect(err).toBeInstanceOf(KeyMissingError);
    expect(err).toBeInstanceOf(SecretsError);
    expect(err.message).toContain(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects an invalid key file, names it and leaves it untouched', () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'db.key');
    fs.writeFileSync(file, 'not-a-key', { mode: 0o600 });
    const err = errorOf(() => loadKey(dataDir, { dbExists: false }));
    expect(err).toBeInstanceOf(SecretsError);
    expect(err.message).toContain(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('not-a-key');
  });

  it.skipIf(isWindows)(`sets the key file to 0600 (AC-38) [${POSIX_ONLY}]`, () => {
    loadKey(dataDir, { dbExists: false });
    expect(fs.statSync(path.join(dataDir, 'db.key')).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)(`refuses a key file with group/other bits [${POSIX_ONLY}]`, () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'db.key');
    fs.writeFileSync(file, 'ef'.repeat(32));
    fs.chmodSync(file, 0o640);
    const err = errorOf(() => loadKey(dataDir, { dbExists: true }));
    expect(err.message).toContain(file);
    expect(err.message).toContain('640');
  });
});

describe('tokenMatches', () => {
  const expected = 'a1'.repeat(32);

  it('accepts the right token (AC-31)', () => {
    expect(tokenMatches(expected, expected)).toBe(true);
  });

  it('rejects a wrong token of the same length (AC-32)', () => {
    expect(tokenMatches(expected, 'b2'.repeat(32))).toBe(false);
  });

  it('rejects a token of the wrong length (AC-32)', () => {
    expect(tokenMatches(expected, expected.slice(0, 63))).toBe(false);
    expect(tokenMatches(expected, expected + 'a')).toBe(false);
  });

  it('rejects non-string candidates', () => {
    expect(tokenMatches(expected, undefined)).toBe(false);
    expect(tokenMatches(expected, 42)).toBe(false);
    expect(tokenMatches(expected, null)).toBe(false);
    expect(tokenMatches(expected, { length: 64 })).toBe(false);
  });
});

describe('resolveDataDir', () => {
  it('defaults to <home>/.agents-office', () => {
    expect(resolveDataDir({}, home)).toBe(path.join(home, '.agents-office'));
  });

  it('honours AGENTS_OFFICE_HOME when inside home', () => {
    const custom = path.join(home, 'custom', 'dir');
    expect(resolveDataDir({ AGENTS_OFFICE_HOME: custom }, home)).toBe(custom);
  });

  it('rejects a data directory outside home', () => {
    const outside = path.join(path.dirname(home), 'elsewhere');
    const err = errorOf(() => resolveDataDir({ AGENTS_OFFICE_HOME: outside }, home));
    expect(err).toBeInstanceOf(SecretsError);
  });

  it('rejects traversal out of home with ..', () => {
    const sneaky = path.join(home, '..', 'elsewhere');
    expect(() => resolveDataDir({ AGENTS_OFFICE_HOME: sneaky }, home)).toThrow(SecretsError);
  });

  it('rejects a sibling directory that merely shares the home prefix', () => {
    const sibling = home + '-evil';
    expect(() => resolveDataDir({ AGENTS_OFFICE_HOME: sibling }, home)).toThrow(SecretsError);
  });
});

describe('secret values never appear in errors', () => {
  it('KeyMissingError and SecretsError carry no secret', () => {
    const token = loadOrCreateToken(dataDir);
    const errs = [
      errorOf(() => loadKey(dataDir, { dbExists: true })),
      errorOf(() => resolveDataDir({ AGENTS_OFFICE_HOME: path.dirname(home) }, home)),
    ];
    for (const e of errs) expect(e.message).not.toContain(token);
  });
});

function tryLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('resolveDataDir with symlinks (R-14)', () => {
  let outside: string;
  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-outside-'));
  });
  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a link inside home whose target is outside home', (ctx) => {
    const link = path.join(home, '.agents-office');
    if (!tryLink(outside, link)) ctx.skip(LINK_SKIP_REASON);
    expect(() => resolveDataDir({}, home)).toThrow(SecretsError);
  });

  it('rejects a not-yet-existing child under a link that points outside home', (ctx) => {
    const link = path.join(home, 'lnk');
    if (!tryLink(outside, link)) ctx.skip(LINK_SKIP_REASON);
    expect(() => resolveDataDir({ AGENTS_OFFICE_HOME: path.join(link, 'new', 'deep') }, home)).toThrow(
      SecretsError,
    );
  });

  it('accepts a link whose target is inside home and returns the real path', (ctx) => {
    const real = path.join(home, 'real-target');
    fs.mkdirSync(real);
    const link = path.join(home, '.agents-office');
    if (!tryLink(real, link)) ctx.skip(LINK_SKIP_REASON);
    expect(resolveDataDir({}, home)).toBe(fs.realpathSync.native(real));
  });

  it('accepts a data directory that does not exist yet under a real home', () => {
    expect(resolveDataDir({}, home)).toBe(path.join(fs.realpathSync.native(home), '.agents-office'));
  });

  it('works when home itself is reached through a link', (ctx) => {
    const linkHome = path.join(outside, 'home-link');
    if (!tryLink(home, linkHome)) ctx.skip(LINK_SKIP_REASON);
    expect(resolveDataDir({}, linkHome)).toBe(path.join(fs.realpathSync.native(home), '.agents-office'));
  });
});

describe('assertSecureMode (pure, runs on every platform)', () => {
  it.each([0o644, 0o640, 0o755, 0o770, 0o604])('refuses mode %o naming target and mode', (mode) => {
    const err = errorOf(() => assertSecureMode(mode, '/x/token', 'file', 'linux'));
    expect(err).toBeInstanceOf(SecretsError);
    expect(err.message).toContain('/x/token');
    expect(err.message).toContain(mode.toString(8));
  });

  it.each([0o600, 0o700])('accepts mode %o', (mode) => {
    expect(() => assertSecureMode(mode, '/x/token', 'file', 'linux')).not.toThrow();
    expect(() => assertSecureMode(mode, '/x', 'directory', 'darwin')).not.toThrow();
  });

  it('accepts anything on win32 (no mode bits)', () => {
    expect(() => assertSecureMode(0o777, 'C:/x/token', 'file', 'win32')).not.toThrow();
  });
});

describe('secret creation race', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to reading the existing file when the exclusive write hits EEXIST', () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const winner = 'ab'.repeat(32);
    const real = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, _data, opts) => {
      real(file, winner, { mode: 0o600 }); // another process won the race
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    });
    expect(loadOrCreateToken(dataDir)).toBe(winner);
  });

  it('rethrows a non-EEXIST write error', () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(() => loadOrCreateToken(dataDir)).toThrow('denied');
  });
});
