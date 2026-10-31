"""Larder's MCP server, reachable through Home Assistant at /api/larder/mcp.

Nabu Casa (and anything else that reaches Home Assistant but not the add-on
directly) can then use Larder's tools. Callers either:

- send a Home Assistant token (a long-lived access token): requests go on to
  Larder with the integration's token; or
- send a Larder token, which connectors like the Claude app get by signing in
  (see oauth.py): passed on as it is, for Larder to check.

Without either, the answer is a 401 saying where to sign in. Larder's MCP
server is stateless and answers each request with plain JSON, so passing it
on is a simple request and response.
"""

from __future__ import annotations

from http import HTTPStatus

from aiohttp import ClientError, ClientTimeout, web
from homeassistant.components.http import KEY_AUTHENTICATED, HomeAssistantView
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .oauth import MCP_PATH, unauthorized

# Headers that matter to MCP and are safe to pass on. Authorization is set separately.
FORWARD_HEADERS = ("content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id")


class LarderMcpView(HomeAssistantView):
    """Passes MCP requests from Home Assistant users on to Larder."""

    url = MCP_PATH
    name = "api:larder:mcp"
    # Checked here: a Larder token is fine too, and a refusal says where to sign in.
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    def _larder(self):
        entries = [e for e in self.hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED]
        return entries[0] if len(entries) == 1 else None

    async def post(self, request: web.Request) -> web.Response:
        """One MCP request."""
        signed_in = bool(request.get(KEY_AUTHENTICATED))
        given = request.headers.get("Authorization", "")
        if not signed_in and not given.lower().startswith("bearer "):
            return unauthorized(self.hass, request)
        entry = self._larder()
        if entry is None:
            return web.json_response({"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "Larder isn't connected to Home Assistant (or more than one Larder is)."}}, status=HTTPStatus.SERVICE_UNAVAILABLE)
        client = entry.runtime_data.client
        headers = {k: v for k in FORWARD_HEADERS if (v := request.headers.get(k))}
        # Signed in to Home Assistant: as the integration. Otherwise it's for Larder to say whether the token is one of its own.
        headers["Authorization"] = f"Bearer {client.token}" if signed_in else given
        body = await request.read()
        try:
            async with client.session.post(f"{client.url}/mcp", data=body, headers=headers, timeout=ClientTimeout(total=60)) as resp:
                if resp.status == 401 and not signed_in:
                    return unauthorized(self.hass, request)
                payload = await resp.read()
                out = {k: v for k in ("content-type", "mcp-session-id") if (v := resp.headers.get(k))}
                return web.Response(status=resp.status, body=payload, headers=out)
        except (ClientError, TimeoutError) as err:
            return web.json_response({"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": f"Can't reach Larder: {err}"}}, status=HTTPStatus.BAD_GATEWAY)

    async def get(self, request: web.Request) -> web.Response:
        """Larder's MCP server is stateless: there's no stream to open."""
        return web.Response(status=HTTPStatus.METHOD_NOT_ALLOWED, headers={"Allow": "POST"})

    async def delete(self, request: web.Request) -> web.Response:
        """No sessions to end."""
        return web.Response(status=HTTPStatus.METHOD_NOT_ALLOWED, headers={"Allow": "POST"})
