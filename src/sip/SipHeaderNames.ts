const COMPACT_HEADER_NAMES: ReadonlyMap<string, string> = new Map([
  ['v', 'via'],
  ['f', 'from'],
  ['t', 'to'],
  ['i', 'call-id'],
  ['m', 'contact'],
  ['l', 'content-length'],
  ['c', 'content-type'],
  ['s', 'subject'],
  ['k', 'supported'],
  ['e', 'content-encoding'],
]);

const DISPLAY_HEADER_NAMES: ReadonlyMap<string, string> = new Map([
  ['call-id', 'Call-ID'],
  ['cseq', 'CSeq'],
]);

export function normalizeHeaderName(name: string): string {
  const lower = name.toLowerCase();
  return COMPACT_HEADER_NAMES.get(lower) ?? lower;
}

export function formatHeaderName(name: string): string {
  return DISPLAY_HEADER_NAMES.get(name)
    ?? name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
}
