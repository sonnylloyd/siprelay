import fs from 'fs';
import { Config } from '../configurations';
import { createIncomingCallNotification } from './IncomingCallNotification';
import { ApnsProvider } from './providers/ApnsProvider';
import { FcmProvider, parseFirebaseServiceAccount } from './providers/FcmProvider';
import { PushDestination, PushProvider, PushSender } from './types';

// Preserve the existing imports used by callers of this module.
export { parsePushDestination } from './PushDestination';
export { PushDestination, PushSender } from './types';

/** Select a configured provider; provider-specific authentication and I/O stay in its strategy. */
export class PushService implements PushSender {
  private readonly providers: PushProvider[] = [];

  constructor(config: Config) {
    const apnsKey = config.PUSH_APNS_KEY_PATH
      ? fs.readFileSync(config.PUSH_APNS_KEY_PATH, 'utf8') : undefined;
    if (apnsKey && config.PUSH_APNS_KEY_ID && config.PUSH_APNS_TEAM_ID && config.PUSH_APNS_TOPIC) {
      this.providers.push(new ApnsProvider({
        key: apnsKey,
        keyId: config.PUSH_APNS_KEY_ID,
        teamId: config.PUSH_APNS_TEAM_ID,
        topic: config.PUSH_APNS_TOPIC,
        sandbox: config.PUSH_APNS_SANDBOX,
      }));
    }
    if (config.PUSH_FCM_SERVICE_ACCOUNT_PATH) {
      const account = parseFirebaseServiceAccount(fs.readFileSync(config.PUSH_FCM_SERVICE_ACCOUNT_PATH, 'utf8'));
      this.providers.push(new FcmProvider(account));
    }
  }

  supports(destination: PushDestination): boolean {
    return this.providers.some(provider => provider.supports(destination));
  }

  async send(destination: PushDestination, callId: string): Promise<void> {
    const provider = this.providers.find(candidate => candidate.supports(destination));
    if (!provider) throw new Error('Push application is not configured');
    await provider.send(destination, createIncomingCallNotification(callId));
  }
}
