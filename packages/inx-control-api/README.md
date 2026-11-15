# INX Control API

From the repository root on the Docker host, bundle the API, then build and start the container:

```sh
pnpm --filter @inx.sh/control-api build

docker compose -f packages/inx-control-api/docker-compose.yaml up -d --build --wait

curl -fsS http://127.0.0.1:3100/health

curl -sSI http://127.0.0.1:3100/bootstrap/0.1.0-beta.0
```

The health check returns JSON. The pinned installer URL returns a redirect to its GitHub Release asset. The container needs outbound HTTPS to GitHub to resolve the latest release at `/bootstrap`.

Compose publishes port 3100 on the host's loopback interface. Point the host's HTTPS reverse proxy at `http://127.0.0.1:3100` for both bootstrap paths; see the [Nginx example](../inx-gateway/README.md#test-and-release). Set `CONTROL_API_PORT` to use a different host port and update the proxy accordingly.

Rerun both commands after updating the source. To stop the service, run `docker compose -f packages/inx-control-api/docker-compose.yaml down`.
