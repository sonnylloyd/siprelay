import crypto from 'crypto';

export function signJwt(header: { alg: 'ES256' | 'RS256'; kid?: string; typ?: string }, claims: object, key: string): string {
  const data = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const signature = crypto.sign('sha256', Buffer.from(data), {
    key, ...(header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' as const } : {}),
  });
  return `${data}.${signature.toString('base64url')}`;
}

