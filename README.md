# exo_nosql

IPSSI · Mastère Dév, Data & IA — Module MIA4 · Conception et intégration d'un SGBD NoSQL

TP Jour 1 — NYC DOHMH : 25 359 restaurants new-yorkais et leurs inspections d'hygiène.

État : **Parties 0 à 6**.

À partir de la Partie 3 la base est modifiée : les comptages divergent de la Partie 1. Pour repartir d'un état propre, relancer le `mongoimport --drop` ci-dessous.

## Lancer

```bash
docker compose up -d

curl -L -o primer-dataset.json https://raw.githubusercontent.com/mongodb/docs-assets/primer-dataset/primer-dataset.json
docker cp primer-dataset.json mongo-ipssi:/tmp/primer-dataset.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants --drop --file /tmp/primer-dataset.json

docker exec -it mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin nyc
```

Interface graphique : http://localhost:8081

## Livrables

| Fichier | |
|---|---|
| `tp_jour1_nyc/reponses_jour1.md` | Q1→Q28 + R1→R3 |
| `tp_jour1_nyc/rapport.js` | script de la Partie 5 |
| `tp_jour1_nyc/staten_island.json` | Q28 — 969 documents |

Rapport de la Partie 5 :

```bash
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin --quiet nyc < tp_jour1_nyc/rapport.js
```

| | |
|---|---|
| Total à l'import (Q1) | 25 359 |
| Cuisines distinctes (Q2) | 85 |
| Brooklyn (Q3) | 6 086 |
| Manhattan + Italian (Q5) | 621 |
| `/BBQ/` vs `/BBQ/i` (Q9) | 0 vs 73 |
| `restaurant_id` 30075445 (Q11) | Morris Park Bake Shop |
| Au moins un score > 50 (Q12) | 349 |
| Grade C historique vs actuel (Q13) | 2 708 vs 220 |
| Naïf vs `$elemMatch` (Q17) | 4 908 vs 4 280 |
| Score max du jeu (Q19) | 131 — Murals On 54/Randolphs'S |
| Après `insertOne` (Q20) | 25 360 |
| `risque: "eleve"` (Q22) | 349 |
| `label_qualite` sur les French (Q23) | 345 |
| `borough: "Missing"` supprimés (Q25) | 51 |
| Total après suppression (Q25) | 25 309 |
| `grades` vides conservés (Q26) | 737 — 2,91 % |
| Total final (Q27) | 25 309 — écart −50 vs Q1 |
| Export Staten Island (Q28) | 969 |
