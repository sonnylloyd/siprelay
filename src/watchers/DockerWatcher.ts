import Docker, { ContainerInfo, ContainerInspectInfo } from 'dockerode';
import { IRecordStore, IPValue } from './../store';
import { Labels } from '../constants';
import { Logger } from '../logging/Logger';
import { ServiceWatcher } from './ServiceWatcher';

interface DockerNetwork {
  IPAddress?: string;
  GlobalIPv6Address?: string;
}

interface DockerEvent {
  Type: string;
  Action: string;
  Actor: {
    ID: string;
  };
}

export class DockerWatcher implements ServiceWatcher {
  private docker: Docker;
  private records: IRecordStore;
  private logger: Logger;

  constructor(records: IRecordStore, logger: Logger) {
    this.docker = new Docker();
    this.records = records;
    this.logger = logger;
  }

  public async update(): Promise<void> {
    try {
      const containers: ContainerInfo[] = await this.docker.listContainers({ all: true });
      await Promise.all(containers.map((container: ContainerInfo) => this.processContainer(container.Id)));
      this.logger.info('Map Updated ✅');
    } catch (error) {
      this.logger.error('Error updating map:', error);
    }
  }

  private async processContainer(containerId: string): Promise<void> {
    try {
      const containerInfo = await this.fetchContainerInfo(containerId);
      if (!containerInfo) return;
  
      const hostname = this.extractHostname(containerInfo);
      if (!hostname) return;
  
      const ip = this.extractIP(containerInfo) ?? containerInfo.Name.replace('/', '');
  
      const udpPort = this.extractUdpPort(containerInfo);
      const tlsPort = this.extractTlsPort(containerInfo);

      if (udpPort || tlsPort) {
        const record: IPValue = {
          ip,
          udpPort: udpPort ? Number(udpPort) : undefined,
          tlsPort: tlsPort ? Number(tlsPort) : undefined
        };

        this.records.addRecord(hostname, record);
        this.logger.info(`Added record: ${hostname} → ${JSON.stringify(record)}`);
      }
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

  private extractHostname(containerInfo: ContainerInspectInfo): string | undefined {
    return containerInfo.Config?.Labels?.[Labels.SIP_PROXY_HOST];
  }
  
  private extractIP(info: ContainerInspectInfo): string | undefined {
    return info.Config?.Labels?.[Labels.SIP_PROXY_IP];
  }
  
  private extractUdpPort(containerInfo: ContainerInspectInfo): string | undefined {
    return containerInfo.Config?.Labels?.[Labels.SIP_PROXY_PORT_UDP];
  }
  
  private extractTlsPort(containerInfo: ContainerInspectInfo): string | undefined {
    return containerInfo.Config?.Labels?.[Labels.SIP_PROXY_PORT_TLS];
  }  
  

  public async watch(): Promise<void> {
    this.logger.info('DockerWatcher started. Listening for container events...');
    
    const eventStream: NodeJS.ReadableStream = await this.docker.getEvents();

    eventStream.on('data', async (chunk: Buffer) => {
      const event: DockerEvent | null = this.parseEvent(chunk);
      if (event) await this.handleEvent(event);
    });

    await this.update(); // Initial load
  }

  private parseEvent(chunk: Buffer): DockerEvent | null {
    try {
      return JSON.parse(chunk.toString()) as DockerEvent;
    } catch (error) {
      this.logger.error('Error parsing event:', error);
      return null;
    }
  }

  private async handleEvent(event: DockerEvent): Promise<void> {
    if (event.Type !== 'container') return;

    const containerId: string = event.Actor.ID;
    const containerInfo: ContainerInspectInfo | null = await this.fetchContainerInfo(containerId);
    if (!containerInfo) return;

    const hostname: string | undefined = this.extractHostname(containerInfo);
    if (!hostname) {
      return;
    }

    if (event.Action === 'start') {
      await this.handleStartEvent(containerId);
    } else if (event.Action === 'stop') {
      this.handleStopEvent(hostname);
    }
  }

  private async handleStartEvent(containerId: string): Promise<void> {
    this.logger.info(`Docker event: start -> ${containerId}`);
    await this.processContainer(containerId);
  }

  private handleStopEvent(hostname: string): void {
    this.logger.info(`Docker event: stop -> ${hostname}`);
    if (this.records.deleteRecord(hostname)) {
      this.logger.info(`Record Removed: ${hostname}`);
    } else {
      this.logger.warn(`No record found to remove for container: ${hostname}`);
    }
  }
}