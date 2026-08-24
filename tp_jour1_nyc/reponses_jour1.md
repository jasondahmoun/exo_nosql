# TP Jour 1 — NoSQL & MongoDB

MongoDB 7.0 via Docker · base `nyc` · collection `restaurants`

## Partie 0

```bash
docker compose up -d
curl -L -o primer-dataset.json https://raw.githubusercontent.com/mongodb/docs-assets/primer-dataset/primer-dataset.json
wc -l primer-dataset.json
docker cp primer-dataset.json mongo-ipssi:/tmp/primer-dataset.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants --drop --file /tmp/primer-dataset.json
```

`wc -l` : **25359** · P0 `db.restaurants.countDocuments({})` : **25359**

## Partie 1

| Q | Commande | Résultat |
|---|---|---|
| Q1 | `db.restaurants.countDocuments({})` | **25359** |
| Q2 | `db.restaurants.distinct("cuisine").length` | **85** |
| Q3 | `db.restaurants.countDocuments({ borough: "Brooklyn" })` | **6086** |
| Q4 | `db.restaurants.countDocuments({ cuisine: "French" })` | **344** |
| Q5 | `db.restaurants.countDocuments({ borough: "Manhattan", cuisine: "Italian" })` | **621** |
| Q6 | `db.restaurants.countDocuments({ borough: "Bronx", cuisine: "Chinese" })` | **323** |
| Q7 | `db.restaurants.countDocuments({ name: "Subway" })` | **421** |
| Q8 | `db.restaurants.countDocuments({ cuisine: { $in: ["Japanese","Korean","Thai","Indian"] } })` | **1623** |
| Q10 | `db.restaurants.countDocuments({ "address.zipcode": "10462" })` | **150** |
| Q11 | `db.restaurants.findOne({ restaurant_id: "30075445" }, { name: 1, _id: 0 })` | **Morris Park Bake Shop** |

Q7 — 3 premiers :
```js
db.restaurants.find({ name: "Subway" }, { name: 1, borough: 1, _id: 0 }).limit(3)
```
`[{borough:'Manhattan',name:'Subway'}, {borough:'Manhattan',name:'Subway'}, {borough:'Queens',name:'Subway'}]`

### Q9

| | Commande | Résultat |
|---|---|---|
| (a) | `db.restaurants.countDocuments({ name: /BBQ/ })` | **0** |
| (b) | `db.restaurants.countDocuments({ name: /BBQ/i })` | **73** |
| (d) | `db.restaurants.countDocuments({ name: /House/ })` | **387** |
| (d) | `db.restaurants.countDocuments({ name: /House/i })` | **503** |

**(c) écart 73.** Exemples trouvés seulement par (b) : `Dallas Bbq`, `Virgil'S Bbq`, `Goody'S Bbq`.
Orthographe réelle : **`Bbq`** en Title Case. La chaîne `BBQ` n'existe nulle part, (a) renvoie donc 0.

**(d) écart 116, cause différente.** `House` existe déjà tel quel (387). Le `/i` ajoute
`Steakhouse`, `Roadhouse`, `Clubhouse` : `house` en minuscule **dans un mot composé**. Ce sont des
faux positifs, pas des variantes de casse. Le `/i` répare la Q9 et dégrade la Q9d.

**(e) Ni (a) ni (b) : un index texte.**
```js
db.restaurants.createIndex({ name: "text" })
db.restaurants.find({ $text: { $search: "bbq" } })
```
Il tokenise et normalise la casse à l'indexation : insensible à la casse sans COLLSCAN, et matche
des mots entiers donc pas `Steakhouse` pour « House ».

## Partie 2

| Q | Commande | Résultat |
|---|---|---|
| Q12 | `db.restaurants.countDocuments({ "grades.score": { $gt: 50 } })` | **349** |
| Q13a | `db.restaurants.countDocuments({ "grades.grade": "C" })` | **2708** |
| Q13b | `db.restaurants.countDocuments({ "grades.0.grade": "C" })` | **220** |
| Q14 | `db.restaurants.countDocuments({ grades: { $size: 0 } })` | **738** |
| Q15 | `db.restaurants.countDocuments({ "grades.5": { $exists: true } })` | **3864** |
| Q16 | `db.restaurants.countDocuments({ "grades.0.grade": "A" })` | **20687** |
| Q17a | `db.restaurants.countDocuments({ "grades.grade": "B", "grades.score": { $gt: 20 } })` | **4908** |
| Q17b | `db.restaurants.countDocuments({ grades: { $elemMatch: { grade: "B", score: { $gt: 20 } } } })` | **4280** |
| Q18a | `db.restaurants.countDocuments({ "grades.score": { $lt: 0 } })` | **13** |

**Q13c — écart 2488.** Les dates de `grades` sont décroissantes, donc **l'indice 0 est la note la
plus récente**. C'est **(b) = 220** qui répond à « actuellement mal notés », et c'est ce chiffre que
je publie. (a) = 2708 est l'historique cumulé : publier ce nombre mettrait en cause 2488
établissements aujourd'hui bien notés.

**Q14 — pourquoi un tableau vide ?** L'établissement est enregistré mais jamais encore noté :
ouverture récente, ou inspection sans notation (le grade `"Not Yet Graded"` existe dans le jeu).
Ce n'est pas une erreur, c'est une absence légitime.

**Q17c — écart 628.** Deux conditions côte à côte sur un tableau sont évaluées séparément : (a)
accepte qu'un élément soit `B` et qu'un **autre** ait un score > 20. `$elemMatch` exige le **même**
élément. **(b) = 4280 répond à la question métier.**

**Q18 — score négatif.** 13 notes, toutes à `-1`. Aucun sens métier : le score est un nombre de
points de pénalité, son plancher est 0. C'est une valeur sentinelle « non renseigné ».

**(b) impact :**
```js
db.restaurants.aggregate([{ $unwind: "$grades" }, { $group: { _id: null, moy: { $avg: "$grades.score" } } }])
db.restaurants.aggregate([{ $unwind: "$grades" }, { $match: { "grades.score": { $gte: 0 } } }, { $group: { _id: null, moy: { $avg: "$grades.score" } } }])
```

| | Moyenne |
|---|---|
| avec négatifs | **11,434842** |
| sans négatifs | **11,436572** |
| écart | **+0,00173 pt = +0,0151 %** |

**(c) Pas d'urgence.** 13 notes sur 93 463 (0,014 %), impact de 0,015 % sur la moyenne : aucun
tableau de bord ne bascule. Mais en affichage unitaire le `-1` est faux, pas imprécis — il place
l'établissement en tête d'un tri croissant. Décision : filtre `$match: { score: { $gte: 0 } }` sur
les vues unitaires, correction à l'ingestion au prochain cycle.

**Q19**
```js
db.restaurants.find({}, { name: 1, "grades.score": 1, _id: 0 }).sort({ "grades.score": -1 }).limit(1)
```
**`Murals On 54/Randolphs'S`** — score **131**
