# diagnostic.md — `explain()` et profiler

Base `citibike`, collection `trips`, **10 000 trajets**. Instance `mongo-j4` (port 27017).

## Q31 — `explain()` sur `db.trips.find({ "start station id": 476 })`

### (a) Avant tout index

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

Aucune clé examinée : il n'y a pas d'index à parcourir. MongoDB lit les 10 000 documents et en jette 9 964.

### (b) Après création de l'index

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

L'`IXSCAN` descend directement sur les 36 entrées d'index de la valeur 476, le `FETCH` va chercher les 36 documents correspondants. Plus rien n'est lu inutilement.

### (c) Ratio `totalDocsExamined / nReturned`

| | `totalDocsExamined` | `nReturned` | Ratio |
|---|---|---|---|
| Avant index | 10 000 | 36 | **277,8** |
| Après index | 36 | 36 | **1,0** |
| Après index **+ projection couvrante** | 0 | 36 | **0** |

**La valeur visée est 1** : un document lu pour un document rendu, c'est-à-dire zéro travail gaspillé.

**Pourquoi ne l'atteint-on presque jamais sans projection ?** Parce qu'un ratio de 1 suppose que l'index discrimine **exactement** le prédicat. Dès que la requête combine plusieurs critères dont l'index ne couvre qu'un préfixe, ou qu'elle porte sur une plage (`$gt`, `$in`, une regex non ancrée), l'`IXSCAN` remonte plus de clés que nécessaire, le `FETCH` va chercher les documents correspondants, et le filtre résiduel en rejette une partie **après** lecture. Ces documents lus pour rien font monter le ratio.

Le cas mesuré ici est le cas idéal — égalité stricte sur un champ unique, index dédié — et c'est justement pour cela qu'il tombe à 1.

Le seul moyen de faire **mieux** que 1, c'est de ne plus lire les documents du tout :

```js
db.trips.find({ "start station id": 476 }, { _id: 0, "start station id": 1 }).explain("executionStats")
```

```
stage             : PROJECTION_COVERED / IXSCAN
totalDocsExamined : 0
```

`PROJECTION_COVERED` : toutes les données demandées sont déjà dans l'index, le `FETCH` disparaît. **Ratio 0**. C'est la requête couverte — le seul cas où l'on répond sans jamais toucher la collection.

## Q32 — Le profiler

```js
db.setProfilingLevel(1, { slowms: 0 })
db.trips.find({ "end station name": "W 52 St & 9 Ave" })
db.trips.aggregate([{ $group: { _id: "$usertype", n: { $sum: 1 } } }])
db.setProfilingLevel(0)
```

`slowms: 0` fait tomber le seuil à zéro : **toutes** les opérations sont enregistrées, pas seulement les lentes.

```js
db.system.profile.find({}, { op:1, ns:1, millis:1, planSummary:1, _id:0 })
```

**2 entrées**, une par opération :

| `op` | `ns` | `millis` | `planSummary` |
|---|---|---|---|
| `query` | `citibike.trips` | 3 | **`COLLSCAN`** |
| `command` | `citibike.trips` | 6 | **`COLLSCAN`** |

- **`op`** — la nature de l'opération : `query` pour un `find`, `command` pour un `aggregate` (qui passe par la commande `aggregate`), et aussi `insert`, `update`, `remove`, `getmore`.
- **`ns`** — le *namespace*, `base.collection`. Il permet de savoir quelle collection encaisse la charge.
- **`millis`** — la durée réelle de l'opération côté serveur.
- **`planSummary`** — **le résumé du plan d'exécution choisi**, la colonne la plus utile du profiler.

**Que vaut `planSummary` et qu'est-ce que cela apprend ?**

Les deux valent **`COLLSCAN`**. C'est le plan « je lis toute la collection ». Sur ces deux requêtes c'est attendu : `end station name` n'a pas d'index, et le `$group` doit de toute façon voir tous les documents.

L'intérêt est ailleurs : `planSummary` est **le seul champ qui dit *pourquoi* une opération a été lente**, et il est disponible **a posteriori, sur du trafic réel, sans avoir à rejouer la requête**. Quand il vaut `IXSCAN { champ: 1 }`, l'index est utilisé et le problème est ailleurs (volume, contention, réseau). Quand il vaut `COLLSCAN` sur une base de plusieurs millions de documents, le diagnostic est immédiat et l'action évidente : il manque un index.

C'est la différence de nature avec `explain()` : `explain()` répond « comment cette requête *serait* exécutée si je la lançais », le profiler répond « comment les requêtes que les utilisateurs ont *réellement* lancées ont été exécutées ».

## Q33 — Les trois niveaux de profiling

| Niveau | Ce qui est enregistré |
|---|---|
| **0** | Rien. Profiler désactivé — c'est le défaut. |
| **1** | Uniquement les opérations dont la durée dépasse `slowms`. |
| **2** | **Toutes** les opérations, sans exception. |

**Lequel en production, et avec quel `slowms` ?**

Le **niveau 1**, avec un `slowms` calé sur le SLA applicatif — en pratique **100 ms**, la valeur par défaut, est un bon point de départ ; on descend à 50 ms sur une API à faible latence, on monte à 500 ms sur du batch. L'idée est de n'enregistrer que ce qui est déjà anormal : le volume écrit reste marginal, et tout ce qui atterrit dans `system.profile` mérite d'être regardé.

Le **niveau 2 n'a sa place qu'en investigation ponctuelle**, sur une fenêtre de quelques minutes, idéalement sur un secondaire.

**Deux risques à laisser le niveau 2 activé sur une base chargée**

**1. Le coût en écriture.** Chaque opération profilée déclenche **une écriture supplémentaire** dans `system.profile`. Sur une base à 10 000 opérations/seconde, on double le volume d'écritures : le profiler ne mesure plus la charge, il la crée. Les I/O, le cache WiredTiger et le journal encaissent le surcoût, et la latence que l'on cherchait à diagnostiquer augmente à cause de l'outil de diagnostic. Le résultat est faussé en plus d'être coûteux.

**2. La perte des données, à cause de la nature *capped* de la collection.**

```js
db.system.profile.stats()
```

```
capped  : true
maxSize : 1048576 octets
```

`system.profile` est une **collection plafonnée à 1 Mo par défaut** : c'est un tampon circulaire, les entrées les plus anciennes sont écrasées silencieusement par les nouvelles.

**Conséquence concrète** : une entrée pèse quelques centaines d'octets, 1 Mo tient donc **quelques milliers d'opérations**. Sur une base chargée au niveau 2, le tampon fait un tour complet en **quelques secondes**. Quand l'incident survient à 14 h et qu'on va lire le profiler à 14 h 10, la trace de l'incident a déjà été écrasée — il ne reste que les dix dernières secondes de trafic normal. **Le niveau 2 donne l'illusion d'une traçabilité complète tout en garantissant qu'on n'aura rien au moment où on en aura besoin.**

Le niveau 1 échappe à ce piège précisément parce qu'il écrit peu : le tampon couvre alors des heures, voire des jours.

Un troisième risque, moins souvent cité : `system.profile` peut contenir les **valeurs des requêtes** (`command`), donc potentiellement des données personnelles. Sur une base qui traite des données réglementées, tout profiler large est aussi un sujet de conformité.

## Q34 — Isoler les COLLSCAN lents

La requête de tableau de bord :

```js
db.system.profile.find(
  { planSummary: /COLLSCAN/,
    millis: { $gt: 100 },
    ns: { $ne: "citibike.system.profile" } },
  { _id: 0, ts: 1, op: 1, ns: 1, millis: 1, planSummary: 1, docsExamined: 1, nreturned: 1 }
).sort({ millis: -1 })
```

Trois points qui comptent :

- **`planSummary: /COLLSCAN/`** en regex et non en égalité stricte : sur une requête à plusieurs plans, le champ peut valoir `COLLSCAN, COLLSCAN` ou mêler `IXSCAN` et `COLLSCAN`. L'égalité stricte raterait ces cas.
- **`ns: { $ne: "citibike.system.profile" }`** : sans cette exclusion, les lectures du tableau de bord lui-même remontent dans ses propres résultats.
- **`sort({ millis: -1 })`** : les pires d'abord, c'est-à-dire les index à créer en premier.

Résultat mesuré, avec `N = 1` ms (le jeu est trop petit pour dépasser 100 ms) :

```js
[
  { op: 'command', ns: 'citibike.trips', docsExamined: 10000, nreturned: 2,  millis: 6, planSummary: 'COLLSCAN' },
  { op: 'query',   ns: 'citibike.trips', docsExamined: 10000, nreturned: 48, millis: 3, planSummary: 'COLLSCAN' },
  { op: 'query',   ns: 'citibike.trips', docsExamined: 10000, nreturned: 48, millis: 2, planSummary: 'COLLSCAN' },
  { op: 'query',   ns: 'citibike.trips', docsExamined: 10000, nreturned: 3,  millis: 2, planSummary: 'COLLSCAN' }
]
```

En ajoutant `docsExamined` et `nreturned` à la projection, on lit directement le ratio de la Q31 sur du trafic réel : **10 000 documents lus pour 2 rendus**, soit un ratio de 5 000. C'est exactement la ligne qui justifie la création d'un index, chiffres à l'appui.

En production on branche cette requête sur une alerte : *plus de N COLLSCAN de plus de 100 ms sur la dernière heure* → ticket automatique, avec le `ns` et le ratio dans le corps du ticket.
