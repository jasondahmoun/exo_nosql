# bench_shard.md — mesures du cluster shardé

Cluster : `cfg1` (config) + `shardA` + `shardB` + `mongos`. Chunk size réduit à **1 Mo**.
Collection : `census.zips`, **29 470 documents** importés, shard key `{ state: 1 }`.

## Q2 — Distribution après `shardCollection`, sans intervention

```bash
docker exec mongos mongosh --quiet census --eval 'db.zips.getShardDistribution()'
```

```js
Shard shardA at shardA/shardA:27017
{
  data: '2.15MiB',
  docs: 29470,
  chunks: 1,
  'estimated data per chunk': '2.15MiB',
  'estimated docs per chunk': 29470
}
---
Shard shardB at shardB/shardB:27017
{
  data: '1006KiB',
  docs: 9242,
  chunks: 1,
  'estimated data per chunk': '1006KiB',
  'estimated docs per chunk': 9242
}
---
Totals
{
  data: '3.13MiB',
  docs: 38712,
  chunks: 2,
  'Shard shardA': [ '68.68 % data', '76.12 % docs in cluster', '111B avg obj size on shard' ],
  'Shard shardB': [ '31.31 % data', '23.87 % docs in cluster', '111B avg obj size on shard' ]
}
```

| | chunks | docs affichés | % docs | % data |
|---|---|---|---|---|
| shardA | 1 | 29 470 | 76,12 % | 68,68 % |
| shardB | 1 | 9 242 | 23,87 % | 31,31 % |
| **total** | **2** | **38 712** | | |

Total affiché 38 712 pour 29 470 documents importés → **9 242 documents fantômes**, soit exactement le contenu de shardB. Orphelins laissés par la migration.

## Q3 — Frontières de chunks (2 chunks)

```
shardA [KY -> MaxKey]
shardB [MinKey -> KY]
```

Sortie brute, sans la fonction d'affichage :

```js
{ shard: 'shardA', min: { state: 'KY' },     max: { state: MaxKey() } }
{ shard: 'shardB', min: { state: MinKey() }, max: { state: 'KY' } }
```

Coupure sur **`KY`**. Intervalles semi-ouverts `[min, max)` couvrant tout l'espace des valeurs.

## Q4 — Distribution après 4 `splitAt` forcés

```js
["FL","MI","NY","TX"].forEach(s => sh.splitAt("census.zips", { state: s }))
```

```js
Shard shardA at shardA/shardA:27017
{
  data: '2.15MiB',
  docs: 29470,
  chunks: 4,
  'estimated data per chunk': '551KiB',
  'estimated docs per chunk': 7367
}
---
Shard shardB at shardB/shardB:27017
{
  data: '1006KiB',
  docs: 9242,
  chunks: 2,
  'estimated data per chunk': '503KiB',
  'estimated docs per chunk': 4621
}
---
Totals
{
  data: '3.13MiB',
  docs: 38712,
  chunks: 6,
  'Shard shardA': [ '68.68 % data', '76.12 % docs in cluster', '111B avg obj size on shard' ],
  'Shard shardB': [ '31.31 % data', '23.87 % docs in cluster', '111B avg obj size on shard' ]
}
```

Frontières après découpage :

```
shardB [MinKey -> FL]
shardB [FL -> KY]
shardA [KY -> MI]
shardA [MI -> NY]
shardA [NY -> TX]
shardA [TX -> MaxKey]
```

### Avant / après

| | chunks avant | chunks après | % docs avant | % docs après | écart |
|---|---|---|---|---|---|
| shardA | 1 | 4 | 76,12 % | 76,12 % | **0 point** |
| shardB | 1 | 2 | 23,87 % | 23,87 % | **0 point** |
| total | 2 | 6 | | | |

Vérifié après 3 minutes supplémentaires : `sh.isBalancerRunning()` → `false`, aucun `moveChunk` supplémentaire dans `config.changelog`.

### Poids réel de chaque chunk

```js
db.zips.countDocuments({ state: { $gte: "...", $lt: "..." } })
```

| Chunk | Shard | Documents |
|---|---|---|
| `[MinKey → FL]` | shardB | 3 890 |
| `[FL → KY]` | shardB | 5 352 |
| `[KY → MI]` | shardA | 2 602 |
| `[MI → NY]` | shardA | 6 255 |
| `[NY → TX]` | shardA | 6 422 |
| `[TX → MaxKey]` | shardA | 4 949 |
| | **total** | **29 470** |

Répartition réelle : shardA 20 228 (68,6 %) / shardB 9 242 (31,4 %). L'écart à combler (~5 500 documents) est du même ordre qu'un chunk entier : le balancer reste sous son seuil de déclenchement et ne migre rien.

### Top 5 des États par nombre de codes postaux

```js
db.zips.aggregate([{$group:{_id:"$state",n:{$sum:1}}},{$sort:{n:-1}},{$limit:5}])
```

| État | Codes postaux |
|---|---|
| TX | 1 676 |
| NY | 1 596 |
| CA | 1 523 |
| PA | 1 458 |
| IL | 1 240 |
