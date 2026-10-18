import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM; output is base64(iv(12) | tag(16) | ciphertext).
export function createCipher(base64Key) {
  const key = Buffer.from(String(base64Key || ''), 'base64');
  if (key.length !== 32) throw new Error('PHONE_ENC_KEY must be 32 bytes (base64)');
  return {
    encrypt(text) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    decrypt(b64) {
      const buf = Buffer.from(String(b64), 'base64');
      if (buf.length < 28) throw new Error('bad ciphertext');
      const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
