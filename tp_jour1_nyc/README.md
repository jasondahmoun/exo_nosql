# TP Jour 1 — NYC DOHMH

25 359 restaurants new-yorkais et leurs inspections d'hygiène.

## Lancer

```bash
docker compose up -d

curl -L -o primer-dataset.json https://raw.githubusercontent.com/mongodb/docs-assets/primer-dataset/primer-dataset.json
docker cp primer-dataset.json mongo-ipssi:/tmp/primer-dataset.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants --drop --file /tmp/primer-dataset.json

docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin --quiet nyc < rapport.js
```

Les parties 3 et 4 modifient la base. Pour repartir propre : relancer `mongoimport --drop`.

## Livrables

| Fichier | |
|---|---|
| `reponses_jour1.md` | Q1→Q28 + R1→R3 |
| `rapport.js` | script de la Partie 5 |
| `staten_island.json` | Q28 — 969 documents |
| `capture_express.png` | **à faire** — http://localhost:8081 → `nyc` → `restaurants` |

## Chiffres clés

| | |
|---|---|
| Total à l'import (Q1) | 25 359 |
| Cuisines distinctes (Q2) | 85 |
| Notes d'inspection | 93 463 |
| `risque: "eleve"` (Q22) | 349 |
| `borough: "Missing"` supprimés (Q25) | 51 |
| **Total final (Q27)** | **25 309** |
| Score max (Q19) | 131 — Murals On 54/Randolphs'S |
