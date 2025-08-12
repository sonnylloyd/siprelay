export class RtpPortManager {
    private inUse = new Set<number>();

    constructor(private minPort = 10000, private maxPort = 10100) {}

    allocate(): number | null {
        for (let port = this.minPort; port <= this.maxPort; port += 2) {
        if (!this.inUse.has(port)) {
            this.inUse.add(port);
            return port;
        }
        }
        return null;
    }

    release(port: number) {
        this.inUse.delete(port);
    }
}
  