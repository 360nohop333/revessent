// Revessent secret box (audit #7).
// AES-256-GCM helpers shared by connect (Razorpay Key Secret) and the webhook
// verifier. Two jobs:
//
// 1. KEY ROTATION — decrypt tries ENCRYPTION_KEY first, then
//    ENCRYPTION_KEY_OLD (if set). Encrypt always uses ENCRYPTION_KEY, so
//    secrets re-encrypt organically the next time they're saved. To rotate:
//    set ENCRYPTION_KEY=<new>, ENCRYPTION_KEY_OLD=<old>, redeploy, then
//    re-save the Razorpay connection once per workspace and drop _OLD.
//
// 2. SELF-DESCRIBING VALUES — encryptToString produces
//    "enc:v1:<iv>:<tag>:<data>" (base64url parts) so a single text column can
//    hold either an encrypted or a legacy plaintext value (webhook_secret).
//    decryptFromString returns the plaintext for both.

const crypto = require('crypto');

function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    const error = new Error('Encryption key not configured.');
    error.statusCode = 500;
    throw error;
  }
  return Buffer.from(key, 'hex');
}

function getLegacyEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY_OLD;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) return null;
  return Buffer.from(key, 'hex');
}

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

// ── column-triplet form (encrypted_restricted_key / key_iv / key_tag) ────────

function decryptWithKey(key, encryptedB64, ivB64, tagB64) {
  const encrypted = Buffer.from(encryptedB64 || '', 'base64');
  const iv = Buffer.from(ivB64 || '', 'base64');
  const tag = Buffer.from(tagB64 || '', 'base64');
  return decryptBuffers(key, encrypted, iv, tag);
}

function decryptBuffers(key, encrypted, iv, tag) {
  if (!encrypted.length || !iv.length || !tag.length) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (_) {
    return null; // wrong key or corrupted value
  }
}

function decryptColumns(encryptedB64, ivB64, tagB64) {
  // Audit #7: current key first, then the rotation key.
  const primary = decryptWithKey(getEncryptionKey(), encryptedB64, ivB64, tagB64);
  if (primary !== null) return primary;

  const legacyKey = getLegacyEncryptionKey();
  if (legacyKey) {
    const legacy = decryptWithKey(legacyKey, encryptedB64, ivB64, tagB64);
    if (legacy !== null) return legacy;
  }

  const error = new Error('Stored Razorpay secret is incomplete. Reconnect Razorpay.');
  error.statusCode = 400;
  throw error;
}

function encryptColumns(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

// ── single-string form ("enc:v1:…" or legacy plaintext) ─────────────────────

const ENC_PREFIX = 'enc:v1:';

function encryptToString(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return ENC_PREFIX + [b64url(iv), b64url(tag), b64url(data)].join(':');
}

function decryptFromString(stored) {
  const value = String(stored || '');
  if (!value.startsWith(ENC_PREFIX)) return value; // legacy plaintext — still valid

  const parts = value.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) {
    const error = new Error('Stored secret is malformed. Reconnect Razorpay.');
    error.statusCode = 400;
    throw error;
  }
  const unurl = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const encrypted = unurl(parts[2]);
  const iv = unurl(parts[0]);
  const tag = unurl(parts[1]);

  const primary = decryptBuffers(getEncryptionKey(), encrypted, iv, tag);
  if (primary !== null) return primary;

  const legacyKey = getLegacyEncryptionKey();
  if (legacyKey) {
    const legacy = decryptBuffers(legacyKey, encrypted, iv, tag);
    if (legacy !== null) return legacy;
  }

  const error = new Error('Stored secret could not be decrypted with the current ENCRYPTION_KEY. Set ENCRYPTION_KEY_OLD to the previous key, or reconnect Razorpay.');
  error.statusCode = 400;
  throw error;
}

module.exports = {
  getEncryptionKey,
  encryptColumns,
  decryptColumns,
  encryptToString,
  decryptFromString,
  getBearerToken,
};
