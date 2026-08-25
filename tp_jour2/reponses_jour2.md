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
