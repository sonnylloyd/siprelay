![Logo](images/sip-relay.svg)  <!-- Path to your logo -->

Sip Relay is a Docker container that acts as a SIP proxy. It listens for newly started containers, checks if they have the `sip-proxy-host` label, and retrieves their MACVLAN IP addresses. This enables dynamic routing and management of SIP traffic between containers within a Docker environment.

## Features

- Listens for new containers and checks for the `sip-proxy-host` label.
- Automatically obtains the MACVLAN IP address of the container with the label.
- Provides dynamic SIP proxy functionality between Docker containers.
- Simple management through Docker container labels.

## Prerequisites

Before using Sip Relay, ensure you have the following installed:

- Docker
- Docker Compose (optional, but recommended for easier management)

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/sonnylloyd/sip-relay.git
cd sip-relay