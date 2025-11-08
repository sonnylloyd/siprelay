export interface RegistrationBinding {
  domain: string;
  user: string;
  clientAddress: string;
  clientPort: number;
  contact?: string;
  expiresAt: number;
}

export class RegistrationStore {
  private bindings: Map<string, RegistrationBinding>;

  constructor() {
    this.bindings = new Map();
  }

  private buildKey(domain: string, user: string): string {
    return `${domain.toLowerCase()}|${user.toLowerCase()}`;
  }

  public upsert(binding: RegistrationBinding): void {
    this.bindings.set(this.buildKey(binding.domain, binding.user), binding);
  }

  public remove(domain: string, user: string): boolean {
    return this.bindings.delete(this.buildKey(domain, user));
  }

  public get(domain: string, user: string): RegistrationBinding | undefined {
    const key = this.buildKey(domain, user);
    const binding = this.bindings.get(key);
    if (!binding) return undefined;

    if (binding.expiresAt <= Date.now()) {
      this.bindings.delete(key);
      return undefined;
    }

    return binding;
  }

  public purgeExpired(): void {
    const now = Date.now();
    for (const [key, binding] of this.bindings.entries()) {
      if (binding.expiresAt <= now) {
        this.bindings.delete(key);
      }
    }
  }
}
