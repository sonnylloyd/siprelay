import { describe, expect, it } from 'vitest';
import { parseAddressParameters, parseSipUri, readAddressTag, splitNameAddress } from '../src/sip/SipUri';

describe('quoted address extension parameters', () => {
  it('accepts instance URNs, embedded separators and escaped quotes without treating them as routing syntax', () => {
    const value = '"Phone, Alice" <sip:device@phone>; +sip.instance="<urn:uuid:1234>";label="a; b, \\"c\\"";tag=dialog';
    expect(parseSipUri(value)).toEqual({ user: 'device', host: 'phone' });
    expect(readAddressTag(value)).toBe('dialog');
    expect(parseAddressParameters(';flag; tag = abc ;empty=""')).toEqual([
      { name: 'flag', value: undefined, quoted: false },
      { name: 'tag', value: 'abc', quoted: false },
      { name: 'empty', value: '', quoted: true },
    ]);
    expect(readAddressTag('<sip:device@phone>;label="tag=forged;tag=other"')).toBeUndefined();
  });
  it.each([
    ';tag="quoted"', ';tag=first;TAG=second', ';tag', ';tag=', ';tag=abc xyz',
    ';label="unfinished', ';label=<urn:bad>', ';label="finished"junk', ';label="bad\\"',
  ])('rejects malformed parameters or ambiguous tags: %s', parameters => {
    expect(readAddressTag(`<sip:device@phone>${parameters}`)).toBeNull();
  });
  it('rejects malformed unbracketed header parameters too', () => {
    expect(readAddressTag('sip:device@phone;tag="unfinished')).toBeNull();
    expect(parseAddressParameters('bad')).toBeNull();
    expect(readAddressTag('sip:device@phone;=bad')).toBeNull();
    expect(splitNameAddress('<sip:device@phone>;label="<,>"')?.uri).toBe('sip:device@phone');
    expect(parseAddressParameters('')).toEqual([]);
  });
});
