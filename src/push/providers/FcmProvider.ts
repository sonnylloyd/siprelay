import { IncomingCallNotification, PushDestination, PushProvider } from '../types';
import { signJwt } from '../signJwt';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 8_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface FirebaseServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export function parseFirebaseServiceAccount(json: string): FirebaseServiceAccount {
  const account = JSON.parse(json) as Partial<FirebaseServiceAccount> | null;
  if (!account || typeof account.project_id !== 'string' || !account.project_id
    || typeof account.client_email !== 'string' || !account.client_email
    || typeof account.private_key !== 'string' || !account.private_key) {
    throw new Error('FCM service account requires project_id, client_email and private_key');
  }
  return { project_id: account.project_id, client_email: account.client_email, private_key: account.private_key };
}

export class FcmProvider implements PushProvider {
  private googleToken?: { token: string; expires: number };
  private tokenRequest?: Promise<string>;

  constructor(private readonly account: FirebaseServiceAccount) {}

  supports(destination: PushDestination): boolean {
    return destination.provider === 'fcm' && destination.app === this.account.project_id;
  }

  async send(destination: PushDestination, notification: IncomingCallNotification): Promise<void> {
    const token = await this.getGoogleToken();
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        message: {
          token: destination.token,
          data: notification,
          android: { priority: 'high', ttl: '25s' },
        },
      }),
    });
    // Never log provider bodies: they may contain tokens or account information.
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`FCM rejected push (${response.status})`);
  }

  private async getGoogleToken(): Promise<string> {
    if (this.googleToken && this.googleToken.expires > Date.now() + TOKEN_REFRESH_MARGIN_MS) return this.googleToken.token;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.requestGoogleToken();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  private async requestGoogleToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt({ alg: 'RS256', typ: 'JWT' }, {
      iss: this.account.client_email,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3_600,
    }, this.account.private_key);
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!response.ok) throw new Error(`FCM OAuth failed (${response.status})`);
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in)) {
      throw new Error('Invalid FCM OAuth response');
    }
    this.googleToken = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }
}
