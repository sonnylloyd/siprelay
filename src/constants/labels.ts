export const Labels = {
    SIP_PROXY_HOST: 'sip-proxy-host',
    SIP_PROXY_PORT_UDP: 'sip-proxy-port-udp',
    SIP_PROXY_PORT_TCP: 'sip-proxy-port-tcp',
    SIP_PROXY_TLS_SERVER_NAME: 'sip-proxy-tls-server-name',
    SIP_PROXY_PORT_TLS: 'sip-proxy-port-tls',
    SIP_PROXY_IP: 'sip-proxy-ip' // optional override
};

export type LabelsType = (typeof Labels)[keyof typeof Labels];