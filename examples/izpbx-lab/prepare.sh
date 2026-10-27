#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ -e .env ]]; then
  printf '%s\n' 'Keeping existing lab .env.'
  exit 0
fi
if [[ ! -S /var/run/docker.sock ]]; then
  printf '%s\n' 'Docker socket /var/run/docker.sock is unavailable.' >&2
  exit 1
fi
umask 077
# Exclusive creation avoids overwriting credentials for an existing database.
(set -o noclobber
  {
    printf 'LAB_DB_ROOT_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'LAB_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'DOCKER_SOCK_GID=%s\n' "$(stat -c '%g' /var/run/docker.sock)"
  } > .env
)
printf '%s\n' 'Created lab .env with random credentials; its contents are not displayed.'
