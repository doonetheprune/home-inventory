"""Sign-in for MCP connectors (the Claude app, ChatGPT) through Home Assistant.

Connectors can't take a pasted token: they find out how to sign in, register
themselves, send the person to a sign-in page and get a token back (the MCP
authorization spec). Larder does all that itself; this makes it work at Home
Assistant's address (and so through Nabu Casa):

1. /api/larder/mcp answers 401 with where to find the sign-in details.
2. The details name /api/larder/oauth as the authorization server.
3. Registering and the token itself are passed on to Larder.
4. Signing in is Home Assistant's own login. The integration checks who
   logged in, asks them to allow the connection, and tells Larder, which
   gives the connector a Larder token (not a Home Assistant one), named
   after it and revocable in Larder's Settings → Access tokens.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from http import HTTPStatus
import logging
import re
import secrets
import time
from typing import Any
from urllib.parse import urlencode

from aiohttp import ClientError, ClientTimeout, web
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.network import NoURLAvailableError, get_url

from .api import LarderError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

MCP_PATH = "/api/larder/mcp"
OAUTH_PATH = "/api/larder/oauth"
RESOURCE_METADATA_PATH = f"/.well-known/oauth-protected-resource{MCP_PATH}"
# Where clients look for an authorization server's details, given its address (RFC 8414, and the OpenID variant).
SERVER_METADATA_PATHS = (
    f"/.well-known/oauth-authorization-server{OAUTH_PATH}",
    f"/.well-known/openid-configuration{OAUTH_PATH}",
    f"{OAUTH_PATH}/.well-known/oauth-authorization-server",
    f"{OAUTH_PATH}/.well-known/openid-configuration",
)
SIGN_IN_MINUTES = 10
TIMEOUT = ClientTimeout(total=30)


def base_url(hass: HomeAssistant, request: web.Request) -> str:
    """Home Assistant's address as the person reached it (Nabu Casa, or at home)."""
    try:
        return get_url(hass, require_current_request=True)
    except NoURLAvailableError:
        return f"{request.scheme}://{request.host}"


def unauthorized(hass: HomeAssistant, request: web.Request) -> web.Response:
    """401 saying where to find out how to sign in."""
    return web.json_response(
        {"error": "invalid_token", "error_description": "Sign in to use Larder."},
        status=HTTPStatus.UNAUTHORIZED,
        headers={"WWW-Authenticate": f'Bearer resource_metadata="{base_url(hass, request)}{RESOURCE_METADATA_PATH}"'},
    )


def _larder(hass: HomeAssistant):
    entries = [e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED]
    return entries[0].runtime_data.client if len(entries) == 1 else None


def _token_endpoints(hass: HomeAssistant, request: web.Request) -> list[tuple[str, bool]]:
    """Home Assistant's own token endpoint (and whether to check its certificate), to turn its login code into who logged in.

    This machine first; then the address the person used, if Home Assistant doesn't listen on 127.0.0.1. Tests replace this.
    """
    http = hass.http
    local = f"{'https' if http.ssl_certificate else 'http'}://127.0.0.1:{http.server_port}/auth/token"
    # A certificate is for Home Assistant's name, not 127.0.0.1, and this never leaves the machine.
    return [(local, False), (f"{base_url(hass, request)}/auth/token", True)]


def _page(title: str, body: str, status: int = HTTPStatus.OK) -> web.Response:
    html = f"""<!doctype html><html lang="en-GB"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(title)}</title>
<style>
body {{ font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f4f6fa; color: #14171f; }}
main {{ max-width: 26rem; margin: 12vh auto; padding: 1.5rem; background: #fff; border-radius: 1rem; box-shadow: 0 2px 12px #0001; }}
h1 {{ font-size: 1.3rem; margin: 0 0 .75rem; }}
.muted {{ color: #5b6270; font-size: .9rem; }}
.buttons {{ display: flex; gap: .75rem; margin-top: 1.25rem; }}
button {{ flex: 1; font: inherit; font-weight: 600; padding: .7rem; border-radius: .6rem; border: 1px solid #c9cfda; background: #fff; cursor: pointer; }}
button.allow {{ background: #1f4e8c; border-color: #1f4e8c; color: #fff; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #14171f; color: #eef1f6; }} main {{ background: #1e222c; }} .muted {{ color: #a3aab8; }} button {{ background: #1e222c; color: inherit; border-color: #3a4150; }} }}
</style>
<main>{body}</main></html>"""
    return web.Response(text=html, content_type="text/html", status=status, headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY"})


@dataclass
class _SignIn:
    """A connector's sign-in, from Larder's request to the person's answer."""

    request_id: str
    expires: float
    user: dict[str, str] | None = None


class _SignIns:
    """Sign-ins under way, by a random key the browser carries (a few minutes; memory is enough)."""

    def __init__(self) -> None:
        self._items: dict[str, _SignIn] = {}

    def add(self, item: _SignIn) -> str:
        now = time.monotonic()
        self._items = {k: v for k, v in self._items.items() if v.expires > now}
        # A household signs in a handful of times; refuse floods rather than grow.
        if len(self._items) > 200:
            self._items.pop(next(iter(self._items)))
        key = secrets.token_urlsafe(24)
        self._items[key] = item
        return key

    def take(self, key: str | None) -> _SignIn | None:
        item = self._items.pop(key or "", None)
        return item if item and item.expires > time.monotonic() else None


class _View(HomeAssistantView):
    requires_auth = False

    def __init__(self, hass: HomeAssistant, sign_ins: _SignIns) -> None:
        self.hass = hass
        self.sign_ins = sign_ins

    def larder_or_error(self):
        client = _larder(self.hass)
        if client is None:
            raise web.HTTPServiceUnavailable(text="Larder isn't connected to Home Assistant.")
        return client


class ResourceMetadataView(_View):
    """What /api/larder/mcp is, and who signs people in for it (RFC 9728)."""

    url = RESOURCE_METADATA_PATH
    name = "larder:oauth:resource"

    async def get(self, request: web.Request) -> web.Response:
        base = base_url(self.hass, request)
        return web.json_response({
            "resource": f"{base}{MCP_PATH}",
            "authorization_servers": [f"{base}{OAUTH_PATH}"],
            "bearer_methods_supported": ["header"],
            "scopes_supported": ["larder"],
            "resource_name": "Larder",
        })


class ServerMetadataView(_View):
    """How to register, sign in and get a token (RFC 8414)."""

    name = "larder:oauth:server"

    def __init__(self, hass: HomeAssistant, sign_ins: _SignIns, url: str) -> None:
        super().__init__(hass, sign_ins)
        self.url = url
        self.name = f"larder:oauth:server:{url}"

    async def get(self, request: web.Request) -> web.Response:
        issuer = f"{base_url(self.hass, request)}{OAUTH_PATH}"
        return web.json_response({
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/authorize",
            "token_endpoint": f"{issuer}/token",
            "registration_endpoint": f"{issuer}/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": ["larder"],
            "authorization_response_iss_parameter_supported": True,
        })


class RegisterView(_View):
    """A connector registers itself: passed on to Larder."""

    url = f"{OAUTH_PATH}/register"
    name = "larder:oauth:register"

    async def post(self, request: web.Request) -> web.Response:
        client = self.larder_or_error()
        try:
            async with client.session.post(f"{client.url}/oauth/register", data=await request.read(), headers={"content-type": "application/json"}, timeout=TIMEOUT) as resp:
                return web.Response(status=resp.status, body=await resp.read(), content_type="application/json")
        except (ClientError, TimeoutError) as err:
            return web.json_response({"error": "temporarily_unavailable", "error_description": f"Can't reach Larder: {err}"}, status=HTTPStatus.BAD_GATEWAY)


class TokenView(_View):
    """The connector swaps its code for a Larder token: passed on to Larder, which checks PKCE."""

    url = f"{OAUTH_PATH}/token"
    name = "larder:oauth:token"

    async def post(self, request: web.Request) -> web.Response:
        client = self.larder_or_error()
        try:
            async with client.session.post(
                f"{client.url}/oauth/token", data=await request.read(),
                headers={"content-type": request.headers.get("content-type", "application/x-www-form-urlencoded")}, timeout=TIMEOUT,
            ) as resp:
                return web.Response(status=resp.status, body=await resp.read(), content_type="application/json", headers={"Cache-Control": "no-store"})
        except (ClientError, TimeoutError) as err:
            return web.json_response({"error": "temporarily_unavailable", "error_description": f"Can't reach Larder: {err}"}, status=HTTPStatus.BAD_GATEWAY)


class AuthorizeView(_View):
    """Start of signing in: Larder checks the request, then Home Assistant's login asks who you are."""

    url = f"{OAUTH_PATH}/authorize"
    name = "larder:oauth:authorize"

    async def get(self, request: web.Request) -> web.StreamResponse:
        client = self.larder_or_error()
        try:
            async with client.session.get(f"{client.url}/oauth/authorize", params=request.query, allow_redirects=False, timeout=TIMEOUT) as resp:
                location = resp.headers.get("location", "")
                found = re.search(r"[?&]request=([A-Za-z0-9_-]+)", location) if resp.status in (301, 302, 303, 307) else None
                if not found:
                    # Larder's own page saying what's wrong with the request.
                    return web.Response(status=resp.status, body=await resp.read(), content_type=resp.content_type or "text/html")
        except (ClientError, TimeoutError) as err:
            return _page("Larder", f"<h1>Can't reach Larder</h1><p>{escape(str(err))}</p>", HTTPStatus.BAD_GATEWAY)
        key = self.sign_ins.add(_SignIn(request_id=found.group(1), expires=time.monotonic() + SIGN_IN_MINUTES * 60))
        base = base_url(self.hass, request)
        query = urlencode({"response_type": "code", "client_id": f"{base}{OAUTH_PATH}/", "redirect_uri": f"{base}{OAUTH_PATH}/callback", "state": key})
        raise web.HTTPFound(f"{base}/auth/authorize?{query}")


class CallbackView(_View):
    """Back from Home Assistant's login: find out who it was, then ask them to allow the connection."""

    url = f"{OAUTH_PATH}/callback"
    name = "larder:oauth:callback"

    async def get(self, request: web.Request) -> web.Response:
        sign_in = self.sign_ins.take(request.query.get("state"))
        code = request.query.get("code")
        if sign_in is None or not code:
            return _page("Larder", "<h1>This sign-in has expired</h1><p>Start connecting again from the assistant.</p>", HTTPStatus.BAD_REQUEST)
        client = self.larder_or_error()
        base = base_url(self.hass, request)
        user = await self._who(request, code, f"{base}{OAUTH_PATH}/")
        if user is None:
            return _page("Larder", "<h1>Couldn't check who signed in</h1><p>Start connecting again from the assistant.</p>", HTTPStatus.BAD_REQUEST)
        try:
            asking = await client.oauth_request(sign_in.request_id)
        except LarderError as err:
            return _page("Larder", f"<h1>Couldn't continue</h1><p>{escape(err.message)}</p>", HTTPStatus.BAD_REQUEST)
        sign_in.user = user
        sign_in.expires = time.monotonic() + SIGN_IN_MINUTES * 60
        key = self.sign_ins.add(sign_in)
        who = escape(asking.get("client", "An AI assistant"))
        where = escape(asking.get("redirectHost", ""))
        return _page("Connect to Larder", f"""
<h1>Allow {who} to use Larder?</h1>
<p>It will be able to see and change what's in Larder as <b>{escape(user["displayName"])}</b>: stock, shopping lists, places and prices. Not the rest of Home Assistant.</p>
<p class="muted">It's sending you back to <b>{where}</b>. Only allow it if you started connecting there. You can disconnect it any time in Larder: Settings → Access tokens.</p>
<form method="post" action="{OAUTH_PATH}/approve">
<input type="hidden" name="key" value="{escape(key)}">
<div class="buttons"><button name="approve" value="no">Cancel</button><button class="allow" name="approve" value="yes">Allow</button></div>
</form>""")

    async def _who(self, request: web.Request, code: str, client_id: str) -> dict[str, str] | None:
        """Swaps Home Assistant's login code for who logged in, then ends that Home Assistant session at once."""
        session = async_get_clientsession(self.hass)
        tokens: dict[str, Any] | None = None
        for endpoint, verify in _token_endpoints(self.hass, request):
            try:
                async with session.post(endpoint, data={"grant_type": "authorization_code", "code": code, "client_id": client_id}, ssl=None if verify else False, timeout=TIMEOUT) as resp:
                    # Home Assistant answered: a refused code stays refused, wherever it's asked.
                    if resp.status == 200:
                        tokens = await resp.json()
                    else:
                        _LOGGER.warning("Home Assistant didn't accept the login code for a connector sign-in: %s %s", resp.status, (await resp.text())[:200])
                    break
            except (ClientError, TimeoutError) as err:
                _LOGGER.debug("Couldn't reach Home Assistant's token endpoint at %s: %s", endpoint, err)
                continue
        if not tokens:
            return None
        refresh = self.hass.auth.async_validate_access_token(tokens.get("access_token", ""))
        if refresh is None:
            return None
        user = refresh.user
        # The connector gets a Larder token, so this Home Assistant one isn't needed.
        self.hass.auth.async_remove_refresh_token(refresh)
        username = next((c.data.get("username") for c in user.credentials if c.auth_provider_type == "homeassistant" and c.data.get("username")), None)
        return {"id": user.id, "username": username or user.name or "homeassistant", "displayName": user.name or username or "Home Assistant user"}


class ApproveView(_View):
    """The person's answer, passed to Larder, then back to the assistant."""

    url = f"{OAUTH_PATH}/approve"
    name = "larder:oauth:approve"

    async def post(self, request: web.Request) -> web.Response:
        form = await request.post()
        sign_in = self.sign_ins.take(str(form.get("key", "")))
        if sign_in is None or sign_in.user is None:
            return _page("Larder", "<h1>This sign-in has expired</h1><p>Start connecting again from the assistant.</p>", HTTPStatus.BAD_REQUEST)
        client = self.larder_or_error()
        try:
            answer = await client.oauth_answer(sign_in.request_id, form.get("approve") == "yes", f"{base_url(self.hass, request)}{OAUTH_PATH}", sign_in.user)
        except LarderError as err:
            return _page("Larder", f"<h1>Couldn't connect</h1><p>{escape(err.message)}</p>", HTTPStatus.BAD_REQUEST)
        raise web.HTTPFound(answer["redirect"])


def async_register_views(hass: HomeAssistant) -> None:
    """Everything a connector needs to sign in at Home Assistant's address."""
    sign_ins = _SignIns()
    hass.http.register_view(ResourceMetadataView(hass, sign_ins))
    for path in SERVER_METADATA_PATHS:
        hass.http.register_view(ServerMetadataView(hass, sign_ins, path))
    for view in (RegisterView, TokenView, AuthorizeView, CallbackView, ApproveView):
        hass.http.register_view(view(hass, sign_ins))
