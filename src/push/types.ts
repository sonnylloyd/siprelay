export interface PushDestination {
  provider: 'apns' | 'fcm';
  token: string;
  app: string;
}

export interface PushSender {
  supports(destination: PushDestination): boolean;
  send(destination: PushDestination, callId: string): Promise<void>;
}

export interface IncomingCallNotification {
  event: 'incoming_call';
  call_id: string;
  call_uuid: string;
}

export interface PushProvider {
  supports(destination: PushDestination): boolean;
  send(destination: PushDestination, notification: IncomingCallNotification): Promise<void>;
}
