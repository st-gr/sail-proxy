# sail-proxy Docker deployment

This folder holds the Docker Compose deployment of sail-proxy: the compose files, the Dockerfiles for the gateway, admin and Ollama images, the nginx configuration and entrypoint, the service configs and the setup and helper scripts.

The deployment runs the gateway, the admin service with the Admin Cockpit, nginx, oauth2-proxy, Dex, PostgreSQL and Valkey.

## Quick start

Run from the root of a checkout:

```bash
node docker/setup-docker.js
docker compose -f docker/docker-compose.yml pull
docker compose -f docker/docker-compose.yml up -d
```

The setup script writes the `.env` files the services read; run it before the first start.

The interactive setup lets you go back (Up arrow, or **← Back** on lists), shows a review screen where you can change any answer before anything is written, and keeps the current values when you run it again (`--force` starts fresh). Existing secrets are kept unless you choose to generate new ones, and are never printed. It also asks for the billing currency (USD by default) and, for other currencies, optional capacity-unit prices. Details: [Going back, reviewing and running again](https://st-gr.github.io/sail-proxy/deploy/docker#going-back-reviewing-and-running-again).

## Documentation

- [Docker Compose deployment](https://st-gr.github.io/sail-proxy/deploy/docker)
- [Authentication](https://st-gr.github.io/sail-proxy/deploy/authentication)
- [Backup and upgrade](https://st-gr.github.io/sail-proxy/deploy/backup-and-upgrade)
- [Docker images](https://st-gr.github.io/sail-proxy/developer/docker-images)

## License

This Docker deployment configuration is part of the sail-proxy project. See the main [LICENSE](../LICENSE) file for details.
