#!/usr/bin/env python3
"""
Minimal local-only static file server for the PII Cleaner app.

- stdlib only (http.server)
- binds 127.0.0.1 ONLY (never 0.0.0.0), so nothing outside this machine can reach it
- sends Cache-Control: no-store on every response
- serves the directory this script lives in, regardless of current working directory
- usage: python3 serve.py [port]   (default port: 8080)
"""
import http.server
import os
import socketserver
import sys


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep default stderr logging behavior (local-only, never sent anywhere).
        super().log_message(fmt, *args)


def main():
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("Invalid port %r, using default 8080" % sys.argv[1], file=sys.stderr)
            port = 8080

    directory = os.path.dirname(os.path.abspath(__file__))
    os.chdir(directory)

    handler = lambda *args, **kwargs: NoStoreHandler(*args, directory=directory, **kwargs)

    host = "127.0.0.1"
    with socketserver.TCPServer((host, port), handler) as httpd:
        print("PII Cleaner serving at http://%s:%d/ (local only, no network access)" % (host, port))
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server.")


if __name__ == "__main__":
    main()
