# Assets And Licenses

## Repository Policy

This repository should not commit third-party avatar binaries, generated private assets, meeting recordings, screenshots containing private workspace data, or local `.env` files.

Allowed in git:

- source code
- public docs
- sample JSON payloads with fake IDs
- references to public sample assets

Not allowed in git:

- OpenAI, Slack, Google, or workspace secrets
- private prompts or workspace-specific policy
- downloaded Live2D model binaries unless the license is explicitly reviewed
- screenshots from real meetings
- generated avatar packs from private experiments

## Hiyori

The default `MAB_AVATAR_MODEL_URL` points to the public Live2D Cubism Web Samples Hiyori model:

<https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@master/Samples/Resources/Hiyori/Hiyori.model3.json>

The repo references this URL for local smoke/demo behavior but does not bundle the model files. Before publishing a packaged app or redistributing assets, review the upstream Live2D sample license and replace Hiyori with an asset you are allowed to redistribute.

## Playwright Browsers

Playwright downloads browser binaries into the local machine cache. They are runtime dependencies, not repository assets.

## Generated Avatars

Generated avatars from Image2/Codex experiments should stay outside this repo until their provenance, license, and redistribution rights are clear.
