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
