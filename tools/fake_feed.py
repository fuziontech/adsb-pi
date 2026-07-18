#!/usr/bin/env python3
"""Generate a fake readsb-style aircraft.json for demos without an SDR.

Usage:
    python3 tools/fake_feed.py --out /tmp/aircraft.json --lat 37.62 --lon -122.38
"""

import argparse
import json
import math
import random
import time
from pathlib import Path

AIRLINES = ["UAL", "AAL", "DAL", "SWA", "JBU", "ASA", "FDX", "UPS",
            "BAW", "DLH", "VIR", "NKS", "FFT", "QFA"]


def nm_to_lat(nm):
    return nm / 60.0


def nm_to_lon(nm, lat):
    return nm / (60.0 * math.cos(math.radians(lat)))


class FakeAircraft:
    def __init__(self, clat, clon):
        self.hex = f"{random.getrandbits(24):06x}"
        self.flight = random.choice(AIRLINES) + str(random.randint(10, 4999))
        brg = math.radians(random.uniform(0, 360))
        dist = random.uniform(5, 180)
        self.lat = clat + nm_to_lat(dist) * math.cos(brg)
        self.lon = clon + nm_to_lon(dist, clat) * math.sin(brg)
        self.track = random.uniform(0, 360)
        self.gs = random.uniform(120, 500)
        self.alt = random.choice([3000, 5000, 8000, 11000, 18000, 24000,
                                  31000, 35000, 41000])
        self.vs = random.choice([-2000, -1500, -1000, 0, 0, 1000, 1500, 2000])
        self.squawk = "".join(str(random.randint(0, 7)) for _ in range(4))
        self.rssi = random.uniform(-30, -5)

    def step(self, dt):
        h = math.radians(self.track)
        self.lat += nm_to_lat(self.gs * dt / 3600) * math.cos(h)
        self.lon += nm_to_lon(self.gs * dt / 3600, self.lat) * math.sin(h)
        self.alt = max(0, self.alt + self.vs * dt / 60)
        if random.random() < 0.002:
            self.track = (self.track + random.choice([-45, -30, 30, 45])) % 360

    def to_json(self):
        return {
            "hex": self.hex,
            "flight": self.flight.ljust(8),
            "lat": round(self.lat, 5),
            "lon": round(self.lon, 5),
            "alt_baro": int(self.alt),
            "gs": round(self.gs, 1),
            "track": round(self.track, 1),
            "baro_rate": self.vs,
            "squawk": self.squawk,
            "emergency": "none",
            "category": "A3",
            "type": "adsb_icao",
            "rssi": self.rssi,
            "seen": random.uniform(0, 2),
            "seen_pos": random.uniform(0, 2),
            "messages": random.randint(50, 2000),
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/aircraft.json")
    ap.add_argument("--lat", type=float, default=37.6213)
    ap.add_argument("--lon", type=float, default=-122.3790)
    ap.add_argument("--count", type=int, default=18)
    ap.add_argument("--interval", type=float, default=1.0)
    args = ap.parse_args()

    out = Path(args.out)
    fakes = [FakeAircraft(args.lat, args.lon) for _ in range(args.count)]
    total_msgs = 0
    print(f"writing {args.count} fake aircraft to {out} every {args.interval}s")
    while True:
        for f in fakes:
            f.step(args.interval)
        total_msgs += random.randint(80, 400)
        doc = {
            "now": time.time(),
            "messages": total_msgs,
            "aircraft": [f.to_json() for f in fakes],
        }
        tmp = out.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc))
        tmp.replace(out)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
