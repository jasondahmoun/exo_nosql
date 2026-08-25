# TP Jour 2 — MFlix

23 539 films et 50 304 commentaires (`sample_mflix`), base `mflix`.

## Lancer

```bash
docker compose up -d

curl -L -o movies.json   https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/movies.json
curl -L -o comments.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/comments.json

docker cp movies.json   mongo-ipssi:/tmp/movies.json
docker cp comments.json mongo-ipssi:/tmp/comments.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection movies   --drop --file /tmp/movies.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection comments --drop --file /tmp/comments.json
```

Partie 3 :
```bash
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin --quiet mflix < analyses.js
```

Partie 4 :
```bash
python3 -m venv .venv && ./.venv/bin/pip install "pymongo>=4.6"
./.venv/bin/python patterns.py
```

Partie 5 — replica set obligatoire pour les transactions :
```bash
docker run -d --name mongo-rs -p 27018:27017 mongo:7.0 --replSet rs0
docker exec mongo-rs mongosh --port 27017 --eval "rs.initiate()"
docker cp movies.json   mongo-rs:/tmp/movies.json
docker cp comments.json mongo-rs:/tmp/comments.json
docker exec mongo-rs mongoimport --db mflix --collection movies   --drop --file /tmp/movies.json
docker exec mongo-rs mongoimport --db mflix --collection comments --drop --file /tmp/comments.json
docker exec -i mongo-rs mongosh --port 27017 --quiet mflix < transaction.js
```

Les parties 2, 4 et 5 modifient la base. Pour repartir propre : relancer `mongoimport --drop`.

## Livrables

| Fichier | |
|---|---|
| `reponses_jour2.md` | Q1→Q19 + R1→R4 + bonus B1→B3 |
| `analyses.js` | agrégations de la Partie 3 |
| `patterns.py` | PyMongo — Computed + Subset Pattern |
| `transaction.js` | transaction ACID de la Partie 5 |
| `index_bench.md` | tableau `explain()` avant/après index |

## Chiffres clés

| | |
|---|---|
| Films / commentaires / genres (Q1) | 23 539 / 50 304 / 25 |
| **Commentaires orphelins (Q2)** | **9 224 — 18,34 %** |
| `movie_id` distincts (Q3) | 14 245, dont **7 449 réels** |
| Compteur Pelham : affiché vs réel (Q4) | 437 vs **161** — +171,43 % |
| `year` en chaîne (Q5) | 37 |
| `imdb.rating: ""` (Q6) | 61 |
| Film-Noir : docs examinés avant/après index (Q7) | 23 539 → **105** |
| Drama depuis 2000 (Q8) | 7 761 |
| `/Godfather/` vs `$text` (Q9) | 5 vs **12** |
| Top genre (Q11) | Drama — 13 789 |
| Note moyenne Drama (Q13) | **6,8305** sur 13 751 films |
| Top réalisateur (Q14) | Woody Allen — 40 |
| Film le plus commenté (Q15) | Pelham 1 2 3 — 161 |
| **Compteurs faux (Q16)** | **12 244 / 15 740 — 77,79 %** |
| Corrigés par `bulk_write` (Q17) | 20 043 |
| ESR bon vs mauvais ordre (R3) | 8 ms vs 21 ms — **`SORT` vs pas de `SORT`** |
