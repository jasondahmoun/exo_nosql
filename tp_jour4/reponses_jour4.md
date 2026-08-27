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
