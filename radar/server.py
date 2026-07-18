#!/usr/bin/env python3
"""ADSB-PI radar server.

Serves the radar web UI and a small JSON API fed by readsb's aircraft.json.
Python standard library only -- no pip install needed.
"""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

CONFIG_PATHS = [
    Path("/etc/adsb-pi/config.json"),
    Path.home() / ".config" / "adsb-pi" / "config.json",
]

DEFAULT_CONFIG = {
    "lat": None,
    "lon": None,
    "range_nm": 100,
    "site_name": "ADSB-PI",
}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

AIRCRAFT_FIELDS = {
    "hex", "flight", "lat", "lon", "alt_baro", "alt_geom", "gs", "track",
    "baro_rate", "geom_rate", "squawk", "emergency", "category", "type",
    "rssi", "seen", "seen_pos", "messages", "true_heading", "ias", "tas",
    "mach", "nac_p", "nic", "sil",
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    for path in CONFIG_PATHS:
        try:
            if path.is_file():
                data = json.loads(path.read_text())
                cfg.update({k: v for k, v in data.items() if k in cfg})
        except Exception:
            pass
    return cfg


def save_config(cfg):
    for path in reversed(CONFIG_PATHS):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(cfg, indent=2) + "\n")
            return
        except Exception:
            pass


class State:
    def __init__(self, data_path, overrides):
        self.data_path = Path(data_path)
        self.lock = threading.Lock()
        self.config = load_config()
        for key, value in overrides.items():
            if value is not None:
                self.config[key] = value

    def get_config(self):
        with self.lock:
            return dict(self.config)

    def update_config(self, updates):
        with self.lock:
            for key in DEFAULT_CONFIG:
                if key in updates:
                    self.config[key] = updates[key]
            save_config(self.config)
            return dict(self.config)

    def read_aircraft(self):
        data = None
        for _ in range(2):
            try:
                data = json.loads(self.data_path.read_text())
                break
            except FileNotFoundError:
                return None
            except (OSError, json.JSONDecodeError):
                time.sleep(0.05)
        if data is None:
            return None
        aircraft = [
            {k: v for k, v in ac.items() if k in AIRCRAFT_FIELDS}
            for ac in data.get("aircraft", [])
        ]
        return {
            "now": data.get("now", time.time()),
            "messages": data.get("messages", 0),
            "aircraft": aircraft,
        }


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        server_version = "adsb-pi/1.0"

        def log_message(self, fmt, *args):
            pass

        def _send_json(self, obj, status=200):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_file(self, path):
            try:
                body = path.read_bytes()
            except OSError:
                self.send_error(404)
                return
            ctype = CONTENT_TYPES.get(path.suffix, "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                return self._send_file(STATIC_DIR / "index.html")
            if path == "/api/aircraft":
                data = state.read_aircraft()
                cfg = state.get_config()
                if data is None:
                    return self._send_json({
                        "ok": False, "error": "decoder offline",
                        "receiver": cfg, "aircraft": [],
                    })
                data["ok"] = True
                data["receiver"] = cfg
                return self._send_json(data)
            if path == "/api/config":
                return self._send_json(state.get_config())
            if path.startswith("/static/"):
                target = (STATIC_DIR / path[len("/static/"):]).resolve()
                if STATIC_DIR in target.parents and target.is_file():
                    return self._send_file(target)
                return self.send_error(404)
            self.send_error(404)

        def do_POST(self):
            path = urlparse(self.path).path
            if path != "/api/config":
                return self.send_error(404)
            try:
                length = int(self.headers.get("Content-Length", 0))
                updates = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self._send_json({"ok": False, "error": "bad json"}, 400)
            clean = {}
            if "lat" in updates or "lon" in updates:
                try:
                    lat = float(updates.get("lat"))
                    lon = float(updates.get("lon"))
                    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                        raise ValueError
                    clean["lat"] = lat
                    clean["lon"] = lon
                except (TypeError, ValueError):
                    return self._send_json({"ok": False, "error": "bad lat/lon"}, 400)
            if "range_nm" in updates:
                try:
                    rng = float(updates["range_nm"])
                    clean["range_nm"] = min(max(rng, 5), 500)
                except (TypeError, ValueError):
                    pass
            if "site_name" in updates:
                name = str(updates["site_name"])[:24].strip()
                if name:
                    clean["site_name"] = name
            cfg = state.update_config(clean)
            return self._send_json({"ok": True, "config": cfg})

    return Handler


def main():
    ap = argparse.ArgumentParser(description="ADSB-PI radar server")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--data", default="/run/readsb/aircraft.json")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--range", type=float, dest="range_nm")
    ap.add_argument("--site-name")
    args = ap.parse_args()

    overrides = {
        "lat": args.lat,
        "lon": args.lon,
        "range_nm": args.range_nm,
        "site_name": args.site_name,
    }
    state = State(args.data, overrides)
    httpd = ThreadingHTTPServer((args.bind, args.port), make_handler(state))
    print(f"adsb-pi radar on http://{args.bind}:{args.port}  data={args.data}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
