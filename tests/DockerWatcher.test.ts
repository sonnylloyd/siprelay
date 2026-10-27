import Docker, { ContainerInfo, ContainerInspectInfo } from 'dockerode';
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { DockerWatcher } from '../src/watchers/DockerWatcher';
import { MemoryStore } from '../src/store';
import { Labels } from '../src/constants';
import { createTestLogger } from './utils';
import { flushAsync } from './fixtures/sip';

function container(id = 'pbx-1', labels: Record<string, string> = {}, ip = '10.0.0.1'): ContainerInfo {
  return {
    Id: id, State: 'running', Names: [`/${id}`],
    Labels: { [Labels.SIP_PROXY_HOST]: 'pbx.internal', [Labels.SIP_PROXY_PORT_UDP]: '5060', ...labels },
    NetworkSettings: { Networks: { sip: { IPAddress: ip } } },
  } as unknown as ContainerInfo;
}

function inspected(id = 'pbx-1', labels: Record<string, string> = {}, ip = '10.0.0.1'): ContainerInspectInfo {
  const summary = container(id, labels, ip);
  return { Name: `/${id}`, Config: { Labels: summary.Labels }, State: { Running: true },
    NetworkSettings: summary.NetworkSettings } as ContainerInspectInfo;
}

function fixture(initial: ContainerInfo[] = []) {
  const stream = new EventEmitter();
  const inspect = vi.fn<() => Promise<ContainerInspectInfo>>().mockResolvedValue(inspected());
  const client = {
    listContainers: vi.fn().mockResolvedValue(initial),
    getEvents: vi.fn().mockResolvedValue(stream),
    getContainer: vi.fn(() => ({ inspect })),
  };
  const records = new MemoryStore();
  const logger = createTestLogger();
  const watcher = new DockerWatcher(records, logger, client as unknown as Docker);
  const emit = (action: string, id = 'pbx-1', attributes: Record<string, string> = {}) => {
    stream.emit('data', Buffer.from(JSON.stringify({ Type: 'container', Action: action, Actor: { ID: id, Attributes: attributes } }) + '\n'));
  };
  return { records, logger, watcher, client, stream, inspect, emit };
}

describe('Docker label discovery', () => {
  it('discovers running labelled containers and filters the Docker query', async () => {
    const { watcher, records, client } = fixture([container()]);
    await watcher.update();
    expect(client.listContainers).toHaveBeenCalledWith({ filters: { label: [Labels.SIP_PROXY_HOST] } });
    expect(records.getRecord('pbx.internal')).toEqual({ ip: '10.0.0.1', udpPort: 5060, tlsPort: undefined });
  });

  it('honors explicit addresses and both transport labels', async () => {
    const { watcher, records } = fixture([container('pbx-1', {
      [Labels.SIP_PROXY_IP]: '192.0.2.50', [Labels.SIP_PROXY_PORT_TLS]: '5061',
    })]);
    await watcher.update();
    expect(records.getRecord('pbx.internal')).toEqual({ ip: '192.0.2.50', udpPort: 5060, tlsPort: 5061 });
  });

  it('uses Docker names when there is no address and ignores unlabelled/stopped containers', async () => {
    const named = container('pbx-name', {}, '');
    const unlabelled = container('unlabelled'); unlabelled.Labels = {};
    const stopped = container('stopped', { [Labels.SIP_PROXY_HOST]: 'stopped.internal' }); stopped.State = 'exited';
    const { watcher, records } = fixture([named, unlabelled, stopped]);
    await watcher.update();
    expect(records.getRecord('pbx.internal')?.ip).toBe('pbx-name');
    expect(records.getRecord('stopped.internal')).toBeUndefined();
  });

  it('removes missing records after reconciliation and updates changed addresses', async () => {
    const { watcher, records, client } = fixture([container()]);
    await watcher.update();
    client.listContainers.mockResolvedValueOnce([container('pbx-1', {}, '10.0.0.2')]);
    await watcher.update();
    expect(records.getRecord('pbx.internal')?.ip).toBe('10.0.0.2');
    client.listContainers.mockResolvedValueOnce([]);
    await watcher.update();
    expect(records.getRecord('pbx.internal')).toBeUndefined();
    expect(records.findHostnameByIp('10.0.0.2')).toBeUndefined();
  });

  it('retains existing routes when listing containers fails', async () => {
    const { watcher, records, client, logger } = fixture([container()]);
    await watcher.update();
    client.listContainers.mockRejectedValueOnce(new Error('Docker unavailable'));
    await watcher.update();
    expect(records.getRecord('pbx.internal')).toBeDefined();
    expect(logger.error).toHaveBeenCalledWith('Error updating map:', expect.any(Error));
  });

  it('does not rewrite identical records on refresh', async () => {
    const { watcher, records } = fixture([container()]);
    const add = vi.spyOn(records, 'addRecord');
    await watcher.update(); await watcher.update();
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('normalizes mixed-case label hosts during discovery and reconciliation', async () => {
    const { watcher, records } = fixture([container('pbx-1', { [Labels.SIP_PROXY_HOST]: 'PBX.Internal' })]);
    await watcher.update(); await watcher.update();
    expect(records.getRecord('pbx.internal')).toBeDefined();
  });

  it.each(['-1', '65536', '5060.5', 'Infinity', 'not-a-port', '0', ''])('does not register invalid port %s', async port => {
    const { watcher, records } = fixture([container('pbx-1', { [Labels.SIP_PROXY_PORT_UDP]: port })]);
    await watcher.update();
    expect(records.getRecord('pbx.internal')).toBeUndefined();
  });
});

describe('Docker event stream', () => {
  it('subscribes before loading routes and assembles fragmented JSON events', async () => {
    const { watcher, stream, records, client } = fixture();
    await watcher.watch();
    expect(client.getEvents).toHaveBeenCalledWith({ filters: { type: ['container'], label: [Labels.SIP_PROXY_HOST] } });
    const event = JSON.stringify({ Type: 'container', Action: 'start', Actor: { ID: 'pbx-1' } }) + '\n';
    stream.emit('data', Buffer.from(event.slice(0, 17)));
    expect(records.getRecord('pbx.internal')).toBeUndefined();
    stream.emit('data', Buffer.from(event.slice(17)));
    await flushAsync();
    expect(records.getRecord('pbx.internal')).toBeDefined();
  });

  it.each(['stop', 'kill', 'die', 'destroy'])('removes a stopped PBX on %s', async action => {
    const { watcher, records, emit } = fixture([container()]);
    await watcher.watch(); emit(action); await flushAsync();
    expect(records.getRecord('pbx.internal')).toBeUndefined();
  });

  it('refreshes restarted containers and reports inspection failures', async () => {
    const { watcher, records, emit, inspect, logger } = fixture();
    await watcher.watch(); emit('restart'); await flushAsync();
    expect(records.getRecord('pbx.internal')).toBeDefined();
    inspect.mockRejectedValueOnce(new Error('container disappeared'));
    emit('start', 'missing'); await flushAsync();
    expect(logger.error).toHaveBeenCalledWith('Failed to inspect container missing:', expect.any(Error));
  });

  it('continues after malformed JSON and safely ignores non-container and unknown events', async () => {
    const { watcher, stream, records, emit, logger } = fixture();
    await watcher.watch();
    stream.emit('data', Buffer.from('\nnot-json\n{"Type":"network"}\n'));
    emit('pause'); emit('start'); await flushAsync();
    expect(logger.error).toHaveBeenCalledWith('Error parsing event:', expect.any(Error));
    expect(records.getRecord('pbx.internal')).toBeDefined();
  });

  it('ignores JSON events with invalid shapes instead of rejecting the event handler', async () => {
    const { watcher, stream, emit, records } = fixture();
    await watcher.watch();
    stream.emit('data', Buffer.from('null\n{}\n{"Type":"container","Action":"start"}\n'));
    emit('start'); await flushAsync();
    expect(records.getRecord('pbx.internal')).toBeDefined();
  });

  it('logs stream failures and termination', async () => {
    const { watcher, stream, logger } = fixture();
    await watcher.watch();
    stream.emit('error', new Error('stream failed')); stream.emit('end');
    expect(logger.error).toHaveBeenCalledWith('Docker event stream error:', expect.any(Error));
    expect(logger.warn).toHaveBeenCalledWith('Docker event stream ended');
  });

  it('does not let an old container stop event remove its replacement route', async () => {
    const { watcher, records, emit, inspect } = fixture([container('old')]);
    await watcher.watch();
    inspect.mockResolvedValueOnce(inspected('new', {}, '10.0.0.2'));
    emit('start', 'new'); await flushAsync();
    emit('stop', 'old'); await flushAsync();
    expect(records.getRecord('pbx.internal')?.ip).toBe('10.0.0.2');
  });

  it('serializes separate start and stop chunks when inspection is delayed', async () => {
    const { watcher, records, emit, inspect } = fixture();
    let resolveInspect: (value: ContainerInspectInfo) => void = () => {};
    inspect.mockReturnValueOnce(new Promise(resolve => { resolveInspect = resolve; }));
    await watcher.watch();
    emit('start'); emit('stop', 'pbx-1', { [Labels.SIP_PROXY_HOST]: 'pbx.internal' });
    await flushAsync();
    resolveInspect(inspected()); await flushAsync();
    expect(records.getRecord('pbx.internal')).toBeUndefined();
  });
  it('ignores invalid attribute maps while continuing with valid subsequent events', async () => {
    const { watcher, stream, records, emit } = fixture(); await watcher.watch();
    for (const attributes of [null, 42, { 'sip-proxy-host': 42 }]) {
      stream.emit('data', Buffer.from(JSON.stringify({ Type: 'container', Action: 'stop', Actor: { ID: 'pbx-1', Attributes: attributes } }) + '\n'));
    }
    emit('start'); await flushAsync(); expect(records.getRecord('pbx.internal')).toBeDefined();
  });

  it('does not erase a replacement while purging an old container from the next snapshot', async () => {
    const { watcher, records, client } = fixture([container('old')]); await watcher.update();
    client.listContainers.mockResolvedValueOnce([container('new', {}, '10.0.0.2')]);
    await watcher.update(); expect(records.getRecord('pbx.internal')?.ip).toBe('10.0.0.2');
  });

  it('uses inspected container names when there are no network addresses', async () => {
    const { watcher, emit, inspect, records } = fixture(); await watcher.watch();
    inspect.mockResolvedValueOnce(inspected('pbx-1', {}, ''));
    emit('start'); await flushAsync(); expect(records.getRecord('pbx.internal')?.ip).toBe('pbx-1');
  });

  it('falls back to the SIP hostname when Docker supplies no name or address', async () => {
    const summary = container(); summary.Names = []; summary.NetworkSettings = { Networks: {} };
    const { watcher, records } = fixture([summary]); await watcher.update();
    expect(records.getRecord('pbx.internal')?.ip).toBe('pbx.internal');
  });

  it('uses stop-event labels for unseen containers and tolerates already removed routes', async () => {
    const { watcher, emit, records, logger } = fixture(); await watcher.watch();
    records.addRecord('pbx.internal', { ip: '10.0.0.1', udpPort: 5060 });
    emit('stop', 'unseen', { [Labels.SIP_PROXY_HOST]: 'PBX.Internal' }); await flushAsync();
    expect(records.getRecord('pbx.internal')).toBeUndefined();
    emit('stop', 'unseen', { [Labels.SIP_PROXY_HOST]: 'pbx.internal' }); await flushAsync();
    expect(logger.warn).toHaveBeenCalledWith('No record found to remove for container: pbx.internal');
  });

  it('does not lose other routes when storing one container fails', async () => {
    const { watcher, records, logger } = fixture([container('one'), container('two', { [Labels.SIP_PROXY_HOST]: 'other.internal' }, '10.0.0.2')]);
    vi.spyOn(records, 'addRecord').mockImplementationOnce(() => { throw new Error('store failure'); });
    await watcher.update();
    expect(records.getRecord('other.internal')).toBeDefined();
    expect(logger.error).toHaveBeenCalledWith('Error processing container one:', expect.any(Error));
  });

  it('ignores well-formed events for other Docker object types', async () => {
    const { watcher, stream, records } = fixture(); await watcher.watch();
    stream.emit('data', Buffer.from(JSON.stringify({ Type: 'network', Action: 'start', Actor: { ID: 'network-1' } }) + '\n'));
    await flushAsync(); expect(Object.keys(records.getAllRecords())).toEqual([]);
  });

  it('purges a route that no longer belongs to any labelled container', async () => {
    const { watcher, records } = fixture(); records.addRecord('stale.internal', { ip: '10.0.0.5' });
    await watcher.update(); expect(records.getRecord('stale.internal')).toBeUndefined();
  });

});

it('discovers TCP endpoints and TLS identities and refreshes changed identities', async () => {
  const info = container('pbx', { [Labels.SIP_PROXY_PORT_UDP]: '', [Labels.SIP_PROXY_PORT_TCP]: '5070', [Labels.SIP_PROXY_TLS_SERVER_NAME]: 'PBX.EXAMPLE.TEST' });
  const f = fixture([info]); await f.watcher.update();
  expect(f.records.getRecord('pbx.internal')).toMatchObject({ tcpPort: 5070, tlsServerName: 'pbx.example.test' });
  info.Labels[Labels.SIP_PROXY_TLS_SERVER_NAME] = 'second.example.test'; await f.watcher.update();
  expect(f.records.getRecord('pbx.internal')?.tlsServerName).toBe('second.example.test');
  info.Labels[Labels.SIP_PROXY_TLS_SERVER_NAME] = 'invalid name';
  const invalid = fixture([info]); await invalid.watcher.update(); expect(invalid.records.getRecord('pbx.internal')).toBeUndefined();
});

it('contains unexpected asynchronous Docker event processing failures and continues with later events', async () => {
  const f = fixture(); await f.watcher.watch();
  const process = vi.spyOn(f.watcher as unknown as { handleEventChunk(chunk: Buffer): Promise<void> }, 'handleEventChunk');
  process.mockRejectedValueOnce(new Error('unexpected decoder failure'));
  f.emit('start'); await flushAsync();
  expect(f.logger.error).toHaveBeenCalledWith('Error processing Docker event:', expect.any(Error));
  f.emit('start'); await flushAsync();
  expect(f.records.getRecord('pbx.internal')).toBeDefined();
});
