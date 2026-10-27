"""Peyvand sticker bot.

People send it a Telegram sticker pack link (t.me/addstickers/NAME). It downloads the pack through the Telegram
Bot API, uploads the files to this homeserver and publishes the pack in the sticker registry room
(#peyvand-stickers), in the Matrix image pack format (MSC2545). Tele reads that room: packs the server admins add
are on for everyone, others are added by tapping the link the bot replies with.

Telegram may be filtered where the server runs, so Telegram requests can go through a proxy (TELEGRAM_PROXY,
for example socks5h://127.0.0.1:10808 from an xray client). Matrix requests always go straight to Synapse.

Settings come from the environment:
    HOMESERVER_URL     Synapse's client API, e.g. http://127.0.0.1:8008
    BOT_ACCESS_TOKEN   access token of the bot account, or instead:
    BOT_USER, BOT_PASSWORD   the bot account's name and password; the bot signs in once and keeps the token
    TELEGRAM_TOKEN     token of a Telegram bot made with @BotFather (only used to read public sticker packs)
    TELEGRAM_PROXY     optional proxy URL for Telegram
    ADMIN_USERS        comma separated Matrix IDs whose packs are turned on for everyone
    STATE_DIR          where the sync position is kept (default /data)
"""

import json
import logging
import os
import re
import sys
import time
import urllib.parse

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sticker-bot")

HOMESERVER_URL = os.environ["HOMESERVER_URL"].rstrip("/")
ACCESS_TOKEN = os.environ.get("BOT_ACCESS_TOKEN", "").strip()
BOT_USER = os.environ.get("BOT_USER", "stickers").strip()
BOT_PASSWORD = os.environ.get("BOT_PASSWORD", "").strip()
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
TELEGRAM_PROXY = os.environ.get("TELEGRAM_PROXY", "").strip()
ADMIN_USERS = {user.strip() for user in os.environ.get("ADMIN_USERS", "").split(",") if user.strip()}
STATE_DIR = os.environ.get("STATE_DIR", "/data")

REGISTRY_LOCALPART = "peyvand-stickers"
PACK_EVENT = "im.ponies.room_emotes"
SYNC_TIMEOUT_MS = 30000
# A state event may be at most 64 KiB; packs are kept well below
MAX_PACK_CONTENT_BYTES = 60000
LINK_RE = re.compile(r"(?:https?://)?(?:t\.me|telegram\.me|telegram\.dog)/addstickers/([A-Za-z0-9_]{1,64})", re.I)
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
MIME_BY_EXTENSION = {
    "tgs": "application/x-tgsticker",
    "webm": "video/webm",
    "webp": "image/webp",
    "png": "image/png",
    "jpg": "image/jpeg",
}

HELP_TEXT = (
    "Send me a Telegram sticker pack link, like https://t.me/addstickers/Animals, "
    "and I'll bring the pack here so you can use it in Tele."
)

matrix = requests.Session()
telegram = requests.Session()
if TELEGRAM_PROXY:
    telegram.proxies = {"http": TELEGRAM_PROXY, "https": TELEGRAM_PROXY}


class BotError(Exception):
    """A failure the person who asked should hear about."""


def mx(method: str, path: str, **kwargs):
    kwargs.setdefault("timeout", 60)
    response = matrix.request(method, f"{HOMESERVER_URL}/_matrix/client/v3{path}", **kwargs)
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path.split('?')[0]}: {response.status_code} {response.text[:200]}")
    return response.json() if response.content else {}


def quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def sign_in() -> str:
    """The access token from BOT_ACCESS_TOKEN, or from signing in with the password (kept for the next start)."""
    if ACCESS_TOKEN:
        return ACCESS_TOKEN
    token_path = os.path.join(STATE_DIR, "access_token")
    try:
        with open(token_path) as file:
            return file.read().strip()
    except OSError:
        pass
    if not BOT_PASSWORD:
        raise SystemExit("Set BOT_ACCESS_TOKEN, or BOT_USER and BOT_PASSWORD")
    while True:
        try:
            response = requests.post(f"{HOMESERVER_URL}/_matrix/client/v3/login", json={
                "type": "m.login.password", "identifier": {"type": "m.id.user", "user": BOT_USER},
                "password": BOT_PASSWORD, "initial_device_display_name": "Sticker bot",
            }, timeout=30)
            break
        except requests.RequestException:
            # Synapse may still be starting
            time.sleep(5)
    if response.status_code != 200:
        raise SystemExit(f"Signing in as {BOT_USER} failed: {response.text[:200]}")
    token = response.json()["access_token"]
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(token_path, "w") as file:
        file.write(token)
    return token


class Bot:
    def __init__(self):
        matrix.headers["Authorization"] = f"Bearer {sign_in()}"
        whoami = mx("GET", "/account/whoami")
        self.user_id = whoami["user_id"]
        self.server_name = self.user_id.split(":", 1)[1]
        self.state_path = os.path.join(STATE_DIR, "state.json")
        self.state = self._load_state()
        self.registry_room_id = self._ensure_registry()
        self.txn = int(time.time() * 1000)
        log.info("Running as %s, registry %s", self.user_id, self.registry_room_id)

    def _load_state(self) -> dict:
        try:
            with open(self.state_path) as file:
                return json.load(file)
        except (OSError, ValueError):
            return {}

    def _save_state(self):
        os.makedirs(STATE_DIR, exist_ok=True)
        temp_path = f"{self.state_path}.tmp"
        with open(temp_path, "w") as file:
            json.dump(self.state, file)
        os.replace(temp_path, self.state_path)

    def _ensure_registry(self) -> str:
        alias = f"#{REGISTRY_LOCALPART}:{self.server_name}"
        try:
            return mx("GET", f"/directory/room/{quote(alias)}")["room_id"]
        except RuntimeError:
            pass
        # Anyone may read the packs without joining; only the bot may change them
        room = mx("POST", "/createRoom", json={
            "name": "Peyvand Stickers",
            "topic": "Sticker packs for everyone on this server",
            "room_alias_name": REGISTRY_LOCALPART,
            "preset": "private_chat",
            "visibility": "private",
            "initial_state": [
                {"type": "m.room.history_visibility", "state_key": "", "content": {"history_visibility": "world_readable"}},
                {"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "invite"}},
            ],
            # The creator keeps full power; everyone else can't post or change anything
            "power_level_content_override": {"users_default": 0, "events_default": 100, "state_default": 100},
        })
        return room["room_id"]

    # Matrix helpers

    def send_text(self, room_id: str, text: str, html: str | None = None):
        self.txn += 1
        content = {"msgtype": "m.notice", "body": text}
        if html:
            content.update({"format": "org.matrix.custom.html", "formatted_body": html})
        mx("PUT", f"/rooms/{quote(room_id)}/send/m.room.message/{self.txn}", json=content)

    def upload(self, data: bytes, filename: str, mime_type: str) -> str:
        response = matrix.post(
            f"{HOMESERVER_URL}/_matrix/media/v3/upload", params={"filename": filename},
            data=data, headers={"Content-Type": mime_type}, timeout=120,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"upload: {response.status_code} {response.text[:200]}")
        return response.json()["content_uri"]

    def get_pack(self, short_name: str) -> tuple[str, dict] | None:
        """The registry entry of a pack, matched without regard to case."""
        events = mx("GET", f"/rooms/{quote(self.registry_room_id)}/state")
        for event in events:
            if event.get("type") == PACK_EVENT and event.get("state_key", "").lower() == short_name.lower():
                if event.get("content", {}).get("images"):
                    return event["state_key"], event["content"]
        return None

    def put_pack(self, short_name: str, content: dict):
        mx("PUT", f"/rooms/{quote(self.registry_room_id)}/state/{PACK_EVENT}/{quote(short_name)}", json=content)

    # Telegram

    def telegram_call(self, method: str, **params):
        if not TELEGRAM_TOKEN:
            raise BotError("The sticker bot isn't connected to Telegram yet; ask the server admin to set it up.")
        try:
            response = telegram.get(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/{method}", params=params, timeout=60)
        except requests.RequestException as err:
            log.warning("Telegram unreachable: %s", type(err).__name__)
            raise BotError("I can't reach Telegram right now. Please try again in a few minutes.")
        body = response.json() if response.headers.get("Content-Type", "").startswith("application/json") else {}
        if not body.get("ok"):
            description = body.get("description", f"HTTP {response.status_code}")
            if "STICKERSET_INVALID" in description or "not found" in description.lower():
                raise BotError("Telegram has no sticker pack with that name. Check the link and send it again.")
            log.warning("Telegram %s failed: %s", method, description)
            raise BotError("Telegram didn't give me that pack. Please try again later.")
        return body["result"]

    def telegram_file(self, file_id: str) -> tuple[bytes, str]:
        file_path = self.telegram_call("getFile", file_id=file_id)["file_path"]
        for attempt in range(3):
            try:
                response = telegram.get(f"https://api.telegram.org/file/bot{TELEGRAM_TOKEN}/{file_path}", timeout=60)
                response.raise_for_status()
                return response.content, file_path
            except requests.RequestException:
                if attempt == 2:
                    raise BotError("Downloading the stickers from Telegram failed. Please try again.")
                time.sleep(2)
        raise AssertionError

    # Importing

    def import_pack(self, short_name: str, notify) -> tuple[str, dict]:
        sticker_set = self.telegram_call("getStickerSet", name=short_name)
        if sticker_set.get("sticker_type", "regular") != "regular":
            raise BotError("That's an emoji pack, not a sticker pack; only sticker packs can be added.")
        stickers = sticker_set.get("stickers", [])
        if not stickers:
            raise BotError("That pack has no stickers.")
        name = sticker_set["name"]
        notify(f"Adding “{sticker_set.get('title', name)}” ({len(stickers)} stickers)…")

        images = {}
        for index, sticker in enumerate(stickers):
            data, file_path = self.telegram_file(sticker["file_id"])
            extension = file_path.rsplit(".", 1)[-1].lower()
            mime_type = MIME_BY_EXTENSION.get(extension, "image/webp")
            url = self.upload(data, f"sticker{index}.{extension}", mime_type)
            info = {"w": sticker.get("width", 512), "h": sticker.get("height", 512),
                    "mimetype": mime_type, "size": len(data)}
            # Animated stickers need a still picture for previews and for apps that can't play them
            thumbnail = sticker.get("thumbnail") or sticker.get("thumb")
            if thumbnail and mime_type != "image/webp":
                thumb_data, thumb_path = self.telegram_file(thumbnail["file_id"])
                thumb_extension = thumb_path.rsplit(".", 1)[-1].lower()
                thumb_mime = MIME_BY_EXTENSION.get(thumb_extension, "image/webp")
                info["thumbnail_url"] = self.upload(thumb_data, f"thumb{index}.{thumb_extension}", thumb_mime)
                info["thumbnail_info"] = {"w": thumbnail.get("width"), "h": thumbnail.get("height"),
                                          "mimetype": thumb_mime}
            images[f"{index:03d}"] = {"url": url, "body": sticker.get("emoji") or "🙂", "info": info,
                                      "usage": ["sticker"]}

        first = images["000"]
        content = {
            "pack": {
                "display_name": sticker_set.get("title", name),
                "avatar_url": first["info"].get("thumbnail_url", first["url"]),
                "usage": ["sticker"],
                "im.peyvand.source": f"https://t.me/addstickers/{name}",
                "im.peyvand.added_ts": int(time.time() * 1000),
            },
            "images": images,
        }
        if len(json.dumps(content).encode()) > MAX_PACK_CONTENT_BYTES:
            raise BotError("That pack is too big to add.")
        return name, content

    def handle_request(self, room_id: str, sender: str, short_name: str):
        is_admin = sender in ADMIN_USERS
        existing = self.get_pack(short_name)
        if existing:
            name, content = existing
            if is_admin and not content["pack"].get("im.peyvand.default"):
                content["pack"]["im.peyvand.default"] = True
                self.put_pack(name, content)
                self.reply_added(room_id, name, content, is_admin, is_new=False)
                return
            self.reply_added(room_id, name, content, is_admin and content["pack"].get("im.peyvand.default"),
                             is_new=False)
            return

        name, content = self.import_pack(short_name, lambda text: self.send_text(room_id, text))
        content["pack"]["im.peyvand.default"] = is_admin
        content["pack"]["im.peyvand.added_by"] = sender
        self.put_pack(name, content)
        log.info("Added pack %s (%d stickers)", name, len(content["images"]))
        self.reply_added(room_id, name, content, is_admin, is_new=True)

    def reply_added(self, room_id: str, name: str, content: dict, is_for_everyone: bool, is_new: bool):
        title = content["pack"].get("display_name", name)
        link = f"https://t.me/addstickers/{name}"
        count = len(content["images"])
        if is_for_everyone:
            text = f"“{title}” ({count} stickers) is {'now ' if is_new else ''}in everyone's stickers. {link}"
        else:
            text = f"“{title}” ({count} stickers) is ready. Tap the link to add it to your stickers: {link}"
        self.send_text(room_id, text)

    # Events

    def on_message(self, room_id: str, event: dict):
        sender = event.get("sender", "")
        if sender == self.user_id:
            return
        if event.get("type") == "m.room.encrypted":
            self.send_text(room_id, "I can't read encrypted messages. Please send the link in a chat without encryption.")
            return
        content = event.get("content", {})
        if content.get("msgtype") not in ("m.text", "m.notice") or "m.new_content" in content:
            return
        body = content.get("body", "").strip()
        names = list(dict.fromkeys(LINK_RE.findall(body)))
        if not names and NAME_RE.match(body) and len(body) > 3:
            names = [body]
        if not names:
            self.send_text(room_id, HELP_TEXT)
            return
        for short_name in names[:3]:
            try:
                self.handle_request(room_id, sender, short_name)
            except BotError as err:
                self.send_text(room_id, str(err))
            except Exception:
                log.exception("Adding %s failed", short_name)
                self.send_text(room_id, "Something went wrong while adding that pack. Please try again later.")

    def on_invite(self, room_id: str, invite_state: dict):
        inviter = next((event.get("sender") for event in invite_state.get("events", [])
                        if event.get("type") == "m.room.member" and event.get("state_key") == self.user_id), None)
        # Only people on this server can use the bot
        if not inviter or inviter.split(":", 1)[-1] != self.server_name:
            mx("POST", f"/rooms/{quote(room_id)}/leave", json={})
            return
        mx("POST", f"/rooms/{quote(room_id)}/join", json={})
        self.send_text(room_id, HELP_TEXT)

    def run(self):
        sync_filter = json.dumps({
            "presence": {"types": []},
            "account_data": {"types": []},
            "room": {
                "timeline": {"types": ["m.room.message", "m.room.encrypted"], "limit": 20},
                "state": {"types": ["m.room.member"], "lazy_load_members": True},
                "ephemeral": {"types": []},
                "account_data": {"types": []},
            },
        })
        since = self.state.get("since")
        while True:
            params = {"filter": sync_filter, "timeout": SYNC_TIMEOUT_MS if since else 0}
            if since:
                params["since"] = since
            try:
                response = mx("GET", "/sync", params=params, timeout=SYNC_TIMEOUT_MS / 1000 + 30)
            except Exception as err:
                log.warning("Sync failed: %s", err)
                time.sleep(5)
                continue
            rooms = response.get("rooms", {})
            for room_id, invite in rooms.get("invite", {}).items():
                try:
                    self.on_invite(room_id, invite.get("invite_state", {}))
                except Exception as err:
                    log.warning("Handling an invite failed: %s", err)
            # Messages from before the first sync are old and not answered
            if since:
                for room_id, joined in rooms.get("join", {}).items():
                    if room_id == self.registry_room_id:
                        continue
                    for event in joined.get("timeline", {}).get("events", []):
                        try:
                            self.on_message(room_id, event)
                        except Exception as err:
                            log.warning("Handling a message failed: %s", err)
            since = response["next_batch"]
            self.state["since"] = since
            self._save_state()


if __name__ == "__main__":
    try:
        Bot().run()
    except KeyboardInterrupt:
        sys.exit(0)
