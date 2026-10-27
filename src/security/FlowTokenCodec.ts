import crypto from 'crypto';

export interface FlowIdentity { domain: string; user: string; flow: string }

/** Authenticated route handles; persistent deployments retain the private signing key. */
export class FlowTokenCodec {
  constructor(private readonly secret = crypto.randomBytes(32)) {}

  encode(identity: FlowIdentity): string {
    const payload = Buffer.from(JSON.stringify([identity.domain.toLowerCase(), identity.user, identity.flow])).toString('base64url');
    return `ft.${payload}.${this.mac(payload).toString('base64url')}`;
  }

  decode(token: string): FlowIdentity | undefined {
    if (token.length > 2048 || !/^ft\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+$/.test(token)) return;
    const [, payload, signature] = token.split('.');
    const supplied = Buffer.from(signature, 'base64url'), expected = this.mac(payload);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return;
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!Array.isArray(value) || value.length !== 3 || value.some(part => typeof part !== 'string' || !part)) return;
    return { domain: value[0], user: value[1], flow: value[2] };
  }

  private mac(payload: string): Buffer { return crypto.createHmac('sha256', this.secret).update(payload).digest(); }
}
