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

## Partie 3 — `analyses.js`

### Q11 — top 5 des genres

```js
db.movies.aggregate([
  { $unwind: "$genres" },
  { $group: { _id: "$genres", films: { $sum: 1 } } },
  { $sort: { films: -1 } },
  { $limit: 5 }
])
```

| Genre | Films |
|---|---|
| Drama | **13789** |
| Comedy | 7024 |
| Romance | 3665 |
| Crime | 2678 |
| Thriller | 2658 |

Drama à lui seul couvre 58,6 % du catalogue. La somme dépasse 23 539 : un film porte plusieurs
genres, `$unwind` le compte une fois par genre. (Aucun ex æquo ici, mais le `_id: 1` est ajouté au
`$sort` par cohérence avec Q14 et Q15.)

### Q12 — films par décennie

```js
db.movies.aggregate([
  { $match: { year: { $type: "int" } } },
  { $group: { _id: { $subtract: ["$year", { $mod: ["$year", 10] }] }, films: { $sum: 1 } } },
  { $sort: { films: -1 } }
])
```

Top 3 :

| Décennie | Films |
|---|---|
| **2000** | **7749** |
| 2010 | 5972 |
| 1990 | 3773 |

Le `$match { year: { $type: "int" } }` écarte les 37 chaînes de la Q5. Sans lui, le pipeline ne
renvoie pas un résultat approximatif : il **échoue**.

```
Location16611 — $mod only supports numeric types, not string and int
```

Contraste instructif avec la Q5 : le même jeu de données mal typé provoque ici une **erreur bruyante**
qui arrête tout, alors qu'un `find({ year: { $gte: 2000 } })` l'ignorait **silencieusement**. Le
framework d'agrégation est strict sur les types là où le langage de requête est permissif — la panne
franche est de loin la moins dangereuse des deux.

### Q13 — note IMDB moyenne des Drama

```js
db.movies.aggregate([
  { $match: { genres: "Drama", "imdb.rating": { $type: "number" } } },
  { $group: { _id: null, moyenne: { $avg: "$imdb.rating" }, films: { $sum: 1 } } },
  { $project: { _id: 0, films: 1, moyenne: { $round: ["$moyenne", 4] } } }
])
```

Moyenne **6.8305** sur **13751** films.

13 751 et non 13 789 (Q11) : le filtre de type écarte **38** Drama dont la note est la chaîne vide de
la Q6. C'est précisément la correction que la Q6 réclamait.

### Q14 — top 3 réalisateurs

```js
db.movies.aggregate([
  { $unwind: "$directors" },
  { $group: { _id: "$directors", films: { $sum: 1 } } },
  { $sort: { films: -1, _id: 1 } },
  { $limit: 3 }
])
```

| Réalisateur | Films |
|---|---|
| **Woody Allen** | **40** |
| John Ford | 35 |
| John Huston | 34 |

**Attention — la 3e place est un ex æquo.** `John Huston` et `Takashi Miike` ont **34 films chacun** ;
`Werner Herzog` suit à 33. Un `$sort: { films: -1 }` seul départage donc **arbitrairement** : deux
exécutions successives de la même requête ont renvoyé Huston puis Miike. D'où le second critère de
tri `_id: 1` ajouté dans `analyses.js`, qui rend le résultat **reproductible**. Un « top N » sans
critère de départage n'est pas un résultat stable.

### Q15 — `$lookup` inversé, top 5 des films les plus commentés

```js
db.comments.aggregate([
  { $group: { _id: "$movie_id", commentaires: { $sum: 1 } } },
  { $sort: { commentaires: -1 } },
  { $limit: 5 },
  { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "film" } },
  { $unwind: "$film" },
  { $project: { _id: 0, titre: "$film.title", commentaires: 1, compteur: "$film.num_mflix_comments" } }
])
```

| Titre | Commentaires réels | `num_mflix_comments` | Écart |
|---|---|---|---|
| The Taking of Pelham 1 2 3 | **161** | 437 | +276 |
| Terminator Salvation | 158 | 416 | +258 |
| 50 First Dates | 158 | 403 | +245 |
| Ocean's Eleven | 158 | 424 | +266 |
| About a Boy | 158 | 441 | +283 |

Le film le plus commenté du catalogue en porte **161**. Et le compteur est faux sur **les cinq**,
toujours dans le même sens : sur-estimation. Ce n'est pas un accident isolé — cf. Q16.

Ici aussi il y a un ex æquo : **4 films ont exactement 158 commentaires**. La composition du top 5
est donc stable (un film à 161, quatre à 158, les suivants à 157), mais **l'ordre interne des quatre
ne l'est pas** sans critère de départage — d'où le `$sort: { commentaires: -1, titre: 1 }` final.

## Partie 4 — `patterns.py`

```python
client = MongoClient("mongodb://admin:ipssi2025@localhost:27017/?authSource=admin")
db = client["mflix"]
```

### Q16 — réconciliation du Computed Pattern

Un seul `aggregate` sur `comments` chargé dans un `dict` Python, puis comparaison — pas de boucle de
23 539 `count_documents` :

```python
reels = { d["_id"]: d["n"] for d in db.comments.aggregate(
    [{"$group": {"_id": "$movie_id", "n": {"$sum": 1}}}]) }
```

| | |
|---|---|
| Films portant `num_mflix_comments` | 15740 |
| **Compteurs incohérents** | **12244** |
| Part des compteurs faux | **77,79 %** |
| Films sans le champ mais commentés | 0 |

**12 244 compteurs sur 15 740 sont faux, soit plus de trois sur quatre.** Le Pelham de la Q4 n'était
pas un cas isolé : c'est l'état normal du champ. Les 7 799 films sans le champ n'ont, eux, aucun
commentaire — leur absence est cohérente.

### Q17 — correction par `bulk_write`

```python
ops = [UpdateOne({"_id": f["_id"]}, {"$set": {"num_mflix_comments": reel}}) ...]
db.movies.bulk_write(ops)
```

| | |
|---|---|
| `matchedCount` | 20043 |
| **`modifiedCount`** | **20043** |
| Re-vérification Q16 | **0 incohérence** sur 23539 films |

20 043 = les 12 244 compteurs faux **+** les 7 799 films auxquels le champ manquait et qui reçoivent
désormais un `0` explicite. Le champ est maintenant présent et juste sur les 23 539 films.

### Q18 — Subset Pattern

Pour les 10 films les plus commentés, on embarque les 3 commentaires les plus récents, réduits à
`{ name, text, date }` :

```python
recents = list(db.comments.find({"movie_id": mid}, {"_id": 0, "name": 1, "text": 1, "date": 1})
                          .sort("date", -1).limit(3))
db.movies.bulk_write([UpdateOne({"_id": mid}, {"$set": {"recent_comments": recents}})])
```

Vérification sur *The Taking of Pelham 1 2 3* (161 commentaires) :

| | |
|---|---|
| `recent_comments` | **3 sous-documents** |
| Clés conservées | `date`, `name`, `text` |
| Plus récent | 2017-06-28 — Robert Baratheon |
| Films porteurs | 10 |

**Pourquoi 3 et pas 161 ?** Parce que la page film n'en affiche que quelques-uns. Le Subset Pattern
embarque **ce que sert la vue principale**, pas la totalité de la relation :

- **Ce qu'on gagne** — la page s'affiche avec **une seule lecture**, sans requête vers `comments` ni
  `$lookup`. Le document reste petit : 3 × 284 o ≈ 852 octets contre ~45,7 Ko pour les 161.
- **Ce qu'on éviterait de perdre** — embarquer 161 commentaires ferait payer leur poids à *toute*
  lecture du film, y compris une liste de résultats qui n'affiche que le titre et l'affiche.
- **Le tableau reste borné.** 3 est une constante ; 161 est une valeur qui grandit sans limite. Un
  tableau non borné dans un document est le défaut de conception que le pattern sert justement à
  éviter.

`comments` reste la source de vérité : `recent_comments` est un cache d'affichage, et il hérite du
même risque de dérive que `num_mflix_comments` (cf. R4).
