# Sticker packs and the sticker bot

Tele has a sticker panel like Telegram's. Packs are stored the standard Matrix way (MSC2545 image packs, which
Cinny and FluffyChat read too) in one registry room, `#peyvand-stickers:<MATRIX_DOMAIN>`. Only the sticker bot
can change that room; anyone on the server can read it.

- Packs a **server admin** asks for are turned on for everyone.
- Packs anyone else asks for are ready to add: the bot replies with the pack's link, and tapping it in Tele opens
  the pack with an **Add** button.
- Anyone can remove a pack from their own panel in the pack window; recent and favorite stickers follow the
  account to every device.

Static (`.webp`), animated (`.tgs`) and video (`.webm`) stickers all work in Tele. Other Matrix apps show static
stickers; most can't play the animated ones.

## Using the bot

Start a chat with `@stickers:<MATRIX_DOMAIN>` and send a link such as `https://t.me/addstickers/Animals`.
The chat must be unencrypted (Tele's default for new chats); the bot can't read encrypted messages.

## Setting it up

1. **Telegram bot token.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and follow
   the steps. Copy the token it gives you. The token is only used to read public sticker packs.
2. **Bot account** on your server:

   ```bash
   docker compose exec synapse register_new_matrix_user -c /data/homeserver.yaml -u stickers --no-admin http://localhost:8008
   ```

3. **`.env`:**

   ```env
   STICKER_BOT_PASSWORD=the password from step 2
   TELEGRAM_BOT_TOKEN=the token from step 1
   STICKER_ADMINS=@you:matrix.example.com
   ```

4. **Telegram filtered on the server?** Put an xray client config at `data/xray/config.json` (start from
   `server/xray/config.example.json`; the proxy must listen on `0.0.0.0:10808`), set
   `TELEGRAM_PROXY=socks5h://xray:10808` and add the `stickers-proxy` profile below. Keep that file out of git:
   it holds your proxy credentials.
5. **Start it:**

   ```bash
   docker compose --profile stickers --profile stickers-proxy up -d --build
   ```

   Leave out `--profile stickers-proxy` when the server reaches Telegram directly.

Check `docker compose logs sticker-bot`: it should say `Running as @stickers:...`.
