import sys
import time
from datetime import datetime

from pymongo import MongoClient
from pymongo.errors import PyMongoError

uri = sys.argv[1]
duree = int(sys.argv[2]) if len(sys.argv) > 2 else 60
wc = sys.argv[3] if len(sys.argv) > 3 else None

kwargs = {"serverSelectionTimeoutMS": 5000}
client = MongoClient(uri, **kwargs)
col = client["census"]["heartbeat"]
if wc == "majority":
    from pymongo import WriteConcern
    col = col.with_options(write_concern=WriteConcern(w="majority"))

col.drop()

ok = 0
ko = 0
t0 = time.time()
i = 0

while time.time() - t0 < duree:
    i += 1
    horo = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    debut = time.time()
    try:
        primary = client.primary
    except Exception:
        primary = None
    try:
        col.insert_one({"n": i, "ts": datetime.now()})
        ok += 1
        etat = "OK"
        detail = ""
    except PyMongoError as e:
        ko += 1
        etat = "ECHEC"
        detail = f"{type(e).__name__}: {str(e)[:90]}"
    ms = (time.time() - debut) * 1000
    p = f"{primary[0]}:{primary[1]}" if primary else "AUCUN"
    print(f"{horo}  n={i:<4} primary={p:<16} {etat:<6} {ms:7.0f}ms  {detail}", flush=True)
    reste = 1.0 - (time.time() - debut)
    if reste > 0:
        time.sleep(reste)

print()
print(f"ecritures reussies (compteur script) : {ok}")
print(f"ecritures en echec                   : {ko}")
try:
    reel = col.count_documents({})
    print(f"documents reellement en base          : {reel}")
    print(f"ecart                                 : {ok - reel}")
except Exception as e:
    print(f"count impossible : {e}")
