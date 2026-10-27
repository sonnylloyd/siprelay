import { isIP } from 'net';

export interface SipAddress {
  user?: string;
  host: string;
}

/** Select the actual URI, never a SIP-looking string in a quoted display name. */
export function splitNameAddress(value: string): { uri: string; parameters: string } | null {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return null;
  const text = value.trim();
  let quoted = false;
  let escaped = false;
  let open = -1;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === '<') { open = index; break; }
    if (!quoted && (character === '>' || character === ',')) return null;
  }
  if (open < 0) {
    if (quoted || !/^sips?:/i.test(text) || /[<>"\\\s,]/.test(text)) return null;
    const semicolon = text.indexOf(';');
    return { uri: text, parameters: semicolon < 0 ? '' : text.slice(semicolon) };
  }
  const close = text.indexOf('>', open + 1);
  if (close < 0) return null;
  const uri = text.slice(open + 1, close);
  const parameters = text.slice(close + 1).trim();
  if (/[<>\s"\\]/.test(uri) || (parameters && !parameters.startsWith(';')) || !parseAddressParameters(parameters)) return null;
  return { uri, parameters };
}

interface AddressParameter { name: string; value?: string; quoted: boolean }

/** Parse header parameters independently of URI parameters, including quoted instance IDs. */
export function parseAddressParameters(parameters: string): AddressParameter[] | null {
  const result: AddressParameter[] = [];
  let rest = parameters;
  while (rest.trim()) {
    const match = rest.match(/^;[ \t]*([A-Za-z0-9.!%*_+`'~-]+)[ \t]*(?:=[ \t]*("(?:[^"\\\r\n]|\\[^\r\n])*"|[^; \t"<>,\\]+)[ \t]*)?(?=;|$)/);
    if (!match) return null;
    const quoted = match[2]?.startsWith('"') ?? false;
    result.push({ name: match[1].toLowerCase(), value: quoted ? match[2].slice(1, -1).replace(/\\(.)/g, '$1') : match[2], quoted });
    rest = rest.slice(match[0].length);
  }
  return result;
}

export function readAddressTag(value: string): string | undefined | null {
  const address = splitNameAddress(value);
  if (!address) return null;
  const parameters = parseAddressParameters(address.parameters);
  if (!parameters) return null;
  const tags = parameters.filter(parameter => parameter.name === 'tag');
  if (tags.length > 1) return null;
  if (!tags.length) return undefined;
  const tag = tags[0];
  return !tag.quoted && tag.value && /^[A-Za-z0-9.!%*_+`'~-]+$/.test(tag.value) ? tag.value : null;
}

export function parseSipUri(value: string): SipAddress | null {
  const address = splitNameAddress(value);
  if (!address) return null;
  const match = address.uri.match(/^sips?:(?:([^@<>\s]+)@)?(\[[a-f\d:.]+\]|[a-z\d._-]+)(?::(\d+))?(?:[;?][^\s<>"\\]*)?$/i);
  if (!match || /%(?![a-f\d]{2})/i.test(address.uri)) return null;
  if (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) return null;
  if (match[2].startsWith('[') && isIP(match[2].slice(1, -1)) !== 6) return null;
  return { ...(match[1] ? { user: match[1] } : {}), host: match[2].toLowerCase() };
}

export function formatSipHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
