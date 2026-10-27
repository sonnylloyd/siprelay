import { IPValue, IRecordStore } from '../store';
import { SipMessage } from '../sip/SipMessage';

interface PbxRoute {
  domain: string;
  record: IPValue;
}

/** Resolve a tenant and verify its configured PBX endpoint before delivering to a phone. */
export class PbxRouteResolver {
  constructor(private readonly records: IRecordStore) {}

  resolveUdp(message: SipMessage, peer: { address: string; port: number }, routeDomain?: string): PbxRoute | undefined {
    return this.resolve(message, routeDomain,
      record => record.ip === peer.address && record.udpPort === peer.port);
  }

  resolveTls(message: SipMessage, upstreamKey: string, routeDomain?: string): PbxRoute | undefined {
    return this.resolve(message, routeDomain,
      record => `${record.ip}:${record.tlsPort}${record.tlsServerName ? `|${record.tlsServerName}` : ''}` === upstreamKey);
  }

  resolveTcp(message: SipMessage, upstreamKey: string, routeDomain?: string): PbxRoute | undefined {
    return this.resolve(message, routeDomain, record => `${record.ip}:${record.tcpPort}` === upstreamKey);
  }

  private resolve(
    message: SipMessage,
    routeDomain: string | undefined,
    matchesPeer: (record: IPValue) => boolean
  ): PbxRoute | undefined {
    let domain = routeDomain;
    if (!domain) {
      const toDomain = message.getAddressOfRecord()?.host;
      const toRecord = toDomain ? this.records.getRecord(toDomain) : undefined;
      if (toRecord) {
        if (!matchesPeer(toRecord)) return;
        domain = toDomain;
      } else {
        const candidates = Object.entries(this.records.getAllRecords()).filter(([, record]) => matchesPeer(record));
        // A shared endpoint cannot choose a tenant on the caller's behalf.
        if (candidates.length !== 1) return;
        domain = candidates[0][0];
      }
    }
    if (!domain) return;
    const record = this.records.getRecord(domain);
    if (!record || !matchesPeer(record)) return;
    return { domain, record };
  }
}
