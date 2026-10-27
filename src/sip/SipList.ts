/** Split a SIP header list without splitting quoted display names or name-address URIs. */
export function splitSipList(value: string): string[] | undefined {
  const values: string[] = [];
  let quoted = false, escaped = false, depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === '<') { if (depth) return; depth++; }
    if (character === '>') { if (!depth) return; depth--; }
    if (character === ',' && !depth) { values.push(value.slice(start, i).trim()); start = i + 1; }
  }
  if (quoted || escaped || depth) return;
  values.push(value.slice(start).trim());
  return values.every(Boolean) ? values : undefined;
}
