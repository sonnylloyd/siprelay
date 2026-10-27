import http2 from 'http2';
import { IncomingCallNotification, PushDestination, PushProvider } from '../types';
import { signJwt } from '../signJwt';

interface ApnsCredentials {
  key: string;
  keyId: string;
  teamId: string;
  topic: string;
  sandbox: boolean;
}

const REQUEST_TIMEOUT_MS = 8_000;
const TOKEN_TTL_MS = 50 * 60 * 1_000;

export class ApnsProvider implements PushProvider {
  private apnsToken?: { value: string; expires: number };

  constructor(private readonly credentials: ApnsCredentials) {}

  supports(destination: PushDestination): boolean {
    return destination.provider === 'apns' && (destination.app === `${this.credentials.teamId}.${this.credentials.topic}`
      || destination.app === this.credentials.topic); // Legacy app format retained during migration.
  }

  send(destination: PushDestination, notification: IncomingCallNotification): Promise<void> {
    const token = this.getAuthorizationToken();
    return new Promise((resolve, reject) => {
      const session = http2.connect(this.credentials.sandbox
        ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        session.destroy();
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error('APNs request timed out')), REQUEST_TIMEOUT_MS);
      session.on('error', () => finish(new Error('APNs connection failed')));
      session.on('connect', () => {
        const request = session.request({
          ':method': 'POST',
          ':path': `/3/device/${destination.token}`,
          authorization: `bearer ${token}`,
          'apns-topic': this.credentials.topic,
          'apns-push-type': 'voip',
          'apns-priority': '10',
          'apns-expiration': '0',
        });
        let status: number | undefined;
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('error', () => finish(new Error('APNs request failed')));
        // Drain the provider response without retaining tokens or account details.
        request.on('data', () => {});
        request.on('end', () => finish(status === 200 ? undefined : new Error(`APNs rejected push (${status})`)));
        request.end(JSON.stringify({ aps: { 'content-available': 1 }, ...notification }));
      });
    });
  }

  private getAuthorizationToken(): string {
    if (this.apnsToken && this.apnsToken.expires >= Date.now()) return this.apnsToken.value;
    const value = signJwt(
      { alg: 'ES256', kid: this.credentials.keyId },
      { iss: this.credentials.teamId, iat: Math.floor(Date.now() / 1_000) },
      this.credentials.key
    );
    this.apnsToken = { value, expires: Date.now() + TOKEN_TTL_MS };
    return value;
  }

}
