# Publishing images to Docker Hub

GitHub Actions (`.github/workflows/docker.yml`) builds two images for `linux/amd64` and `linux/arm64` and pushes
them to Docker Hub:

| Image | What it is |
|---|---|
| `<user>/peyvand-web` | The Tele web app. Domains and the push key are filled in when the container starts, so one image works for every server |
| `<user>/peyvand-sticker-bot` | The optional sticker bot (docs/stickers.md) |

The other services (Synapse, Postgres, Sygnal, coturn, Caddy) already use official images.

## Setting it up

1. On Docker Hub, create an access token: **Account settings → Personal access tokens → Generate**, with
   **Read & Write** access.
2. On GitHub, open the repository's **Settings → Secrets and variables → Actions** and add:
   - `DOCKERHUB_USERNAME`: your Docker Hub user name (or organization)
   - `DOCKERHUB_TOKEN`: the token from step 1
3. Push to `main`, or run the workflow by hand from the **Actions** tab (**Docker images → Run workflow**).

| Push | Tags published |
|---|---|
| to `main` | `latest` and `sha-<commit>` |
| a tag `v1.2.3` | `1.2.3`, `1.2` and `sha-<commit>` |
| a pull request | nothing; the images are only built to check them |

Without the two secrets the workflow still builds the images but doesn't push them.

## Using the published images

In `.env`:

```env
PEYVAND_WEB_IMAGE=yourname/peyvand-web:latest
PEYVAND_STICKER_BOT_IMAGE=yourname/peyvand-sticker-bot:latest
```

Then:

```bash
docker compose pull web
docker compose up -d
```

Updating later is the same two commands. Leave the variables empty to build the images on the server instead.
