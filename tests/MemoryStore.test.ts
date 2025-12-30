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
