# index_bench.md — explain() avant / après index

`db.movies` · 23 539 documents · MongoDB 7.0
Relevés via `.explain("executionStats")` : `executionStages.stage`, `totalDocsExamined`,
`totalKeysExamined`, `nReturned`.

## Q7 — index multi-clés sur `genres`

```js
db.movies.find({ genres: "Film-Noir" })
```

| | Stage | totalKeysExamined | totalDocsExamined | nReturned | ms |
|---|---|---|---|---|---|
| Avant | `COLLSCAN` | 0 | **23539** | 105 | 30 |
| Après `{ genres: 1 }` | `FETCH ← IXSCAN` | 105 | **105** | 105 | 1 |

Documents examinés divisés par **224**. Avant, la base lisait les 23 539 documents pour en retenir
105 — soit 99,55 % de lecture inutile. Après, elle en lit exactement 105 : un document examiné par
document renvoyé, le rapport optimal.

`genres` est un tableau : l'index créé est **multi-clés**, une entrée par valeur du tableau et par
document. MongoDB le détecte seul, sans déclaration particulière.

## Q8 — index composé, règle ESR

```js
db.movies.find({ genres: "Drama", year: { $gte: 2000 } }).sort({ "imdb.rating": -1 })
```

Filtre seul (Q8a) : **7761** films.

| Index | Stage | totalKeysExamined | totalDocsExamined | nReturned | ms |
|---|---|---|---|---|---|
| `genres_1` seul | `SORT ← FETCH ← IXSCAN` | 13789 | 13789 | 7761 | 23 |
| `esr_ok` = `{ genres: 1, "imdb.rating": -1, year: 1 }` | `FETCH ← IXSCAN` | 7834 | **7761** | 7761 | **8** |
| `esr_ko` = `{ genres: 1, year: 1, "imdb.rating": -1 }` | `FETCH ← SORT ← IXSCAN` | 7761 | 7761 | 7761 | 21 |

L'index `esr_ok` fait **disparaître le stage `SORT`** : le tri est servi par l'ordre de l'index.
Détail sur le comparatif `esr_ok` / `esr_ko` en R3.

## Q9 — index text sur `title` + `plot`

| | Commande | Résultat |
|---|---|---|
| (a) | `db.movies.countDocuments({ title: { $regex: /Godfather/ } })` | **5** |
| (b) | `db.movies.countDocuments({ $text: { $search: "godfather" } })` | **12** |
| (d) | `db.movies.countDocuments({ $text: { $search: "godfathers" } })` | **12** |

## Q10 — état final des index

| Index | Créé par | Statut |
|---|---|---|
| `_id_` | MongoDB, automatiquement | conservé |
| `genres_1` | Q7 | conservé |
| `esr_ok` | Q8 | conservé |
| `esr_ko` | R3 | conservé pour la démonstration |
| `titre_intrigue_txt` | Q9 | **supprimé** (`dropIndex`) |

## Bonus

| | Requête | Stage | totalDocsExamined |
|---|---|---|---|
| B1 échec | `find({ genres: "Film-Noir" }, { genres: 1, _id: 0 })` | `PROJECTION_SIMPLE ← FETCH ← IXSCAN` | 105 |
| B1 réussi | `find({ title: "The Godfather" }, { title: 1, _id: 0 })` | `PROJECTION_COVERED ← IXSCAN` | **0** |
| B2 | index partiel `type: "series"` | `FETCH ← IXSCAN` | 1 |

Un index multi-clés **ne peut pas couvrir** une requête : les entrées d'index contiennent les valeurs
du tableau une à une, pas le tableau original, donc MongoDB doit aller chercher le document pour
reconstruire `genres`. D'où le `FETCH` et les 105 documents examinés en B1 échec.
