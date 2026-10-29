"""Larder's MCP server with a second client: the official Python MCP SDK.

(The TypeScript SDK client is in tests/api/mcp.test.ts.)
"""

from __future__ import annotations

import uuid

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .conftest import Larder


async def test_python_mcp_client(larder: Larder) -> None:
    """List tools, then add, look up and use stock by name."""
    name = f"Dog food {uuid.uuid4().hex[:6]}"
    await larder.call("POST", "/products", {"name": name, "unit": "tin", "minQuantity": 4})
    async with (
        httpx2.AsyncClient(headers={"Authorization": f"Bearer {larder.token}"}) as http,
        streamable_http_client(f"{larder.url}/mcp", http_client=http, terminate_on_close=False) as streams,
        ClientSession(streams[0], streams[1]) as session,
    ):
        init = await session.initialize()
        assert init.server_info.name == "larder"
        assert "Never guess" in (init.instructions or "")

        tools = {t.name: t for t in (await session.list_tools()).tools}
        assert {"search", "get_item", "add_stock", "use_stock", "shopping_list", "expiring"} <= set(tools)

        result = await session.call_tool("add_stock", {"item": name.lower(), "quantity": 6})
        assert not result.is_error
        assert result.content[0].text == f"{name}: added 6 tins. 6 tins in stock."

        result = await session.call_tool("use_stock", {"item": name, "quantity": 3})
        assert result.content[0].text == f"{name}: used 3 tins. 3 tins left, running low."

        result = await session.call_tool("get_item", {"item": name})
        assert "In stock: 3 tins." in result.content[0].text

        result = await session.call_tool("get_item", {"item": "no such thing at all"})
        assert result.is_error
