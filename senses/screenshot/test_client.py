"""端到端测试：用官方 MCP client 起 server.py，调用 screenshot 并验证图片。"""
import asyncio
import base64
import os

import mcp

HERE = os.path.dirname(os.path.abspath(__file__))


async def main() -> None:
    params = mcp.StdioServerParameters(
        command=r"D:\Program-Files\Python\312\python.exe",
        args=[os.path.join(HERE, "server.py")],
        cwd=HERE,
        env={"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
    )
    async with mcp.stdio_client(params) as (read, write):
        async with mcp.ClientSession(read, write) as session:
            init = await session.initialize()
            print("server:", init.server_info.name, init.server_info.version)
            tools = await session.list_tools()
            print("tools:", [t.name for t in tools.tools])

            res = await session.call_tool("screenshot", {"region": "0,0,640,360", "fmt": "jpg", "quality": 95})
            print("isError:", res.is_error, "blocks:", len(res.content))
            for c in res.content:
                print("  block:", c.type, getattr(c, "mime_type", None), len(getattr(c, "data", "") or ""))
                if c.type == "image":
                    raw = base64.b64decode(c.data)
                    out = os.path.join(HERE, "mcp_test.jpg")
                    with open(out, "wb") as f:
                        f.write(raw)
                    print("  saved:", out, len(raw), "bytes")
                    print("  magic:", raw[:4].hex())


asyncio.run(main())
