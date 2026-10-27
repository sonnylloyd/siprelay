import { describe, expect, it } from 'vitest';
import { PbxRouteResolver } from '../src/proxies/PbxRouteResolver';
import { SipMessage } from '../src/sip';
import { MemoryStore } from '../src/store';

function fixture() {
  const records = new MemoryStore();
  records.addRecord('alpha.example', { ip: '10.0.0.1', udpPort: 5060, tlsPort: 5061 });
  records.addRecord('beta.example', { ip: '10.0.0.2', udpPort: 5070, tlsPort: 5071 });
  const message = new SipMessage('INVITE sip:alice@relay.example SIP/2.0\r\nTo: <sip:alice@alpha.example>\r\n\r\n');
  return { resolver: new PbxRouteResolver(records), message };
}

describe('trusted PBX route resolution', () => {
  it('resolves UDP only when both the PBX address and port match', () => {
    const { resolver, message } = fixture();
    expect(resolver.resolveUdp(message, { address: '10.0.0.1', port: 5060 })?.domain).toBe('alpha.example');
    expect(resolver.resolveUdp(message, { address: '10.0.0.1', port: 55000 })).toBeUndefined();
    expect(resolver.resolveUdp(message, { address: '198.51.100.10', port: 5060 })).toBeUndefined();
  });

  it('rejects a Route claiming another tenant instead of falling back to the source tenant', () => {
    const { resolver, message } = fixture();
    expect(resolver.resolveUdp(message, { address: '10.0.0.1', port: 5060 }, 'beta.example')).toBeUndefined();
    expect(resolver.resolveTls(message, '10.0.0.1:5061', 'beta.example')).toBeUndefined();
  });

  it('falls back to the discovered PBX when To names an unrelated domain', () => {
    const { resolver, message } = fixture();
    message.setHeader('To', '<sip:alice@external.example>');
    expect(resolver.resolveTls(message, '10.0.0.2:5071')?.domain).toBe('beta.example');
    expect(resolver.resolveTls(message, '10.0.0.2:5061')).toBeUndefined();
  });

  it('prefers the matching To tenant when multiple domains share a PBX address', () => {
    const records = new MemoryStore();
    records.addRecord('alpha.example', { ip: '10.0.0.1', udpPort: 5060 });
    records.addRecord('beta.example', { ip: '10.0.0.1', udpPort: 5060 });
    const { message } = fixture();
    const resolver = new PbxRouteResolver(records);
    expect(resolver.resolveUdp(message, { address: '10.0.0.1', port: 5060 })?.domain).toBe('alpha.example');
  });
});
