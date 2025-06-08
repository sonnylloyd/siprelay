// BaseProxy.ts
import { IPValue, IRecordStore } from './../store';
import { Logger } from '../logging/Logger';
import { Proxy } from './Proxy';
import { parse, write, MediaDescription } from 'sdp-transform';

export interface ClientInfo {
  address: string;
  port: number;
  branch?: string;
  rport?: boolean;
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
    const match = message.match(/\s*(?:INVITE|REGISTER|ACK|BYE|CANCEL|OPTIONS|INFO|MESSAGE|SUBSCRIBE|NOTIFY)\s+sip:[^@]+@([^>\s;]+)/i);
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

  protected storeClient(callId: string, address: string, port: number, sipMessage?: string): void {
    this.logger.info(`Storing client ${address}:${port} for Call-ID ${callId}`);
    const existingClient = this.clientMap.get(callId);
    if (existingClient?.timeout) clearTimeout(existingClient.timeout);

    let branch: string | undefined;
    let rport = false;

    if (sipMessage) {
      const viaMatches = sipMessage.match(/^Via:\s*(SIP\/2.0\/[^\s]+)\s+([^\s;]+)(.*)$/gim);
      if (viaMatches && viaMatches.length > 1) {
        const originalVia = viaMatches[1];
        const branchMatch = originalVia.match(/branch=([^;\s]+)/i);
        if (branchMatch?.[1]) branch = branchMatch[1];
        rport = /;rport(?:=|$)/i.test(originalVia);
      }
    }

    const timeout = setTimeout(() => {
      this.logger.warn(`Client ${address}:${port} for Call-ID ${callId} timed out and was removed`);
      this.clientMap.delete(callId);
    }, this.CLIENT_TIMEOUT_MS);

    this.clientMap.set(callId, { address, port, branch, rport, timeout });
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
      this.logger.info(`Client for Call-ID ${callId} not removed (status code: ${status})`);
    }
  }

  protected isResponse(sipMessage: string): boolean {
    return /^SIP\/2.0\s+\d{3}/.test(sipMessage);
  }

  protected addViaHeader(sipMessage: string, proxyIp: string, proxyPort: number, protocol: string): string {
    const branch = this.generateBranch();
    const viaHeader = `Via: SIP/2.0/${protocol} ${proxyIp}:${proxyPort};branch=${branch}\r\n`;
    this.logger.info(`New proxy Via Header ${viaHeader}`);
    return /^Via: .*$/gim.test(sipMessage)
      ? sipMessage.replace(/^(Via: .*?$)/gim, viaHeader + '$1')
      : `${sipMessage.split('\r\n')[0]}\r\n${viaHeader}${sipMessage.split('\r\n').slice(1).join('\r\n')}`;
  }  

  protected removeViaHeader(sipMessage: string, callId: string, protocol: string): string {
    const clientInfo = this.getClient(callId);
    if (!clientInfo) {
      this.logger.warn(`No client info found for Call-ID ${callId}. Sending response as-is.`);
      return sipMessage;
    }

    const viaRegex = /^Via:\s*SIP\/2.0\/[A-Z]+\s+[^;\s]+(?:;[^=\s]+(?:=[^;\s]+)?)*/gim;
    const vias = sipMessage.match(viaRegex);
    if (!vias || vias.length === 0) {
      this.logger.warn(`No Via header found for Call-ID ${callId}. Sending response as-is.`);
      return sipMessage;
    }

    let newVia = `Via: SIP/2.0/${protocol} ${clientInfo.address}:${clientInfo.port}`;
    if (clientInfo.branch) newVia += `;branch=${clientInfo.branch}`;
    if (clientInfo.rport) newVia += `;rport`;

    return sipMessage.replace(viaRegex, (match, offset) =>
      offset === sipMessage.indexOf(match) ? newVia : match
    );
  }

  protected rewriteContactHeader(sipMessage: string, ip: string, port: number): string {
    return sipMessage.replace(
      /Contact: <sip:([^@>]+)@[^:>]+(?::\d+)?>/,
      `Contact: <sip:$1@${ip}:${port}>`
    );
  }

  private generateBranch(): string {
    return `z9hG4bK${Math.random().toString(36).substring(2, 12)}`;
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