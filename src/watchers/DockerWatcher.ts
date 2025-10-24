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

  constructor(records: IRecordStore, logger: Logger) {
    this.docker = new Docker();
    this.records = records;
    this.logger = logger;
    this.containerHosts = new Map();
  }

  public async update(): Promise<void> {
    try {
      const listFilters = { label: [Labels.SIP_PROXY_HOST] };
      const containers: ContainerInfo[] = await this.docker.listContainers({ filters: listFilters });
      const seenContainerIds = new Set<string>();
      const activeHostnames = new Set<string>();

      await Promise.all(
        containers.map(async (container: ContainerInfo) => {
          seenContainerIds.add(container.Id);
          await this.processContainer(container.Id, container);
          const labelHost = container.Labels?.[Labels.SIP_PROXY_HOST];
          if (labelHost) activeHostnames.add(labelHost);
        })
      );

      // Purge container map entries for containers that vanished without events
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

      // Remove records that no longer have a backing container
      const currentRecords = this.records.getAllRecords();
      for (const hostname of Object.keys(currentRecords)) {
        if (!activeHostnames.has(hostname)) {
          if (this.records.deleteRecord(hostname)) {
            this.logger.info(`Record removed (stale): ${hostname}`);
          }
        }
      }

      this.logger.info('PBX routing map refreshed');
    } catch (error) {
      this.logger.error('Error updating map:', error);
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
  
      const hostname = this.extractHostname(info);
      if (!hostname) return;
  
      const ip = this.extractIP(info) ?? this.extractName(info) ?? hostname;

      const udpPort = this.extractUdpPort(info);
      const tlsPort = this.extractTlsPort(info);

      if (udpPort || tlsPort) {
        const record: IPValue = {
          ip,
          udpPort: udpPort ? Number(udpPort) : undefined,
          tlsPort: tlsPort ? Number(tlsPort) : undefined
        };

        const existing = this.records.getRecord(hostname);
        if (existing && this.recordsEqual(existing, record)) {
          this.containerHosts.set(containerId, hostname);
          return;
        }

        this.records.addRecord(hostname, record);
        this.containerHosts.set(containerId, hostname);

        const action = existing ? 'Updated' : 'Added';
        this.logger.info(`${action} record: ${hostname} → ${JSON.stringify(record)}`);
        return;
      }

      this.logger.warn(`No SIP port labels found for container ${containerId} (hostname: ${hostname})`);
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

  private extractHostname(containerInfo: ContainerInspectInfo | ContainerInfo): string | undefined {
    const labels = this.extractLabels(containerInfo);
    return labels?.[Labels.SIP_PROXY_HOST];
  }
  
  private extractIP(info: ContainerInspectInfo | ContainerInfo): string | undefined {
    const labels = this.extractLabels(info);
    if (labels?.[Labels.SIP_PROXY_IP]) return labels[Labels.SIP_PROXY_IP];
    return this.extractNetworkIp(info);
  }
  
  private extractUdpPort(containerInfo: ContainerInspectInfo | ContainerInfo): string | undefined {
    return this.extractLabels(containerInfo)?.[Labels.SIP_PROXY_PORT_UDP];
  }
  
  private extractTlsPort(containerInfo: ContainerInspectInfo | ContainerInfo): string | undefined {
    return this.extractLabels(containerInfo)?.[Labels.SIP_PROXY_PORT_TLS];
  }  
  
  private extractLabels(info: ContainerInspectInfo | ContainerInfo): Record<string, string> | undefined {
    if ('Config' in info) {
      return info.Config?.Labels || undefined;
    }
    return info.Labels;
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

  public async watch(): Promise<void> {
    this.logger.info('DockerWatcher started. Listening for container events...');

    const eventOptions: GetEventsOptions = {
      filters: {
        type: ['container'],
        label: [Labels.SIP_PROXY_HOST],
      },
    };
    
    const eventStream = await this.docker.getEvents(eventOptions);

    eventStream.on('data', async (chunk: Buffer) => {
      this.eventBuffer += chunk.toString();
      const lines = this.eventBuffer.split('\n');
      this.eventBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const event = this.parseEvent(line);
        if (event) {
          await this.handleEvent(event);
        }
      }
    });

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
