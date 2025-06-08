// BaseProxy.ts
import { IPValue, IRecordStore } from './../store';
import { Logger } from '../logging/Logger';
import { Proxy } from './Proxy';
import { parse, write, MediaDescription } from 'sdp-transform';

export interface ClientInfo {
  address: string;
  port: number;
  timeout?: NodeJS.Timeout;
}

export abstract class BaseProxy implements Proxy {
  protected records: IRecordStore;
  protected logger: Logger;
  protected clientMap: Map<string, ClientInfo>;
  private CLIENT_TIMEOUT_MS = 30000; // 30 seconds timeout

  constructor(records: IRecordStore, logger: Logger) {
    this.records = records;
    this.logger = logger;
    this.clientMap = new Map();
  }

  protected extractSipHost(message: string): string | null {
    const match = message.match(/^(?:INVITE|REGISTER|ACK|BYE|CANCEL|OPTIONS|INFO|MESSAGE|SUBSCRIBE|NOTIFY)\s+sip:[^@]+@([^>\s;]+)/i);
    return match ? match[1] : null;
  }

  protected extractStatusCode(sipMessage: string): number | null {
    const match = sipMessage.match(/^SIP\/2.0\s+(\d{3})/);
    return match ? parseInt(match[1], 10) : null;
  }

  protected getTargetRecord(destinationHost: string): IPValue | null {
    const target = this.records.getRecord(destinationHost);
    if (!target) {
      this.logger.warn(`No record found for hostname: ${destinationHost}`);
      return null;
    }
    return target;
  }

  protected extractCallId(sipMessage: string): string | null {
    const match = sipMessage.match(/Call-ID: (.+)/i);
    return match ? match[1].trim() : null;
  }

  protected storeClient(callId: string, address: string, port: number): void {
    this.logger.info(`Storing client ${address}:${port} for Call-ID ${callId}`);
    const existingClient = this.clientMap.get(callId);
    if (existingClient?.timeout) clearTimeout(existingClient.timeout);

    const timeout = setTimeout(() => {
      this.logger.warn(`Client ${address}:${port} for Call-ID ${callId} timed out and was removed`);
      this.clientMap.delete(callId);
    }, this.CLIENT_TIMEOUT_MS);

    this.clientMap.set(callId, { address, port, timeout });
  }

  protected getClient(callId: string): ClientInfo | undefined {
    return this.clientMap.get(callId);
  }

  protected removeClient(callId: string): void {
    const client = this.clientMap.get(callId);
    if (client?.timeout) clearTimeout(client.timeout);
    this.clientMap.delete(callId);
    this.logger.info(`Removed client for Call-ID ${callId}`);
  }

  protected removeClientOn2xx(callId: string, sipMessage: string): void {
    const status = this.extractStatusCode(sipMessage);
    if (status && status >= 200 && status < 300) {
      this.removeClient(callId);
    } else {
      this.logger.debug(`Client for Call-ID ${callId} not removed (status code: ${status})`);
    }
  }

  protected isResponse(sipMessage: string): boolean {
    return /^SIP\/2.0\s+\d{3}/.test(sipMessage);
  }

  protected addViaHeader(sipMessage: string, proxyIp: string, proxyPort: number): string {
    const viaHeader = `Via: SIP/2.0/UDP ${proxyIp}:${proxyPort};branch=z9hG4bKproxy\r\n`;
    this.logger.info(`New proxy Via Header ${viaHeader}`);
    return /^Via: .*$/gim.test(sipMessage)
      ? sipMessage.replace(/^(Via: .*?$)/gim, viaHeader + '$1')
      : `${sipMessage.split('\r\n')[0]}\r\n${viaHeader}${sipMessage.split('\r\n').slice(1).join('\r\n')}`;
  }

  protected removeViaHeader(sipMessage: string, callId: string): string {
    const clientInfo = this.getClient(callId);
    if (!clientInfo) {
      this.logger.warn(`No client info found for Call-ID ${callId}. Sending response as-is.`);
      return sipMessage.replace(/^Via: .*?\r\n/i, '');
    }
    return sipMessage.replace(
      /^Via: .*?\r\n/i,
      `Via: SIP/2.0/UDP ${clientInfo.address}:${clientInfo.port};branch=z9hG4bKclient\r\n`
    );
  }

  protected rewriteContactHeader(sipMessage: string, ip: string, port: number): string {
    return sipMessage.replace(
      /Contact: <sip:([^@>]+)@[^:>]+(?::\d+)?>/,
      `Contact: <sip:$1@${ip}:${port}>`
    );
  }

  protected rewriteSdpBody(sipMessage: string, newIp: string): string {
    const sdpStartIndex = sipMessage.indexOf('\r\n\r\n');
    if (sdpStartIndex === -1) return sipMessage;
    const sdp = sipMessage.slice(sdpStartIndex + 4);
    const parsed = parse(sdp);

    if (parsed.connection) parsed.connection.ip = newIp;
    (parsed.media as MediaDescription[])?.forEach(m => {
      if (m.connection) m.connection.ip = newIp;
    });

    const newSdp = write(parsed);
    return sipMessage.slice(0, sdpStartIndex + 4) + newSdp;
  }

  abstract start(): void;
}