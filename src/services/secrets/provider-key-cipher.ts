/**
 * AES-256-GCM at rest for the platform-owned tenant sub-keys. Master key: env `PROVIDER_KEY_KEK`
 * (base64, 32 bytes). The tenant id is bound as AAD, so a ciphertext copied to another tenant's
 * row fails to decrypt. Format: `v1:<iv>:<tag>:<ciphertext>` (base64). Never log the plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { registerSecret } from './redaction';

export interface ProviderKeyCipher {
  encrypt(plaintext: string, tenantId: string): string;
  decrypt(ciphertext: string, tenantId: string): string;
}

export function kekFromEnv(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.PROVIDER_KEY_KEK?.trim();
  const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('PROVIDER_KEY_KEK must be 32 bytes encoded as base64.');
  return key;
}

export function createProviderKeyCipher(kek: Buffer = kekFromEnv()): ProviderKeyCipher {
  if (kek.length !== 32) throw new Error('PROVIDER_KEY_KEK must be 32 bytes encoded as base64.');
  return {
    encrypt(plaintext, tenantId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', kek, iv);
      cipher.setAAD(Buffer.from(tenantId, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
    },
    decrypt(ciphertext, tenantId) {
      const [version, iv, tag, body] = ciphertext.split(':');
      if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Unsupported provider key ciphertext.');
      const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(tenantId, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
      registerSecret(plaintext);
      return plaintext;
    },
  };
}
