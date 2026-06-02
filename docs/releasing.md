# Releasing

This repo is ready for source releases on GitHub. It is not set up for `npm publish`, and container publication is still a manual operator step.

## Release Scope

- Publish Git tags and GitHub Releases from the public repo.
- Keep `"private": true` in `package.json` so the CLI package is not published to npm by accident.
- Treat Docker images as optional deployment artifacts, not as the primary release surface.

## Pre-Release Checklist

Run these from a clean checkout:

```bash
vp install
vp run doctor
vp run ci
vp run smoke:docker-meeting-surfaces
```

If the release is meant to bless live operator flows, also run the relevant human-gated checks:

- Slack install / OAuth acceptance
- Real Meet room acceptance
- Live provider checks for the selected AgentRunner / STT / TTS stack

## Versioning

1. Update `package.json` version.
2. Refresh release notes / README callouts if the operator surface changed.
3. Commit the version bump and any doc updates together.

## Publishing

1. Push the release commit to `main`.
2. Create an annotated tag such as `v0.1.0`.
3. Push the tag.
4. Create a GitHub Release that links:
   - the tag
   - the notable verification evidence
   - any required runtime/env caveats

Example:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin main --tags
gh release create v0.1.0 --generate-notes
```

## Docker Publishing

The repo includes `Dockerfile`, `docker-compose.yml`, and `vp run smoke:docker-meeting-surfaces`, but it does not yet automate image publication.

For now:

```bash
docker build -t ghcr.io/afk-surf/oneesama:v0.1.0 .
docker run --rm --shm-size=1g ghcr.io/afk-surf/oneesama:v0.1.0 vp run smoke:screen-share
docker run --rm --shm-size=1g ghcr.io/afk-surf/oneesama:v0.1.0 vp run smoke:hiyori-live2d
docker push ghcr.io/afk-surf/oneesama:v0.1.0
```

## Current Gaps

- No automated GitHub Release workflow.
- No automated container publish workflow.
- No signed release artifact pipeline.
- No separate packaged desktop/frontend distribution; the browser runtime ships inside the Meeting Agent service.
