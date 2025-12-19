export const Protocal = {
  UDP: 'UDP',
  TLS: 'TLS',
  TCP: 'TCP',
} as const;

export type ProtocalType = (typeof Protocal)[keyof typeof Protocal];
