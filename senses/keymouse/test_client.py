"""端到端：用官方 MCP client 起 server.py，调 input_info / move。"""
import asyncio
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
            print("server:", init.server_info.name)
            tools = await session.list_tools()
            print("tools:", [t.name for t in tools.tools])

            for name, args in [("input_info", {}), ("move", {"x": 60, "y": 60})]:
                res = await session.call_tool(name, args)
                print(name, "isError:", res.is_error)
                for c in res.content:
                    print("  ", c.type, (getattr(c, "text", "") or "")[:120])


asyncio.run(main())
