import { SipMessage } from '../SipMessage';

export type SendPacket = (packet: Buffer) => void | Promise<void>;
type ClientState = 'calling' | 'trying' | 'proceeding' | 'completed' | 'accepted';
type ServerState = 'proceeding' | 'completed' | 'confirmed' | 'accepted';
type Timer = ReturnType<typeof setTimeout>;

interface ServerTransaction {
  key: string;
  request: SipMessage;
  reliable: boolean;
  send: SendPacket;
  state: ServerState;
  latest?: SipMessage;
  client?: ClientTransaction;
  timers: Map<string, Timer>;
}
interface ClientTransaction {
  key: string;
  request: SipMessage;
  server?: ServerTransaction;
  peer: string;
  reliable: boolean;
  send: SendPacket;
  state: ClientState;
  acknowledgement?: Buffer;
  cancelRequested: boolean;
  cancelSent: boolean;
  timers: Map<string, Timer>;
}
export interface TransactionOptions {
  t1?: number;
  t2?: number;
  t4?: number;
  timerC?: number;
  maxEntries?: number;
  onError?: (error: unknown) => void;
  onClientTerminated?: (key: string) => void;
}

/** One-hop RFC 3261 transactions, with RFC 6026 accepted states and RFC 4320 timeouts.
 * Network identity is supplied by the transport; this layer never trusts a packet's Via address.
 */
export class TransactionLayer {
  private readonly servers = new Map<string, ServerTransaction>();
  private readonly clients = new Map<string, ClientTransaction>();
  private readonly t1: number;
  private readonly t2: number;
  private readonly t4: number;
  private readonly timerC: number;
  private readonly maxEntries: number;

  constructor(private readonly options: TransactionOptions = {}) {
    this.t1 = options.t1 ?? 500;
    this.t2 = options.t2 ?? 4_000;
    this.t4 = options.t4 ?? 5_000;
    this.timerC = options.timerC ?? 181_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    if (this.t1 <= 0 || this.t2 < this.t1 || this.t4 <= 0 || this.timerC <= 180_000 || this.maxEntries < 1) {
      throw new Error('Invalid SIP transaction timer or capacity configuration');
    }
  }

  serverKey(message: SipMessage, flow: string, method = message.getMethod()): string {
    const via = message.getTopVia()?.split(',')[0] ?? '';
    const sentBy = via.split(/\s+/)[1]?.split(';')[0]?.toLowerCase();
    return JSON.stringify([flow, message.getBranchFromVia(via), sentBy, method, message.getCallId(), message.getCSeqNumber()]);
  }

  /** true means consumed (duplicate, local CANCEL, non-2xx ACK, or capacity rejection). */
  receiveRequest(message: SipMessage, flow: string, reliable: boolean, send: SendPacket): boolean {
    const method = message.getMethod();
    const invite = this.servers.get(this.serverKey(message, flow, 'INVITE'));
    if (method === 'ACK') {
      if (!invite || !['completed', 'confirmed'].includes(invite.state) || !this.matchesTags(message, invite.latest!)) return false;
      if (invite.state === 'confirmed') return true;
      invite.state = 'confirmed';
      this.clearTimers(invite);
      this.schedule(invite, 'I', reliable ? 0 : this.t4, () => this.removeServer(invite));
      return true;
    }
    const key = this.serverKey(message, flow);
    const previous = this.servers.get(key);
    if (previous) {
      // A repeated branch must not change the request identity or move its response destination.
      if (!this.matchesTags(message, previous.request) || message.startLine !== previous.request.startLine) return true;
      if (previous.latest && previous.state !== 'accepted' && previous.state !== 'confirmed') this.send(previous.send, previous.latest.toBuffer());
      return true;
    }
    if (this.servers.size >= this.maxEntries) {
      this.send(send, Buffer.from(message.createResponse(503, 'Service Unavailable')));
      return true;
    }
    const server: ServerTransaction = { key, request: message.clone(), reliable, send, state: 'proceeding', timers: new Map() };
    this.servers.set(key, server);
    if (method === 'CANCEL') {
      if (!invite || !this.matchesTags(message, invite.request)) {
        this.respond(server, new SipMessage(message.createResponse(481, 'Call/Transaction Does Not Exist')));
        return true;
      }
      // Cancellation while routing/pushing is local: never release that INVITE later.
      if (!invite.client && invite.state === 'proceeding') {
        this.respond(server, new SipMessage(message.createResponse(200, 'OK')));
        this.respond(invite, new SipMessage(invite.request.createResponse(487, 'Request Terminated')));
        return true;
      }
      this.respond(server, new SipMessage(message.createResponse(200, 'OK')));
      if (invite.client && ['calling', 'proceeding'].includes(invite.client.state)) {
        invite.client.cancelRequested = true;
        if (invite.client.state === 'proceeding') this.sendCancel(invite.client);
      }
      return true;
    }
    if (method === 'INVITE') {
      this.schedule(server, 'trying', 200, () => {
        if (!server.latest) this.respond(server, new SipMessage(server.request.createResponse(100, 'Trying')));
      });
    }
    // Bound requests awaiting application routing or push without a client transaction.
    this.schedule(server, 'routing', this.timerC, () => {
      if (!server.client && server.state === 'proceeding') {
        if (method === 'INVITE') this.respond(server, new SipMessage(server.request.createResponse(408, 'Request Timeout')));
        else this.removeServer(server);
      }
    });
    return false;
  }

  /** Records and sends application-generated responses through the server transaction. */
  reply(request: SipMessage, flow: string, response: SipMessage): boolean {
    const server = this.servers.get(this.serverKey(request, flow));
    if (!server) return false;
    this.respond(server, response);
    return true;
  }

  forward(request: SipMessage, serverKey: string, peer: string, reliable: boolean, send: SendPacket): boolean {
    if (request.getMethod() === 'ACK') { this.send(send, request.toBuffer()); return true; }
    const server = this.servers.get(serverKey);
    if (!server || server.state !== 'proceeding') return false;
    if (this.clients.size >= this.maxEntries) {
      this.respond(server, new SipMessage(server.request.createResponse(503, 'Service Unavailable')));
      return false;
    }
    this.startClient(request, server, peer, reliable, send);
    return true;
  }

  /** Returns false for unmatched, spoofed, hop-local or duplicate responses. */
  receiveResponse(message: SipMessage, peer: string, onValidated?: () => void): boolean {
    const client = this.clients.get(message.getTransactionKey());
    if (!client || client.peer !== peer || message.getFromTag() !== client.request.getFromTag()
      || (client.request.getToTag() && message.getToTag() !== client.request.getToTag())) return false;
    const status = message.getStatusCode();
    if (!status) return false;
    const invite = client.request.getMethod() === 'INVITE';
    if (client.state === 'completed') {
      if (invite && status >= 300 && client.acknowledgement) this.send(client.send, client.acknowledgement);
      return false;
    }
    if (client.state === 'accepted') {
      if (status < 200 || status >= 300) return false;
      onValidated?.(); this.forwardResponse(client, message);
      return true;
    }
    onValidated?.();
    if (status < 200) {
      client.state = 'proceeding';
      if (invite) {
        this.cancelTimer(client, 'A'); this.cancelTimer(client, 'B');
        if (status > 100) this.scheduleTimerC(client);
        if (client.cancelRequested) this.sendCancel(client);
      }
      if (status !== 100) this.forwardResponse(client, message);
      return false;
    }
    this.clearTimers(client);
    if (invite && status < 300) {
      client.state = 'accepted';
      this.schedule(client, 'M', 64 * this.t1, () => this.removeClient(client));
    } else {
      client.state = 'completed';
      if (invite) {
        client.acknowledgement = this.makeControl(client.request, 'ACK', message.getFirstHeader('To')).toBuffer();
        this.send(client.send, client.acknowledgement);
      }
      this.schedule(client, invite ? 'D' : 'K', client.reliable ? 0 : invite ? Math.max(32_000, 64 * this.t1) : this.t4,
        () => this.removeClient(client));
    }
    this.forwardResponse(client, message);
    return true;
  }

  dispose(): void {
    for (const client of [...this.clients.values()]) this.removeClient(client);
    for (const server of [...this.servers.values()]) this.removeServer(server);
  }

  private startClient(request: SipMessage, server: ServerTransaction | undefined, peer: string, reliable: boolean, send: SendPacket): void {
    const invite = request.getMethod() === 'INVITE';
    const client: ClientTransaction = { key: request.getTransactionKey(), request: request.clone(), server, peer, reliable, send,
      state: invite ? 'calling' : 'trying', cancelRequested: false, cancelSent: false, timers: new Map() };
    this.clients.set(client.key, client);
    if (server) { server.client = client; this.cancelTimer(server, 'routing'); }
    this.schedule(client, invite ? 'B' : 'F', 64 * this.t1, () => this.timeout(client));
    if (invite) this.scheduleTimerC(client);
    if (!reliable) this.retransmitRequest(client, this.t1);
    this.send(send, request.toBuffer(), () => this.transportFailure(client));
  }

  private retransmitRequest(client: ClientTransaction, delay: number): void {
    const invite = client.request.getMethod() === 'INVITE';
    this.schedule(client, invite ? 'A' : 'E', delay, () => {
      this.send(client.send, client.request.toBuffer(), () => this.transportFailure(client));
      const next = invite ? delay * 2 : client.state === 'proceeding' ? this.t2 : Math.min(delay * 2, this.t2);
      if (this.clients.get(client.key) === client) this.retransmitRequest(client, next);
    });
  }

  private scheduleTimerC(client: ClientTransaction): void {
    this.schedule(client, 'C', this.timerC, () => {
      client.cancelRequested = true;
      this.sendCancel(client);
      this.schedule(client, 'B', 64 * this.t1, () => this.timeout(client));
    });
  }

  private sendCancel(client: ClientTransaction): void {
    if (client.cancelSent || this.clients.size >= this.maxEntries) return;
    client.cancelSent = true;
    this.startClient(this.makeControl(client.request, 'CANCEL'), undefined, client.peer, client.reliable, client.send);
  }

  private makeControl(request: SipMessage, method: 'ACK' | 'CANCEL', to = request.getFirstHeader('To')): SipMessage {
    const control = new SipMessage(`${method} ${request.startLine.split(' ')[1]} SIP/2.0\r\n\r\n`);
    for (const name of ['From', 'Call-ID', 'Route', 'Max-Forwards']) control.setHeader(name, request.getHeader(name));
    control.setHeader('To', to!);
    control.setHeader('Via', request.getTopVia()!.split(',')[0]);
    control.setHeader('CSeq', `${request.getCSeqNumber()} ${method}`);
    return control;
  }

  private forwardResponse(client: ClientTransaction, response: SipMessage): void {
    if (!client.server) return; // The proxy generated this CANCEL itself.
    const copy = response.clone(); copy.removeViaTop();
    this.respond(client.server, copy);
  }

  private respond(server: ServerTransaction, response: SipMessage): void {
    const status = response.getStatusCode()!;
    if (server.state === 'confirmed') return;
    if (server.state === 'completed') return;
    if (server.state === 'accepted' && (status < 200 || status >= 300)) return;
    this.cancelTimer(server, 'trying');
    server.latest = response.clone();
    if (status >= 200 && server.state !== 'accepted') {
      this.clearTimers(server);
      const invite = server.request.getMethod() === 'INVITE';
      server.state = invite && status < 300 ? 'accepted' : 'completed';
      this.schedule(server, invite ? status < 300 ? 'L' : 'H' : 'J',
        !invite && server.reliable ? 0 : 64 * this.t1, () => this.removeServer(server));
      if (invite && status >= 300 && !server.reliable) this.retransmitResponse(server, this.t1);
    }
    this.send(server.send, response.toBuffer());
  }

  private retransmitResponse(server: ServerTransaction, delay: number): void {
    this.schedule(server, 'G', delay, () => {
      this.send(server.send, server.latest!.toBuffer());
      this.retransmitResponse(server, Math.min(delay * 2, this.t2));
    });
  }

  private timeout(client: ClientTransaction): void {
    if (client.server) {
      // RFC 4320: do not generate non-INVITE 408 responses.
      if (client.request.getMethod() === 'INVITE') this.respond(client.server, new SipMessage(client.server.request.createResponse(408, 'Request Timeout')));
      else this.removeServer(client.server);
    }
    this.removeClient(client);
  }

  private transportFailure(client: ClientTransaction): void {
    if (this.clients.get(client.key) !== client) return;
    if (client.server) this.respond(client.server, new SipMessage(client.server.request.createResponse(503, 'Service Unavailable')));
    this.removeClient(client);
  }

  private matchesTags(message: SipMessage, original: SipMessage): boolean {
    return message.getFromTag() === original.getFromTag() && message.getToTag() === original.getToTag();
  }

  private send(send: SendPacket, packet: Buffer, onFailure?: () => void): void {
    try { Promise.resolve(send(packet)).catch(error => { this.options.onError?.(error); onFailure?.(); }); }
    catch (error) { this.options.onError?.(error); onFailure?.(); }
  }

  private schedule(owner: { timers: Map<string, Timer> }, name: string, delay: number, action: () => void): void {
    this.cancelTimer(owner, name);
    const timer = setTimeout(() => { owner.timers.delete(name); action(); }, delay);
    timer.unref(); owner.timers.set(name, timer);
  }
  private cancelTimer(owner: { timers: Map<string, Timer> }, name: string): void {
    clearTimeout(owner.timers.get(name)); owner.timers.delete(name);
  }
  private clearTimers(owner: { timers: Map<string, Timer> }): void {
    for (const timer of owner.timers.values()) clearTimeout(timer);
    owner.timers.clear();
  }
  private removeServer(server: ServerTransaction): void {
    this.clearTimers(server); this.servers.delete(server.key);
  }
  private removeClient(client: ClientTransaction): void {
    this.clearTimers(client); this.clients.delete(client.key);
    this.options.onClientTerminated?.(client.key);
  }
}
