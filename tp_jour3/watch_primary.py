import sys
import time
from datetime import datetime

from pymongo import MongoClient

PORTS = {"mongo1": 27017, "mongo2": 27018, "mongo3": 27019}

noeud = sys.argv[1] if len(sys.argv) > 1 else "mongo2"
duree = int(sys.argv[2]) if len(sys.argv) > 2 else 120
port = PORTS[noeud]

client = MongoClient(f"mongodb://localhost:{port}/?directConnection=true",
                     serverSelectionTimeoutMS=800)
t0 = time.time()
courant = None

print(f"observation via {noeud} (localhost:{port}) pendant {duree}s", flush=True)

while time.time() - t0 < duree:
    try:
        h = client.admin.command("hello")
        primary = h.get("primary", "AUCUN")
    except Exception as e:
        primary = f"INJOIGNABLE({type(e).__name__})"

    if primary != courant:
        dt = time.time() - t0
        horo = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        print(f"[{dt:7.2f}s] {horo}  primary = {primary}", flush=True)
        courant = primary

    time.sleep(0.3)
