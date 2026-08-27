# TP Jour 4 — Sharding appliqué, Performances & Diagnostic

MongoDB 7.0 · cluster shardé `shardlab` (cfg1, shardA, shardB, mongos) · base `census` · collection `zips`

Fichiers d'infra : `docker-compose.shard.yml`, `setup-shard.sh`.

## Partie A0 — Monter le cluster

Arrêt du Jour 3 d'abord, sinon les ports sont pris :

```bash
docker compose -f ../tp_jour3/docker-compose.rs-auth.yml down
```

```bash
chmod +x setup-shard.sh && ./setup-shard.sh
docker exec -it mongos mongosh --eval 'sh.status()'
```

```js
shards
[
  { _id: 'shardA', host: 'shardA/shardA:27017', state: 1 },
  { _id: 'shardB', host: 'shardB/shardB:27017', state: 1 }
]
active mongoses
[ { '7.0.30': 1 } ]
balancer
{ 'Currently enabled': 'yes', 'Currently running': 'no' }
```

### Q1 — Le rôle des 4 conteneurs

| Conteneur | Process | Port hôte | Rôle |
|---|---|---|---|
| `cfg1` | `mongod --configsvr --replSet cfgRS` | 27119 | **Config server**. Stocke les métadonnées du cluster : la liste des shards, la liste des collections shardées, et surtout **la carte des chunks**. |
| `shardA` | `mongod --shardsvr --replSet shardA` | 27120 | Shard de données. Détient une partie des documents de `census.zips`. |
| `shardB` | `mongod --shardsvr --replSet shardB` | 27121 | Shard de données, idem. |
| `mongos` | `mongos --configdb cfgRS/cfg1:27017` | 27122 | **Routeur**. Point d'entrée unique du client. Lit la carte chez `cfg1`, décide quel(s) shard(s) interroger, agrège les réponses. |

**Qui stocke la carte « tel intervalle de valeurs vit sur tel shard » ?** → `cfg1`, dans la base `config` :

```bash
docker exec cfg1 mongosh --quiet --eval 'printjson(db.getSiblingDB("config").getCollectionNames().filter(c => /chunk|collections|shards|databases/.test(c)))'
```

```js
[ 'shards', 'collections', 'databases', 'chunks' ]
```

C'est `config.chunks` qui contient une ligne par chunk avec son `min`, son `max` et son `shard`.

**Qui n'héberge aucune donnée ?** → `mongos`. Il est **stateless** : pas de `/data/db`, pas de fichier, rien à persister. Les bases qu'il affiche ne sont pas les siennes, ce sont des vues du cluster :

```bash
docker exec mongos mongosh --quiet --eval 'printjson(db.adminCommand({listDatabases:1}).databases.map(d => d.name))'
```

```js
[ 'admin', 'census', 'config' ]
```

`census` vit sur shardA/shardB, `config` vit sur cfg1. On peut détruire et recréer `mongos` sans perdre une seule donnée.

**Pourquoi passer les chunks de 128 Mo à 1 Mo est indispensable ici ?**

`zips.json` fait 5,7 Mo de JSON, soit **3,13 Mo une fois en BSON dans le cluster**. Avec la taille par défaut de 128 Mo, la collection entière tient dans **un seul chunk** : MongoDB n'aurait aucune raison de la découper, donc aucune raison de la répartir. On aurait un cluster shardé avec 100 % des documents sur un seul shard — impossible de mesurer quoi que ce soit sur la distribution, le balancer, ou `targeted` vs `broadcast`. En descendant à 1 Mo, 3,13 Mo de données donnent de quoi faire plusieurs chunks et le découpage devient observable.

**Pourquoi ce serait une très mauvaise idée en production ?**

Parce que le coût du sharding n'est pas dans les données, il est dans les **métadonnées et les migrations** :

- Chaque chunk = une entrée dans `config.chunks`. Sur un vrai volume (disons 5 To), 128 Mo donnent ~40 000 chunks ; 1 Mo en donnerait **5 millions**. La carte que `mongos` doit consulter et garder en cache explose, et chaque routage devient plus cher.
- Le balancer déplace les chunks **un par un**, et chaque migration a un coût fixe (verrous, commit auprès du config server, nettoyage des orphelins) largement supérieur au coût de copier 1 Mo. Multiplier le nombre de chunks par 128, c'est multiplier ce coût fixe par 128 pour la même quantité de données déplacée.
- Le cluster passerait son temps à migrer au lieu de servir les requêtes.

1 Mo est une valeur de laboratoire, faite pour rendre visible en 30 secondes un phénomène qui prendrait des heures en vrai.

## Partie A1 — Sharder sur `state`

Import du jeu de données par le routeur :

```bash
docker cp zips.json mongos:/tmp/zips.json
docker exec mongos mongoimport --db census --collection zips --drop --file /tmp/zips.json
```

```
29470 document(s) imported successfully. 0 document(s) failed to import.
```

Activation du sharding :

```js
sh.enableSharding("census")
use census
db.zips.createIndex({ state: 1 })
sh.shardCollection("census.zips", { state: 1 })
```

```js
{ collectionsharded: 'census.zips', ok: 1 }
```

### Q2 — Distribution initiale

```bash
docker exec mongos mongosh --quiet census --eval 'db.zips.getShardDistribution()'
```

```js
Shard shardA at shardA/shardA:27017
{ data: '2.15MiB', docs: 29470, chunks: 1, 'estimated docs per chunk': 29470 }
---
Shard shardB at shardB/shardB:27017
{ data: '1006KiB', docs: 9242, chunks: 1, 'estimated docs per chunk': 9242 }
---
Totals
{
  data: '3.13MiB', docs: 38712, chunks: 2,
  'Shard shardA': [ '68.68 % data', '76.12 % docs in cluster', '111B avg obj size on shard' ],
  'Shard shardB': [ '31.31 % data', '23.87 % docs in cluster', '111B avg obj size on shard' ]
}
```

| Question | Réponse mesurée |
|---|---|
| Combien de chunks ? | **2** |
| % de documents shardA | **76,12 %** |
| % de documents shardB | **23,87 %** |
| Équilibré ? | **Non** |

La répartition n'est pas équilibrée : le rapport est de **3,2 pour 1** entre les deux shards. Le balancer a fait une seule coupure et déplacé un seul chunk, il s'est arrêté là.

Détail qui saute aux yeux : le total affiché est **38 712 documents**, alors qu'on en a importé **29 470**. Il y a 9 242 documents de trop, exactement le contenu de shardB. Ce sont les documents du chunk migré, encore physiquement présents sur shardA. C'est le sujet de la Q5.

### Q3 — Frontières de chunks

```js
const c = db.getSiblingDB("config");
const u = c.collections.findOne({ _id: "census.zips" }).uuid;
c.chunks.find({ uuid: u }).sort({ shard: 1 }).toArray().forEach(x => {
  const borne = v => (v && v.constructor && /^(MinKey|MaxKey)$/.test(v.constructor.name))
                     ? v.constructor.name : v;
  print(x.shard + " [" + borne(x.min.state) + " -> " + borne(x.max.state) + "]");
})
```

```
shardA [KY -> MaxKey]
shardB [MinKey -> KY]
```

Avec `printjson`, sans la fonction d'affichage :

```js
{ shard: 'shardA', min: { state: 'KY' },       max: { state: MaxKey() } }
{ shard: 'shardB', min: { state: MinKey() },   max: { state: 'KY' } }
```

**Que signifient `MinKey` et `MaxKey` ?** Ce sont deux valeurs spéciales du BSON qui se comparent respectivement comme **plus petites** et **plus grandes** que n'importe quelle autre valeur, tous types confondus. Elles servent de bornes ouvertes : `[MinKey → KY]` veut dire « tout ce qui est strictement avant `KY` », sans avoir à écrire une borne basse concrète. Elles garantissent que les chunks couvrent **tout** l'espace des valeurs de la shard key, y compris les documents où `state` serait absent ou d'un autre type. Chaque chunk est un intervalle semi-ouvert `[min, max)`.

**Sur quelle valeur la coupure a-t-elle été faite ?** Sur **`KY`** (Kentucky).

**Est-ce le milieu de l'alphabet ?** `K` est la 11ᵉ lettre sur 26, donc à peu près au milieu de l'alphabet — mais c'est une coïncidence. Le balancer ne connaît pas l'alphabet, et il ne cherche pas le milieu lexicographique.

**Qu'est-ce qu'il a cherché à équilibrer ?** Le **volume de données**, pas le nombre de lettres ni le nombre d'États. Il a choisi le point de coupure qui, d'après les statistiques de l'index `{ state: 1 }`, séparait la collection en deux moitiés de taille comparable. Comme les États n'ont pas tous le même nombre de codes postaux (TX en a 1 676, un petit État en a quelques dizaines), le point d'équilibre en volume ne tombe pas au milieu de l'alphabet. Et même ce découpage-là n'a pas donné 50/50 : 68,7 % / 31,3 % en données.

### Q4 — Découper plus, est-ce rééquilibrer ?

```js
["FL","MI","NY","TX"].forEach(s => sh.splitAt("census.zips", { state: s }))
```

Puis, après une minute :

```bash
docker exec mongos mongosh --quiet census --eval 'db.zips.getShardDistribution()'
```

```js
Shard shardA at shardA/shardA:27017
{ data: '2.15MiB', docs: 29470, chunks: 4, 'estimated docs per chunk': 7367 }
---
Shard shardB at shardB/shardB:27017
{ data: '1006KiB', docs: 9242, chunks: 2, 'estimated docs per chunk': 4621 }
---
Totals
{
  data: '3.13MiB', docs: 38712, chunks: 6,
  'Shard shardA': [ '68.68 % data', '76.12 % docs in cluster', '111B avg obj size on shard' ],
  'Shard shardB': [ '31.31 % data', '23.87 % docs in cluster', '111B avg obj size on shard' ]
}
```

Nouvelles frontières :

```
shardB [MinKey -> FL]
shardB [FL -> KY]
shardA [KY -> MI]
shardA [MI -> NY]
shardA [NY -> TX]
shardA [TX -> MaxKey]
```

**(a) Combien de chunks maintenant ?** **6** (2 avant, 4 coupures forcées → 6). Répartis 4 sur shardA, 2 sur shardB.

**(b) Pourcentage de documents avant et après**

| | shardA | shardB |
|---|---|---|
| Avant (Q2) | 76,12 % | 23,87 % |
| Après (Q4) | 76,12 % | 23,87 % |
| **Écart** | **0 point** | **0 point** |

**Il n'a pas bougé d'un seul point.** J'ai laissé tourner 3 minutes de plus pour être sûr, `sh.isBalancerRunning()` est repassé à `false` et `config.changelog` ne montre aucun `moveChunk` supplémentaire : le balancer a regardé, et a décidé de ne rien faire.

**(c) Explication**

Il faut distinguer deux opérations que l'on confond facilement :

- **`splitAt` est une opération de métadonnées.** Elle ne déplace pas un octet. Elle écrit dans `config.chunks` que l'intervalle `[KY → MaxKey]` devient quatre intervalles. Les documents ne bougent pas, ils sont exactement là où ils étaient.
- **Le rééquilibrage, c'est le balancer**, et lui déplace des chunks entiers d'un shard à l'autre.

Découper ne rééquilibre donc jamais tout seul. Encore faut-il que le balancer *veuille* déplacer quelque chose. Ici il ne veut pas, et c'est le vrai enseignement. Comptons les documents par intervalle :

```js
db.zips.aggregate([{$group:{_id:"$state",n:{$sum:1}}},{$sort:{n:-1}},{$limit:5}])
```

```js
[ { _id: 'TX', n: 1676 }, { _id: 'NY', n: 1596 }, { _id: 'CA', n: 1523 },
  { _id: 'PA', n: 1458 }, { _id: 'IL', n: 1240 } ]
```

Et le poids réel de chaque chunk (`countDocuments` par intervalle, via mongos) :

| Chunk | Shard | Documents réels |
|---|---|---|
| `[MinKey → FL]` | shardB | 3 890 |
| `[FL → KY]` | shardB | 5 352 |
| `[KY → MI]` | shardA | 2 602 |
| `[MI → NY]` | shardA | 6 255 |
| `[NY → TX]` | shardA | 6 422 |
| `[TX → MaxKey]` | shardA | 4 949 |
| | **total** | **29 470** |

shardA détient réellement 20 228 documents (68,6 %) contre 9 242 (31,4 %) pour shardB. Pour équilibrer, le balancer devrait déplacer environ 5 500 documents, soit **à peu près un chunk entier**. Or déplacer n'importe lequel des chunks de shardA (2 602, 4 949, 6 255 ou 6 422 documents) ferait basculer le déséquilibre dans l'autre sens sans rien améliorer. Le balancer applique un seuil : tant que l'écart entre le shard le plus chargé et le moins chargé est **inférieur à la taille d'un chunk**, il ne migre pas, parce que migrer coûterait plus cher que le gain. On est exactement dans ce cas.

**Que peut faire le balancer quand un seul État pèse plus qu'un chunk entier ?**

**Rien.** Et c'est la limite structurelle du sharding par plage sur une clé de faible cardinalité. Un chunk est un **intervalle de valeurs de la shard key**, et l'unité indivisible est **une valeur**. TX a 1 676 codes postaux : tous ces documents ont la même valeur `state: "TX"`, ils sont donc dans le même chunk **par construction**. Si ce chunk dépasse la taille cible, MongoDB ne peut pas le couper — il n'y a aucun point de coupure disponible à l'intérieur d'une valeur unique. C'est ce qu'on appelle un **jumbo chunk** : il est marqué comme tel, le balancer refuse de le déplacer, et il grossit indéfiniment sur son shard.

Avec 50 pays (le scénario de la DSI), le problème est le même en pire : ~50 valeurs distinctes pour la shard key, donc **au maximum ~50 chunks**, quel que soit le volume. À 500 millions de documents, chaque chunk pèserait 10 millions de documents et rien ne serait découpable. Le cluster ne scalerait plus du tout. **Une shard key doit avoir une cardinalité largement supérieure au nombre de chunks que l'on veut pouvoir créer** — c'est ce que la Q8 va vérifier avec la clé hachée.

## Partie A2 — Le piège du comptage

### Q5 — La question d'écart

```bash
docker exec mongos mongosh --quiet census --eval '
  print(db.zips.countDocuments({}));
  print(db.zips.estimatedDocumentCount())'
```

**(a) Les deux nombres et l'écart**

| Commande | Résultat |
|---|---|
| `db.zips.countDocuments({})` | **29 470** |
| `db.zips.estimatedDocumentCount()` | **38 712** |
| **Écart** | **9 242 documents**, soit **+31,4 %** |

`countDocuments` donne le bon chiffre : c'est exactement le nombre de documents importés par `mongoimport`.

**(b) Comparaison avec la Q2**

L'écart de **9 242** est **exactement** le nombre de documents affiché pour **shardB** dans la Q2. Au document près, pas approximativement.

Ce n'est pas une coïncidence : shardB a reçu son contenu par **migration** depuis shardA. Les 9 242 documents ont été copiés sur shardB, la carte des chunks a été mise à jour chez `cfg1` pour dire « l'intervalle `[MinKey → KY]` vit maintenant sur shardB »… mais **les originaux sont toujours physiquement présents sur shardA**. Vérification en interrogeant chaque shard directement, sans passer par le routeur :

```bash
docker exec shardA mongosh --quiet census --eval 'print(db.zips.count())'
docker exec shardB mongosh --quiet census --eval 'print(db.zips.count())'
```

```
shardA physique : 29470
shardB physique : 9242
```

shardA détient encore les 29 470 documents de départ alors qu'il n'est légitimement propriétaire que de 20 228 d'entre eux. Les 9 242 autres ne lui appartiennent plus.

**(c) Le nom du phénomène**

Ce sont des **documents orphelins** (*orphaned documents*) : des documents physiquement présents sur un shard qui n'est plus le propriétaire déclaré de leur intervalle de shard key. Ils apparaissent après chaque migration de chunk et sont supprimés en différé par le *range deleter*, piloté par le paramètre **`orphanCleanupDelaySecs`**.

**Laquelle des deux commandes faut-il bannir sur un cluster shardé ?**

**`estimatedDocumentCount()`.** Elle ne lit aucun document : elle demande à chaque shard le compteur de métadonnées de sa collection locale (`collStats.count`) et additionne. Ce compteur reflète ce qui est **physiquement sur disque**, orphelins compris. Sur un cluster shardé son résultat est donc faux dès la première migration, et il l'est **silencieusement** — aucun avertissement, un nombre plausible.

`countDocuments()` est fiable parce que c'est une vraie agrégation (`$match` + `$group` + `$sum`) qui traverse les documents, et que chaque shard applique au passage un étage **`SHARDING_FILTER`** qui écarte tout document hors de ses intervalles :

```js
db.zips.find({ city: "NEW YORK" }).explain("executionStats")
```

```js
[ { shard: 'shardB', stage: 'SHARDING_FILTER', inner: 'COLLSCAN' },
  { shard: 'shardA', stage: 'SHARDING_FILTER', inner: 'COLLSCAN' } ]
```

C'est cet étage qui fait que les lectures normales, elles, ne voient jamais les orphelins — seul le comptage par métadonnées y échappe.

**Pourquoi l'autre est-elle plus coûteuse ?**

Parce qu'elle fait le travail. `estimatedDocumentCount()` est en O(1) : elle lit un compteur. `countDocuments()` doit parcourir l'index (ou la collection) et filtrer chaque document contre les bornes de chunks du shard, sur tous les shards, avant que `mongos` n'agrège les sous-totaux. C'est le prix de l'exactitude : **on paie un scan pour ne pas compter les orphelins**.

**(d) Valeur par défaut et prédiction**

```bash
docker exec shardA mongosh --quiet --eval 'printjson(db.adminCommand({getParameter:1, orphanCleanupDelaySecs:1}))'
```

```js
{ orphanCleanupDelaySecs: 900, ok: 1 }
```

**900 secondes, soit exactement 15 minutes.** C'est le délai que le shard donneur attend, après le commit de la migration, avant de supprimer sa copie devenue orpheline. Ce délai existe pour laisser aux lectures déjà en cours (curseurs ouverts, requêtes longues) le temps de se terminer sur l'ancienne copie.

Horodatage de la migration, relevé dans `config.changelog` :

```
2026-08-27T13:48:08.890Z  moveChunk.commit  census.zips
```

L'échéance du nettoyage tombe donc à **13:48:08 + 900 s = 14:03:08 UTC**.

> **Prédiction, formulée avant vérification** — 15 minutes après la migration, le range deleter de shardA aura supprimé les 9 242 documents dont il n'est plus propriétaire. shardA passera de 29 470 à 20 228 documents physiques. Les deux commandes donneront alors :
>
> | Commande | Avant | Prédiction après 14:03:08 |
> |---|---|---|
> | `countDocuments({})` | 29 470 | **29 470** — inchangé, il était déjà juste |
> | `estimatedDocumentCount()` | 38 712 | **29 470** — il redevient juste |
> | Écart | 9 242 | **0** |
>
> Autrement dit : `countDocuments` ne bougera pas d'un document, et `estimatedDocumentCount` va « se corriger tout seul ».

**Vérification, à 14:06:16 UTC** (soit 3 minutes après l'échéance) :

```bash
docker exec mongos mongosh --quiet census --eval '
  print(db.zips.countDocuments({}));
  print(db.zips.estimatedDocumentCount())'
```

```
countDocuments        : 29470
estimatedDocumentCount: 29470
```

```
shardA physique : 20228
shardB physique :  9242
```

| Commande | Avant | Prédit | Mesuré | |
|---|---|---|---|---|
| `countDocuments({})` | 29 470 | 29 470 | **29 470** | ✅ |
| `estimatedDocumentCount()` | 38 712 | 29 470 | **29 470** | ✅ |
| Écart | 9 242 | 0 | **0** | ✅ |
| shardA physique | 29 470 | 20 228 | **20 228** | ✅ |

Prédiction vérifiée au document près : les 9 242 orphelins ont disparu, et shardA détient exactement les 20 228 documents que le calcul par intervalles de chunks donnait en Q4(c).

La distribution affichée devient enfin honnête — et surtout, **le % de documents rejoint le % de données**, ce qui n'était pas le cas tant que les orphelins gonflaient shardA :

| | % docs avant nettoyage | % docs après | % data |
|---|---|---|---|
| shardA | 76,12 % | **68,63 %** | 68,64 % |
| shardB | 23,87 % | **31,36 %** | 31,35 % |

**En quoi une anomalie qui disparaît d'elle-même est-elle plus dangereuse en production qu'une anomalie permanente ?**

Pour quatre raisons, qui se cumulent :

1. **Elle échappe au diagnostic.** Une anomalie permanente, on la reproduit : on la constate, on ouvre un ticket, on investigue, elle est encore là. Celle-ci a une durée de vie de 15 minutes. Le temps qu'un analyste s'étonne d'un chiffre, prévienne quelqu'un, et que la personne relance la commande — le chiffre est redevenu correct. Le rapport de bug se clôt en « non reproductible », et personne n'apprend rien.

2. **Elle valide la mauvaise commande.** Comme `estimatedDocumentCount()` finit toujours par redonner le bon résultat, l'équipe conclut qu'elle est fiable. Elle reste dans le code, dans les dashboards, dans les exports. Le jour où le cluster rééquilibre pendant une facturation ou un export réglementaire, le chiffre est faux — et cette fois il part chez le client.

3. **Elle ment au pire moment.** Le nettoyage se déclenche *après* une migration, c'est-à-dire pendant les périodes de rééquilibrage : ajout d'un shard, purge massive, pic de charge. Exactement les moments où on surveille les métriques de près et où on prend des décisions d'exploitation. L'anomalie est corrélée aux incidents, pas aléatoire.

4. **Elle érode la confiance sans laisser de trace.** Deux tableaux de bord affichent 38 712 et 29 470 le même après-midi, sans explication et sans historique. On ne sait pas lequel croire, on ne sait pas depuis quand, on ne sait pas quels chiffres passés étaient faux. Une anomalie permanente est un bug ; une anomalie intermittente est un doute permanent sur toute la chaîne de mesure.

La règle qui en découle : **sur un cluster shardé, `estimatedDocumentCount()` est à proscrire dès qu'un chiffre est destiné à quelqu'un.** Elle reste acceptable pour un ordre de grandeur en interne — jamais pour un compte affiché, facturé ou reporté.

## Partie A3 — Targeted vs broadcast

### Q6 — Les deux requêtes à l'`explain`

```js
db.zips.find({ state: "NY" }).explain("executionStats")
db.zips.find({ city:  "NEW YORK" }).explain("executionStats")
```

| | filtre = shard key (`state`) | filtre = autre champ (`city`) |
|---|---|---|
| `stage` racine de `winningPlan` | **`SINGLE_SHARD`** | **`SHARD_MERGE`** |
| Shards interrogés | **`["shardA"]`** — 1 sur 2 | **`["shardB","shardA"]`** — 2 sur 2 |
| Plan par shard | `FETCH` / `IXSCAN` | `SHARDING_FILTER` / `COLLSCAN` ×2 |
| `nReturned` | 1 596 | 40 |
| `totalKeysExamined` | 1 596 | **0** |
| `totalDocsExamined` | **1 596** | **29 470** |
| `executionTimeMillis` | 4 | 31 |

### Q7 — Laquelle est *targeted*, laquelle est *broadcast*

**(a) Le signe précis dans l'`explain`**

La requête sur `state` est **targeted**, celle sur `city` est **broadcast** (scatter-gather). Deux signes le disent, et le second est le signe formel :

1. **Le `stage` racine de `winningPlan`** :
   - **`SINGLE_SHARD`** → `mongos` a su, en lisant la carte des chunks, que *toutes* les valeurs `state: "NY"` vivent dans l'intervalle `[MI → NY]`, donc sur shardA. Il n'a envoyé la requête qu'à lui.
   - **`SHARD_MERGE`** → `mongos` ne peut rien déduire : `city` n'est pas la shard key, un `NEW YORK` peut se trouver dans n'importe quel chunk. Il diffuse à tous les shards et fusionne les réponses.

2. **Le contenu de `winningPlan.shards`**, qui liste les shards réellement sollicités :

```
state: "NY"      → [ "shardA" ]
city: "NEW YORK" → [ "shardB", "shardA" ]
```

C'est la preuve directe : un seul nom dans un cas, tous les shards dans l'autre.

Détail révélateur : la requête ciblée fait un `IXSCAN` (1 596 clés → 1 596 documents), la requête diffusée fait un `COLLSCAN` **sur chaque shard** (`totalKeysExamined: 0`). Elle ne lit pas seulement partout, elle lit **tout**, partout.

**(b) Le rapport `totalDocsExamined / nReturned` pour la requête broadcast**

```
29 470 / 40 = 736,75
```

**736 documents lus pour 1 document rendu.** Pour comparaison, la requête ciblée est à `1596 / 1596 = 1,0` — le ratio idéal.

**(c) Extrapolation à 20 shards et 500 millions de documents**

| | Ce TP (2 shards, 29 470 docs) | Extrapolation (20 shards, 500 M docs) |
|---|---|---|
| Machines mobilisées | 2 sur 2 | **20 sur 20** |
| Documents lus | 29 470 | **500 000 000** |
| Documents rendus | 40 | ~679 000 |
| Ratio | 736,75 | 736,75 |

Une seule requête `find({ city: ... })` mobiliserait **les 20 machines** et leur ferait lire **les 500 millions de documents** — l'intégralité de la base — pour en rendre une fraction.

**Ce que cela dit de la scalabilité d'un cluster mal shardé :**

Elle est **négative**. C'est le point contre-intuitif du sharding, et il tient en une phrase : sur une requête broadcast, **ajouter un shard n'accélère rien et dégrade la capacité globale**.

Le détail du raisonnement :

- Le **temps de réponse** d'une requête broadcast est celui du shard le plus lent, pas la moyenne. Ajouter des machines multiplie les occasions d'en avoir une en GC, en compaction ou sur un disque saturé. Plus il y a de shards, plus la traîne de latence s'allonge.
- La **capacité en débit s'effondre**. Sur un cluster bien shardé, une requête ciblée occupe 1 machine sur 20 : le cluster peut en traiter 20 en parallèle. En broadcast, chaque requête occupe les 20 machines : le cluster n'en traite qu'**une seule à la fois**. Le débit maximal est divisé par 20 — on a payé 20 serveurs pour obtenir les performances d'un seul, avec la latence réseau en plus.
- Le coût de coordination croît avec le nombre de shards : `mongos` doit ouvrir 20 connexions, attendre 20 réponses, les fusionner, et trier en mémoire s'il y a un `sort`.

D'où la règle : **la shard key doit être choisie à partir des requêtes métier, pas à partir de la distribution seule.** Une clé qui répartit parfaitement mais que personne ne filtre transforme chaque requête en scan complet du cluster.

## Partie A4 — La clé hachée, et le compromis

```js
sh.shardCollection("census.zips_hashed", { _id: "hashed" })
```

```bash
docker exec mongos mongoimport --db census --collection zips_hashed --file /tmp/zips.json
```

```
29470 document(s) imported successfully.
```

### Q8 — Distribution de la collection hachée

```js
db.zips_hashed.getShardDistribution()
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
  data: '3.13MiB', docs: 29470, chunks: 4,
  'Shard shardA': [ '49.26 % data', '49.26 % docs in cluster', '111B avg obj size on shard' ],
  'Shard shardB': [ '50.73 % data', '50.73 % docs in cluster', '111B avg obj size on shard' ]
}
```

| | shardA | shardB |
|---|---|---|
| Documents | 14 517 | 14 953 |
| % | **49,26 %** | **50,73 %** |
| Chunks | 2 | 2 |

**4 chunks, sans aucun `splitAt` manuel.** Écart entre les deux shards : **1,5 point**. À comparer aux 37 points d'écart de `census.zips` avant nettoyage, et aux 6 chunks qu'il avait fallu forcer à la main pour n'obtenir aucun rééquilibrage.

**Pourquoi le hachage donne-t-il cette répartition d'emblée ?**

Deux mécanismes, dont le second est celui que l'énoncé fait chercher :

1. **La fonction de hachage détruit la corrélation entre la valeur et sa place.** La shard key n'est pas `_id`, c'est `hash(_id)` — un entier 64 bits réparti uniformément. Deux `_id` consécutifs atterrissent à des endroits sans rapport. La distribution des données ne dépend plus du tout de la distribution métier des valeurs : elle est uniforme par construction.

2. **Le *pre-splitting*.** C'est le point décisif. Quand on lance `shardCollection` avec une clé hachée **sur une collection vide**, MongoDB ne crée pas un chunk unique : il découpe immédiatement l'espace de hachage en autant de chunks qu'il faut et les distribue sur les shards **avant le moindre document**. Les frontières le montrent — ce sont des bornes numériques régulières, pas des valeurs métier :

```
shardB [MinKey                -> -4611686018427387902]
shardB [-4611686018427387902  -> 0]
shardA [0                     -> 4611686018427387902]
shardA [4611686018427387902   -> MaxKey]
```

L'espace des hachés 64 bits est coupé en **quatre quarts égaux**, deux par shard. Chaque document importé va ensuite se ranger dans le quart correspondant à son haché — donc, statistiquement, un quart des documents par chunk. **Aucune migration n'a lieu, parce qu'il n'y a rien à rééquilibrer : la répartition est correcte dès la première insertion.**

**Comparaison `countDocuments` / `estimatedDocumentCount` sur cette collection**

```
countDocuments        : 29470
estimatedDocumentCount: 29470
```

| | `census.zips` | `census.zips_hashed` |
|---|---|---|
| `countDocuments` | 29 470 | 29 470 |
| `estimatedDocumentCount` | 38 712 *(avant nettoyage)* | 29 470 |
| Écart | **9 242** | **0** |

**L'écart de la Q5 n'existe pas ici. Pourquoi ?**

Parce que les orphelins sont une **séquelle de migration**, et qu'**aucune migration n'a eu lieu**. C'est la conséquence directe du pre-splitting : les chunks étaient déjà à leur place définitive avant l'import, chaque document a été écrit du premier coup sur le bon shard, le balancer n'a jamais eu à déplacer quoi que ce soit — donc aucun shard ne détient de copie devenue illégitime.

Cela confirme au passage le diagnostic de la Q5 : l'écart n'était pas un défaut de `estimatedDocumentCount` en soi, c'était la trace d'une migration récente. **Sur un cluster shardé, il faut le lire comme un symptôme** : un écart signifie qu'une migration a eu lieu il y a moins de 15 minutes.

### Q9 — Le compromis, prouvé puis arbitré

```js
db.zips_hashed.find({ state: "NY" }).explain("executionStats")
```

| | `census.zips` (`{state:1}`) | `census.zips_hashed` (`{_id:"hashed"}`) |
|---|---|---|
| `stage` racine | **`SINGLE_SHARD`** | **`SHARD_MERGE`** |
| Shards interrogés | `["shardA"]` | `["shardB","shardA"]` |
| Plan par shard | `FETCH` / `IXSCAN` | `SHARDING_FILTER` / `COLLSCAN` ×2 |
| `nReturned` | 1 596 | 1 596 |
| `totalDocsExamined` | **1 596** | **29 470** |
| Ratio | **1,0** | **18,5** |

**(a) Le `stage` racine est-il le même ?**

**Non.** Exactement la même requête métier passe de `SINGLE_SHARD` à `SHARD_MERGE`. La collection la mieux répartie des deux est celle qui répond le plus mal à la requête que l'on pose réellement : elle lit les 29 470 documents au lieu de 1 596, sur les deux shards au lieu d'un.

**Le compromis fondamental du sharding, en une phrase :**

> **Une shard key ne peut pas à la fois répartir uniformément la donnée et regrouper les documents que les requêtes métier lisent ensemble — distribuer, c'est disperser ; regrouper, c'est déséquilibrer.**

Les deux objectifs sont antagonistes par nature : bien répartir suppose de casser toute corrélation entre la valeur et sa place, et cibler suppose exactement l'inverse.

**(b) Tableau de décision**

Cardinalités mesurées sur les 29 470 documents :

```js
db.zips.distinct("state").length
db.zips.distinct("zip").length
db.zips.aggregate([{$group:{_id:{s:"$state",z:"$zip"}}},{$count:"c"}])
```

| Shard key candidate | Cardinalité | Distribution mesurée | Requêtes métier ciblées ? | Verdict |
|---|---|---|---|---|
| `{ state: 1 }` | **51** | **68,63 / 31,36** — déséquilibrée, plafonnée à ~51 chunks, jumbo chunks garantis | **Oui** — `SINGLE_SHARD`, ratio 1,0 | ❌ **À rejeter.** Cible bien, mais la cardinalité est un plafond dur : ~51 chunks maximum quel que soit le volume. À ×50 pays, le cluster ne scale plus. |
| `{ _id: "hashed" }` | **29 470** — unique | **49,26 / 50,73** — quasi parfaite, 4 chunks pre-splittés, zéro orphelin | **Non** — `SHARD_MERGE`, ratio 18,5 | ⚠️ **Acceptable par défaut.** Répartition irréprochable, mais toute requête sur `state` devient broadcast. À réserver aux charges dominées par l'accès par `_id`. |
| `{ zip: 1 }` | **29 467** — *non unique*, 3 doublons | Excellente en théorie (cardinalité ≈ nombre de documents) | **Non** — aucune requête métier ne filtre sur `zip` seul | ⚠️ **Bonne clé technique, inutile ici.** Réponse de la Q4 du Jour 3 confirmée par la mesure : `zip` n'est **pas** unique — 3 codes postaux à cheval sur deux États. Elle disperse aussi bien que le hachage sans mieux cibler. |
| `{ state: 1, zip: 1 }` | **29 470** — unique | Bonne : `state` en préfixe donne des chunks contigus, `zip` en second terme rend chaque État découpable | **Oui** — préfixe = `state`, donc `SINGLE_SHARD` sur `{state:"NY"}` | ✅ **Le meilleur choix.** |

**Pourquoi `{ state: 1, zip: 1 }` gagne**

C'est la clé composée qui lève la contradiction, et le raisonnement tient à la **règle du préfixe** : une requête est ciblée dès qu'elle filtre sur un **préfixe** de la shard key.

- Une requête qui ne filtre que sur `state` porte sur le préfixe `{state: 1}` → `mongos` sait que `NY` occupe un intervalle contigu de la clé composée, donc **elle reste `SINGLE_SHARD`**. On garde exactement le bénéfice de `{state: 1}`.
- Mais le second terme change tout côté découpage : la valeur de la clé n'est plus `"NY"` mais `("NY", "10001")`, `("NY", "10002")`… **1 596 valeurs distinctes rien que pour NY**. Le chunk `NY` devient découpable autant de fois qu'on veut, et le jumbo chunk de la Q4 disparaît.
- La cardinalité totale passe de 51 à **29 470, et elle est unique** — les 3 doublons de `zip` sont résolus par le couple, puisqu'ils étaient à cheval sur deux États.

En clair : `state` en préfixe donne le **ciblage**, `zip` en second terme donne la **granularité**. C'est la réponse à donner à la DSI pour l'ouverture à 50 pays — `{ country: 1, <identifiant fin>: 1 }` plutôt que `{ country: 1 }` seul.

# PARTIE B — Performances & diagnostic

Instance dédiée `mongo-j4` (port 27017), base `citibike`, collection `trips`.
Le cluster shardé de la Partie A reste allumé sur les ports 27119-27122 — aucun conflit.

## Partie B0 — Environnement et import

```bash
docker compose up -d
curl -L -o trips.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_training/trips.json
wc -l trips.json
docker cp trips.json mongo-j4:/tmp/trips.json
docker exec mongo-j4 mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db citibike --collection trips --drop --file /tmp/trips.json
```

```
10000 trips.json
10000 document(s) imported successfully. 0 document(s) failed to import.
```

**Point de contrôle B0** — `db.trips.countDocuments({})` renvoie bien **10000**.

```js
db.trips.findOne()
```

```js
{
  _id: ObjectId('572bb8222b288919b68abf5a'),
  tripduration: 379,
  'start station id': 476,
  'start station name': 'E 31 St & 3 Ave',
  'end station id': 498,
  'end station name': 'Broadway & W 32 St',
  bikeid: 17827,
  usertype: 'Subscriber',
  'birth year': 1969,
  gender: 1,
  'start station location': { type: 'Point', coordinates: [ -73.97966069, 40.74394314 ] },
  'end station location':   { type: 'Point', coordinates: [ -73.98808416, 40.74854862 ] },
  'start time': ISODate('2016-01-01T00:00:45.000Z'),
  'stop time':  ISODate('2016-01-01T00:07:04.000Z')
}
```

### Q10 — Les espaces dans les noms de champs

**(a) Dans un filtre `find`**

```js
db.trips.find({ "start station id": 476 })
```

Le nom du champ doit être **entre guillemets**. C'est une contrainte de JavaScript, pas de MongoDB : dans un littéral d'objet, une clé non quotée doit être un identifiant valide, et `start station id` n'en est pas un — c'est trois identifiants séparés par des espaces.

**(b) Dans une référence de `$group`**

```js
{ $group: { _id: "$start station id", n: { $sum: 1 } } }
```

Ici les guillemets sont **déjà là par nature** : une référence de champ dans le pipeline est une **chaîne** commençant par `$`. Le champ étant la valeur et non la clé, il n'y a aucun piège. Le piège revient dès qu'on veut ce champ comme **clé de sortie** :

```js
{ $group: { _id: { "start station id": "$start station id" } } }
```

**Que se passe-t-il si on oublie les guillemets ?**

Ce n'est **pas** une erreur MongoDB, c'est une **erreur de syntaxe JavaScript**, levée par `mongosh` avant que la requête ne parte :

```
SyntaxError: Unexpected identifier
```

C'est le cas le plus favorable : ça casse tout de suite et bruyamment. Le cas dangereux serait un nom de champ qui *reste* un identifiant valide après la faute de frappe — là, MongoDB accepterait la requête et renverrait silencieusement zéro résultat.

### Q11 — La plage temporelle réelle

```js
db.trips.aggregate([
  { $group: { _id: null,
              min_start: { $min: "$start time" },
              max_start: { $max: "$start time" },
              max_stop:  { $max: "$stop time" } } }
])
```

```js
[ { _id: null,
    min_start: ISODate('2016-01-01T00:00:41.000Z'),
    max_start: ISODate('2016-01-02T19:35:22.000Z'),
    min_stop:  ISODate('2016-01-01T00:06:51.000Z'),
    max_stop:  ISODate('2016-01-05T21:47:46.000Z') } ]
```

| Borne | Valeur |
|---|---|
| `$min` de `start time` | **2016-01-01 00:00:41** |
| `$max` de `start time` | **2016-01-02 19:35:22** |
| `$max` de `stop time` | **2016-01-05 21:47:46** |

**Commentaire — le jeu s'annonce comme « janvier 2016 », il ne l'est pas.**

Trois écarts, du plus visible au plus sournois :

1. **Il ne couvre pas janvier, il couvre 43 heures.** Les départs s'étalent du 1er janvier 00:00:41 au 2 janvier 19:35:22, soit **moins de deux jours** sur les 31 annoncés. Ce n'est pas « janvier 2016 », c'est un échantillon de 10 000 trajets pris au tout début du mois.

2. **Ces deux jours sont les plus atypiques de l'année.** Le 1er janvier 2016 était un **vendredi férié**, le 2 un **samedi**. Aucun trajet domicile-travail. Toute conclusion sur les usages tirée de ce jeu décrit un week-end de jour de l'an, pas l'usage courant du service. C'est ce que la Q15 va confirmer sur le profil horaire.

3. **`stop time` déborde de trois jours sur `start time`.** Le dernier départ est le 2 janvier, mais la dernière arrivée est le **5 janvier à 21:47**. Un trajet a donc duré plus de 3 jours. Ce n'est pas une erreur de bornage du jeu : c'est le premier indice des durées aberrantes que la Q20 va chiffrer.

Conséquence méthodologique : **toute moyenne calculée sur ce jeu et présentée comme « l'usage en janvier » serait fausse** — pas à cause du calcul, mais à cause du périmètre. C'est le sujet de la R3.

## Partie B1 — Aggregation pipeline

Tous les pipelines de cette partie sont dans `pipelines.js`, exécutable via :

```bash
docker exec -i mongo-j4 mongosh -u admin -p ipssi2025 --authenticationDatabase admin < pipelines.js
```

### Q12 — Top 5 des stations de départ

```js
db.trips.aggregate([
  { $group: { _id: "$start station name", n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 }
])
```

| # | Station | Trajets |
|---|---|---|
| 1 | Central Park S & 6 Ave | **114** |
| 2 | Lafayette St & E 8 St | 99 |
| 3 | Carmine St & 6 Ave | 95 |
| 4 | Broadway & E 14 St | 93 |
| 5 | E 17 St & Broadway | 86 |

La station de tête est à l'entrée sud de **Central Park** — cohérent avec un week-end férié : c'est une station de loisir, pas de bureau.

### Q13 — Répartition par type d'abonnement

```js
db.trips.aggregate([
  { $group: { _id: "$usertype", n: { $sum: 1 }, duree_moy: { $avg: "$tripduration" } } },
  { $sort: { n: -1 } }
])
```

| `usertype` | Trajets | Part | Durée moyenne |
|---|---|---|---|
| `Subscriber` | **8 011** | 80,1 % | **762,36 s** — 12 min 42 |
| `Customer` | **1 989** | 19,9 % | **2 610,71 s** — 43 min 31 |

**Le rapport entre les deux moyennes : 2 610,71 / 762,36 = 3,42.**

Un `Customer` roule **3,4 fois plus longtemps** qu'un `Subscriber`.

**Hypothèse métier :** ce ne sont pas les mêmes usages, ni les mêmes tarifs.

- Le **`Subscriber`** est un abonné annuel, un new-yorkais qui connaît le réseau. Il fait un trajet utilitaire de point A à point B, et son abonnement facture au-delà de 45 minutes : il a un intérêt direct à raccourcir et à reposer le vélo à la première borne. 12 minutes, c'est un trajet de liaison.
- Le **`Customer`** est un ticket à la journée ou 24 h, très majoritairement un touriste. Il ne va pas d'un point à un autre, il **se promène** — et 43 minutes correspond à une balade, typiquement autour de Central Park ou le long de l'Hudson. Ayant payé au forfait, il n'a aucune incitation à rendre le vélo vite.

Ces deux moyennes sont à garder : la **Q21 va les recalculer** en excluant les trajets aberrants, et l'écart entre les deux populations ne sera pas du tout le même.

### Q14 — Trajets par jour

```js
db.trips.aggregate([
  { $group: { _id: { $dateTrunc: { date: "$start time", unit: "day" } }, n: { $sum: 1 } } },
  { $sort: { _id: 1 } }
])
```

| Jour | Trajets |
|---|---|
| 2016-01-01 (vendredi) | **6 348** |
| 2016-01-02 (samedi) | **3 652** |
| **Total** | **10 000** |

**Deux jours.** Le résultat est parfaitement cohérent avec la Q11 : `$min` et `$max` de `start time` tombaient sur ces deux dates, il ne peut donc pas y en avoir d'autres. Les deux mesures se contrôlent mutuellement, et la somme retombe exactement sur les 10 000 documents importés — aucun trajet sans date, aucun hors bornes.

C'est la confirmation chiffrée que « janvier 2016 » est un abus de langage : **2 jours sur 31, soit 6,5 % du mois annoncé**.

### Q15 — Heure de pointe

```js
db.trips.aggregate([
  { $group: { _id: { $hour: "$start time" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 }
])
```

| # | Heure de départ | Trajets |
|---|---|---|
| 1 | **13 h** | **1 061** |
| 2 | 12 h | 827 |
| 3 | 11 h | 778 |
| 4 | 15 h | 709 |
| 5 | 14 h | 685 |

**Ce profil ressemble-t-il à un usage domicile-travail ? Non, et c'est l'inverse exact.**

Un profil domicile-travail est **bimodal** : un pic vers 8 h-9 h, un creux marqué en milieu de journée, un second pic vers 17 h-18 h. Ici le top 5 est **11 h, 12 h, 13 h, 14 h, 15 h** — cinq heures consécutives, un seul pic, centré sur le milieu de journée. Le creux du midi attendu est précisément le sommet observé. Aucune heure de pointe matinale ou vespérale n'apparaît dans le classement.

**Justification par la date du jeu :** le **1er janvier 2016 était un vendredi**, et un **jour férié** ; le 2 janvier était un **samedi**. Aucun des deux jours n'est ouvré. Personne ne va au bureau à vélo le jour de l'an. Ce qu'on observe est un usage de **loisir** : on part se promener après le déjeuner, le pic suit la logique de la lumière du jour et de la température, pas celle des horaires de travail.

Cela recoupe la Q12 (Central Park en tête) et la Q13 (43 minutes de moyenne chez les `Customer`). **Les trois mesures racontent la même histoire.**

Conséquence directe pour la direction : ce jeu ne permet **pas** de dimensionner le service aux heures de pointe ouvrées. Il faudrait un échantillon de jours ouvrés pour cela.

### Q16 — Distribution des durées

```js
db.trips.aggregate([
  { $bucket: { groupBy: "$tripduration",
               boundaries: [0, 300, 600, 1800, 3600, 1000000],
               default: "hors bornes",
               output: { n: { $sum: 1 } } } }
])
```

| Tranche | Durée | Trajets | Part |
|---|---|---|---|
| `[0, 300)` | moins de 5 min | 2 009 | 20,1 % |
| `[300, 600)` | 5 à 10 min | 3 136 | 31,4 % |
| **`[600, 1800)`** | **10 à 30 min** | **3 953** | **39,5 %** |
| `[1800, 3600)` | 30 min à 1 h | 652 | 6,5 % |
| `[3600, 1000000)` | plus d'1 h | 250 | 2,5 % |
| | **Total** | **10 000** | 100 % |

**La tranche la plus peuplée est `[600, 1800)` — 10 à 30 minutes — avec 3 953 trajets, soit 39,5 % du jeu.**

Aucun document n'est tombé dans `default: "hors bornes"` : toutes les durées sont positives et inférieures à 1 000 000 s.

Deux observations qui préparent la suite :

- **91 % des trajets durent moins de 30 minutes.** La distribution est très concentrée à gauche.
- Mais **250 trajets dépassent une heure**, et la borne haute de 1 000 000 s (11,5 jours) a été nécessaire pour tous les capturer. Le simple fait qu'il faille une borne aussi absurde pour ne rien perdre est le signal que la Q20 va exploiter.

### Q17 — Boucles

```js
db.trips.countDocuments({ $expr: { $eq: ["$start station id", "$end station id"] } })
```

**316 trajets** repartent de la station où ils sont arrivés, soit **3,2 %** du jeu.

**Pourquoi `$expr` est nécessaire ici :** un filtre classique compare un champ à une **valeur constante** (`{ "start station id": 476 }`). Il n'existe pas de syntaxe de requête ordinaire pour comparer **deux champs du même document** entre eux. `$expr` est le pont qui permet d'utiliser un opérateur d'agrégation (`$eq` sur deux références de champs) à l'intérieur d'un `$match` ou d'un `find`.

L'alternative avec `$addFields` :

```js
db.trips.aggregate([
  { $addFields: { boucle: { $eq: ["$start station id", "$end station id"] } } },
  { $match: { boucle: true } },
  { $count: "boucles" }
])
```

Elle donne le même résultat mais est **moins efficace** : elle calcule le champ `boucle` pour les 10 000 documents avant de filtrer, là où `$expr` filtre au fil de l'eau. À noter dans les deux cas : **`$expr` ne peut pas utiliser d'index** — c'est un `COLLSCAN` obligatoire. Sur une grosse collection, on matérialiserait le booléen à l'écriture plutôt que de le recalculer à chaque lecture.

Métier, ces 3,2 % sont cohérents avec le profil de loisir : une boucle, c'est une balade qui revient à son point de départ — typiquement le tour de Central Park.

## Partie B2 — Qualité de données et optimiseur

### Q18 — Le champ piégé

```js
db.trips.countDocuments({ "birth year": { $type: "string" } })
db.trips.countDocuments({ "birth year": { $type: "int" } })
```

| Type de `birth year` | Trajets |
|---|---|
| `string` | **1 989** |
| `int` | **8 011** |
| `double` | 0 |
| absent | 0 |

Croisement avec `usertype` :

```js
db.trips.aggregate([
  { $group: { _id: { type: { $type: "$birth year" }, usertype: "$usertype" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } }
])
```

```js
[ { _id: { type: 'int',    usertype: 'Subscriber' }, n: 8011 },
  { _id: { type: 'string', usertype: 'Customer'   }, n: 1989 } ]
```

**Ce qu'on découvre : la corrélation est parfaite, à 100 %.**

Deux groupes seulement, aucun croisement. **Tous** les `Subscriber` ont une année entière, **tous** les `Customer` ont une chaîne. Et le nombre saute aux yeux : **1 989 et 8 011 sont exactement les effectifs de la Q13**. Ce n'est pas un jeu de données sale au hasard — c'est une règle métier qui a laissé une trace dans le typage.

La valeur exacte des chaînes le confirme :

```js
db.trips.distinct("birth year", { "birth year": { $type: "string" } })
```

```js
[ '' ]
```

**Une seule valeur distincte : la chaîne vide.** Le formulaire d'achat d'un ticket à la journée ne demande pas la date de naissance ; le champ part vide et est stocké comme `""` au lieu d'être omis ou mis à `null`. L'abonnement annuel, lui, l'exige.

**Pourquoi `{ "birth year": { $lt: 1950 } }` est silencieusement fausse**

```js
db.trips.countDocuments({ "birth year": { $lt: 1950 } })
```

La requête renvoie **163** et ne lève aucune erreur. Elle a pourtant deux défauts, et le second est le grave :

1. **MongoDB compare d'abord par type, pas par valeur.** L'ordre de tri BSON est fixe : `null` < nombres < chaînes < objets < … Une chaîne est donc **toujours** supérieure à n'importe quel nombre. `"" < 1950` est **faux**, quelle que soit la chaîne. Les 1 989 `Customer` sont écartés du résultat — pas parce qu'ils ne remplissent pas le critère, mais parce que leur type les rend incomparables au seuil.

2. **Le filtre porte donc en réalité sur une sous-population, sans le dire.** Ce que la requête retourne, ce n'est pas « les trajets d'usagers nés avant 1950 » : c'est « les trajets d'usagers **abonnés** nés avant 1950 ». Le filtre `usertype: "Subscriber"` est appliqué **implicitement**, par effet de bord du typage. Personne ne l'a écrit, personne ne le voit dans le code, et il n'apparaît dans aucun `explain`.

C'est ce qui rend l'erreur **silencieuse** au sens fort : pas d'exception, pas d'avertissement, un résultat plausible, et un biais de population de 20 % invisible à la relecture. Une requête qui plante est un incident ; celle-ci est un chiffre faux qui part en réunion.

La bonne écriture est explicite sur le périmètre :

```js
db.trips.countDocuments({ "birth year": { $type: "int", $lt: 1950 } })
```

### Q19 — Âge moyen des usagers en 2016

```js
db.trips.aggregate([
  { $match: { "birth year": { $type: "int" } } },
  { $group: { _id: null,
              age_moyen:  { $avg: { $subtract: [2016, "$birth year"] } },
              effectif:   { $sum: 1 },
              plus_vieux: { $max: { $subtract: [2016, "$birth year"] } },
              annee_min:  { $min: "$birth year" } } }
])
```

| Métrique | Valeur |
|---|---|
| **Âge moyen** | **39,86 ans** |
| **Effectif retenu** | **8 011** trajets sur 10 000 |
| **Âge du plus vieil usager** | **131 ans** (`birth year: 1885`) |

**131 ans est-il crédible ? Non.** La doyenne de l'humanité en 2016 avait 116 ans, et le record absolu jamais homologué est de 122 ans. Une personne de 131 ans à vélo dans Manhattan n'existe pas.

**Que faire de ce document ?**

**Surtout pas le supprimer.** L'enregistrement du trajet est probablement valide — quelqu'un a bien loué ce vélo. C'est le champ `birth year` qui est faux, pas le trajet. Le supprimer reviendrait à perdre une course réelle pour corriger une donnée déclarative.

La démarche que je retiendrais, dans l'ordre :

1. **Comprendre l'origine.** 1885 n'est pas une valeur aléatoire : c'est le genre de valeur qu'on obtient quand un formulaire propose une liste déroulante d'années qui commence à 1885, et que l'usager laisse le premier choix. On trouverait sans doute d'autres valeurs identiques — c'est une valeur sentinelle, pas une faute de frappe.
2. **Ne pas nettoyer à la source, filtrer à l'analyse.** On garde le document intact et on borne le calcul à un intervalle plausible, en le documentant :

```js
{ $match: { "birth year": { $type: "int", $gte: 1930, $lte: 2005 } } }
```

3. **Comptabiliser et publier les exclusions.** Le nombre de documents écartés fait partie du résultat, jamais une note de bas de page.
4. **Remonter le défaut au producteur** : le formulaire devrait interdire une année incompatible avec l'âge minimum légal (16 ans chez Citi Bike).

Ce qu'il ne faut pas faire : corriger la valeur en base par une estimation. Une donnée fausse est réparable ; une donnée inventée qui a l'air vraie ne l'est plus.

**Remarque sur l'effectif** : les 8 011 trajets retenus sont, encore une fois, exactement les `Subscriber`. **L'âge moyen de 39,86 ans n'est donc pas l'âge moyen des usagers de Citi Bike — c'est l'âge moyen des abonnés.** Les touristes sont hors du calcul, faute de donnée. C'est une limite à énoncer, pas à masquer.

### Q20 — Les valeurs aberrantes

```js
db.trips.countDocuments({ tripduration: { $gt: 10800 } })
db.trips.countDocuments({ tripduration: { $gt: 86400 } })
```

| Seuil | Trajets | Part du jeu |
|---|---|---|
| Plus de **3 heures** | **54** | 0,54 % |
| Plus de **24 heures** | **9** | 0,09 % |

Les 3 plus longs :

| Durée | Équivalent | `usertype` | Départ | Arrivée |
|---|---|---|---|---|
| **326 222 s** | **3 j 18 h** | `Subscriber` | 2016-01-01 00:58 | 2016-01-04 19:35 |
| **279 620 s** | **3 j 05 h** | `Customer` | 2016-01-02 16:07 | 2016-01-05 21:47 |
| **173 357 s** | **2 j 00 h** | `Customer` | 2016-01-02 14:25 | 2016-01-04 14:34 |

C'est ce dernier trajet qui expliquait le `max_stop` du 5 janvier relevé en Q11 : les deux mesures se recoupent.

**Explication métier**

Ces durées ne sont pas des erreurs de mesure : les horodatages sont cohérents entre eux (`stop time − start time` correspond bien à `tripduration`). Le vélo a réellement été considéré comme sorti pendant 3 jours. Les causes plausibles, par ordre de vraisemblance :

- **Le vélo n'a pas été correctement raccroché.** C'est le cas le plus fréquent : l'usager repose le vélo, la borne ne verrouille pas complètement, et le compteur continue de tourner jusqu'à ce qu'un agent régularise. Chez Citi Bike, la course reste ouverte tant que le verrou n'a pas confirmé.
- **Vol ou perte.** Le vélo est facturé au forfait de remplacement, et la course se ferme quand le vélo est retrouvé ou déclaré perdu.
- **Panne de la borne d'arrivée.** L'usager restitue le vélo à une station hors service, la restitution n'est pas enregistrée.

Le point important pour l'analyse : **ces trajets ne représentent pas un usage**. Ce sont des incidents d'exploitation. Les inclure dans une durée moyenne revient à mélanger deux populations qui n'ont rien à voir — c'est exactement ce que la Q21 va chiffrer.

Le fait que le plus long soit le fait d'un `Subscriber` est intéressant : le biais ne vient pas d'un type d'usager, mais bien d'un défaut matériel.

### Q21 — La question d'écart

```js
db.trips.aggregate([
  { $match: { tripduration: { $lte: 10800 } } },
  { $group: { _id: "$usertype", n: { $sum: 1 }, duree_moy: { $avg: "$tripduration" } } }
])
```

**(a) Les nouvelles moyennes**

| `usertype` | Effectif retenu | Nouvelle moyenne |
|---|---|---|
| `Subscriber` | 7 998 | **648,59 s** — 10 min 49 |
| `Customer` | 1 948 | **1 717,93 s** — 28 min 38 |

**(b) Pourcentage d'écart avec la Q13**

| `usertype` | Q13 (tout) | Q21 (≤ 3 h) | Écart absolu | **Écart relatif** |
|---|---|---|---|---|
| `Subscriber` | 762,36 s | 648,59 s | −113,77 s | **−14,9 %** |
| `Customer` | 2 610,71 s | 1 717,93 s | −892,78 s | **−34,2 %** |

**Les deux populations ne sont pas affectées de la même façon — l'écart est 2,3 fois plus fort chez les `Customer`.**

**Pourquoi ?** Deux raisons qui se cumulent :

1. **Les aberrations ne sont pas réparties uniformément.** Sur les 54 trajets exclus :

```js
[ { _id: 'Customer', n: 41 }, { _id: 'Subscriber', n: 13 } ]
```

**41 chez les `Customer` contre 13 chez les `Subscriber`** — alors que les `Customer` ne pèsent que 20 % du jeu. Rapporté à l'effectif, un `Customer` a **12,6 fois plus de chances** de générer un trajet aberrant (2,06 % contre 0,16 %). Métier, c'est logique : le touriste ne connaît pas le geste de verrouillage, ne vérifie pas le voyant, et n'a pas l'application pour signaler l'anomalie.

2. **Une moyenne est d'autant plus fragile que l'effectif est petit.** Les 41 valeurs extrêmes sont diluées dans 1 989 observations chez les `Customer`, contre 13 dans 8 011 chez les `Subscriber`.

Conséquence sur la lecture métier : le rapport entre les deux populations, que la Q13 estimait à **3,42**, tombe à **2,65** une fois les incidents écartés. La conclusion qualitative tient — un touriste roule bien plus longtemps qu'un abonné — mais **l'amplitude annoncée était surestimée de 29 %**.

**(c) Trajets exclus et pourcentage du jeu**

**54 trajets exclus, soit 0,54 % du jeu.**

**Le rapport entre ce pourcentage et l'écart calculé en (b) est le résultat le plus important de la journée :**

| | `Subscriber` | `Customer` |
|---|---|---|
| Part des données exclue | 0,16 % | 2,06 % |
| Impact sur la moyenne | −14,9 % | −34,2 % |
| **Effet de levier** | **× 91** | **× 17** |

**0,54 % des données déplaçaient la moyenne globale de plus de 30 % sur une population.** Autrement dit, **un document sur 200 pesait plus lourd que les 199 autres réunis**.

C'est la démonstration que la moyenne arithmétique n'a **aucune résistance aux valeurs extrêmes** : chaque observation y entre avec le même poids, donc un trajet de 3 jours compte autant que 430 trajets de 10 minutes. Sur une distribution à queue longue — et toutes les durées, tous les montants, tous les temps de réponse le sont — la moyenne brute est une statistique dangereuse.

**(d) Laquelle communiquer à la direction ?**

**La moyenne de la Q21 (hors trajets de plus de 3 heures), et elle seule** — accompagnée de son critère d'exclusion et de son effectif.

Le raisonnement tient en trois points :

1. **Elle répond à la question réellement posée.** La direction veut connaître l'usage du service : combien de temps les gens roulent. Un vélo mal raccroché pendant 3 jours n'est pas un usage, c'est une panne. Les deux chiffres ne mesurent pas la même chose, et celui de la Q13 mélange les deux.

2. **Elle est stable.** Un seul incident supplémentaire de 4 jours ferait bouger la moyenne de la Q13 de façon visible ; il ne toucherait pas celle de la Q21. Un indicateur de pilotage qui saute au gré des pannes de bornes est inutilisable pour décider quoi que ce soit.

3. **Les incidents doivent être suivis — mais comme un indicateur séparé.** Les 54 trajets aberrants sont une information précieuse : c'est un taux de dysfonctionnement de 0,54 %, avec une concentration à 2,06 % chez les `Customer`. Cela mérite son propre tableau de bord et probablement une action sur la signalétique des bornes. Les noyer dans une moyenne de durée, c'est perdre les deux informations à la fois : on fausse la durée **et** on masque la panne.

**La condition qui rend cette réponse honnête** : le critère d'exclusion doit être **écrit dans le rapport**, pas appliqué en silence. « Durée moyenne d'un trajet : 10 min 49 (abonnés) et 28 min 38 (tickets), sur 9 946 trajets, hors 54 trajets de plus de 3 heures identifiés comme incidents de restitution. » C'est le sujet de la R3.

### Q22 — `$match` en premier — vraiment ?

**Pipeline A**

```js
db.trips.explain("executionStats").aggregate([
  { $match: { usertype: "Subscriber" } },
  { $group: { _id: "$start station id", n: { $sum: 1 } } }
])
```

**Pipeline B**

```js
db.trips.explain("executionStats").aggregate([
  { $group: { _id: { s: "$start station id", u: "$usertype" }, n: { $sum: 1 } } },
  { $match: { "_id.u": "Subscriber" } }
])
```

| | Pipeline A (`$match` d'abord) | Pipeline B (`$match` après `$group`) |
|---|---|---|
| Étages du plan | `["$cursor", "$group"]` | **`["$cursor", "$group"]`** |
| Filtre dans le curseur | `{ usertype: { $eq: "Subscriber" } }` | **`{ usertype: { $eq: "Subscriber" } }`** |
| `totalDocsExamined` | **10 000** | **10 000** |
| Documents remontés du curseur | **8 011** | **8 011** |

**Les deux plans sont-ils différents ? Non — ils sont rigoureusement identiques.**

Le point à relever : dans le pipeline B, **l'étage `$match` a disparu de la liste des étages**. Il n'a pas été exécuté après le `$group`, il a été **absorbé dans le curseur**, où l'on retrouve le filtre `{ usertype: { $eq: "Subscriber" } }` — réécrit au passage, puisque l'utilisateur avait écrit `{ "_id.u": "Subscriber" }` sur un champ qui n'existe qu'après le `$group`.

Les deux pipelines remontent 8 011 documents du curseur au lieu de 10 000 : le filtre est bien appliqué **avant** l'agrégation dans les deux cas.

**Ce que l'optimiseur a fait — *aggregation pipeline optimization***

MongoDB ne prend pas le pipeline au pied de la lettre : il le réécrit avant exécution, tant que la réécriture est prouvée équivalente. Deux transformations se sont appliquées ici :

1. **Le *`$match` pushdown*.** L'optimiseur a fait **remonter** le `$match` au-dessus du `$group`. Il en a le droit parce que `usertype` fait partie de la clé de groupement `_id` : un document qui ne passe pas le filtre ne peut contribuer à aucun groupe qui le passerait. Filtrer avant ou après donne le même résultat, mais avant, on agrège 8 011 documents au lieu de 10 000.
2. **La fusion dans le curseur.** Une fois remonté en tête, le `$match` n'est même plus un étage de pipeline : il devient le **filtre de la requête sous-jacente**, exécutable par le moteur de requête — et donc, le cas échéant, capable d'utiliser un index.

`totalDocsExamined` reste à 10 000 dans les deux cas simplement parce qu'il n'existe **aucun index sur `usertype`** : le filtre est appliqué au fil d'un `COLLSCAN`. Avec un index, les deux pipelines passeraient ensemble en `IXSCAN`.

**La conclusion pratique :** sur ce cas, écrire le `$match` en premier n'apporte **rien en performance** — l'optimiseur le fait pour vous. Cela reste la bonne façon d'écrire, pour la lisibilité et parce que la Q23 montre que l'optimiseur a une frontière.

### Q23 — La limite de l'optimiseur

```js
db.trips.explain("executionStats").aggregate([
  { $group: { _id: "$start station id", n: { $sum: 1 } } },
  { $match: { n: { $gt: 50 } } }
])
```

| | Q22 (filtre sur un champ source) | **Q23 (filtre sur un champ calculé)** |
|---|---|---|
| Étages du plan | `["$cursor", "$group"]` | **`["$cursor", "$group", "$match"]`** |
| Filtre dans le curseur | `{ usertype: { $eq: "Subscriber" } }` | **aucun** — `COLLSCAN` nu |
| Documents remontés du curseur | 8 011 | **10 000** |

**Combien de documents traversent le `$group` ? Les 10 000.** Aucun n'est filtré en amont, et l'étage `$match` subsiste comme **troisième étage**, exécuté après coup sur les 462 groupes produits.

**Pourquoi l'optimiseur ne peut-il rien faire ici ?**

Parce que **le champ `n` n'existe pas avant le `$group` — c'est le `$group` qui le fabrique.**

`n` est le résultat de `{ $sum: 1 }`, c'est-à-dire un **agrégat** : sa valeur dépend de l'ensemble des documents d'un groupe, pas d'un document isolé. Il est donc impossible de décider si un document doit être retenu tant que **tous** les documents de son groupe n'ont pas été lus. Une station à 49 départs et une station à 51 départs sont indiscernables tant qu'on n'a pas fini de compter. Remonter le filtre reviendrait à décider avant de savoir.

La différence avec la Q22 est exactement là : `usertype` est une **propriété du document**, lisible sur chaque document indépendamment des autres ; `n` est une **propriété du groupe**, qui n'a de valeur qu'une fois l'agrégation terminée.

**Combien de stations dépassent 50 départs ?**

```js
db.trips.aggregate([
  { $group: { _id: "$start station id", n: { $sum: 1 } } },
  { $match: { n: { $gt: 50 } } },
  { $count: "stations" }
])
```

**34 stations**, sur **462** stations de départ distinctes — soit **7,4 %**.

**La règle générale qui en découle**

> **L'optimiseur peut déplacer un filtre tant qu'il porte sur une donnée qui existe déjà dans le document en entrée ; il ne le peut plus dès que le filtre porte sur une valeur produite par le pipeline lui-même.**

Deux corollaires pratiques :

- **Écrivez toujours le `$match` en premier quand il porte sur un champ source.** Non parce que l'optimiseur ne le ferait pas, mais parce que c'est plus lisible et que cela vous force à vérifier qu'un index existe sur ce champ.
- **Quand le filtre porte nécessairement sur un agrégat, le `$group` traversera tout.** La seule optimisation possible est alors de **réduire l'entrée en amont** — un `$match` supplémentaire sur un champ source, une plage de dates, une projection — ou de **matérialiser le résultat** avec `$merge` pour ne plus le recalculer. C'est exactement ce que la Q24 met en place et ce que la R1 chiffre.

## Partie B3 — Matérialisation et jointure

### Q24 — `$merge` : créer la collection `stations`

```js
db.trips.aggregate([
  { $group: { _id: "$start station id",
              nom:      { $first: "$start station name" },
              position: { $first: "$start station location" },
              departs:  { $sum: 1 } } },
  { $merge: { into: "stations", whenMatched: "replace" } }
])
```

**462 stations** obtenues.

| # | Station | `departs` |
|---|---|---|
| 1 | Central Park S & 6 Ave | **114** |
| 2 | Lafayette St & E 8 St | 99 |
| 3 | Carmine St & 6 Ave | 95 |

Les trois premières correspondent exactement au top 5 de la Q12 — la matérialisation n'a rien perdu.

Note sur `$first` : il prend la valeur du premier document du groupe. C'est valide ici parce que `nom` et `position` sont des **attributs de la station**, constants pour un même `start station id`. Sur un champ qui varierait à l'intérieur du groupe, `$first` renverrait une valeur arbitraire — c'est un piège classique.

### Q25 — `$out` vs `$merge`

| | `$out` | `$merge` |
|---|---|---|
| Collection existante | **Remplacée intégralement** | **Conservée**, document par document |
| Documents non produits par le pipeline | **Supprimés** | **Laissés en place** |
| Comportement sur collision | — | Configurable : `replace`, `merge`, `keepExisting`, `fail`, `pipeline` |
| Documents nouveaux | Insérés | Configurable : `insert` ou `discard` |
| Cible shardée | **Interdit** | Autorisé |
| Cible = collection source | Interdit | Autorisé |
| Atomicité | Bascule atomique en fin de pipeline | Écritures au fil de l'eau, **non atomique** |

En une phrase : **`$out` écrase, `$merge` réconcilie.**

**Lequel permet un rafraîchissement quotidien incrémental, et pourquoi ?**

**`$merge`, sans hésitation** — et `$out` en est structurellement incapable.

Le raisonnement : un rafraîchissement incrémental consiste à ne recalculer que ce qui a changé — les trajets de la veille — et à **fusionner** ce résultat partiel dans un tableau de bord qui contient déjà l'historique.

- Avec **`$out`**, la collection cible est intégralement remplacée par le résultat du pipeline. Si le pipeline ne traite que la veille, **toutes les stations qui n'ont eu aucun départ ce jour-là disparaissent du tableau de bord**. Pour éviter cela, il faudrait rejouer l'intégralité de l'historique chaque nuit — ce n'est plus incrémental, c'est un recalcul complet.
- Avec **`$merge`** et `whenMatched: "merge"` (ou un pipeline de mise à jour), on traite uniquement les nouveaux trajets, et chaque station existante est **mise à jour sur place** ; celles qui n'apparaissent pas dans le lot du jour restent intactes. C'est précisément la sémantique d'un *upsert* en masse.

Un exemple de rafraîchissement incrémental qui cumule au lieu d'écraser :

```js
db.trips.aggregate([
  { $match: { "start time": { $gte: ISODate("2016-01-02") } } },
  { $group: { _id: "$start station id", nom: { $first: "$start station name" }, departs: { $sum: 1 } } },
  { $merge: {
      into: "stations",
      whenMatched: [ { $set: { departs: { $add: ["$departs", "$$new.departs"] } } } ],
      whenNotMatched: "insert" } }
])
```

Deux avantages secondaires de `$merge` qui comptent en production :

- **Pas de trou de service.** `$out` remplace la collection à la fin du pipeline ; pendant le calcul, la cible reste l'ancienne, mais toute lecture pendant la bascule voit un état ou l'autre. `$merge` écrit au fil de l'eau, le tableau de bord reste interrogeable en continu.
- **Il fonctionne sur une cible shardée**, ce que `$out` refuse. Sur un cluster comme celui de la Partie A, `$out` est simplement hors jeu.

Le revers, à connaître : `$merge` n'est **pas atomique**. Si le pipeline échoue à mi-parcours, la collection cible est dans un état partiellement mis à jour. Sur un tableau de bord quotidien c'est acceptable ; sur des données transactionnelles, il faut un marqueur de version.

### Q26 — `$lookup` : top 5 des stations d'arrivée

```js
db.trips.aggregate([
  { $group: { _id: "$end station id", arrivees: { $sum: 1 } } },
  { $sort: { arrivees: -1 } },
  { $limit: 5 },
  { $lookup: { from: "stations", localField: "_id", foreignField: "_id", as: "st" } },
  { $project: { _id: 1, arrivees: 1,
                nom:     { $first: "$st.nom" },
                departs: { $first: "$st.departs" },
                solde:   { $subtract: ["$arrivees", { $first: "$st.departs" }] } } }
])
```

| # | Station | Arrivées | Départs (Q12) | **Solde** |
|---|---|---|---|---|
| 1 | E 17 St & Broadway | **96** | 86 | **+10** |
| 2 | Central Park S & 6 Ave | 95 | 114 | **−19** |
| 3 | Broadway & E 14 St | 91 | 93 | −2 |
| 4 | W 21 St & 6 Ave | 85 | 67 | **+18** |
| 5 | West St & Chambers St | 85 | 68 | **+17** |

Le `$limit: 5` est placé **avant** le `$lookup` : la jointure ne s'exécute que sur 5 documents au lieu de 462. C'est la règle générale — on réduit avant de joindre.

**Comparaison avec le classement des départs (Q12)**

Le top 5 des départs était : Central Park S & 6 Ave (114), Lafayette St & E 8 St (99), Carmine St & 6 Ave (95), Broadway & E 14 St (93), E 17 St & Broadway (86).

**Trois stations sur cinq apparaissent dans les deux classements** : Central Park S & 6 Ave, Broadway & E 14 St et E 17 St & Broadway. Ce sont des stations à fort trafic dans les deux sens — des nœuds du réseau.

Les deux autres sont **spécifiques aux arrivées** : `W 21 St & 6 Ave` et `West St & Chambers St` reçoivent chacune 85 vélos pour 67 et 68 émis, soit **+27 % et +25 %**. Elles sont absentes du top des départs.

**Que signale une station qui reçoit beaucoup plus de vélos qu'elle n'en émet ?**

Un **déséquilibre de flux**, et c'est le problème d'exploitation numéro un d'un service de vélos en libre-service. Trois lectures, de la plus opérationnelle à la plus stratégique :

1. **La station va saturer.** Une borne a un nombre fini d'ancrages. Une station qui encaisse +25 % en permanence finit **pleine**, et une station pleine est aussi inutilisable qu'une station vide : l'usager qui arrive ne peut pas rendre son vélo, doit repartir chercher une autre borne, et le trajet s'allonge. C'est un des générateurs des durées anormales de la Q20.

2. **Elle impose un rééquilibrage manuel.** L'opérateur doit envoyer un camion récupérer les vélos excédentaires pour les redéployer vers les stations déficitaires. C'est le poste de coût opérationnel principal du service, et il se pilote exactement avec cette mesure — d'où l'intérêt d'avoir mis le `solde` dans le pipeline.

3. **Elle révèle la géographie des usages.** Un solde positif marque une **destination** : un lieu où l'on va sans en revenir à vélo, typiquement parce qu'on repart en métro, à pied, ou parce que c'est un point bas topographique (on descend à vélo, on remonte autrement). `West St & Chambers St` est à Tribeca côté Hudson, `W 21 St & 6 Ave` à Chelsea — deux quartiers de destination un week-end.

Le cas symétrique est tout aussi parlant : **Central Park S & 6 Ave est à −19**, première station en départs et seulement deuxième en arrivées. C'est une **source** : on y prend un vélo pour aller ailleurs. Un jour férié, c'est cohérent — les gens partent de l'entrée du parc et rendent le vélo à destination.

En production, on n'attendrait pas un top 5 : on calculerait le solde sur **toutes** les stations, par tranche horaire, pour planifier les tournées de camions. La collection `stations` de la Q24 est précisément la structure qui rend ce calcul instantané.

## Partie B4 — Index géospatial `2dsphere`

Toutes les requêtes de cette partie sont dans `geo.js`. Point de référence : **Times Square**, `[-73.9855, 40.7580]` (longitude puis latitude).

### Q27 — Sans index

```js
db.trips.find({ "start station location": { $near: {
  $geometry: { type: "Point", coordinates: [-73.9855, 40.7580] }, $maxDistance: 500 } } })
```

```
MongoServerError: error processing query: ns=citibike.trips
Tree: GEONEAR  field=start station location maxdist=500 isNearSphere=0
Sort: {}
Proj: {}
planner returned error :: caused by :: unable to find index for $geoNear query
```

**Ce que dit l'erreur exactement :** le planificateur a construit un étage `GEONEAR`, puis a cherché un index géospatial pour l'alimenter et n'en a trouvé aucun — `unable to find index for $geoNear query`. Ce n'est pas un avertissement de performance, c'est un **refus d'exécution**.

**Pourquoi un index est-il obligatoire ici, alors qu'il n'est que conseillé pour une requête classique ?**

Parce que `$near` ne fait pas que filtrer : **il trie**. Sa sémantique est « les documents les plus proches d'abord », et le tri par distance fait partie du contrat de l'opérateur, pas d'un `.sort()` optionnel qu'on pourrait retirer.

Or trier par distance sans index supposerait de calculer la distance sphérique entre le point de référence et **chacun** des 10 000 documents, puis de trier l'ensemble en mémoire. MongoDB refuse pour deux raisons :

- **Le coût.** Un `COLLSCAN` peut se contenter d'un test d'égalité par document ; ici il faudrait une trigonométrie sphérique complète sur chaque document, puis un tri global soumis à la limite des 100 Mo en mémoire.
- **L'index géospatial n'est pas un accélérateur, c'est la structure de calcul elle-même.** Un index `2dsphere` encode la position par des cellules **S2** hiérarchiques, ce qui permet de parcourir l'espace **du plus proche au plus lointain** sans jamais calculer les distances lointaines. Sans cette structure, l'algorithme de `$near` n'existe tout simplement pas — il n'y a pas de version dégradée à proposer.

C'est la différence de nature avec un index B-tree ordinaire : sur `{ "start station id": 1 }`, l'index évite un scan ; sur du géospatial, il **fournit l'ordre de parcours**. D'où : conseillé dans un cas, obligatoire dans l'autre.

### Q28 — Avec l'index

```js
db.trips.createIndex({ "start station location": "2dsphere" })
```

```
start station location_2dsphere
```

La même requête renvoie alors **148 trajets** partant à moins de 500 m de Times Square.

**Les 5 premiers noms de station :**

| # | Station |
|---|---|
| 1 | W 45 St & 6 Ave |
| 2 | W 45 St & 6 Ave |
| 3 | W 45 St & 6 Ave |
| 4 | W 45 St & 6 Ave |
| 5 | W 45 St & 8 Ave |

**Dans quel ordre `$near` les renvoie-t-il ? Par distance croissante**, du plus proche au plus lointain. C'est un tri implicite, garanti par l'opérateur.

Le résultat le montre bien : les quatre premiers sont **le même point géographique** — `W 45 St & 6 Ave`, la station la plus proche de Times Square dans ce jeu (256 m, cf. Q30). Quatre trajets différents sont partis de cette station, ils ont tous la même distance, ils sortent donc en bloc avant la station suivante.

C'est un rappel utile : on interroge ici la collection `trips`, où **un document = un trajet**, pas une station. Les positions sont massivement dupliquées. C'est exactement pour cela que la Q30 travaille sur `stations` — une ligne par station — où la question « quelle est la station la plus proche » a un sens.

### Q29 — Le piège du comptage, encore

```js
db.trips.countDocuments({ "start station location": { $near: { ... } } })
```

```
MongoServerError: $geoNear, $near, and $nearSphere are not allowed in this context,
as these operators require sorting geospatial data.
If you do not need sort, consider using $geoWithin instead.
```

**Explication.** L'indice de l'énoncé donne la clé : **`countDocuments` est une agrégation déguisée**. Ce n'est pas une commande de comptage native — c'est un raccourci que le driver traduit en pipeline :

```js
db.trips.aggregate([ { $match: { ... } }, { $group: { _id: null, n: { $sum: 1 } } } ])
```

Le filtre atterrit donc dans un **`$match`**, et `$near` est interdit dans un `$match` de pipeline. La raison est cohérente avec la Q27 : `$near` **impose un tri**, or un étage `$match` n'a pas le droit de réordonner le flux — son contrat est de filtrer, pas de trier. Un tri obligatoire à l'intérieur d'un filtre est une contradiction que MongoDB refuse plutôt que d'ignorer silencieusement.

Le message le dit d'ailleurs lui-même : *« If you do not need sort, consider using `$geoWithin` instead »*. Et pour compter, on n'a effectivement pas besoin de l'ordre.

**L'opérateur de remplacement : `$geoWithin` + `$centerSphere`**

`$geoWithin` répond à « est-ce dans cette zone ? » — un prédicat booléen, sans notion d'ordre, donc parfaitement légal dans un `$match`.

Le rayon de `$centerSphere` s'exprime en **radians** : on divise les kilomètres par le rayon terrestre, **6 378,1 km**.

```js
db.trips.countDocuments({
  "start station location": { $geoWithin: { $centerSphere: [[-73.9855, 40.7580], 0.5 / 6378.1] } }
})
```

| Distance de Times Square | Rayon en radians | **Trajets** |
|---|---|---|
| moins de **500 m** | `0.5 / 6378.1` = 7,839 × 10⁻⁵ | **148** |
| moins de **1 000 m** | `1 / 6378.1` = 1,568 × 10⁻⁴ | **774** |

Contrôle croisé : les **148** de `$geoWithin` à 500 m correspondent exactement aux **148** résultats de `$near` en Q28. Les deux opérateurs délimitent bien la même zone — seul l'ordre de restitution diffère.

À noter : le nombre est multiplié par **5,2** en doublant le rayon, alors que la surface ne fait que quadrupler. La densité de stations augmente donc en s'éloignant du cœur de Times Square — logique, Times Square même est piétonnier et mal pourvu en bornes.

### Q30 — `$geoNear` sur la collection `stations`

```js
db.stations.createIndex({ position: "2dsphere" })

db.stations.aggregate([
  { $geoNear: { near: { type: "Point", coordinates: [-73.9855, 40.7580] },
                distanceField: "distance_m",
                maxDistance: 1000,
                spherical: true } },
  { $project: { _id: 0, nom: 1, departs: 1, distance_m: { $round: ["$distance_m", 0] } } },
  { $sort: { distance_m: 1 } }
])
```

**34 stations** à moins de 1 km de Times Square.

| # | Station | Distance | Départs |
|---|---|---|---|
| 1 | **W 45 St & 6 Ave** | **256 m** | 4 |
| 2 | W 45 St & 8 Ave | 298 m | 33 |
| 3 | Broadway & W 49 St | 310 m | 24 |
| 4 | Broadway & W 41 St | 332 m | 10 |
| 5 | W 43 St & 6 Ave | 362 m | 26 |
| 6 | W 41 St & 8 Ave | 421 m | 17 |
| 7 | W 42 St & 8 Ave | 465 m | 34 |
| 8 | Broadway & W 51 St | 510 m | 27 |

**La plus proche est `W 45 St & 6 Ave`, à 256 mètres.** C'est bien la station qui occupait les quatre premières places de la Q28 — les deux mesures se recoupent.

Observation métier : la station la plus proche n'est que 12ᵉ en volume de départs (4 trajets), quand `W 42 St & 8 Ave` à 465 m en compte 34. La proximité géographique du point de référence ne prédit pas le trafic — ce sont les correspondances (Port Authority sur la 8ᵉ avenue) qui le font.

**Pourquoi `$geoNear` doit-il être le premier stage du pipeline ?**

Pour la même raison qui rendait l'index obligatoire en Q27, poussée un cran plus loin. Trois angles :

1. **C'est un étage d'accès aux données, pas un étage de transformation.** `$geoNear` ne reçoit pas un flux de documents pour le filtrer : il **produit** le flux, en parcourant l'index `2dsphere` du plus proche au plus lointain. Comme il est la source, il ne peut être précédé de rien — au même titre qu'on ne peut pas mettre un `$match` avant le curseur.

2. **Il a besoin de l'index, et l'index ne s'applique qu'à la collection.** Dès qu'un étage antérieur a transformé le flux (`$group`, `$project`, `$unwind`), les documents en circulation ne sont plus ceux de la collection : l'index ne les décrit plus. `$geoNear` n'aurait plus aucune structure sur laquelle s'appuyer.

3. **Il impose un ordre, et cet ordre est son résultat.** Comme `$near`, `$geoNear` trie par distance. Si un étage précédent avait déjà trié le flux, `$geoNear` détruirait ce tri — MongoDB préfère interdire la construction plutôt que laisser écrire un pipeline dont le résultat dépendrait d'un ordre d'application non évident.

Le `$sort: { distance_m: 1 }` que j'ai laissé en fin de pipeline est donc **redondant** : `$geoNear` a déjà trié. Je le garde pour rendre l'intention explicite à la relecture, mais il ne coûte rien puisque le flux est déjà dans l'ordre.

C'est d'ailleurs l'avantage de `$geoNear` sur `$near` : il **matérialise la distance** dans un champ (`distanceField`), ce que `$near` ne fait pas. C'est ce qui permet ici de l'arrondir, de l'afficher, et de la réutiliser dans les étages suivants.

## Partie B5 — Diagnostic

L'analyse détaillée de cette partie est dans le livrable dédié **`diagnostic.md`**. Commandes et résultats exacts ci-dessous.

### Q31 — `explain()` sur `db.trips.find({ "start station id": 476 })`

**(a) Avant tout index**

```js
db.trips.find({ "start station id": 476 }).explain("executionStats")
```

| Métrique | Valeur |
|---|---|
| `stage` | **`COLLSCAN`** |
| `nReturned` | 36 |
| `totalKeysExamined` | **0** |
| `totalDocsExamined` | **10 000** |
| `executionTimeMillis` | 2 |

**(b) Après création de l'index**

```js
db.trips.createIndex({ "start station id": 1 })
```

| Métrique | Valeur |
|---|---|
| `stage` | **`FETCH` / `IXSCAN`** |
| `nReturned` | 36 |
| `totalKeysExamined` | **36** |
| `totalDocsExamined` | **36** |
| `executionTimeMillis` | 0 |

**(c) Ratio `totalDocsExamined / nReturned`**

| | `totalDocsExamined` | `nReturned` | Ratio |
|---|---|---|---|
| Avant index | 10 000 | 36 | **277,8** |
| Après index | 36 | 36 | **1,0** |
| Après index + projection couvrante | 0 | 36 | **0** |

**On vise 1** : un document lu par document rendu, zéro travail gaspillé. On ne l'atteint presque jamais sans projection parce qu'un ratio de 1 suppose que l'index discrimine **exactement** le prédicat : dès que la requête combine plusieurs critères dont l'index ne couvre qu'un préfixe, ou porte sur une plage (`$gt`, `$in`, une regex non ancrée), l'`IXSCAN` remonte plus de clés que nécessaire et le `FETCH` lit des documents que le filtre résiduel rejette **après** lecture.

Le cas mesuré ici est le cas idéal — égalité stricte, index dédié — d'où le 1,0. Pour faire mieux, il faut ne plus lire les documents du tout :

```js
db.trips.find({ "start station id": 476 }, { _id: 0, "start station id": 1 }).explain("executionStats")
```

```
stage             : PROJECTION_COVERED / IXSCAN
totalDocsExamined : 0
```

### Q32 — Le profiler

```js
db.setProfilingLevel(1, { slowms: 0 })
db.trips.find({ "end station name": "W 52 St & 9 Ave" })
db.trips.aggregate([{ $group: { _id: "$usertype", n: { $sum: 1 } } }])
db.setProfilingLevel(0)
db.system.profile.find({}, { op:1, ns:1, millis:1, planSummary:1, _id:0 })
```

**2 entrées**, une par opération :

| `op` | `ns` | `millis` | `planSummary` |
|---|---|---|---|
| `query` | `citibike.trips` | 3 | **`COLLSCAN`** |
| `command` | `citibike.trips` | 6 | **`COLLSCAN`** |

- **`op`** — nature de l'opération : `query` pour un `find`, `command` pour un `aggregate`.
- **`ns`** — le *namespace* `base.collection`, qui dit quelle collection encaisse la charge.
- **`millis`** — durée réelle côté serveur.
- **`planSummary`** — le résumé du plan choisi.

**`planSummary` vaut `COLLSCAN` pour les deux.** Ce qu'il apprend : c'est **le seul champ qui dit *pourquoi* une opération a été lente**, disponible *a posteriori*, sur du trafic réel, sans rejouer la requête. `IXSCAN {champ: 1}` → l'index sert, le problème est ailleurs ; `COLLSCAN` sur une grosse collection → il manque un index, action immédiate. C'est la différence de nature avec `explain()`, qui répond « comment cette requête *serait* exécutée » quand le profiler répond « comment les requêtes réellement lancées *l'ont été* ».

### Q33 — Les trois niveaux de profiling

| Niveau | Ce qui est enregistré |
|---|---|
| **0** | Rien — profiler désactivé, valeur par défaut |
| **1** | Uniquement les opérations dépassant `slowms` |
| **2** | **Toutes** les opérations |

**En production : niveau 1**, avec `slowms` calé sur le SLA — **100 ms** par défaut est un bon point de départ, 50 ms sur une API à faible latence, 500 ms sur du batch. On n'enregistre que ce qui est déjà anormal.

**Deux risques à laisser le niveau 2 sur une base chargée :**

1. **Le coût en écriture.** Chaque opération profilée déclenche une écriture supplémentaire dans `system.profile`. À 10 000 op/s, on double le volume d'écritures : le profiler ne mesure plus la charge, **il la crée**. La latence qu'on diagnostique augmente à cause de l'outil de diagnostic.

2. **La perte des données, par la nature *capped* de la collection.**

```js
db.system.profile.stats()
```

```
capped  : true
maxSize : 1048576 octets
```

C'est un **tampon circulaire de 1 Mo** : les entrées anciennes sont écrasées silencieusement. Une entrée pèse quelques centaines d'octets, 1 Mo tient donc quelques milliers d'opérations — sur une base chargée au niveau 2, le tampon fait un tour complet **en quelques secondes**. Quand l'incident survient à 14 h et qu'on lit le profiler à 14 h 10, **la trace a déjà été écrasée**. Le niveau 2 donne l'illusion d'une traçabilité complète tout en garantissant qu'on n'aura rien au moment utile.

Un troisième risque : `system.profile` contient les **valeurs** des requêtes, donc potentiellement des données personnelles — sujet de conformité sur une base réglementée.

### Q34 — Isoler les COLLSCAN de plus de N millisecondes

```js
db.system.profile.find(
  { planSummary: /COLLSCAN/,
    millis: { $gt: 100 },
    ns: { $ne: "citibike.system.profile" } },
  { _id: 0, ts: 1, op: 1, ns: 1, millis: 1, planSummary: 1, docsExamined: 1, nreturned: 1 }
).sort({ millis: -1 })
```

Résultat mesuré, avec `N = 1` ms (le jeu est trop petit pour dépasser 100 ms) :

```js
[
  { op: 'command', ns: 'citibike.trips', docsExamined: 10000, nreturned: 2,  millis: 6, planSummary: 'COLLSCAN' },
  { op: 'query',   ns: 'citibike.trips', docsExamined: 10000, nreturned: 48, millis: 3, planSummary: 'COLLSCAN' },
  { op: 'query',   ns: 'citibike.trips', docsExamined: 10000, nreturned: 48, millis: 2, planSummary: 'COLLSCAN' },
  { op: 'query',   ns: 'citibike.trips', docsExamined: 10000, nreturned: 3,  millis: 2, planSummary: 'COLLSCAN' }
]
```

Trois points qui comptent :

- **`planSummary: /COLLSCAN/`** en regex, pas en égalité : sur une requête à plusieurs plans le champ peut valoir `COLLSCAN, COLLSCAN` ou mêler `IXSCAN` et `COLLSCAN`.
- **`ns: { $ne: "citibike.system.profile" }`** : sinon les lectures du tableau de bord remontent dans ses propres résultats.
- **`docsExamined` et `nreturned` projetés** : on lit le ratio de la Q31 directement sur du trafic réel — ici **10 000 documents lus pour 2 rendus**, la ligne qui justifie un index chiffres à l'appui.

# Partie C — Réflexion

### R1 — Le tableau de bord quotidien

**L'architecture**

Le principe : **ne plus jamais recalculer une agrégation à l'affichage.** Le tableau de bord lit une collection déjà agrégée, alimentée une fois par nuit.

**1. Une collection matérialisée par `$merge`, rafraîchie à 6 h.** Un job planifié construit les collections de service — `stations` (Q24) et une collection `kpi_quotidiens` — à partir de `trips` :

```js
db.trips.aggregate([
  { $match: { "start time": { $gte: hier, $lt: aujourdhui } } },
  { $group: { _id: "$start station id",
              nom: { $first: "$start station name" },
              position: { $first: "$start station location" },
              departs: { $sum: 1 } } },
  { $merge: { into: "stations",
              whenMatched: [ { $set: { departs: { $add: ["$departs", "$$new.departs"] } } } ],
              whenNotMatched: "insert" } }
])
```

`$merge` et non `$out` (Q25) : le calcul ne porte que sur la veille, mais les stations sans départ ce jour-là doivent rester dans le tableau de bord. C'est ce qui rend le rafraîchissement **incrémental** — on lit une journée, pas tout l'historique.

**2. Un `$match` sur une plage de dates indexée en tête de pipeline.** Un index sur `start time` transforme la lecture nocturne en `IXSCAN` borné sur ~5 000 documents au lieu d'un `COLLSCAN` sur toute la collection. C'est le seul endroit où l'optimiseur peut aider (Q22) : le filtre porte sur un champ source, il descend dans le curseur.

**3. Les index de service sur les collections dérivées.** `{ departs: -1 }` sur `stations` pour les classements, `{ position: "2dsphere" }` pour les requêtes de proximité (Q30). Sur 462 documents ils coûtent quelques kilo-octets.

**4. Le profiler en niveau 1, `slowms: 100`, en permanence** (Q33), avec la requête de la Q34 branchée sur une alerte. C'est le filet : si un jour une page du tableau de bord repasse en `COLLSCAN`, on le sait avant les utilisateurs.

**Le chiffrage du gain**

| | Documents traversés |
|---|---|
| Agrégation complète sur `trips` (Q23) — `totalDocsExamined` | **10 000** |
| Lecture de la collection `stations` (Q24) | **462** |
| **Rapport** | **21,6** |

**Chaque affichage du tableau de bord lit 21,6 fois moins de documents.** Et ce rapport est un plancher, pour deux raisons :

- La Q23 a montré que le `$group` traverse **tous** les documents quoi qu'il arrive, l'optimiseur ne pouvant pas remonter un filtre portant sur un agrégat. Le coût du recalcul est donc proportionnel au volume de `trips`, qui grossit chaque jour.
- Le coût de la lecture de `stations` est proportionnel au nombre de **stations**, qui est stable — Citi Bike en ouvre quelques dizaines par an.

Sur le jeu réel : `trips` gagne ~50 000 courses par jour, `stations` reste à ~1 000 lignes. Au bout d'un an, le rapport n'est plus 21,6 mais plusieurs milliers. **L'écart se creuse tout seul, et c'est tout l'intérêt de la matérialisation.**

**Le compromis accepté**

C'est un arbitrage classique **fraîcheur contre coût de lecture**, et il porte sur trois points :

1. **La donnée affichée a jusqu'à 24 h de retard.** À 5 h 59, le tableau de bord montre encore les chiffres de l'avant-veille. C'est acceptable ici parce que la direction demande explicitement un tableau de bord **quotidien** : elle pilote des tendances, pas de l'opérationnel temps réel. Si demain elle veut suivre le rééquilibrage des camions (Q26), il faudra une seconde vue rafraîchie toutes les 15 minutes — l'architecture ne change pas, seule la fréquence du job.

2. **On duplique la donnée, donc on peut la désynchroniser.** Une correction rétroactive sur `trips` (un trajet annulé, une durée rectifiée) ne se propage pas toute seule dans `stations`. Il faut soit un recalcul complet périodique — un dimanche par mois — soit accepter la dérive. C'est le prix de toute dénormalisation.

3. **`$merge` n'est pas atomique** (Q25). Si le job de 6 h échoue à mi-parcours, `stations` est partiellement à jour. On ajoute donc un champ `maj_le` et le tableau de bord affiche la date du dernier rafraîchissement réussi — un chiffre daté vaut mieux qu'un chiffre douteux.

Ce qu'on **n'accepte pas** en échange : la perte de la donnée brute. `trips` reste la source de vérité, `stations` n'est qu'une vue reconstructible. À tout moment on peut jeter `stations` et la recalculer entièrement — c'est ce qui rend ce compromis réversible, donc raisonnable.

### R2 — La règle d'écriture des pipelines, vérifiée

**La règle, en trois phrases**

1. **L'optimiseur fait remonter un `$match` aussi haut que possible dans le pipeline, jusque dans le filtre du curseur, tant que le filtre porte sur un champ qui existe déjà dans les documents en entrée** — quitte à inverser un renommage pour retrouver le nom d'origine.
2. **Il ne le peut plus dès que le filtre porte sur une valeur que le pipeline a lui-même produite** — un accumulateur de `$group`, une expression calculée dans un `$project` — parce que cette valeur n'existe pas avant l'étage qui la fabrique.
3. **Écrivez donc le `$match` en premier quand il porte sur un champ source** : l'optimiseur le ferait pour vous, mais l'écrire vous force à vérifier qu'un index existe sur ce champ, et à voir immédiatement les cas où aucune remontée n'est possible.

**Le test : un `$match` après un `$project` qui supprime le champ filtré**

```js
db.trips.explain("executionStats").aggregate([
  { $project: { station: "$start station id", type: "$usertype" } },
  { $match: { type: "Subscriber" } }
])
```

Le `$project` ne conserve **ni `usertype` ni `start station id`** : il les renomme en `type` et `station`. Le `$match` porte donc sur un champ qui n'existe **pas** dans la collection.

**Résultat :**

```js
{
  "stage": "PROJECTION_DEFAULT",
  "transformBy": { "_id": true, "station": "$start station id", "type": "$usertype" },
  "inputStage": {
    "stage": "COLLSCAN",
    "filter": { "usertype": { "$eq": "Subscriber" } },
    "direction": "forward"
  }
}
```

| | Valeur |
|---|---|
| Étages d'agrégation restants | **aucun** — le pipeline entier a été absorbé |
| Filtre poussé dans le `COLLSCAN` | **`{ usertype: { $eq: "Subscriber" } }`** |
| `nReturned` | 8 011 |

**L'optimiseur remonte-t-il le `$match` cette fois ? Oui — et il fait mieux que le remonter.**

Deux choses se sont produites :

1. **Il a inversé le renommage.** L'utilisateur a écrit `{ type: "Subscriber" }` ; l'optimiseur a lu la table de transformation du `$project`, vu que `type` n'est que l'alias de `$usertype`, et **réécrit le filtre en `{ usertype: { $eq: "Subscriber" } }`** pour le poser sur la collection réelle.
2. **Il a fait disparaître le pipeline.** L'explain ne contient plus aucun tableau `stages` : `$project` et `$match` ont été convertis en un simple `find` avec projection. Il n'y a plus d'agrégation du tout.

**Ce que ce troisième cas apprend sur la frontière exacte**

Ma formulation initiale — « le filtre doit porter sur un champ qui existe en entrée » — était **trop restrictive**. La frontière réelle est ailleurs :

> **L'optimiseur peut remonter un `$match` tant qu'il sait calculer la transformation inverse, document par document. Il ne le peut plus dès que la valeur filtrée dépend de plusieurs documents.**

Le critère n'est pas *« le champ existe-t-il ? »* mais *« la valeur filtrée est-elle déterminée par le document seul ? »*. Les trois cas mesurés le montrent :

| Cas | Pipeline | `$match` remonté ? | Pourquoi |
|---|---|---|---|
| Q22 | `$group` → `$match` sur `_id.u` | ✅ oui | `usertype` est dans la clé de groupement, donc lisible sur chaque document |
| **R2** | `$project` → `$match` sur un **alias** | ✅ **oui** | Renommage pur, l'optimiseur inverse la correspondance |
| Q23 | `$group` → `$match` sur `n` | ❌ non | `n` est un **agrégat** — il faut avoir lu tout le groupe pour le connaître |

Vérification du critère sur un quatrième cas — un champ **calculé** par `$project`, et non un simple alias :

```js
db.trips.explain("executionStats").aggregate([
  { $project: { minutes: { $divide: ["$tripduration", 60] } } },
  { $match: { minutes: { $gt: 10 } } }
])
```

```
stages            : ["$cursor", "$match"]
filtre du COLLSCAN : aucun
nReturned curseur  : 10000
```

Le `$match` **survit comme étage séparé**, les 10 000 documents traversent le pipeline. Pourtant `minutes` est bien déterminé par le seul document — mais l'optimiseur ne cherche pas à inverser une division. Il ne remonte que les correspondances **triviales** (renommages, chemins directs), pas les expressions arithmétiques.

La frontière exacte est donc plus étroite que le critère théorique :

> **L'optimiseur remonte un `$match` quand la valeur filtrée est un champ source ou un simple alias de champ source. Toute expression calculée — arithmétique dans un `$project`, accumulateur dans un `$group` — bloque la remontée, même quand la transformation serait mathématiquement inversible.**

La conséquence pratique : **si vous devez filtrer sur une valeur calculée, filtrez sur l'expression source, pas sur le résultat.** Écrire `{ $match: { tripduration: { $gt: 600 } } }` avant le `$project` fait descendre le filtre dans le curseur et devient indexable ; écrire `{ $match: { minutes: { $gt: 10 } } }` après force la lecture intégrale. Les deux renvoient exactement le même résultat, avec un facteur 10 000 / 2 891 de différence sur les documents traversés.

### R3 — Le chiffre unique, et son coût

**(a) La phrase du rapport**

> **Durée moyenne d'un trajet Citi Bike : 14 min 18 s (858 s), calculée sur 9 946 trajets, après exclusion des 54 trajets de plus de 3 heures identifiés comme incidents de restitution (0,54 % du jeu). Données du 1er et 2 janvier 2016.**

Les quatre éléments sont indissociables :

| Élément | Valeur | Pourquoi il est obligatoire |
|---|---|---|
| **La valeur** | 858 s — 14 min 18 | C'est le chiffre demandé |
| **L'effectif retenu** | 9 946 | Permet de juger de la solidité et de recalculer |
| **Le critère d'exclusion explicite** | trajets > 3 h, soit 54 | Sans lui, la valeur n'est pas reproductible |
| **Le périmètre temporel** | 2 jours, dont un férié | La Q11 a montré que « janvier 2016 » est faux |

Sans exclusion, le même calcul donne **1 129,99 s — 18 min 50**. Les deux chiffres décrivent le même jeu de données et diffèrent de **32 %**. Seule la phrase complète permet de savoir lequel on lit.

**(b) La médiane**

```js
db.trips.aggregate([
  { $group: { _id: null,
              mediane: { $median: { input: "$tripduration", method: "approximate" } },
              moyenne: { $avg: "$tripduration" } } }
])
```

| Indicateur | Sur le jeu **non filtré** | Écart avec la médiane |
|---|---|---|
| **Médiane** (Q non filtré) | **578,78 s** — 9 min 39 | — |
| Moyenne Q13 (non filtrée) | 1 129,99 s — 18 min 50 | **+95,2 %** |
| Moyenne Q21 (hors > 3 h) | 858,03 s — 14 min 18 | +48,2 % |

Par `usertype`, sur le jeu non filtré :

| `usertype` | Médiane | Moyenne Q13 | Écart |
|---|---|---|---|
| `Subscriber` | **489,68 s** — 8 min 10 | 762,36 s | +55,7 % |
| `Customer` | **1 296 s** — 21 min 36 | 2 610,71 s | +101,4 % |

**Laquelle des trois valeurs est la plus robuste ? La médiane, très nettement.**

La démonstration est dans les chiffres eux-mêmes. La médiane est calculée sur le jeu **non filtré** — elle inclut les 54 trajets aberrants, dont un de 3 jours et 18 heures. Et pourtant :

```
Médiane non filtrée   : 578,78 s
Médiane hors > 3 h    : 575,69 s
Écart                 : 3,09 s, soit 0,5 %
```

**Les mêmes 54 documents qui déplaçaient la moyenne de 32 % déplacent la médiane de 0,5 %.** Un facteur **64** entre les deux sensibilités.

La raison est structurelle : la moyenne intègre la **valeur** de chaque observation, la médiane n'intègre que son **rang**. Un trajet de 326 222 s compte, pour la médiane, exactement autant qu'un trajet de 1 801 s : c'est « une observation au-dessus du milieu ». Pour la moyenne, il pèse 430 trajets ordinaires. Sur une distribution à queue longue — et la Q16 a montré que 91 % des trajets tiennent sous 30 minutes pendant que la borne haute doit monter à 11 jours — c'est décisif.

Autrement dit : **la médiane n'a pas besoin qu'on nettoie les données pour donner le bon ordre de grandeur.** La moyenne, si — et le nettoyage est précisément l'étape où l'on introduit des choix discutables.

L'écart moyenne/médiane est d'ailleurs lui-même un indicateur : +95 % globalement, +101 % chez les `Customer` contre +56 % chez les `Subscriber`. Il mesure l'asymétrie de la distribution, et confirme sans autre calcul que les `Customer` concentrent les valeurs extrêmes — ce que la Q21 avait établi en comptant les exclusions.

**Ce que je livrerais réellement à la direction :** la médiane comme chiffre principal, la moyenne nettoyée en second, et l'écart entre les deux comme signal de qualité. Un chiffre unique sans son indicateur de dispersion reste une information appauvrie.

**(c) En quoi une réponse sans précaution serait-elle malhonnête — et pas seulement imprécise ?**

La distinction tient à ce que l'on sait au moment où l'on parle.

**L'imprécision est un état de la mesure ; la malhonnêteté est un choix de présentation.** Annoncer 18 min 50 sans rien dire ne serait imprécis que si l'on ignorait ce que ce chiffre contient. Or à ce stade, on a mesuré que :

- 54 trajets sont des incidents de restitution et non des usages (Q20) ;
- ces 54 documents déplacent la moyenne de 32 % (Q21) ;
- ils se concentrent à 76 % sur une seule population (Q21b) ;
- le jeu couvre 2 jours fériés et non « janvier » (Q11, Q14) ;
- la médiane, elle, ne bouge pas de 0,5 % (R3b).

Livrer un chiffre unique en connaissant tout cela, ce n'est plus se tromper : c'est **choisir de ne pas transmettre ce qui permettrait au lecteur d'évaluer le chiffre**. L'erreur est du côté de l'analyste, pas de la donnée.

Trois raisons qui font basculer de l'imprécis vers le malhonnête :

1. **Le chiffre devient irréfutable.** Sans critère d'exclusion ni effectif, personne en réunion ne peut le contester, le recalculer, ni même savoir quelle question il répond. Une imprécision annoncée reste discutable ; une imprécision masquée fait taire la discussion. C'est l'inverse de ce qu'un chiffre est censé produire.

2. **Le choix est orienté, et invisible.** Entre 9 min 39, 14 min 18 et 18 min 50, l'analyste retient une valeur. Chacune sert un discours différent — « nos usagers font des trajets courts et utilitaires » ou « nos usagers roulent longtemps, le service est attractif ». Ne pas dire lequel des trois on a pris, ni pourquoi, revient à faire passer un arbitrage éditorial pour une constatation neutre. **C'est la précaution omise qui transforme un calcul en argument.**

3. **La décision qui suit engage des moyens.** Si la direction dimensionne des tournées de rééquilibrage ou une grille tarifaire sur 18 min 50 alors que l'usage réel est à 9 min 39, l'erreur ne reste pas dans le tableur. Le coût est réel, et il est supporté par des gens qui n'ont jamais vu la donnée.

La règle que j'en tire : **un chiffre transmis sans son périmètre n'est pas un résultat, c'est une affirmation.** La précaution n'est pas une réserve de prudence ajoutée à la fin — c'est ce qui distingue une mesure d'une opinion chiffrée.

### R4 — `explain()` ou profiler ?

**Ce que chacun voit, et que l'autre ne voit pas**

| | `explain()` | Profiler |
|---|---|---|
| **Nature** | Simulation *a priori* sur **une** requête que j'écris | Enregistrement *a posteriori* du trafic **réel** |
| **Périmètre** | La requête que je soupçonne | Toutes les opérations, y compris celles auxquelles je n'ai pas pensé |
| **Détail** | Plan complet : tous les plans candidats, `totalKeysExamined`, `totalDocsExamined`, l'arbre des étages | Résumé : `planSummary`, `millis`, `docsExamined`, `nreturned` |
| **Charge réelle** | Invisible — une requête isolée sur un serveur au repos | Visible — durée réellement subie, sous la concurrence du moment |
| **Fréquence** | Invisible | **Visible** — combien de fois la requête est passée |
| **Coût** | Nul en `queryPlanner`, une exécution en `executionStats` | Une écriture par opération profilée |

**Ce que `explain()` voit et que le profiler ne voit pas :** le **pourquoi détaillé**. Sur la Q31, il donne l'arbre complet — `FETCH` / `IXSCAN`, 36 clés examinées, 36 documents lus — et surtout les **plans rejetés**, qui disent quels index ont été envisagés et écartés. Le profiler s'arrête à `planSummary: COLLSCAN` : il annonce le symptôme, pas le raisonnement. `explain()` permet aussi de tester un index **avant** de le créer, sur une requête qui n'a encore jamais été exécutée en production.

**Ce que le profiler voit et que `explain()` ne voit pas :** **ce qui se passe vraiment**. `explain()` répond à la question que je pose ; le profiler me montre les questions que je n'ai pas pensé à poser. En Q32, il a capté une agrégation à 6 ms et un `find` à 3 ms, toutes deux en `COLLSCAN`, sans que j'aie eu à deviner lesquelles étaient lentes. Il apporte trois choses que `explain()` ne peut structurellement pas donner : la **fréquence** (une requête à 50 ms lancée 10 000 fois/min coûte plus cher qu'une requête à 2 s lancée une fois par heure), la **durée réellement subie** sous charge concurrente, et les **requêtes inconnues** — celles d'un ORM, d'un job oublié, d'un dashboard tiers.

En une phrase : **`explain()` explique une requête, le profiler désigne laquelle expliquer.**

**L'incident : « l'appli est lente depuis 14 h »**

L'ordre que je suivrais : **logs → `mongostat` → profiler → `explain()`**. Il est dicté par le coût de chaque outil et par le nombre d'hypothèses qu'il élimine.

**1. Les logs applicatifs et MongoDB.** *Coût : nul, aucune action sur la base.*

Première question : **qu'est-ce qui a changé à 14 h ?** Un déploiement, un job batch, un pic de trafic, un basculement de primaire, un disque plein. Les logs répondent en quelques minutes, et un `getMore` massif ou un `Slow query` déjà journalisé par MongoDB oriente immédiatement.

Ce que cela élimine : **tout ce qui n'est pas la base**. Une lenteur réseau, une saturation applicative, un cache tombé. Commencer par la base quand le problème est ailleurs, c'est perdre l'heure la plus utile.

**2. `mongostat`.** *Coût : une connexion, quelques dizaines d'octets par seconde.*

Il donne en temps réel le pouls du serveur : opérations par seconde par type, `qrw`/`arw` (files d'attente en lecture/écriture), taux de défaut du cache, `netIn`/`netOut`. En dix secondes, on sait **si le serveur est saturé et de quel côté**.

Ce que cela élimine : la question **« est-ce un problème de volume ou un problème de requête ? »**. Si les files d'attente sont vides et les opérations/s normales, la base n'est pas le goulot — retour au point 1. Si `qr` explose, on tient le symptôme et on continue.

**3. Le profiler.** *Coût : une écriture par opération profilée. Réel mais maîtrisable en niveau 1.*

Là, on cherche **quelle** requête. Niveau 1 avec un `slowms` calé sur ce que `mongostat` a montré, puis la requête de la Q34 :

```js
db.system.profile.find(
  { planSummary: /COLLSCAN/, millis: { $gt: 100 } },
  { ts:1, op:1, ns:1, millis:1, planSummary:1, docsExamined:1, nreturned:1 }
).sort({ millis: -1 })
```

Ce que cela élimine : **toutes les requêtes sauf les coupables**. On passe de « la base est lente » à « ces trois requêtes sur `citibike.trips` sont en `COLLSCAN` à 800 ms, 400 fois par minute depuis 14 h 02 ». Le `ts` recoupe l'heure de l'incident, la fréquence hiérarchise, `docsExamined / nreturned` donne le ratio de la Q31 directement sur le trafic réel.

Pourquoi pas avant `mongostat` : le profiler **coûte des écritures sur une base déjà en souffrance**. On ne l'active qu'une fois sûr que le problème est bien dans les requêtes, et sur une fenêtre courte.

**4. `explain()`.** *Coût : une exécution de la requête, à faire hors production si elle est lourde.*

On tient la requête coupable, on cherche **pourquoi** son plan est mauvais et **quel index** la corrigerait. `explain("executionStats")` donne l'arbre, le ratio avant, et permet de valider l'index candidat avant de le créer — une création d'index sur une collection volumineuse est elle-même un événement de production.

Ce que cela élimine : **les fausses corrections**. C'est le seul outil qui prouve qu'un index donné va effectivement changer le plan, plutôt que d'en créer trois au jugé.

**La justification de l'ordre**

Chaque étape est **plus coûteuse et plus étroite** que la précédente, et chacune réduit l'espace des hypothèses de l'étape suivante :

| Étape | Coût | Hypothèse éliminée | Question qui reste |
|---|---|---|---|
| Logs | nul | Le problème est-il ailleurs que dans la base ? | Où, dans la base ? |
| `mongostat` | négligeable | Est-ce une saturation globale ou une requête ? | Laquelle ? |
| Profiler | écritures | Quelles requêtes, à quelle fréquence ? | Pourquoi celle-ci ? |
| `explain()` | une exécution | Quel plan, quel index ? | — |

Inverser l'ordre, c'est **payer cher pour répondre à la mauvaise question**. Lancer `explain()` en premier suppose de deviner la requête coupable : sur une base qui en sert des centaines, la probabilité de tomber juste est faible, et chaque essai raté coûte une exécution. Activer le profiler en niveau 2 en premier ajoute une charge d'écriture à un serveur déjà saturé — et, comme la Q33 l'a montré, le tampon capped de 1 Mo aura écrasé les traces de 14 h avant qu'on ne les lise.

**Le principe général : on part de l'outil qui coûte le moins et qui élimine le plus d'hypothèses, et on ne restreint le périmètre qu'une fois la couche précédente écartée.** Un incident se diagnostique par élimination, pas par intuition — et l'intuition, quand elle est bonne, se vérifie de toute façon en quatre minutes avec les trois premières étapes.
