"""Larder's MCP server, reachable through Home Assistant at /api/larder/mcp.

Nabu Casa (and anything else that reaches Home Assistant but not the add-on
directly) can then use Larder's tools. Callers sign in to Home Assistant (a
long-lived access token, or Home Assistant's own sign-in), and requests are
passed on to Larder with the integration's token. Larder's MCP server is
stateless and answers each request with plain JSON, so passing it on is a
simple request and response.
"""

from __future__ import annotations

from http import HTTPStatus

from aiohttp import ClientError, ClientTimeout, web
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant

from .const import DOMAIN

MCP_PATH = "/api/larder/mcp"
# Headers that matter to MCP and are safe to pass on. Authorization is replaced with Larder's token.
FORWARD_HEADERS = ("content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id")


class LarderMcpView(HomeAssistantView):
    """Passes MCP requests from Home Assistant users on to Larder."""

    url = MCP_PATH
    name = "api:larder:mcp"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    def _larder(self):
        entries = [e for e in self.hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED]
        return entries[0] if len(entries) == 1 else None

    async def post(self, request: web.Request) -> web.Response:
        """One MCP request."""
        entry = self._larder()
        if entry is None:
            return web.json_response({"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "Larder isn't connected to Home Assistant (or more than one Larder is)."}}, status=HTTPStatus.SERVICE_UNAVAILABLE)
        client = entry.runtime_data.client
        headers = {k: v for k in FORWARD_HEADERS if (v := request.headers.get(k))}
        headers["Authorization"] = f"Bearer {client.token}"
        body = await request.read()
        try:
            async with client.session.post(f"{client.url}/mcp", data=body, headers=headers, timeout=ClientTimeout(total=60)) as resp:
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
