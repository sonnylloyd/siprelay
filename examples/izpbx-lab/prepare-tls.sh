#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077
mkdir -p .tls
if [[ ! -e .tls/ca.key ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout .tls/ca.key -out .tls/ca.crt -subj '/CN=SIPRelay isolated lab CA' >/dev/null 2>&1
fi
for name in pbx siprelay pbx-b; do
  if [[ -s .tls/$name.key && -s .tls/$name.crt ]]; then continue; fi
  openssl req -newkey rsa:2048 -nodes -keyout ".tls/$name.key" -out ".tls/$name.csr" -subj "/CN=$name.test" >/dev/null 2>&1
  {
    printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n'
    if [[ "$name" == siprelay ]]; then
      printf 'subjectAltName=DNS:siprelay.test,IP:172.30.231.10\n'
    else
      printf 'subjectAltName=DNS:%s.test\n' "$name"
    fi
  } > ".tls/$name.ext"
  openssl x509 -req -in ".tls/$name.csr" -CA .tls/ca.crt -CAkey .tls/ca.key -CAcreateserial -days 2 -out ".tls/$name.crt" -extfile ".tls/$name.ext" >/dev/null 2>&1
done
printf '%s\n' 'Created short-lived isolated lab certificates; private keys are not displayed.'
