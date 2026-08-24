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

## Partie 3

**Q20**
```js
db.restaurants.insertOne({
  name: "JD Bistrot Data", borough: "Montpellier", cuisine: "French", restaurant_id: "99999001",
  address: { building: "1", street: "Rue de l'IPSSI", zipcode: "34000", coord: [3.8767, 43.6108] },
  grades: [{ grade: "A", score: 7, date: new Date() }]
})
```
Total : **25360**

**Q21**
```js
db.restaurants.updateOne({ restaurant_id: "30075445" },
  { $push: { grades: { grade: "A", score: 3, date: new Date() } } })
```
Notes : **5 → 6**

**Q22**
```js
db.restaurants.updateMany({ "grades.score": { $gt: 50 } }, { $set: { risque: "eleve" } })
```
`matchedCount: 349` · `modifiedCount: 349`

**Q23**
```js
db.restaurants.updateMany({ cuisine: "French" }, { $set: { label_qualite: true } })
```
`matchedCount: 345` · `modifiedCount: 345` — **345 et non 344** : le restaurant de la Q20 est aussi French.

## Partie 4

**Q24** `db.restaurants.countDocuments({ borough: "Missing" })` → **51**

**Q25** `db.restaurants.deleteMany({ borough: "Missing" })` → `deletedCount: 51`, reste **25309**

**Q26a** `db.restaurants.countDocuments({ grades: { $size: 0 } })` → **737 / 25309 = 2,91 %**
(737 et non 738 : un des 51 documents supprimés avait aussi un tableau vide)

**Q26b — traitement asymétrique.** Un `borough: "Missing"` est une information **perdue et
irrécupérable** : le document est incomplet sur une dimension d'analyse, il fausserait chaque
ventilation. Un `grades: []` est une **donnée vraie** : « pas encore noté ». Le document reste
exploitable, et ces 2,91 % sont même un indicateur utile — le stock d'établissements en attente
d'inspection. On supprime ce qui est faux et irréparable, on garde ce qui est vide mais vrai.

## Partie 5

**Q27** — voir `rapport.js`
```bash
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin --quiet nyc < rapport.js
```
```
1. TOTAL RESTAURANTS : 25309

2. TOP 5 CUISINES
   1. American : 6173
   2. Chinese : 2412
   3. Café/Coffee/Tea : 1210
   4. Pizza : 1162
   5. Italian : 1069

3. PAR ARRONDISSEMENT
   Bronx : 2338
   Brooklyn : 6086
   Manhattan : 10259
   Montpellier : 1
   Queens : 5656
   Staten Island : 969
```

**Écart avec la Q1 : 25309 − 25359 = −50**

| Étape | Δ | Total |
|---|---|---|
| Q1 import | — | 25359 |
| Q20 `insertOne` | **+1** | 25360 |
| Q21/Q22/Q23 `update` | 0 | 25360 |
| Q25 `deleteMany` | **−51** | **25309** |

Les trois `update` touchent 1 + 349 + 345 documents mais n'en créent ni n'en suppriment aucun.

**La valeur nouvelle : `Montpellier`**, créée par le `insertOne` de la Q20 ; `Missing` a disparu
(Q25). Aucune contrainte n'a empêché d'écrire une ville française dans un champ censé contenir un
arrondissement de New York : c'est le schéma flexible. En SQL une clé étrangère l'aurait refusé ;
en MongoDB il faut poser un JSON Schema validator avec un `enum` sur `borough`.

**Q28**
```bash
docker exec mongo-ipssi mongoexport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants --query '{"borough":"Staten Island"}' --out /tmp/staten_island.json
```
**969 lignes** → `staten_island.json`

## Partie 6

### R1 — Les 5 V

**Volume.** 25 359 documents (Q1) et 93 463 notes imbriquées. Sans index, chercher
`cuisine: "French"` examine **25 309 documents pour en retourner 345** (B1) — ratio 73:1. C'est ce
ratio, pas le volume absolu, qui impose l'architecture.

**Variété.** **85 valeurs de `cuisine`** (Q2) dans une taxonomie non normalisée. Surtout, `grades`
est un tableau de longueur variable : **738 documents à zéro note** (Q14), **3 864 à six ou plus**
(Q15). Un schéma tabulaire devrait prévoir N colonnes vides ou éclater en table fille.

**Véracité.** **51 documents** `borough: "Missing"` (Q24), **738** avec un historique vide (Q14),
**13** avec un score de `-1` (Q18a) — impossible pour un barème dont le plancher est 0. Cet écart
déplace la moyenne de **11,434842 à 11,436572, soit +0,0151 %** (Q18b) : l'impact est chiffré, donc
arbitrable — il permet de *ne pas* déclencher un chantier de nettoyage.

**Valeur.** 25 359 lignes brutes deviennent **349 établissements `risque: "eleve"`** (Q22), une
liste d'inspection actionnable. Et la Q13 montre que la valeur dépend de la formulation : **2708**
ont déjà été notés C, **220** le sont actuellement — facteur 12 sur la même donnée.

### R2 — CAP & BASE

Scénario : **Morris Park Bake Shop** (Q11, `restaurant_id: "30075445"`) vient d'être fermé pour
insalubrité. L'écriture atteint le primaire, puis le lien réseau avec le secondaire qui sert
l'application publique tombe. La partition arrive, elle ne se choisit pas — reste C ou A.

**(a) Avec C** — le secondaire sait qu'il peut être en retard et **refuse de répondre**. L'usager
voit une erreur. Il n'apprend pas que le commerce est fermé, mais il n'apprend rien du tout, et
l'absence de réponse est un signal honnête.

**(b) Avec A** — la page s'affiche, rapide et complète : **« Morris Park Bake Shop — Grade A »**.
L'usager lit une information fausse présentée comme vraie, décide d'y aller, et le service publie
une caution sanitaire sur un établissement qu'il vient lui-même de fermer.

**Je choisis C.** Les deux erreurs ne sont pas symétriques : une page indisponible est un
désagrément, une page affichant « Grade A » sur un local fermé pour insalubrité est un risque
sanitaire et juridique.

**Le dommage accepté** : pendant toute la partition, les **25 309 fiches** sont indisponibles, pas
seulement celle qui a changé. J'échange de la disponibilité de masse contre la garantie de ne jamais
publier une caution périmée.

### R3 — Embarqué vs référencé

**(a)** `bsonsize(db.restaurants.findOne({ restaurant_id: "30075445" }))` = **478 o** pour 5 notes.
Le même document sans `grades` = **252 o**. Donc 226 o pour 5 notes → **≈ 45 o par note**.
Les 3 864 restaurants à 6 notes ou plus (Q15) portent déjà ≥ 270 o de `grades`, soit plus que le
reste du document. Après le `$push` de la Q21, le document 30075445 a **6 notes** (~523 o).

**(b)** 520 notes × 45 o + 252 o = **≈ 23 Kio**. Limite BSON : **16 Mo**. Marge : **0,14 %**.
**Le modèle embarqué tient largement** — le plafond ne serait atteint qu'à ~371 000 notes, soit une
inspection par semaine pendant 7 100 ans.

**(c)** Mais le plafond BSON est le mauvais indicateur. Trois limites mordent avant : lire le nom
d'un restaurant charge ses 520 notes ; un `$push` fait réécrire le document entier et ses index,
soit 23 Kio d'I/O pour 45 o d'information ; toutes les inspections d'un établissement écrivent sur
le même verrou.

**Avantage** : une seule lecture, aucune jointure — la fiche complète arrive en une opération. C'est
le motif d'accès dominant ici, donc le choix est bon.
**Limite** : le document ne peut que grossir et son coût croît avec un historique qu'on ne lit
presque jamais en entier.
**Bascule vers un modèle référencé** à partir de ~2 000 notes (~90 Kio), ou plus tôt si le tableau
devient non borné dans le temps, ou si on veut requêter les notes indépendamment des restaurants
(« toutes les inspections de mars 2015 »), ce qui imposerait un `$unwind` sur toute la collection.
