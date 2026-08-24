# exo_nosql

IPSSI · Mastère Dév, Data & IA — Module MIA4 · Conception et intégration d'un SGBD NoSQL

TP Jour 1 — NYC DOHMH : 25 359 restaurants new-yorkais et leurs inspections d'hygiène.

État : **Parties 0 et 1**.

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

## Réponses

`tp_jour1_nyc/reponses_jour1.md`

| | |
|---|---|
| Total à l'import (Q1) | 25 359 |
| Cuisines distinctes (Q2) | 85 |
| Brooklyn (Q3) | 6 086 |
| Manhattan + Italian (Q5) | 621 |
| `/BBQ/` vs `/BBQ/i` (Q9) | 0 vs 73 |
| `restaurant_id` 30075445 (Q11) | Morris Park Bake Shop |
