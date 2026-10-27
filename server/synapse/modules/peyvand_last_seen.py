"""Last seen with privacy rules for Peyvand.

Synapse presence is shown to everyone sharing a room with a user and has no privacy settings. This module
replaces it: clients report activity with heartbeats and ask for other users' status, and each answer is
filtered by the target's "last seen" privacy rules. Server admins always get the exact status.

Privacy rules live in the target's global account data `im.peyvand.privacy`:
    {"lastSeen": {"visibility": "everybody" | "contacts" | "nobody",
                  "allowUsers": [...], "blockUsers": [...], "allowRooms": [...], "blockRooms": [...]}}
Contacts are the people the target has a direct chat with (`m.direct`).

Users on other servers are asked from their own server through a federation-signed request, so the viewer is
proven to belong to the calling server and the target's server applies the rules. Servers without this module
leave their users' status out.
"""

import logging
import time
from collections.abc import Mapping

from twisted.internet import defer

from synapse.federation.transport.server._base import Authenticator
from synapse.http.server import DirectServeJsonResource
from synapse.logging.context import make_deferred_yieldable, run_in_background
from synapse.module_api import ModuleApi
from synapse.module_api.errors import SynapseError
from synapse.types import UserID

logger = logging.getLogger(__name__)

PRIVACY_TYPE = "im.peyvand.privacy"
BASE_PATH = "/_synapse/client/peyvand/last_seen"
# A user counts as online while heartbeats keep arriving within this window
ONLINE_TIMEOUT_MS = 90 * 1000
MAX_USERS_PER_REQUEST = 200
DAY_MS = 24 * 60 * 60 * 1000
# Statuses from other servers are reused for this long, and a server that failed isn't asked again for a while
REMOTE_CACHE_MS = 25 * 1000
REMOTE_RETRY_MS = 5 * 60 * 1000
REMOTE_TIMEOUT_MS = 5 * 1000


def now_ms() -> int:
    return int(time.time() * 1000)


class LastSeenModule:
    def __init__(self, config: dict, api: ModuleApi):
        self._api = api
        # user_id -> (last_active_ts, online_until_ts)
        self._activity: dict[str, tuple[int, int]] = {}
        # (viewer, user_id) -> (status, fetched_ts); server -> time it may be asked again
        self._remote_statuses: dict[tuple[str, str], tuple[dict, int]] = {}
        self._remote_retry_at: dict[str, int] = {}
        hs = api._hs
        self._federation_client = hs.get_federation_http_client()
        self._authenticator = Authenticator(hs)
        api.register_web_resource(f"{BASE_PATH}/heartbeat", HeartbeatResource(self))
        api.register_web_resource(f"{BASE_PATH}/status", StatusResource(self))
        api.register_web_resource(f"{BASE_PATH}/federation/status", FederationStatusResource(self))
        api.run_db_interaction("peyvand_last_seen_create", self._create_table)

    def is_local(self, user_id: str) -> bool:
        try:
            return self._api.is_mine(user_id)
        except Exception:
            return False

    @staticmethod
    def parse_config(config: dict) -> dict:
        return config or {}

    @staticmethod
    def _create_table(txn) -> None:
        txn.execute(
            "CREATE TABLE IF NOT EXISTS peyvand_last_seen ("
            " user_id TEXT PRIMARY KEY, last_active_ts BIGINT NOT NULL)"
        )

    async def record_activity(self, user_id: str, is_online: bool) -> None:
        ts = now_ms()
        self._activity[user_id] = (ts, ts + ONLINE_TIMEOUT_MS if is_online else 0)

        def store(txn) -> None:
            txn.execute(
                "INSERT INTO peyvand_last_seen (user_id, last_active_ts) VALUES (?, ?)"
                " ON CONFLICT (user_id) DO UPDATE SET last_active_ts = EXCLUDED.last_active_ts",
                (user_id, ts),
            )

        await self._api.run_db_interaction("peyvand_last_seen_store", store)

    async def _load_last_active(self, user_ids: list[str]) -> dict[str, int]:
        """Last activity from heartbeats, falling back to the last request any of the user's devices made."""

        def load(txn) -> dict[str, int]:
            result: dict[str, int] = {}
            placeholders = ",".join("?" for _ in user_ids)
            txn.execute(
                f"SELECT user_id, MAX(last_seen) FROM user_ips WHERE user_id IN ({placeholders}) GROUP BY user_id",
                user_ids,
            )
            for user_id, ts in txn.fetchall():
                if ts:
                    result[user_id] = int(ts)
            txn.execute(
                f"SELECT user_id, last_active_ts FROM peyvand_last_seen WHERE user_id IN ({placeholders})",
                user_ids,
            )
            for user_id, ts in txn.fetchall():
                result[user_id] = max(result.get(user_id, 0), int(ts))
            return result

        return await self._api.run_db_interaction("peyvand_last_seen_load", load)

    async def _get_rules(self, user_id: str) -> Mapping:
        # Account data comes back as immutable mappings, not dicts
        data = await self._api.account_data_manager.get_global(user_id, PRIVACY_TYPE) or {}
        rules = data.get("lastSeen")
        return rules if isinstance(rules, Mapping) else {}

    async def _is_contact(self, target: str, viewer: str) -> bool:
        direct = await self._api.account_data_manager.get_global(target, "m.direct") or {}
        return viewer in direct

    async def _is_room_member(self, room_ids: list, viewer: str) -> bool:
        for room_id in room_ids:
            if not isinstance(room_id, str):
                continue
            try:
                state = await self._api.get_room_state(room_id, [("m.room.member", viewer)])
            except Exception:
                continue
            event = state.get(("m.room.member", viewer))
            if event and event.content.get("membership") == "join":
                return True
        return False

    async def _can_see(self, target: str, viewer: str) -> bool:
        rules = await self._get_rules(target)
        if viewer in (rules.get("blockUsers") or []):
            return False
        if viewer in (rules.get("allowUsers") or []):
            return True
        if await self._is_room_member(rules.get("blockRooms") or [], viewer):
            return False
        if await self._is_room_member(rules.get("allowRooms") or [], viewer):
            return True
        visibility = rules.get("visibility", "everybody")
        if visibility == "nobody":
            return False
        if visibility == "contacts":
            return await self._is_contact(target, viewer)
        return True

    async def get_statuses(self, viewer: str, user_ids: list[str]) -> dict[str, dict]:
        local_ids = [user_id for user_id in user_ids if self.is_local(user_id)]
        ids_by_server: dict[str, list[str]] = {}
        for user_id in user_ids:
            if user_id not in local_ids:
                try:
                    ids_by_server.setdefault(UserID.from_string(user_id).domain, []).append(user_id)
                except Exception:
                    continue
        statuses = await self.get_local_statuses(viewer, local_ids) if local_ids else {}
        if ids_by_server:
            results = await make_deferred_yieldable(defer.gatherResults([
                run_in_background(self._get_remote_statuses, viewer, server, ids)
                for server, ids in ids_by_server.items()
            ], consumeErrors=True))
            for result in results:
                statuses.update(result)
        return statuses

    async def _get_remote_statuses(self, viewer: str, server: str, user_ids: list[str]) -> dict[str, dict]:
        now = now_ms()
        statuses: dict[str, dict] = {}
        missing: list[str] = []
        for user_id in user_ids:
            cached = self._remote_statuses.get((viewer, user_id))
            if cached and now - cached[1] < REMOTE_CACHE_MS:
                statuses[user_id] = cached[0]
            else:
                missing.append(user_id)
        if not missing or self._remote_retry_at.get(server, 0) > now:
            return statuses
        try:
            response = await self._federation_client.get_json(
                server, f"{BASE_PATH}/federation/status", args={"user_id": missing, "viewer": viewer},
                timeout=REMOTE_TIMEOUT_MS,
            )
        except Exception as e:
            logger.info("Last seen from %s unavailable: %s", server, type(e).__name__)
            self._remote_retry_at[server] = now + REMOTE_RETRY_MS
            return statuses
        remote = response.get("statuses") if isinstance(response, dict) else None
        if not isinstance(remote, dict):
            return statuses
        for user_id in missing:
            status = remote.get(user_id)
            if isinstance(status, dict) and isinstance(status.get("state"), str):
                statuses[user_id] = status
                self._remote_statuses[(viewer, user_id)] = (status, now)
        # Drop old entries so the cache doesn't grow with every viewer
        if len(self._remote_statuses) > 10000:
            self._remote_statuses = {
                key: value for key, value in self._remote_statuses.items() if now - value[1] < REMOTE_CACHE_MS
            }
        return statuses

    async def get_local_statuses(self, viewer: str, user_ids: list[str]) -> dict[str, dict]:
        is_admin = self.is_local(viewer) and await self._api.is_user_admin(viewer)
        last_active = await self._load_last_active(user_ids)
        now = now_ms()
        statuses: dict[str, dict] = {}
        for user_id in user_ids:
            active_ts, online_until = self._activity.get(user_id, (0, 0))
            last_ts = max(active_ts, last_active.get(user_id, 0))
            is_online = online_until > now
            if user_id == viewer or is_admin or await self._can_see(user_id, viewer):
                if is_online:
                    statuses[user_id] = {"state": "online", "expires_ts": online_until}
                elif last_ts:
                    statuses[user_id] = {"state": "offline", "last_active_ts": last_ts}
                else:
                    statuses[user_id] = {"state": "long_ago"}
                continue
            # Hidden users only reveal roughly how long ago they were around, like Telegram does
            age = now - last_ts if last_ts else None
            if is_online or (age is not None and age < 3 * DAY_MS):
                statuses[user_id] = {"state": "recently"}
            elif age is not None and age < 7 * DAY_MS:
                statuses[user_id] = {"state": "last_week"}
            elif age is not None and age < 30 * DAY_MS:
                statuses[user_id] = {"state": "last_month"}
            else:
                statuses[user_id] = {"state": "long_ago"}
        return statuses


class _Resource(DirectServeJsonResource):
    def __init__(self, module: LastSeenModule):
        super().__init__()
        self._module = module

    # CORS preflight for requests with an Authorization header
    async def _async_render_OPTIONS(self, request):
        return 200, {}


class HeartbeatResource(_Resource):
    async def _async_render_POST(self, request):
        requester = await self._module._api.get_user_by_req(request)
        is_online = request.args.get(b"offline", [b""])[0] != b"1"
        await self._module.record_activity(requester.user.to_string(), is_online)
        return 200, {}


class StatusResource(_Resource):
    async def _async_render_GET(self, request):
        requester = await self._module._api.get_user_by_req(request)
        user_ids = [value.decode("utf-8") for value in request.args.get(b"user_id", [])]
        user_ids = list(dict.fromkeys(user_ids))
        if len(user_ids) > MAX_USERS_PER_REQUEST:
            raise SynapseError(400, f"At most {MAX_USERS_PER_REQUEST} users per request")
        if not user_ids:
            return 200, {"statuses": {}}
        statuses = await self._module.get_statuses(requester.user.to_string(), user_ids)
        return 200, {"statuses": statuses}


class FederationStatusResource(_Resource):
    """Statuses of this server's users for a viewer on the calling server."""

    async def _async_render_GET(self, request):
        origin = await self._module._authenticator.authenticate_request(request, None)
        viewer = request.args.get(b"viewer", [b""])[0].decode("utf-8")
        try:
            viewer_server = UserID.from_string(viewer).domain
        except Exception:
            raise SynapseError(400, "Invalid viewer")
        if viewer_server != origin:
            raise SynapseError(403, "Viewer isn't on the calling server")
        user_ids = [value.decode("utf-8") for value in request.args.get(b"user_id", [])]
        user_ids = [user_id for user_id in dict.fromkeys(user_ids) if self._module.is_local(user_id)]
        if len(user_ids) > MAX_USERS_PER_REQUEST:
            raise SynapseError(400, f"At most {MAX_USERS_PER_REQUEST} users per request")
        if not user_ids:
            return 200, {"statuses": {}}
        statuses = await self._module.get_local_statuses(viewer, user_ids)
        return 200, {"statuses": statuses}
