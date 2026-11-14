"""`python -m mcp_server` runs the read-only stdio MCP server.

`python -m mcp_server --http [--host H] [--port P]` runs the remote (streamable HTTP)
transport, an OAuth resource server for any MCP harness (mcp_server.http)."""

import argparse

from mcp_server.server import main

if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m mcp_server")
    parser.add_argument(
        "--http", action="store_true", help="serve streamable HTTP instead of stdio"
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args()
    if args.http:
        from mcp_server.http import main as http_main

        http_main(args.host, args.port)
    else:
        main()
