"""A small client for Larder's REST API (see docs/openapi.json in the Larder repo).

Everything the integration does goes through here, so it works the same
whether Larder runs as an add-on or anywhere else on the network.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
import json
from typing import Any

import aiohttp


class LarderError(Exception):
    """Larder answered with an error, or couldn't be reached."""

    def __init__(self, message: str, status: int | None = None, code: str | None = None, candidates: list[str] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.candidates = candidates or []


class LarderConnectionError(LarderError):
    """Larder couldn't be reached."""


class LarderAuthError(LarderError):
    """The token was refused."""


class LarderClient:
    """Talks to one Larder over HTTP with an access token."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        self.session = session
        self.url = url.rstrip("/")
        self.token = token

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}

    async def _request(self, method: str, path: str, body: Any = None, timeout: float = 30) -> Any:
        try:
            async with self.session.request(
                method,
                f"{self.url}/api{path}",
                json=body,
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                text = await resp.text()
                data: Any = json.loads(text) if text else None
                if resp.status in (401, 403):
                    raise LarderAuthError(_message(data, "Larder refused the access token."), resp.status, _field(data, "error"))
                if resp.status >= 400:
                    raise LarderError(_message(data, f"Larder answered {resp.status}."), resp.status, _field(data, "error"), _candidates(data))
                return data
        except (aiohttp.ClientError, TimeoutError) as err:
            raise LarderConnectionError(f"Can't reach Larder at {self.url}: {err}") from err
        except ValueError as err:
            raise LarderConnectionError(f"{self.url} didn't answer like Larder does.") from err

    async def status(self) -> dict[str, Any]:
        """Who the token belongs to, plus the Larder version and instance id."""
        data = await self._request("GET", "/v1/auth/status")
        if not data or not data.get("user"):
            raise LarderAuthError("Larder didn't accept the access token.")
        return data

    async def manifest(self) -> dict[str, Any]:
        """The sensors and actions Larder offers."""
        return await self._request("GET", "/v1/automation")

    async def state(self) -> dict[str, Any]:
        """Every sensor's current reading."""
        return (await self._request("GET", "/v1/automation/state"))["sensors"]

    async def run_action(self, action: str, data: dict[str, Any]) -> dict[str, Any]:
        """Run one of Larder's actions."""
        return await self._request("POST", f"/v1/automation/actions/{action}", data)

    async def modules(self) -> list[dict[str, Any]]:
        """Larder's modules and whether each is switched on."""
        return await self._request("GET", "/v1/modules")

    async def nfc_scanned(self, tag_id: str, device: str | None) -> dict[str, Any]:
        """Tell Larder a tag was scanned."""
        return await self._request("POST", "/v1/nfc/scanned", {"tagId": tag_id, "device": device})

    async def battery_devices(self) -> list[dict[str, Any]]:
        """The devices with batteries Larder knows about."""
        return await self._request("GET", "/v1/modules/batteries/devices")

    async def sync_battery_devices(self, devices: list[dict[str, Any]]) -> None:
        """Replace Larder's list of devices with batteries."""
        await self._request("PUT", "/v1/modules/batteries/devices", {"devices": devices})

    async def battery_low(self, device_id: str, level: float | None) -> dict[str, Any]:
        """A device's battery is low; Larder answers with what to do."""
        return await self._request("POST", "/v1/modules/batteries/low", {"deviceId": device_id, "level": level})

    async def events(self, on_open: Callable[[], Awaitable[None]] | None = None) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        """Larder's live events (Server-Sent Events). Ends when the connection drops. on_open runs once connected."""
        try:
            async with self.session.get(
                f"{self.url}/api/v1/events",
                headers={**self._headers, "Accept": "text/event-stream"},
                # Larder sends a ping every 25 seconds, so a minute of silence means the link is gone.
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=70),
            ) as resp:
                if resp.status in (401, 403):
                    raise LarderAuthError("Larder refused the access token.", resp.status)
                if resp.status >= 400:
                    raise LarderError(f"Larder answered {resp.status} for live events.", resp.status)
                if on_open:
                    await on_open()
                event, data = "", ""
                async for raw in resp.content:
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if not line:
                        if event and data:
                            try:
                                payload = json.loads(data)
                            except ValueError:
                                payload = {}
                            yield event, payload.get("data", {}) if isinstance(payload, dict) else {}
                        event, data = "", ""
                    elif line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        data += line[5:].strip()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise LarderConnectionError(f"Lost the live connection to Larder: {err}") from err


def _field(data: Any, key: str) -> Any:
    return data.get(key) if isinstance(data, dict) else None


def _message(data: Any, fallback: str) -> str:
    return _field(data, "message") or fallback


def _candidates(data: Any) -> list[str]:
    value = _field(data, "candidates")
    return [str(v) for v in value] if isinstance(value, list) else []
