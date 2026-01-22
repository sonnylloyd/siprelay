import Docker, { ContainerInfo, ContainerInspectInfo, GetEventsOptions } from 'dockerode';
import { IRecordStore, IPValue } from './../store';
import { Labels } from '../constants';
import { Logger } from '../logging/Logger';
import { ServiceWatcher } from './ServiceWatcher';

interface DockerEvent {
  Type: string;
  Action: string;
  Actor: {
    ID: string;
    Attributes?: Record<string, string>;
  };
}

export class DockerWatcher implements ServiceWatcher {
  private docker: Docker;
  private records: IRecordStore;
  private logger: Logger;
  private containerHosts: Map<string, string>;
  private eventBuffer = '';
  private readonly inspectConcurrency = 5;

  constructor(records: IRecordStore, logger: Logger) {
    this.docker = new Docker();
    this.records = records;
    this.logger = logger;
    this.containerHosts = new Map();
  }

  public async update(): Promise<void> {
    try {
      const containers = await this.listWatchedContainers();
      const seenContainerIds = await this.syncActiveContainers(containers);
      const activeHostnames = this.collectActiveHostnames(containers);

      this.purgeMissingContainers(seenContainerIds);
      this.purgeStaleRecords(activeHostnames);
      this.logger.info('PBX routing map refreshed');
    } catch (error) {
      this.logger.error('Error updating map:', error);
    }
  }

  private async listWatchedContainers(): Promise<ContainerInfo[]> {
    const listFilters = { label: [Labels.SIP_PROXY_HOST] };
    return this.docker.listContainers({ filters: listFilters });
  }

  private async syncActiveContainers(containers: ContainerInfo[]): Promise<Set<string>> {
    const seenContainerIds = new Set<string>();
    let index = 0;
    const worker = async () => {
      while (index < containers.length) {
        const container = containers[index++];
        seenContainerIds.add(container.Id);
        await this.processContainer(container.Id, container);
      }
    };
    const workers = Array.from(
      { length: Math.min(this.inspectConcurrency, containers.length) },
      () => worker()
    );
    await Promise.all(workers);
    return seenContainerIds;
  }

  private collectActiveHostnames(containers: ContainerInfo[]): Set<string> {
    const activeHostnames = new Set<string>();
    for (const container of containers) {
      const labelHost = container.Labels?.[Labels.SIP_PROXY_HOST];
      if (labelHost) activeHostnames.add(labelHost);
    }
    return activeHostnames;
  }

  private purgeMissingContainers(seenContainerIds: Set<string>): void {
    for (const containerId of this.containerHosts.keys()) {
      if (!seenContainerIds.has(containerId)) {
        const hostname = this.containerHosts.get(containerId);
        if (hostname) {
          this.records.deleteRecord(hostname);
          this.logger.info(`Record removed (stale): ${hostname}`);
        }
        this.containerHosts.delete(containerId);
      }
    }
  }

  private purgeStaleRecords(activeHostnames: Set<string>): void {
    const currentRecords = this.records.getAllRecords();
    for (const hostname of Object.keys(currentRecords)) {
      if (!activeHostnames.has(hostname)) {
        if (this.records.deleteRecord(hostname)) {
          this.logger.info(`Record removed (stale): ${hostname}`);
        }
      }
    }
  }

  private async processContainer(containerId: string, containerInfo?: ContainerInspectInfo | ContainerInfo): Promise<void> {
    try {
      const info = containerInfo ?? await this.fetchContainerInfo(containerId);
      if (!info) return;

      if (!this.isRunning(info)) {
        this.handleStopEvent(containerId);
        return;
      }

      const routing = this.extractRoutingInfo(info);
      if (!routing || !routing.hostname) return;

      const record: IPValue = {
        ip: routing.ip ?? routing.hostname,
        udpPort: routing.udpPort,
        tlsPort: routing.tlsPort,
      };

      if (!routing.udpPort && !routing.tlsPort) {
        this.logger.warn(`No SIP port labels found for container ${containerId} (hostname: ${routing.hostname})`);
        return;
      }

      const existing = this.records.getRecord(routing.hostname);
      if (existing && this.recordsEqual(existing, record)) {
        this.containerHosts.set(containerId, routing.hostname);
        return;
      }

      this.records.addRecord(routing.hostname, record);
      this.containerHosts.set(containerId, routing.hostname);

      const action = existing ? 'Updated' : 'Added';
      this.logger.info(`${action} record: ${routing.hostname} → ${JSON.stringify(record)}`);
    } catch (error) {
      this.logger.error(`Error processing container ${containerId}:`, error);
    }
  } 

  private async fetchContainerInfo(containerId: string): Promise<ContainerInspectInfo | null> {
    try {
      return await this.docker.getContainer(containerId).inspect();
    } catch (error) {
      this.logger.error(`Failed to inspect container ${containerId}:`, error);
      return null;
    }
  }

  private extractLabels(info: ContainerInspectInfo | ContainerInfo): Record<string, string> | undefined {
    if ('Config' in info) {
      return info.Config?.Labels || undefined;
    }
    return info.Labels;
  }

  private isRunning(info: ContainerInspectInfo | ContainerInfo): boolean {
    if ('State' in info && typeof info.State === 'object') {
      return Boolean(info.State?.Running);
    }
    if ('State' in info && typeof info.State === 'string') {
      return info.State === 'running';
    }
    return true;
  }

  private recordsEqual(a: IPValue, b: IPValue): boolean {
    return a.ip === b.ip && a.udpPort === b.udpPort && a.tlsPort === b.tlsPort;
  }

  private extractRoutingInfo(info: ContainerInspectInfo | ContainerInfo): {
    hostname?: string;
    ip?: string;
    udpPort?: number;
    tlsPort?: number;
  } | null {
    const labels = this.extractLabels(info);
    const hostname = labels?.[Labels.SIP_PROXY_HOST];
    if (!hostname) return null;

    const udpPort = this.parsePort(labels?.[Labels.SIP_PROXY_PORT_UDP]);
    const tlsPort = this.parsePort(labels?.[Labels.SIP_PROXY_PORT_TLS]);
    const explicitIp = labels?.[Labels.SIP_PROXY_IP];

    return {
      hostname,
      ip: explicitIp ?? this.extractNetworkIp(info) ?? this.extractName(info),
      udpPort,
      tlsPort,
    };
  }

  private parsePort(port?: string): number | undefined {
    if (!port) return undefined;
    const parsed = Number(port);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private extractName(info: ContainerInspectInfo | ContainerInfo): string | undefined {
    if ('Name' in info && info.Name) {
      return info.Name.replace(/^\//, '');
    }
    if ('Names' in info) {
      const names = info.Names ?? [];
      if (names.length) {
        return names[0].replace(/^\//, '');
      }
    }
    return undefined;
  }

  private extractNetworkIp(info: ContainerInspectInfo | ContainerInfo): string | undefined {
    if ('NetworkSettings' in info) {
      const networks = info.NetworkSettings?.Networks;
      if (networks) {
        for (const network of Object.values(networks)) {
          if (network?.IPAddress) return network.IPAddress;
        }
      }
    }
    return undefined;
  }


  public async watch(): Promise<void> {
    this.logger.info('DockerWatcher started. Listening for container events...');

    const eventOptions: GetEventsOptions = {
      filters: {
        type: ['container'],
        label: [Labels.SIP_PROXY_HOST],
      },
    };
    
    const eventStream = await this.docker.getEvents(eventOptions);

    eventStream.on('data', (chunk: Buffer) => this.handleEventChunk(chunk));

    eventStream.on('error', (error) => {
      this.logger.error('Docker event stream error:', error);
    });

    eventStream.on('end', () => {
      this.logger.warn('Docker event stream ended');
    });

    await this.update(); // Initial load
  }

  private parseEvent(raw: string): DockerEvent | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed) as DockerEvent;
    } catch (error) {
      this.logger.error('Error parsing event:', error);
      return null;
    }
  }

  private async handleEventChunk(chunk: Buffer): Promise<void> {
    this.eventBuffer += chunk.toString();
    const lines = this.eventBuffer.split('\n');
    this.eventBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = this.parseEvent(line);
      if (event) {
        await this.handleEvent(event);
      }
    }
  }

  private async handleEvent(event: DockerEvent): Promise<void> {
    if (event.Type !== 'container') return;

    const containerId: string = event.Actor.ID;
    const action = event.Action;
    const hostnameFromEvent = event.Actor.Attributes?.[Labels.SIP_PROXY_HOST];

    if (action === 'start' || action === 'restart') {
      await this.handleStartEvent(containerId);
    } else if (['stop', 'kill', 'die', 'destroy'].includes(action)) {
      this.handleStopEvent(containerId, hostnameFromEvent);
    }
  }

  private async handleStartEvent(containerId: string): Promise<void> {
    this.logger.info(`Docker event: start -> ${containerId}`);
    await this.processContainer(containerId);
  }

  private handleStopEvent(containerId: string, fallbackHostname?: string): void {
    const hostname = this.containerHosts.get(containerId) ?? fallbackHostname;
    if (!hostname) {
      this.logger.warn(`Unable to resolve hostname for container ${containerId} on stop event`);
      return;
    }

    this.logger.info(`Docker event: stop -> ${hostname}`);
    if (this.records.deleteRecord(hostname)) {
      this.logger.info(`Record removed: ${hostname}`);
    } else {
      this.logger.warn(`No record found to remove for container: ${hostname}`);
    }
    this.containerHosts.delete(containerId);
  }
}
