"""Gmail sign-in for Larder's order emails, back through Home Assistant.

Larder reads shops' order emails from Gmail with read-only access the
household grants through its own Google Cloud client. After signing in, Google
sends the person back to an https address it was told about: Home Assistant's
from outside the house (Nabu Casa, or the household's own), at
/api/larder/gmail/callback. This page passes what Google sent to Larder, which
finishes signing in, and says how it went. It needs no Home Assistant login
(Google's redirect doesn't carry one): Larder only accepts a sign-in it started
in the last few minutes, by its one-off state.
"""

from __future__ import annotations

from html import escape
from http import HTTPStatus
import logging

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .api import LarderError
from .oauth import _larder, _page

_LOGGER = logging.getLogger(__name__)

CALLBACK_PATH = "/api/larder/gmail/callback"


class GmailCallbackView(HomeAssistantView):
    """Where Google sends the person back after they allow Larder to read Gmail."""

    url = CALLBACK_PATH
    name = "larder:gmail:callback"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request) -> web.Response:
        query = request.query
        client = _larder(self.hass)
        if client is None:
            return _page("Gmail wasn't connected", "<h1>Gmail wasn't connected</h1><p>Larder isn't set up in Home Assistant yet (Settings → Devices &amp; services).</p>", HTTPStatus.SERVICE_UNAVAILABLE)
        body = {"state": query.get("state", "")[:200]}
        if query.get("code"):
            body["code"] = query["code"][:2000]
        if query.get("error"):
            body["error"] = query["error"][:200]
        try:
            answer = await client.gmail_signed_in(body)
        except LarderError as err:
            if err.status == 404:
                message = "Order emails are switched off in Larder (Settings → Modules)."
            else:
                message = err.message
            _LOGGER.info("Gmail sign-in for Larder didn't finish: %s", message)
            return _page("Gmail wasn't connected", f"<h1>Gmail wasn't connected</h1><p>{escape(message)}</p><p class=\"muted\">Go back to Larder (Settings → Order emails) to try again.</p>", HTTPStatus.BAD_REQUEST)
        return _page("Gmail connected", f"<h1>Gmail connected</h1><p>{escape(str(answer.get('message', 'Larder can read your order emails now.')))}</p><p class=\"muted\">You can close this page and go back to Larder.</p>")


def async_register_views(hass: HomeAssistant) -> None:
    """Add the page Google sends people back to."""
    hass.http.register_view(GmailCallbackView(hass))
