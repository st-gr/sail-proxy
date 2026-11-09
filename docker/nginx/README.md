# sail-proxy nginx image

This folder holds the configurable nginx edge image of sail-proxy: the Dockerfile, the entrypoint that renders the configuration from environment variables at container start, and the `nginx.conf` and JWT (njs) templates. One image serves Docker Compose and Kyma.

## Documentation

- [The nginx image](https://st-gr.github.io/sail-proxy/developer/nginx): configuration modes, environment variables, JWT and JWKS, service discovery, Compose and Kubernetes usage
- [Docker images and build](https://st-gr.github.io/sail-proxy/developer/docker-images)
- [Docker Compose deployment](https://st-gr.github.io/sail-proxy/deploy/docker)

## License

Part of the sail-proxy project. See the main [LICENSE](../../LICENSE) file for details.
