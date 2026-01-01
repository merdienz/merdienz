import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_SMTP_PASSWORD_FILE = '/etc/merdienz-cloud/smtp-password';
export const MAX_SECRET_BYTES = 4096;

export function merdienzGroupId() {
  try {
    const text = readFileSync('/etc/group', 'utf8');
    for (const line of text.split('\n')) {
      const [name, , gid] = line.split(':');
      if (name === 'merdienz') {
        const n = Number(gid);
        return Number.isInteger(n) ? n : null;
      }
    }
  } catch {
    // no /etc/group or unreadable
  }
  return null;
}

function modeBits(stat) {
  return stat.mode & 0o777;
}

function modeString(stat) {
  return modeBits(stat).toString(8);
}

export function isUnderCredentialsDirectory(path) {
  const creds = process.env.CREDENTIALS_DIRECTORY;
  if (!creds) return false;
  try {
    return dirname(realpathSync(path)) === realpathSync(creds);
  } catch {
    return false;
  }
}

/**
 * Permission decision for a secret-file fstat, used by the reader and tests.
 * 640 is accepted only when allowGroupReadable is set and the owner is root:merdienz.
 */
export function secretPermsAllowed(stat, { allowGroupReadable = false, underCredentialsDir = false, merdienzGid } = {}) {
  if (!stat || typeof stat.isFile === 'function' && !stat.isFile()) {
    return { ok: false, message: 'not found' };
  }
  if (Number(stat.size) > MAX_SECRET_BYTES) {
    return { ok: false, message: 'is too large' };
  }
  const mode = modeBits(stat);
  if (mode === 0o600 || mode === 0o400) return { ok: true };
  if (mode === 0o640 && allowGroupReadable) {
    const gid = merdienzGid === undefined ? merdienzGroupId() : merdienzGid;
    if (stat.uid === 0 && gid != null && stat.gid === gid) return { ok: true };
    return { ok: false, message: 'mode 640 must be owned by root:merdienz' };
  }
  if (mode === 0o440 && underCredentialsDir) return { ok: true };
  if (allowGroupReadable) {
    return { ok: false, message: `must be mode 600, 400, or 640 (got ${mode.toString(8)})` };
  }
  return { ok: false, message: `must be mode 600 or 400 (got ${mode.toString(8)})` };
}

function assertSecretPerms(stat, path, label, opts = {}) {
  const result = secretPermsAllowed(stat, {
    allowGroupReadable: Boolean(opts.allowGroupReadable),
    underCredentialsDir: isUnderCredentialsDirectory(path),
    merdienzGid: opts.merdienzGid,
  });
  if (!result.ok) {
    throw new Error(`${label} ${result.message}`);
  }
}

/** Open a secret file, refuse unexpected symlinks, and fstat the fd for mode/owner/size. */
export function openSecretFile(path, label = 'secret file', opts = {}) {
  if (!path) {
    throw new Error(`${label} path is required`);
  }
  let link;
  try {
    link = lstatSync(path);
  } catch {
    throw new Error(`${label} not found`);
  }
  if (link.isSymbolicLink()) {
    if (!isUnderCredentialsDirectory(path)) {
      throw new Error(`${label} must not be a symlink`);
    }
  } else if (!link.isFile()) {
    throw new Error(`${label} not found`);
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch {
    throw new Error(`${label} is not readable`);
  }
  try {
    const stat = fstatSync(fd);
    assertSecretPerms(stat, path, label, opts);
    return fd;
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closing after a failed check
    }
    throw err;
  }
}

/**
 * Same rules as the shell secret-file check used by the reference deploy scripts, plus:
 * open + fstat, no unexpected symlinks, 4 KiB cap, 640 only as root:merdienz.
 */
export function requireSecretFile(path, label = 'secret file', opts = {}) {
  const fd = openSecretFile(path, label, opts);
  closeSync(fd);
  return path;
}

/** Read a secret file, trim trailing CR/LF, and refuse an empty value. Never include the contents in the error. */
export function readSecretFile(path, label = 'secret file', opts = {}) {
  const fd = openSecretFile(path, label, opts);
  try {
    const stat = fstatSync(fd);
    const size = Number(stat.size);
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    const value = buf.toString('utf8', 0, off).replace(/(?:\r?\n)+$/u, '');
    if (!value) {
      throw new Error(`${label} is empty`);
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

export { modeString };
