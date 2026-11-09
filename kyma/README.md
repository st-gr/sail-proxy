# sail-proxy Kyma deployment

This folder holds the SAP BTP Kyma deployment of sail-proxy: the Kubernetes manifest templates in `templates/` and the scripts in `scripts/` that render and apply them.

The deployment runs the services of the Docker deployment (gateway, admin service with the Admin Cockpit, nginx, oauth2-proxy, Dex, PostgreSQL and Valkey) in one namespace, `sail-proxy` by default.

## Quick start

Run from the root of a checkout, with `kubectl` connected to the cluster:

```bash
node kyma/scripts/setup-kyma.js    # asks for the configuration, renders manifests, Secrets and ConfigMaps
node kyma/scripts/deploy-kyma.js   # applies them in the right order
```

Both scripts take `--namespace <ns>` to deploy a second instance next to an existing one.

The interactive setup lets you go back (Up arrow, or **← Back** on lists), shows a review screen where you can change any answer before anything is written, and keeps the current values when you run it again (`--force` starts fresh). Existing secrets are kept unless you choose to generate new ones, and are not printed. The login of a private registry is offered again for the same registry. It also asks for the billing currency (USD by default) and, for other currencies, optional capacity-unit prices. Details: [Going back, reviewing and running again](https://st-gr.github.io/sail-proxy/deploy/kyma#going-back-reviewing-and-running-again).

## Documentation

- [Deploy on SAP BTP Kyma](https://st-gr.github.io/sail-proxy/deploy/kyma)
- [Kyma prerequisites](https://st-gr.github.io/sail-proxy/deploy/kyma-prerequisites)
- [Database migration](https://st-gr.github.io/sail-proxy/deploy/database-migration)

## License

This Kyma deployment configuration is part of the sail-proxy project. See the main [LICENSE](../LICENSE) file for details.
