import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store';

describe('MemoryStore', () => {
  it('maintains a reverse IP index without orphaned entries', () => {
    const store = new MemoryStore();

    store.addRecord('pbx.internal', { ip: '10.0.0.10', udpPort: 5060 });
    expect(store.findHostnameByIp('10.0.0.10')).toBe('pbx.internal');

    store.updateRecord('pbx.internal', { ip: '10.0.0.11', udpPort: 5060 });
    expect(store.findHostnameByIp('10.0.0.10')).toBeUndefined();
    expect(store.findHostnameByIp('10.0.0.11')).toBe('pbx.internal');

    store.deleteRecord('pbx.internal');
    expect(store.findHostnameByIp('10.0.0.11')).toBeUndefined();
  });
});

describe('route store replacement and shared endpoints', () => {
  it('normalizes domains, supports prototype-like names, and returns all routes', () => {
    const store = new MemoryStore();
    store.addRecord('PBX.Internal', { ip: '10.0.0.1' });
    store.addRecord('__proto__', { ip: '10.0.0.2' });
    expect(store.getRecord('pbx.internal')?.ip).toBe('10.0.0.1');
    expect(store.getRecord('__proto__')?.ip).toBe('10.0.0.2');
    expect(Object.keys(store.getAllRecords())).toHaveLength(2);
    expect(store.deleteRecord('PBX.INTERNAL')).toBe(true);
    expect(store.deleteRecord('missing')).toBe(false);
    expect(store.updateRecord('missing', { ip: '10.0.0.3' })).toBeUndefined();
  });

  it('removes the old IP mapping when add replaces an existing route', () => {
    const store = new MemoryStore();
    store.addRecord('pbx.internal', { ip: '10.0.0.1' });
    store.addRecord('PBX.INTERNAL', { ip: '10.0.0.2' });
    expect(store.findHostnameByIp('10.0.0.1')).toBeUndefined();
    expect(store.findHostnameByIp('10.0.0.2')).toBe('pbx.internal');
    store.updateRecord('pbx.internal', { ip: '10.0.0.2', udpPort: 5090 });
    expect(store.getRecord('pbx.internal')?.udpPort).toBe(5090);
  });

  it('retains another domain sharing the same IP when one route is removed or moved', () => {
    const store = new MemoryStore();
    store.addRecord('alpha.internal', { ip: '10.0.0.1', udpPort: 5060 });
    store.addRecord('beta.internal', { ip: '10.0.0.1', udpPort: 5070 });
    store.deleteRecord('alpha.internal');
    expect(store.findHostnameByIp('10.0.0.1')).toBe('beta.internal');
    store.addRecord('alpha.internal', { ip: '10.0.0.1' });
    store.updateRecord('alpha.internal', { ip: '10.0.0.2' });
    expect(store.findHostnameByIp('10.0.0.1')).toBe('beta.internal');
    store.deleteRecord('beta.internal');
    expect(store.findHostnameByIp('10.0.0.1')).toBeUndefined();
  });
});
