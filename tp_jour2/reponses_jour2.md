# TP Jour 2 — Modélisation, Indexation & Drivers

MongoDB 7.0 via Docker · base `mflix` · collections `movies` et `comments`

## Partie 0

```bash
curl -L -o movies.json   https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/movies.json
curl -L -o comments.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/comments.json
wc -l movies.json comments.json

docker cp movies.json   mongo-ipssi:/tmp/movies.json
docker cp comments.json mongo-ipssi:/tmp/comments.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection movies   --drop --file /tmp/movies.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection comments --drop --file /tmp/comments.json
```

`wc -l` : **23539** et **50304** · import : 23539 et 50304 documents, 0 échec.

Contrôle P0 : `db.movies.countDocuments({})` = **23539**, `db.comments.countDocuments({})` = **50304**.

Structure repérée dans `movies` — tableaux `genres`, `cast`, `directors` ; sous-documents `imdb`,
`tomatoes`, `awards`. Dans `comments` — `movie_id` (ObjectId) est la référence vers `movies._id`.

## Partie 1

| Q | Commande | Résultat |
|---|---|---|
| Q1a | `db.movies.countDocuments({})` | **23539** |
| Q1b | `db.comments.countDocuments({})` | **50304** |
| Q1c | `db.movies.distinct("genres").length` | **25** |
| Q4a | `db.movies.countDocuments({ num_mflix_comments: { $exists: true } })` | **15740** — 66,87 % |
| Q5 | `db.movies.countDocuments({ year: { $type: "string" } })` | **37** |
| Q6 | `db.movies.countDocuments({ "imdb.rating": "" })` | **61** |

### Q2 — commentaires orphelins

```js
db.comments.aggregate([
  { $lookup: { from: "movies", localField: "movie_id", foreignField: "_id", as: "film" } },
  { $match: { film: { $eq: [] } } },
  { $count: "orphelins" }
])
```

**9224 orphelins**, soit **18,34 %** des 50 304 commentaires. Aucune contrainte de clé étrangère
n'a empêché leur insertion : MongoDB a accepté 9 224 `movie_id` qui ne désignent aucun document.

### Q3 — films distincts référencés

```js
db.comments.aggregate([{ $group: { _id: "$movie_id" } }, { $count: "films_references" }])
```

**14245** `movie_id` distincts. Mais le `$group` compte des identifiants, pas des films : en
recroisant avec `movies`, seuls **7449** correspondent à un film réel, les **6796** autres pointent
dans le vide et portent à eux seuls les 9 224 orphelins de la Q2.

```js
db.comments.aggregate([
  { $group: { _id: "$movie_id" } },
  { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "f" } },
  { $group: { _id: { $eq: [{ $size: "$f" }, 0] }, n: { $sum: 1 } } }
])
```
`[{ _id: true, n: 6796 }, { _id: false, n: 7449 }]`

La réponse à publier est **7449 films réellement commentés**, pas 14 245.

### Q4 — Computed Pattern

**(a)** 15 740 films sur 23 539 portent `num_mflix_comments`, soit **66,87 %**. 7 799 films ne
l'ont pas du tout : le champ pré-calculé n'est même pas présent partout.

**(b)** Deux films portent ce titre, le libellé exact de l'énoncé désigne celui de 2009 :

```js
db.movies.find({ title: /Taking of Pelham/ }, { title: 1, year: 1, num_mflix_comments: 1 })
```

| Film | `num_mflix_comments` |
|---|---|
| The Taking of Pelham One Two Three (1974) | 1 |
| **The Taking of Pelham 1 2 3 (2009)** | **437** |

```js
const f = db.movies.findOne({ title: "The Taking of Pelham 1 2 3" })
db.comments.countDocuments({ movie_id: f._id })
```

Compteur : **437** · réel : **161**.

**(c)** Écart absolu **+276**, soit **+171,43 %**. Le compteur **sur-estime** : il annonce **2,71×**
le nombre réel de commentaires.

**(d)** L'utilisateur lit « 437 commentaires », clique, et en trouve 161 : il manque 276 entrées,
les deux tiers de ce qui lui était promis. Rien ne signale l'erreur, ni côté base ni côté écran.

Ce que révèle l'écart sur les compteurs dénormalisés en général : un champ pré-calculé est une
**copie**, et une copie ne se met à jour que si quelqu'un écrit le code qui la met à jour. Dès que
l'écriture du compteur et l'écriture de la donnée source ne sont pas atomiques — suppression de
commentaires en masse, purge, import, bug applicatif — les deux divergent définitivement. La base
ne détecte pas la dérive, ne la corrige pas, et sert la valeur fausse avec la même autorité qu'une
valeur juste. Le gain de lecture se paie en fiabilité, et la facture n'arrive qu'au moment où un
utilisateur compare. Ampleur mesurée sur tout le catalogue en Q16.

### Q5 — type bracketing

**37 films** ont un `year` stocké en chaîne. Valeurs relevées : `'1981è'`, `'1994è1998'`,
`'2006è2012'`… — des plages d'années de séries, écrasées dans un champ prévu pour un entier.

```js
db.movies.countDocuments({ year: { $gte: 2000 } })   // 13721
db.movies.countDocuments({ year: { $type: "int" } }) // 23502
```

`{ year: { $gte: 2000 } }` les ignore **silencieusement** parce que MongoDB compare **à l'intérieur
d'un même type BSON** (type bracketing). L'opérande `2000` est un nombre, donc `$gte` ne parcourt
que la plage des valeurs numériques ; les chaînes appartiennent à une plage BSON distincte et ne
sont jamais candidates. Aucune erreur, aucun avertissement : la requête renvoie 13 721 et paraît
correcte. **26** des 37 chaînes désignent pourtant une année ≥ 2000 et manquent au résultat.

### Q6 — chaîne vide et moyenne

**61 films** ont `imdb.rating: ""`. 23 478 ont une note numérique.

```js
db.movies.aggregate([{ $group: { _id: null, moy: { $avg: "$imdb.rating" }, n: { $sum: 1 } } }])
```
`{ moy: 6.693466223698782, n: 23539 }`

Le piège tient à la **dissociation entre la moyenne et son effectif**. `$avg` ignore les valeurs non
numériques : la moyenne 6,6935 est en réalité calculée sur 23 478 notes, pas sur les 23 539
documents que `$sum: 1` affiche à côté. On publie donc un effectif faux avec une moyenne juste.

Pire si le calcul est refait à la main avec `$sum` puis division par le nombre de documents :

| Méthode | Effectif | Moyenne |
|---|---|---|
| `$avg` (ignore les `""`) | 23 478 réels, 23 539 affichés | **6,6935** |
| `$sum / nb documents` | 23 539 | **6,6761** |

Les 61 chaînes vides comptent alors comme des zéros au dénominateur et tirent la moyenne vers le
bas. Correctif : filtrer sur le type avant d'agréger.

```js
db.movies.aggregate([
  { $match: { "imdb.rating": { $type: "number" } } },
  { $group: { _id: null, moy: { $avg: "$imdb.rating" }, n: { $sum: 1 } } }
])
```
`{ moy: 6.693466223698782, n: 23478 }`

## Partie 2

Tableau `explain()` complet avant/après dans **`index_bench.md`**.

| Q | Commande | Résultat |
|---|---|---|
| Q8a | `db.movies.countDocuments({ genres: "Drama", year: { $gte: 2000 } })` | **7761** |
| Q9a | `db.movies.countDocuments({ title: { $regex: /Godfather/ } })` | **5** |
| Q9b | `db.movies.countDocuments({ $text: { $search: "godfather" } })` | **12** |
| Q9d | `db.movies.countDocuments({ $text: { $search: "godfathers" } })` | **12** |

### Q7 — index multi-clés

| | Stage | totalDocsExamined | nReturned |
|---|---|---|---|
| (a) avant | `COLLSCAN` | **23539** | 105 |
| (b) après `db.movies.createIndex({ genres: 1 })` | `FETCH ← IXSCAN` | **105** | 105 |

`totalDocsExamined` passe de 23 539 à 105, soit **224× moins**. `genres` étant un tableau, l'index
est **multi-clés** : MongoDB indexe chaque valeur du tableau séparément, sans qu'on ait à le
déclarer.

### Q8 — règle ESR

**(a)** 7761 films.

**(b)** Ordre ESR → `{ genres: 1, "imdb.rating": -1, year: 1 }`

```js
db.movies.createIndex({ genres: 1, "imdb.rating": -1, year: 1 }, { name: "esr_ok" })
```

- **E**quality → `genres: "Drama"`. Une égalité fixe **un seul point d'entrée** dans l'arbre : toutes
  les clés utiles sont contiguës derrière ce préfixe. Placée en tête, elle réduit d'emblée la zone à
  parcourir.
- **S**ort → `imdb.rating: -1`. À l'intérieur du bloc « Drama », les clés sont déjà rangées par note
  décroissante. Le curseur n'a qu'à les lire dans l'ordre : **pas de tri à faire**.
- **R**ange → `year: { $gte: 2000 }`. Une plage est le seul des trois à **disperser** les clés. En
  dernière position elle ne casse l'ordre de rien : on filtre au passage, l'ordre de tri survit.

Une plage placée avant le champ de tri détruirait l'ordre du tri — c'est exactement ce que R3
mesure.

**(c)** Vérification :

| Index | Stage | totalKeysExamined | totalDocsExamined |
|---|---|---|---|
| `esr_ok` | **`FETCH ← IXSCAN`** | 7834 | 7761 |

**Aucun stage `SORT`.** Le tri est entièrement couvert par l'index — rien n'est trié en mémoire.

### Q9 — index text

**(a)** `/Godfather/` → **5** : `The Godfather`, `The Godfather: Part II`, `The Godfather: Part III`,
`Godfather`, `Tokyo Godfathers`.

**(b)**
```js
db.movies.createIndex({ title: "text", plot: "text" }, { name: "titre_intrigue_txt" })
db.movies.countDocuments({ $text: { $search: "godfather" } })
```
→ **12**

**(c) Écart : +7.** Trois films que seul `$text` trouve :

| Titre | Pourquoi |
|---|---|
| Jane Austen's Mafia! | `plot` : « Takeoff on **the Godfather** with the son of a mafia king… » |
| The Nutcracker in 3D | `plot` : « …whose **godfather** gives her a special doll… » |
| C(r)ook | `plot` : « The mafia **godfather** suspects treason. » |

Aucun n'a « Godfather » dans son titre. Ils sortent parce que l'index text porte sur **deux champs**,
`title` **et** `plot` : la recherche couvre l'intrigue, là où le `$regex` de (a) ne regardait que le
titre.

**(d) Stemming confirmé.** `$text` sur « godfathers » renvoie **12**, exactement comme le singulier.
La racine indexée est la même, le pluriel et le singulier sont donc interchangeables.

Un `$regex` n'aurait rien fait de tel :

| Requête | Résultat |
|---|---|
| `{ $text: { $search: "godfathers" } }` | **12** |
| `{ title: { $regex: /godfathers/ } }` | **0** |
| `{ title: { $regex: /Godfathers/ } }` | **1** |

Le regex cherche une suite de caractères littérale : il ignore la casse s'il n'a pas `/i`, et ne sait
rien de la morphologie. `/godfathers/` ne trouve rien du tout, `/Godfathers/` ne trouve que
`Tokyo Godfathers` et **rate les 3 films Godfather** que tout utilisateur attend en premier.

**(e) Quand le `$regex` reste préférable : la sous-chaîne qui n'est pas un mot entier.**

`$text` découpe le texte en mots ; il ne sait pas chercher **à l'intérieur** d'un mot. Vérifié :

| Requête | Résultat | `The Godfather` trouvé ? |
|---|---|---|
| `{ $text: { $search: "father" } }` | 1060 | **non** (0) |
| `{ title: { $regex: /father/i } }` | 67 | **oui** |

`$text` renvoie 1060 films contenant le **mot** « father », mais pas `The Godfather` : « father » y
est un fragment de « Godfather », pas un mot. Le `$regex` le trouve.

D'où le cas d'usage : **numéro de série, référence produit, fragment de code, SKU** — chercher
`ABC-123` dans `REF-ABC-12345` est un problème de sous-chaîne, pas de vocabulaire. Le `$text` est
structurellement incapable de le résoudre ; le `$regex` est le bon outil, même s'il coûte un
`COLLSCAN`.

### Q10 — inventaire et suppression

```js
db.movies.getIndexes()
```

| Index | Clé | Créé par |
|---|---|---|
| `_id_` | `{ _id: 1 }` | **personne — MongoDB le crée automatiquement** |
| `genres_1` | `{ genres: 1 }` | Q7 |
| `esr_ok` | `{ genres: 1, "imdb.rating": -1, year: 1 }` | Q8 |
| `esr_ko` | `{ genres: 1, year: 1, "imdb.rating": -1 }` | R3 |
| `titre_intrigue_txt` | `{ _fts: "text", _ftsx: 1 }` | Q9 |

Celui qu'on n'a pas créé : **`_id_`**. MongoDB l'impose à toute collection, il est unique et ne peut
pas être supprimé.

```js
db.movies.dropIndex("titre_intrigue_txt")   // { nIndexesWas: 5, ok: 1 }
```

**Pourquoi un index inutilisé est un coût pur.** Il ne se contente pas d'occuper du disque et de la
RAM : il est **maintenu à chaque écriture**. Tout `insert`, `update` ou `delete` doit mettre à jour
l'index en plus du document — un coût payé sur le chemin d'écriture, en permanence, pour zéro
lecture accélérée. Un index text est le pire cas : il indexe chaque mot de chaque champ couvert. Sur
`title` + `plot`, cela fait plusieurs entrées par film. Il concurrence aussi les index utiles dans
le cache : de la RAM occupée par des données que personne ne lit est de la RAM retirée à celles que
tout le monde lit.
