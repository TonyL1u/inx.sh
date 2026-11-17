import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

export function parseSecretKey(value: string) {
  const key = Buffer.from(value.trim(), /^[0-9a-f]{64}$/i.test(value.trim()) ? 'hex' : 'base64url');
  if (key.length !== 32) throw Error('INX_SECRET_KEY must encode 32 bytes (64 hex characters or 43 base64url characters).');
  return key;
}

// AES-256-GCM. `context` is bound as associated data, so a value sealed for one record cannot be replayed into another.
export function seal(key: Buffer, plaintext: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return 'v1.' + iv.toString('base64url') + '.' + body.toString('base64url');
}

export function unseal(key: Buffer, sealed: string, context: string) {
  const [version, iv, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !body) throw Error('Unsupported sealed value');
  const data = Buffer.from(body, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
}

const scryptParams = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const derive = (password: string, salt: Buffer, params: typeof scryptParams) => new Promise<Buffer>((resolve, reject) => scrypt(password.normalize('NFKC'), salt, 32, params, (e, key) => (e ? reject(e) : resolve(key))));

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, scryptParams);
  return ['scrypt', Math.log2(scryptParams.N), scryptParams.r, scryptParams.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, logN, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), { ...scryptParams, N: 2 ** Number(logN), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}
