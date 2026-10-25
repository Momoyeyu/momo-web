"""Owned desktop sidecar. No fixed port, no shared data, no runtime downloads."""
import argparse
import asyncio
import json
import os
import socket
import sys
import threading
import signal


def force_owned_group_exit():
    """Only a dedicated Unix process group may be reclaimed by the backend."""
    if os.name != "nt" and hasattr(os, "killpg") and os.getpgrp() == os.getpid():
        os.killpg(os.getpid(), signal.SIGKILL)



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--resources-dir", required=True)
    parser.add_argument("--port", type=int, default=0, choices=[0])
    args = parser.parse_args()
    if len(os.environ.get("MOMO_DESKTOP_TOKEN", "")) < 32 or not os.environ.get("MOMO_DESKTOP_NONCE"):
        parser.error("Desktop token and nonce are required")
    os.environ["MOMO_DATA_DIR"] = os.path.abspath(args.data_dir)
    os.environ["MOMO_RESOURCES_DIR"] = os.path.abspath(args.resources_dir)
    import uvicorn
    from app.main import app
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False, timeout_graceful_shutdown=5))
    finished = threading.Event()
    def parent_watch():
        while sys.stdin.buffer.read(1):
            pass
        server.should_exit = True
        if not finished.wait(8):
            force_owned_group_exit()
    threading.Thread(target=parent_watch, daemon=True).start()
    async def run():
        task = asyncio.create_task(server.serve(sockets=[sock]))
        while not server.started and not task.done():
            await asyncio.sleep(.01)
        if server.started:
            print(json.dumps({"type": "momo-ready", "nonce": os.environ["MOMO_DESKTOP_NONCE"], "pid": os.getpid(), "port": sock.getsockname()[1]}), flush=True)
        await task
        if not server.started:
            raise SystemExit(1)
    try:
        asyncio.run(run())
    finally:
        finished.set()


if __name__ == "__main__":
    main()
