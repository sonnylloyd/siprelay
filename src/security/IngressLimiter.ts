/** Fixed one-second windows bound parsing work and the number of source-address entries. */
export class IngressLimiter {
  private window = -1;
  private count = 0;
  private readonly peers = new Map<string, number>();

  constructor(private readonly totalLimit = 2_000, private readonly peerLimit = 200) {}

  allow(peer: string): boolean {
    const window = Math.floor(Date.now() / 1_000);
    if (window !== this.window) {
      this.window = window;
      this.count = 0;
      this.peers.clear();
    }
    if (this.count >= this.totalLimit) return false;
    const count = this.peers.get(peer) ?? 0;
    if (count >= this.peerLimit) return false;
    this.count++;
    this.peers.set(peer, count + 1);
    return true;
  }
}
