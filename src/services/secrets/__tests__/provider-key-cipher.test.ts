import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createProviderKeyCipher, kekFromEnv } from '../provider-key-cipher';
import { resetRegisteredSecrets } from '../redaction';
import { redactEvidenceContent } from '../../ai-config/execution';

afterEach(resetRegisteredSecrets);

const secret = 'tenant-subkey-not-matching-any-regex-1234567890';

describe('provider key cipher (AES-GCM)', () => {
  const cipher = createProviderKeyCipher(randomBytes(32));

  it('round-trips and never stores plaintext', () => {
    const boxed = cipher.encrypt(secret, 'tenant-a');
    expect(boxed.startsWith('v1:')).toBe(true);
    expect(boxed).not.toContain(secret);
    expect(cipher.encrypt(secret, 'tenant-a')).not.toBe(boxed); // fresh IV
    expect(cipher.decrypt(boxed, 'tenant-a')).toBe(secret);
  });

  it('fails for another tenant (AAD), a tampered body or another master key', () => {
    const boxed = cipher.encrypt(secret, 'tenant-a');
    expect(() => cipher.decrypt(boxed, 'tenant-b')).toThrow();
    const parts = boxed.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => cipher.decrypt(parts.join(':'), 'tenant-a')).toThrow();
    expect(() => createProviderKeyCipher(randomBytes(32)).decrypt(boxed, 'tenant-a')).toThrow();
  });

  it('requires a 32-byte base64 KEK', () => {
    expect(() => kekFromEnv({})).toThrow('PROVIDER_KEY_KEK');
    expect(() => kekFromEnv({ PROVIDER_KEY_KEK: Buffer.from('short').toString('base64') })).toThrow();
    expect(kekFromEnv({ PROVIDER_KEY_KEK: randomBytes(32).toString('base64') })).toHaveLength(32);
  });
});

describe('evidence redaction of tenant sub-keys', () => {
  it('redacts a decrypted key even when it matches no known pattern', () => {
    const cipher = createProviderKeyCipher(randomBytes(32));
    expect(redactEvidenceContent(`header ${secret}`)).toContain(secret);
    cipher.decrypt(cipher.encrypt(secret, 't'), 't');
    expect(redactEvidenceContent(`header ${secret} tail`)).toBe('header [REDACTED] tail');
  });

  it('redacts the provisioning key from env', () => {
    process.env.OPENROUTER_PROVISIONING_KEY = 'prov-key-plain-abcdefgh';
    try {
      expect(redactEvidenceContent('x prov-key-plain-abcdefgh y')).toBe('x [REDACTED] y');
    } finally {
      delete process.env.OPENROUTER_PROVISIONING_KEY;
    }
  });
});
