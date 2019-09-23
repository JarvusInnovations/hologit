# hologit-actions-base

Provides an online-cachable base for hologit-based GitHub Actions.

## Usage

```dockerfile
FROM jarvus/hologit-actions-base:v1

COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

## Publishing

```bash
docker build -t jarvus/hologit-actions-base:v1 .
docker push jarvus/hologit-actions-base:v1
```
