"""A tiny MCP server, started as a subprocess by the MCP client tests.

Real servers are npx packages that CI should not download, so the client is
exercised against this instead: a couple of tools, one of which fails on
purpose.
"""

from mcp.server.mcpserver import MCPServer

server = MCPServer("thursday-test")


@server.tool()
def echo(text: str, times: int = 1) -> str:
    """Repeat some text.

    Args:
        text: What to repeat.
        times: How many times.
    """
    return " ".join([text] * max(1, times))


@server.tool()
def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


@server.tool()
def explode() -> str:
    """Always fails, so the client's error path can be tested."""
    raise ValueError("the server is on fire")


if __name__ == "__main__":
    server.run()
