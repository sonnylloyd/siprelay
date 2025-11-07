export class RtpPortManager {
  private readonly start: number;
  private readonly end: number;
  private readonly allocated: Set<number>;

  constructor(startPort: number, endPort: number) {
    if (startPort > endPort) {
      throw new Error('RTP start port must be less than end port');
    }
    this.start = startPort;
    this.end = endPort;
    this.allocated = new Set();
  }

  public allocate(): number | null {
    for (let port = this.start; port <= this.end; port += 2) {
      if (!this.allocated.has(port)) {
        this.allocated.add(port);
        return port;
      }
    }
    return null;
  }

  public release(port: number): void {
    this.allocated.delete(port);
  }

  public reset(): void {
    this.allocated.clear();
  }
}
