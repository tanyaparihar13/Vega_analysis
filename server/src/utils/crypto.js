const crypto = require('crypto');
require('dotenv').config();

const ALGO = 'aes-256-gcm';
const KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || '', 'hex');

function encrypt(plainText) {
  if (KEY.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars).');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together, base64 encoded
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(payload) {
  const data = Buffer.from(payload, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
