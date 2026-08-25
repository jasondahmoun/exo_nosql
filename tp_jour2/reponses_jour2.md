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

## Partie 5 — `transaction.js`

```bash
docker run -d --name mongo-rs -p 27018:27017 mongo:7.0 --replSet rs0
docker exec mongo-rs mongosh --port 27017 --eval "rs.initiate()"
```

Les deux collections sont réimportées dans ce nœud (23 539 / 50 304), qui devient primaire.

### Q19 — modération atomique

```js
const s = db.getMongo().startSession();
s.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
try {
  const sdb = s.getDatabase("mflix");
  sdb.comments.deleteOne({ _id: cible._id });
  sdb.movies.updateOne({ _id: film._id }, { $inc: { num_mflix_comments: -1 } });
  s.commitTransaction();
} catch (e) {
  s.abortTransaction();
}
```

**Transaction 1 — commit** (film *The Taking of Pelham 1 2 3*) :

| | `num_mflix_comments` | Commentaires réels |
|---|---|---|
| Avant | 437 | 161 |
| Après commit | **436** | **160** |

Les deux collections bougent ensemble.

**Transaction 2 — abort**, avec lecture depuis l'intérieur et depuis l'extérieur de la session :

| Point de vue | `num_mflix_comments` | Commentaires |
|---|---|---|
| Dans la session, avant commit | **435** | **159** |
| Hors session, au même instant | **436** | **160** |
| Après `abortTransaction()` | **436** | **160** |

Le commentaire visé est toujours présent après l'abort (`countDocuments({_id: cible2._id})` = 1).
**Rien n'a été appliqué.**

### Ce que garantit chaque lettre, ici

- **A — Atomicité.** Le `deleteOne` et le `$inc` forment **un seul geste**. Sans transaction, un
  crash entre les deux laisserait un compteur décrémenté pour un commentaire toujours en base —
  exactement le type de dérive mesuré en Q16. L'abort le prouve : deux écritures déjà exécutées ont
  été annulées ensemble.
- **C — Cohérence.** L'invariant métier « `num_mflix_comments` = nombre de commentaires » est vrai
  avant et après. La base ne connaît pas cet invariant — c'est la transaction qui empêche
  l'application de le briser.
- **I — Isolation.** Mesuré directement : pendant la transaction, la session voit **435/159** et le
  reste du monde **436/160**. Aucun autre client ne lit l'état intermédiaire. Le
  `readConcern: "snapshot"` fige une vue cohérente pour toute la durée.
- **D — Durabilité.** `writeConcern: { w: "majority" }` : le commit n'est acquitté qu'une fois
  répliqué sur la majorité du replica set. Une panne du primaire juste après ne perd pas l'écriture.

C'est aussi la raison de la Partie 5 : les transactions **exigent un replica set**, car elles
s'appuient sur l'oplog et les snapshots. Sur le nœud standalone du Jour 1, `startTransaction()`
échoue.

## Partie 6 — Réflexion

### R1 — Ce que le SGBD ne fait plus pour vous

**La responsabilité qui bascule : l'intégrité référentielle.** En relationnel, une clé étrangère
`comments.movie_id → movies._id` fait **rejeter** par le moteur toute insertion pointant vers un
film inexistant, et impose au moment du `DELETE` un `CASCADE` ou un `RESTRICT`. MongoDB n'a pas de
clé étrangère : `movie_id` est un champ comme un autre, dont la sémantique de référence n'existe que
dans la tête du développeur. Le contrôle passe intégralement **du moteur vers l'application**.

**Le chiffre.** Q2 : **9224 commentaires orphelins** sur **50304** (Q1), soit **18,34 % de la
collection qui pointe dans le vide**. Près d'un commentaire sur cinq référence un film absent. Et
Q3 le confirme côté identifiants : sur 14 245 `movie_id` distincts, **6796 ne correspondent à aucun
film** — seuls 7 449 sont de vraies références. Aucune de ces 9 224 insertions n'a été refusée :
la base les a toutes acceptées sans un avertissement.

**Deux stratégies applicatives, et leur facture :**

**1. Validation à l'écriture** — vérifier l'existence du film avant d'insérer le commentaire, ou
déclarer un [JSON Schema validator](https://www.mongodb.com/docs/manual/core/schema-validation/) sur
la collection.

*Ce que ça coûte :* un **aller-retour supplémentaire à chaque écriture** (lecture de `movies` avant
insertion dans `comments`), donc de la latence sur le chemin le plus chaud. Surtout, la couverture
est **partielle et illusoire** : la vérification et l'insertion ne sont pas atomiques sans
transaction — le film peut être supprimé entre les deux. Et un validator `$jsonSchema` sait
contrôler un **type** (`movie_id` est bien un ObjectId), pas une **existence** : il ne peut pas
interroger une autre collection. Il n'aurait bloqué aucun de nos 9 224 orphelins.

**2. Suppression en cascade applicative, dans une transaction** — supprimer un film et ses
commentaires dans une même transaction ACID, comme en Partie 5.

*Ce que ça coûte :* de la **complexité** et de la **performance**. Il faut un replica set (contrainte
d'infrastructure), les transactions multi-documents sont nettement plus lourdes que des écritures
simples, et surtout la discipline doit être **absolue** : il suffit d'**un seul** chemin de code qui
supprime un film sans passer par la fonction transactionnelle — un script de purge, un import, une
correction manuelle en console — pour recréer des orphelins. La garantie ne vaut que si 100 % des
appelants la respectent, alors que la clé étrangère relationnelle, elle, ne pouvait pas être
contournée.

**Le vrai enseignement :** ces deux stratégies préviennent, aucune ne répare. D'où la nécessité d'une
troisième ligne — un **job de réconciliation périodique**, comme celui de la Q16 — qui détecte et
corrige la dérive après coup. On remplace une garantie du moteur par un processus applicatif à
maintenir.

### R2 — Embed vs reference : la borne

**Le film le plus commenté en porte 161** (Q15, *The Taking of Pelham 1 2 3*).

**Estimation du poids**, méthode du Jour 1 (R3) — `db.comments.stats().avgObjSize` = **284 octets**
par commentaire, `db.movies.stats().avgObjSize` = **1606 octets** par film.

| | Calcul | Taille |
|---|---|---|
| 161 commentaires imbriqués | 161 × 284 o | **45 724 o ≈ 44,7 Ko** |
| Film + ses 161 commentaires | 1 606 + 45 724 | **47 330 o ≈ 46,2 Ko** |
| Part de la limite BSON de 16 Mo | | **0,282 %** |
| Commentaires nécessaires pour saturer 16 Mo | (16 777 216 − 1 606) / 284 | **59 069** |

**Ce n'est donc PAS la limite des 16 Mo qui tranche.** Le pire cas du jeu occupe moins de 0,3 % du
plafond ; il faudrait **59 069 commentaires sur un seul film** — 367 fois le maximum observé — pour
l'atteindre. Sur ce jeu de données, l'argument des 16 Mo ne mord pas.

**Ce qui tranche vraiment, ce sont trois autres choses :**

1. **Le tableau n'est pas borné.** 161 est un maximum *observé*, pas une limite *structurelle*. Rien
   n'empêche un film viral d'en accumuler 50 000. Un modèle qui fonctionne aujourd'hui et casse à
   une valeur qu'on ne contrôle pas est un modèle qui casse — la question est quand, pas si.

2. **Les écritures sont fréquentes et concurrentes.** C'est le critère du cours : *reference quand
   les écritures sont fréquentes*. Chaque nouveau commentaire réécrirait le document film. À 161
   commentaires, chaque ajout fait réécrire ~46 Ko pour ajouter 284 octets, avec contention sur le
   document et croissance qui force MongoDB à le relocaliser.

3. **La règle d'or joue contre l'imbrication ici.** *« Data that is accessed together should be
   stored together »* — or les commentaires **ne sont pas lus avec le film** dans la plupart des
   accès. Une liste de résultats, une affiche, une recherche par genre n'affichent que titre, année
   et note. Imbriquer ferait payer 46 Ko à chaque lecture qui n'a besoin que de 1,6 Ko : les
   commentaires sont une **section secondaire**, chargée sur demande. C'est du 1:beaucoup entre deux
   entités indépendantes — un commentaire a sa propre vie (modération, signalement, profil
   utilisateur). **Référencer est le bon choix.**

**Dans quel cas imbriquerait-on quand même ?** Quand les trois critères s'inversent : relation
**1:peu et bornée par construction**, lue **systématiquement avec le parent**, et **peu réécrite**.
Concrètement ici : le **Subset Pattern de la Q18** — les 3 commentaires les plus récents sont
imbriqués (852 octets, borné par une constante du code, affiché sur la page film) pendant que les
161 restent référencés. Ce n'est pas embed *ou* reference, c'est **les deux** : on imbrique la
tranche que la vue principale consomme, on référence le reste.

### R3 — ESR, vérifié par l'expérience

**Pourquoi cet ordre, avec mes mots.** Un index composé est une liste **triée une seule fois**, selon
les champs pris dans l'ordre déclaré — comme un annuaire trié par ville, puis nom, puis prénom. Tout
découle de là :

- L'**égalité** en premier parce qu'elle **découpe un bloc contigu** : « genres = Drama » désigne une
  tranche continue de l'index, tout le reste est ignoré d'un coup. C'est le filtre le plus rentable
  par position.
- Le **tri** juste après, parce qu'à l'intérieur de ce bloc les clés sont **déjà dans l'ordre
  voulu**. Le curseur les lit en séquence et le tri est gratuit — il ne reste rien à trier.
- La **plage en dernier**, parce qu'une plage **éparpille** les clés au lieu de les regrouper. Placée
  avant le champ de tri, elle rend l'ordre du tri inutilisable : les résultats sortent triés d'abord
  par année, et l'ordre des notes est brisé à chaque changement d'année. MongoDB doit alors **tout
  remonter en mémoire et retrier**.

**La preuve.** Second index dans le mauvais ordre, forcé au `.hint()` :

```js
db.movies.createIndex({ genres: 1, year: 1, "imdb.rating": -1 }, { name: "esr_ko" })
db.movies.find({ genres: "Drama", year: { $gte: 2000 } })
         .sort({ "imdb.rating": -1 }).hint("esr_ko").explain("executionStats")
```

**(a)**

| Index | Stage | totalKeysExamined | totalDocsExamined | ms |
|---|---|---|---|---|
| `esr_ok` `{ genres, imdb.rating, year }` | `FETCH ← IXSCAN` | **7834** | 7761 | **8** |
| `esr_ko` `{ genres, year, imdb.rating }` | **`FETCH ← SORT ← IXSCAN`** | 7761 | 7761 | 21 |

**Oui, un stage `SORT` apparaît** avec `esr_ko`, et il est absent avec `esr_ok`.

**(b) L'écart.** Sur les volumes lus, il est presque nul : `esr_ko` examine même **73 clés de
moins** (7 761 contre 7 834), et exactement autant de documents. Le résultat contre-intuitif mérite
d'être dit : **le mauvais index lit légèrement moins**, parce qu'avec `year` en deuxième position la
plage est appliquée dans l'index et aucune clé inutile n'est touchée ; `esr_ok` traverse au contraire
73 clés qui échoueront sur le filtre `year`.

**Ce n'est pourtant pas là que se joue le coût.** `esr_ko` est **2,6× plus lent** — 21 ms contre 8 ms
— pour un nombre de documents identique. Le surcoût n'est **pas** dans les lectures, il est dans le
**tri bloquant** : les 7 761 documents doivent être **intégralement matérialisés en mémoire** avant
que la première ligne puisse sortir. `esr_ok` est donc le moins coûteux, de 13 ms sur cette requête,
et l'écart réel est plus grave que ce chiffre :

- Le `SORT` est **bloquant** : avec un `.limit(10)`, `esr_ok` s'arrête après 10 clés là où `esr_ko`
  doit d'abord trier les 7 761. C'est là que le rapport explose.
- La mémoire consommée croît avec le **nombre de résultats**, pas avec la taille du `limit`.

**La leçon : `totalDocsExamined` seul ne suffit pas à juger un index.** Ici, les deux index lisent la
même chose et l'un est 2,6× plus lent. Il faut regarder le **stage**.

**(c) Si le tri en mémoire dépasse la limite.** L'énoncé mentionne 32 Mo — sur **MongoDB 7.0 la
valeur par défaut est 100 Mo** (`internalQueryMaxBlockingSortMemoryUsageBytes` = **104857600**,
relevé sur l'instance ; 32 Mo était la valeur des versions antérieures à la 4.4).

Vérifié en abaissant volontairement le paramètre à 100 000 octets :

| | Résultat |
|---|---|
| `aggregate` `$sort`, `allowDiskUse: false` | **`QueryExceededMemoryLimitNoDiskUseAllowed`** — *« Sort exceeded memory limit of 100000 bytes, but did not opt in to external sorting. »* |
| `aggregate` `$sort`, `allowDiskUse: true` | **OK — 13 789 documents triés sur disque** |
| `find().sort()` | **pas d'erreur** |

La requête **échoue** — elle ne dégrade pas, elle ne ralentit pas : elle est **abandonnée**. En
production cela se traduit par une erreur utilisateur, sur la requête qui a le plus de résultats,
c'est-à-dire au pire moment.

Deux issues : `{ allowDiskUse: true }`, qui autorise le déversement sur disque au prix d'un net
ralentissement — ou **créer le bon index**, qui supprime le tri au lieu de lui trouver de la place.

Nuance relevée à l'exécution : `find().sort()` **n'a pas levé d'erreur**, seul l'`aggregate` l'a
fait. Depuis MongoDB 4.4, les tris de `find()` déversent sur disque **par défaut** ; c'est le
pipeline d'agrégation qui exige un `allowDiskUse` explicite.

### R4 — Le Computed Pattern : le bénéfice et sa facture

**Le bénéfice, chiffré.** `num_mflix_comments` évite un recomptage à chaque affichage. Sans lui,
afficher « N commentaires » impose un `countDocuments({ movie_id })` ou un `$lookup` — et Q3 donne
l'ampleur : **7449 films sont réellement commentés**. Chaque page film de ces 7 449, chaque ligne de
liste, chaque résultat de recherche déclencherait une agrégation sur une collection de 50 304
commentaires. Sur une page de 20 films, c'est **20 agrégations pour afficher 20 nombres**. Le champ
pré-calculé remplace tout cela par une lecture déjà présente dans le document : **coût zéro**, la
donnée arrive avec le film. C'est un vrai gain, et il est la raison d'être du pattern.

**Le risque, chiffré.** Q16 : **12244 compteurs faux sur 15740 films portant le champ, soit
77,79 %**. **Plus de trois compteurs sur quatre mentent.** Et pas d'un peu — Q4 : 437 affichés contre
161 réels, soit **2,71× le vrai chiffre**. Q15 montre que les 5 films les plus commentés sont *tous*
faux, tous sur-estimés. Le pattern n'a pas légèrement dérivé : **il a cessé de décrire la réalité**,
tout en continuant à être servi avec la même autorité qu'une donnée juste.

**Le vrai danger n'est pas l'erreur, c'est le silence.** Rien ne signale la dérive. Pas d'exception,
pas de log, pas d'incohérence visible à la lecture. Il a fallu **écrire une requête exprès** (Q16)
pour la découvrir — le job de réconciliation de la Q17, qui a corrigé 20 043 documents. Un compteur
faux se comporte exactement comme un compteur juste.

**À quelle condition ce pattern est-il acceptable en production ?** Trois, cumulatives :

1. **Toute écriture de la source met à jour le compteur dans la même transaction.** C'est exactement
   la Partie 5 : supprimer un commentaire **et** décrémenter le compteur atomiquement. Le `$inc`
   hors transaction est la faille par laquelle les 12 244 incohérences sont entrées.

2. **Un job de réconciliation périodique tourne et alerte.** La Q17 l'a fait une fois
   (`modifiedCount` = 20 043) ; en production il tourne en continu. Corriger ne suffit pas : il faut
   **mesurer le taux de dérive** — si 77,79 % des compteurs sont faux, le problème est en amont, et
   un job qui corrige sans alerter ne fait que masquer un bug d'écriture.

3. **La donnée tolère l'approximation.** Un compteur de commentaires peut afficher 158 au lieu de
   161 sans conséquence. **Un solde bancaire, un stock, un décompte de places ne le peuvent pas.**
   C'est le critère décisif : le Computed Pattern échange de la **fraîcheur** contre de la
   **vitesse**, et cet échange n'est acceptable que si l'approximation est sans conséquence métier.

**En un mot :** le Computed Pattern ne coûte rien à lire et tout à maintenir. Le bénéfice est
immédiat et visible, la facture est différée et invisible — c'est précisément ce qui le rend
dangereux. Il est acceptable là où l'à-peu-près l'est ; il ne l'est jamais par défaut, et jamais
sans le job qui le surveille.

## Pour aller plus loin

### B1 — Covered query

Première tentative sur l'index multi-clés `genres_1` :

```js
db.movies.find({ genres: "Film-Noir" }, { genres: 1, _id: 0 }).explain("executionStats")
```
→ `PROJECTION_SIMPLE ← FETCH ← IXSCAN`, `totalDocsExamined: 105` — **non couverte**.

**Un index multi-clés ne peut jamais couvrir une requête** : ses entrées contiennent les valeurs du
tableau une par une, jamais le tableau d'origine. MongoDB est obligé d'aller chercher le document
pour reconstituer `genres`, d'où le `FETCH`.

Sur un index simple, en revanche :

```js
db.movies.createIndex({ title: 1 }, { name: "titre_complet" })
db.movies.find({ title: "The Godfather" }, { title: 1, _id: 0 }).hint("titre_complet").explain("executionStats")
```

| | |
|---|---|
| Stage | **`PROJECTION_COVERED ← IXSCAN`** |
| `totalDocsExamined` | **0** |
| `totalKeysExamined` | 1 |
| `nReturned` | 1 |

**Aucun `FETCH`, zéro document examiné.** Le résultat est entièrement lu dans l'index. Les deux
conditions : tous les champs du filtre **et** de la projection sont dans l'index, et `_id` est
explicitement exclu (il n'appartient pas à `titre_complet`).

### B2 — Index partiel

254 films de `type: "series"` sur 23 539.

```js
db.movies.createIndex({ title: 1 }, { name: "titre_complet" })
db.movies.createIndex({ title: 1 }, { name: "titre_series",
                                      partialFilterExpression: { type: "series" } })
```

| Index | Taille |
|---|---|
| `titre_complet` (23 539 films) | 483 328 o |
| `titre_series` (254 films) | **24 576 o** |
| **Gain** | **94,92 %** |

L'index partiel occupe **1/20e** de la place pour servir les mêmes requêtes sur les séries
(`FETCH ← IXSCAN`, 1 clé, 1 document). Le gain porte sur la RAM — moins d'espace occupé dans le
cache — **et** sur les écritures : les 23 285 films non-séries ne provoquent aucune maintenance de
cet index. Contrainte : il n'est utilisable que si la requête contient le filtre
`type: "series"`, sans quoi le planificateur l'ignore.

### B3 — Index TTL

```js
db.sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600, name: "ttl_1h" })
db.sessions.insertOne({ user: "jason", createdAt: new Date() })
```
`{ v: 2, key: { createdAt: 1 }, name: 'ttl_1h', expireAfterSeconds: 3600 }`

MongoDB exécute une tâche de fond **toutes les 60 s** qui supprime les documents dont `createdAt`
dépasse 3 600 s. L'expiration n'est donc pas à la seconde près : un document peut survivre jusqu'à
une minute au-delà de son échéance.

**Cas d'usage :** sessions utilisateur, tokens de réinitialisation de mot de passe, codes OTP,
paniers abandonnés, caches de résultats, logs à rétention courte. Le point commun : une donnée dont
la **péremption fait partie de la définition**. Le TTL déplace la purge du code applicatif — un cron
à écrire, à déployer et à surveiller — vers une **propriété déclarative du schéma**. Bénéfice
secondaire mais réel : la conformité RGPD, où une durée de conservation devient une ligne de
configuration vérifiable plutôt qu'une promesse dans une documentation.
