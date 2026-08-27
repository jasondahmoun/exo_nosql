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

## Q5 — Distribution après nettoyage des orphelins

`orphanCleanupDelaySecs = 900`. Migration commitée à 13:48:08 UTC, nettoyage effectif à 14:03:08.
Relevé à 14:06:16 :

```js
Shard shardA at shardA/shardA:27017
{ data: '2.15MiB', docs: 20228, chunks: 4, 'estimated docs per chunk': 5057 }
---
Shard shardB at shardB/shardB:27017
{ data: '1006KiB', docs: 9242, chunks: 2, 'estimated docs per chunk': 4621 }
---
Totals
{
  data: '3.13MiB',
  docs: 29470,
  chunks: 6,
  'Shard shardA': [ '68.64 % data', '68.63 % docs in cluster', '111B avg obj size on shard' ],
  'Shard shardB': [ '31.35 % data', '31.36 % docs in cluster', '111B avg obj size on shard' ]
}
```

| | docs avant | docs après | % docs avant | % docs après |
|---|---|---|---|---|
| shardA | 29 470 | **20 228** | 76,12 % | **68,63 %** |
| shardB | 9 242 | 9 242 | 23,87 % | **31,36 %** |
| **total** | **38 712** | **29 470** | | |

Le total tombe enfin sur les 29 470 documents importés, et le % de documents rejoint le % de données.
Les 20 228 de shardA correspondent exactement à la somme de ses 4 chunks (2 602 + 6 255 + 6 422 + 4 949).

| Commande | Avant nettoyage | Après nettoyage |
|---|---|---|
| `countDocuments({})` | 29 470 | 29 470 |
| `estimatedDocumentCount()` | 38 712 | 29 470 |
| Écart | **9 242** | **0** |

## Q8 — Distribution de `census.zips_hashed` (clé `{ _id: "hashed" }`)

```js
sh.shardCollection("census.zips_hashed", { _id: "hashed" })
```

```bash
docker exec mongos mongoimport --db census --collection zips_hashed --file /tmp/zips.json
```

```js
Shard shardA at shardA/shardA:27017
{ data: '1.54MiB', docs: 14517, chunks: 2, 'estimated docs per chunk': 7258 }
---
Shard shardB at shardB/shardB:27017
{ data: '1.58MiB', docs: 14953, chunks: 2, 'estimated docs per chunk': 7476 }
---
Totals
{
  data: '3.13MiB',
  docs: 29470,
  chunks: 4,
  'Shard shardA': [ '49.26 % data', '49.26 % docs in cluster', '111B avg obj size on shard' ],
  'Shard shardB': [ '50.73 % data', '50.73 % docs in cluster', '111B avg obj size on shard' ]
}
```

| | chunks | docs | % docs |
|---|---|---|---|
| shardA | 2 | 14 517 | **49,26 %** |
| shardB | 2 | 14 953 | **50,73 %** |
| **total** | **4** | **29 470** | |

**4 chunks sans aucun `splitAt` manuel**, écart de **1,5 point**. Aucun orphelin : `countDocuments` et `estimatedDocumentCount` donnent tous deux **29 470** — aucune migration n'a eu lieu, donc aucune copie résiduelle.

### Frontières de chunks — clé hachée

```
shardB [MinKey                -> -4611686018427387902]
shardB [-4611686018427387902  -> 0]
shardA [0                     -> 4611686018427387902]
shardA [4611686018427387902   -> MaxKey]
```

L'espace des hachés 64 bits est coupé en **quatre quarts égaux**, deux par shard, **avant l'import** (*pre-splitting*). Bornes numériques régulières, aucune valeur métier.

### Comparaison des deux clés

| | `{ state: 1 }` | `{ _id: "hashed" }` |
|---|---|---|
| Chunks obtenus | 2, puis 6 après 4 `splitAt` manuels | **4, automatiquement** |
| Frontières | valeurs d'États (`KY`, `FL`, `MI`, `NY`, `TX`) | quarts de l'espace de hachage |
| Distribution | 68,63 % / 31,36 % | **49,26 % / 50,73 %** |
| Écart | **37,3 points** *(76,12 / 23,87 avant nettoyage)* | **1,5 point** |
| Migrations | 1, puis plus rien malgré le déséquilibre | **aucune** |
| Orphelins | 9 242 pendant 15 min | **0** |
| Cardinalité | 51 | 29 470 |
| Plafond de chunks | ~51 | aucun |

## Q6 / Q9 — Les trois `explain()` : targeted vs broadcast

### 1. `census.zips` — filtre sur la shard key

```js
db.zips.find({ state: "NY" }).explain("executionStats")
```

| Métrique | Valeur |
|---|---|
| `stage` racine de `winningPlan` | **`SINGLE_SHARD`** |
| `winningPlan.shards` | **`["shardA"]`** |
| Plan par shard | `FETCH` / `IXSCAN` |
| `nReturned` | 1 596 |
| `totalKeysExamined` | 1 596 |
| `totalDocsExamined` | **1 596** |
| `executionTimeMillis` | 4 |
| **Ratio `docsExamined / nReturned`** | **1,0** |

→ **TARGETED.** 1 shard sur 2.

### 2. `census.zips` — filtre sur un autre champ

```js
db.zips.find({ city: "NEW YORK" }).explain("executionStats")
```

| Métrique | Valeur |
|---|---|
| `stage` racine de `winningPlan` | **`SHARD_MERGE`** |
| `winningPlan.shards` | **`["shardB","shardA"]`** |
| Plan par shard | `SHARDING_FILTER` / `COLLSCAN` ×2 |
| `nReturned` | 40 |
| `totalKeysExamined` | **0** |
| `totalDocsExamined` | **29 470** |
| `executionTimeMillis` | 31 |
| **Ratio `docsExamined / nReturned`** | **736,75** |

→ **BROADCAST** (scatter-gather). 2 shards sur 2, `COLLSCAN` sur chacun.

### 3. `census.zips_hashed` — même requête métier que la n°1

```js
db.zips_hashed.find({ state: "NY" }).explain("executionStats")
```

| Métrique | Valeur |
|---|---|
| `stage` racine de `winningPlan` | **`SHARD_MERGE`** |
| `winningPlan.shards` | **`["shardB","shardA"]`** |
| Plan par shard | `SHARDING_FILTER` / `COLLSCAN` ×2 |
| `nReturned` | 1 596 |
| `totalDocsExamined` | **29 470** |
| `executionTimeMillis` | 3 |
| **Ratio `docsExamined / nReturned`** | **18,5** |

→ **BROADCAST.** La collection la mieux répartie répond le plus mal à la requête métier.

### Synthèse

| | `zips` / `state:"NY"` | `zips` / `city:"NEW YORK"` | `zips_hashed` / `state:"NY"` |
|---|---|---|---|
| Stage racine | `SINGLE_SHARD` | `SHARD_MERGE` | `SHARD_MERGE` |
| Shards | 1 / 2 | 2 / 2 | 2 / 2 |
| Accès | `IXSCAN` | `COLLSCAN` ×2 | `COLLSCAN` ×2 |
| `totalDocsExamined` | 1 596 | 29 470 | 29 470 |
| Ratio | **1,0** | **736,75** | **18,5** |

Extrapolation de la requête broadcast à **20 shards / 500 M de documents** : **20 machines mobilisées**, **500 000 000 de documents lus** pour ~679 000 rendus. Le ratio de 736,75 est invariant — il ne dépend pas du volume mais de la clé.

## Q9(b) — Tableau de décision

Cardinalités mesurées sur 29 470 documents :

```js
db.zips.distinct("state").length
db.zips.distinct("zip").length
db.zips.aggregate([{$group:{_id:{s:"$state",z:"$zip"}}},{$count:"c"}])
```

| Shard key candidate | Cardinalité | Distribution mesurée | Requêtes métier ciblées ? | Verdict |
|---|---|---|---|---|
| `{ state: 1 }` | **51** | 68,63 / 31,36 — 6 chunks, plafond ~51, jumbo chunks garantis | **Oui** — `SINGLE_SHARD`, ratio 1,0 | ❌ **Rejetée.** Cardinalité trop faible : plafond dur sur le nombre de chunks, le cluster cesse de scaler. |
| `{ _id: "hashed" }` | **29 470** — unique | 49,26 / 50,73 — 4 chunks pre-splittés, 0 orphelin | **Non** — `SHARD_MERGE`, ratio 18,5 | ⚠️ **Par défaut.** Répartition irréprochable, mais toute requête sur `state` devient broadcast. |
| `{ zip: 1 }` | **29 467** — *non unique* (3 doublons) | Excellente en théorie | **Non** — aucune requête ne filtre sur `zip` seul | ⚠️ **Bonne clé technique, inutile ici.** Disperse autant que le hachage sans mieux cibler. |
| `{ state: 1, zip: 1 }` | **29 470** — unique | Bonne : préfixe `state` contigu, `zip` rend chaque État découpable | **Oui** — préfixe `state` → `SINGLE_SHARD` | ✅ **Retenue.** `state` donne le ciblage, `zip` la granularité. Les 3 doublons de `zip` sont levés par le couple. |
