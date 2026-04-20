# Contributing — packages/agents

This package hosts the Python agent runtime shipped in the
`chimera-agents` Docker image. It also defines the supply-chain policy
that all Chimera Dockerfiles must follow.

## Supply-chain: Docker base-image digest pinning

All Dockerfiles in this repo (currently `packages/agents/Dockerfile` and
`packages/chat-gateway/Dockerfile`) consume public ECR mirrors. Those tags
are mutable — an upstream retag could silently replace a trusted image
with a different one. To defend against that, every `FROM` line should
be pinned to an immutable `sha256:` digest.

### Current state

Both Dockerfiles currently use **tag-only** `FROM` lines with a
`FIXME(supply-chain)` comment directly above them showing the
digest-pinned form to adopt. The tag-only form is an interim state so CI
stays green while the first digest refresh is scheduled; see the
`FIXME` comments for rationale.

### Refreshing the pinned digest (quarterly)

Run this from a host with Docker that can reach AWS ECR Public:

```bash
# python:3.11-slim (packages/agents/Dockerfile)
docker pull public.ecr.aws/docker/library/python:3.11-slim
docker inspect --format='{{index .RepoDigests 0}}' \
  public.ecr.aws/docker/library/python:3.11-slim

# debian:bookworm-slim (packages/chat-gateway/Dockerfile)
docker pull public.ecr.aws/debian/debian:bookworm-slim
docker inspect --format='{{index .RepoDigests 0}}' \
  public.ecr.aws/debian/debian:bookworm-slim
```

The `inspect` command prints a line like:

```
public.ecr.aws/docker/library/python@sha256:abcdef0123...
```

Copy the `sha256:...` portion into the Dockerfile's `FROM`, replacing
the tag-only form:

```dockerfile
# before
FROM public.ecr.aws/docker/library/python:3.11-slim
# after
FROM public.ecr.aws/docker/library/python:3.11-slim@sha256:abcdef0123...
```

### Cadence and triggers

- **Every quarter** — refresh both digests during the standard
  dependency-update cycle (first week of Jan/Apr/Jul/Oct).
- **Security releases** — when upstream Debian/Python ship CVE patches,
  refresh immediately rather than waiting for the quarter boundary.
- **CI failure on pinned digest** — if a pinned image is withdrawn, the
  build will fail with `manifest unknown`. Refresh to the newest
  published digest.

Record the refresh in the commit message:
`chore(supply-chain): refresh base-image digest for chimera-agents`.
