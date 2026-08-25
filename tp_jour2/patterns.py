from pymongo import MongoClient, UpdateOne

client = MongoClient("mongodb://admin:ipssi2025@localhost:27017/?authSource=admin")
db = client["mflix"]


def vrais_compteurs():
    return {
        d["_id"]: d["n"]
        for d in db.comments.aggregate([{"$group": {"_id": "$movie_id", "n": {"$sum": 1}}}])
    }


def incoherences():
    reels = vrais_compteurs()
    avec_champ, sans_champ_mais_commente, faux = 0, 0, 0
    for f in db.movies.find({}, {"num_mflix_comments": 1}):
        reel = reels.get(f["_id"], 0)
        if "num_mflix_comments" in f:
            avec_champ += 1
            if f["num_mflix_comments"] != reel:
                faux += 1
        elif reel > 0:
            sans_champ_mais_commente += 1
    return avec_champ, faux, sans_champ_mais_commente


def corriger():
    reels = vrais_compteurs()
    ops = []
    for f in db.movies.find({}, {"num_mflix_comments": 1}):
        reel = reels.get(f["_id"], 0)
        if f.get("num_mflix_comments") != reel:
            ops.append(UpdateOne({"_id": f["_id"]}, {"$set": {"num_mflix_comments": reel}}))
    return db.movies.bulk_write(ops)


def subset(n_films=10, n_commentaires=3):
    top = list(db.comments.aggregate([
        {"$group": {"_id": "$movie_id", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}},
        {"$limit": n_films},
    ]))
    ops = []
    for t in top:
        recents = list(db.comments.find(
            {"movie_id": t["_id"]}, {"_id": 0, "name": 1, "text": 1, "date": 1}
        ).sort("date", -1).limit(n_commentaires))
        ops.append(UpdateOne({"_id": t["_id"]}, {"$set": {"recent_comments": recents}}))
    db.movies.bulk_write(ops)
    return [t["_id"] for t in top]


print("=== Q16 ===")
avec, faux, orphelins_de_champ = incoherences()
print(f"films portant num_mflix_comments : {avec}")
print(f"compteurs incoherents            : {faux}  ({faux / avec * 100:.2f} %)")
print(f"films sans le champ mais commentes : {orphelins_de_champ}")

print("\n=== Q17 ===")
res = corriger()
print(f"matchedCount  : {res.matched_count}")
print(f"modifiedCount : {res.modified_count}")
avec2, faux2, orph2 = incoherences()
print(f"re-verification Q16 : {faux2} incoherence(s) sur {avec2} films portant le champ")
print(f"films sans le champ mais commentes : {orph2}")

print("\n=== Q18 ===")
ids = subset()
f = db.movies.find_one({"_id": ids[0]}, {"title": 1, "num_mflix_comments": 1, "recent_comments": 1})
print(f"film verifie : {f['title']}  ({f['num_mflix_comments']} commentaires)")
print(f"recent_comments : {len(f['recent_comments'])} sous-documents")
for c in f["recent_comments"]:
    print(f"  - {c['date']}  {c['name']:22s} {c['text'][:52]}...")
print(f"cles conservees : {sorted(f['recent_comments'][0].keys())}")
print(f"films portant recent_comments : {db.movies.count_documents({'recent_comments': {'$exists': True}})}")
