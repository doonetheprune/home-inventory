"""Fixtures: a real Larder server (started once for the whole run) and Home Assistant.

The tests talk to the same Larder the add-on runs, so they check the real
API rather than a copy of it. Needs Node.js and `npm ci` in the repo.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from typing import Any
import urllib.request

import aiohttp
from homeassistant.core import HomeAssistant
import pytest
import pytest_socket

pytest_plugins = "pytest_homeassistant_custom_component"

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Load custom_components/larder from this repo."""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _post(url: str, body: Any, headers: dict[str, str] | None = None) -> Any:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", **(headers or {})}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read() or b"null"), resp.headers


class Larder:
    """A running Larder, plus an admin token for setting things up in tests."""

    def __init__(self, url: str, token: str) -> None:
        self.url = url
        self.token = token

    async def call(self, method: str, path: str, body: Any = None) -> Any:
        async with aiohttp.ClientSession() as session, session.request(
            method, f"{self.url}/api/v1{path}", json=body, headers={"authorization": f"Bearer {self.token}"}
        ) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise AssertionError(f"{method} {path} -> {resp.status}: {text}")
            return json.loads(text) if text else None

    async def new_token(self, name: str = "Home Assistant test") -> str:
        return (await self.call("POST", "/auth/tokens", {"name": name}))["token"]


@pytest.fixture(scope="session")
def larder_server() -> Iterator[Larder]:
    """Start Larder with in-memory storage, set up an admin and make a token."""
    # Home Assistant's test harness blocks sockets; these tests talk to a local Larder on purpose.
    pytest_socket.enable_socket()
    port = _free_port()
    env = {
        **os.environ,
        "LARDER_PORT": str(port),
        "LARDER_HOST": "127.0.0.1",
        "LARDER_STORAGE": "memory",
        "LARDER_AUTH": "local",
        "LARDER_WEB_DIR": "/nonexistent",
        "LARDER_LOG_LEVEL": "warn",
        "LARDER_MODULES_DISABLED": "lookup-openfoodfacts,lookup-openbeautyfacts,lookup-openproductsfacts",
    }
    proc = subprocess.Popen(
        ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/server/main.ts"],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"{url}/api/health", timeout=1):
                    break
            except OSError:
                if proc.poll() is not None:
                    raise RuntimeError(f"Larder exited: {proc.stdout.read().decode() if proc.stdout else ''}")
                time.sleep(0.2)
        else:
            raise RuntimeError("Larder didn't start")
        _body, headers = _post(f"{url}/api/v1/auth/setup", {"username": "admin", "password": "correct horse"})
        cookie = headers["set-cookie"].split(";")[0]
        token, _ = _post(f"{url}/api/v1/auth/tokens", {"name": "tests"}, {"cookie": cookie, "x-larder-client": "tests"})
        pytest_socket.disable_socket(allow_unix_socket=True)
        yield Larder(url, token["token"])
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        if proc.stdout:
            proc.stdout.close()


@pytest.fixture
async def larder(larder_server: Larder, socket_enabled: None) -> AsyncIterator[Larder]:
    """The running Larder, for a test (with local sockets allowed)."""
    pytest_socket.socket_allow_hosts(["127.0.0.1"])
    yield larder_server


@pytest.fixture
async def setup_larder(hass: HomeAssistant, larder: Larder):
    """Connect Home Assistant to Larder with a fresh token; returns the config entry."""
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    from custom_components.larder.const import CONF_TOKEN, CONF_URL, DOMAIN

    status = await larder.call("GET", "/auth/status")
    entry = MockConfigEntry(domain=DOMAIN, title="Larder", unique_id=status["instanceId"], data={CONF_URL: larder.url, CONF_TOKEN: await larder.new_token()})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    yield entry
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
