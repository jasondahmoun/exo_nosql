# TP Jour 3 — Réplication & haute disponibilité

MongoDB 7.0 · Replica Set `rs0` — 3 nœuds Docker · base `census` · collection `zips`

Fichiers d'infra : `docker-compose.rs.yml`, `init-rs.js`, `watch_primary.py`, `writer.py`.

## Partie 0

### 0.1 Libérer le port 27017

```bash
docker stop mongo-ipssi mongo-express-ipssi
```

En plus de l'énoncé, **`mongo-rs` du Jour 2 occupait le port 27018**, celui de `mongo2`. Il a fallu
l'arrêter aussi, sinon `docker compose up` échoue sur le second nœud.

### 0.2 Démarrer les trois nœuds sans les assembler

```bash
docker compose -f docker-compose.rs.yml up -d
docker compose -f docker-compose.rs.yml ps
```

| Conteneur | État | Port |
|---|---|---|
| mongo1 | running | 27017 → 27017 |
| mongo2 | running | 27018 → 27017 |
| mongo3 | running | 27019 → 27017 |

### Q1 — un `mongod --replSet` non initialisé

```bash
docker exec mongo1 mongosh --quiet --eval 'printjson(db.hello())'
```

```js
{
  isWritablePrimary: false,
  secondary: false,
  info: 'Does not have a valid replica set config',
  isreplicaset: true,
  maxBsonObjectSize: 16777216,
  ...
}
```

| Champ | Valeur |
|---|---|
| `isWritablePrimary` | **`false`** |
| `secondary` | **`false`** |
| `primary` | **absent** — le champ n'existe pas |
| `info` | **`Does not have a valid replica set config`** |
| `isreplicaset` | `true` |

```bash
docker exec mongo1 mongosh --quiet --eval 'db.test.insertOne({ a: 1 })'
```

```
codeName : NotWritablePrimary
code     : 10107
message  : not primary
```

**Conclusion : ni primary, ni secondary — un troisième état.** Les deux champs valent `false`
simultanément, et le champ `primary` est *absent* : le nœud ne sait même pas désigner un primary,
puisqu'il ne connaît aucun autre membre. C'est `isreplicaset: true` qui décrit son vrai statut : il
sait qu'il appartient à un Replica Set, mais il n'a jamais reçu de configuration. Il attend
`rs.initiate()`.

Conséquence pratique : il **refuse les écritures**. Un `--replSet` sans `rs.initiate()` n'est pas un
mongod standalone dégradé, c'est un nœud inutilisable.

### Q2 — initialisation

```bash
docker exec -i mongo1 mongosh < init-rs.js
docker exec mongo1 mongosh --quiet --eval 'rs.status().members.map(m => m.name + " " + m.stateStr).join(" | ")'
```

```
mongo1:27017 PRIMARY | mongo2:27017 SECONDARY | mongo3:27017 SECONDARY
```

**`mongo1` est PRIMARY.** Le champ qui l'explique dans `init-rs.js` est **`priority`**, valeur **`2`**,
contre `1` pour les deux autres :

```js
members: [
  { _id: 0, host: "mongo1:27017", priority: 2 },
  { _id: 1, host: "mongo2:27017", priority: 1 },
  { _id: 2, host: "mongo3:27017", priority: 1 }
]
```

À l'élection, le membre de plus forte priorité l'emporte à condition d'être à jour. Ce `priority: 2`
est aussi ce qui provoquera le **priority takeover** de la Q19 : au retour de mongo1, le cluster
rebasculera *spontanément* vers lui.

### 0.4 Import des données réelles

```bash
curl -L -o zips.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_training/zips.json
wc -l zips.json
docker cp zips.json mongo1:/tmp/zips.json
docker exec mongo1 mongoimport --db census --collection zips --drop --file /tmp/zips.json
```

`wc -l` : **29470** · import : **29470 document(s) imported successfully, 0 failed**.

L'import s'adresse à **mongo1, le primary** — seul nœud à accepter des écritures (vérifié en Q14).

### Q3 — contenu

```js
db.zips.countDocuments({})
db.zips.distinct("state").length
db.zips.aggregate([{ $group: { _id: null, pop: { $sum: "$pop" } } }])
```

| | |
|---|---|
| Documents | **29470** |
| États distincts | **51** |
| Population totale | **248 709 873** |

**Oui, 51 surprend — on attend 50.** L'explication est dans la liste : elle contient **`DC`**, le
District of Columbia, qui n'est pas un État mais un district fédéral. 50 États + DC = 51.

À noter aussi ce que la liste **ne contient pas** : aucun territoire (`PR` Porto Rico, `GU` Guam,
`VI` Îles Vierges). Le jeu couvre les 50 États + DC, rien d'autre.

Second point, non demandé mais vérifiable : **248 709 873 est exactement la population du
recensement américain de 1990**. Ce n'est pas un jeu de données actuel — il date de 36 ans, ce qui
explique les écarts avec la population américaine d'aujourd'hui (~335 M).

### Q4 — `zip` est-il une clé naturelle ?

```js
db.zips.countDocuments({})        // 29470
db.zips.distinct("zip").length    // 29467
```

**Réfuté : 29 467 valeurs distinctes pour 29 470 documents.** Il manque 3.

```js
db.zips.aggregate([
  { $group: { _id: "$zip", n: { $sum: 1 }, villes: { $push: "$city" }, etats: { $push: "$state" } } },
  { $match: { n: { $gt: 1 } } },
  { $sort: { _id: 1 } }
])
```

| `zip` | Ville | États |
|---|---|---|
| **32350** | PINETTA | FL / GA |
| **42223** | FORT CAMPBELL | KY / TN |
| **63673** | SAINT MARY | IL / MO |

Les trois doublons sont des **codes postaux à cheval sur une frontière d'État**, et ce n'est pas une
erreur : un ZIP code est une **tournée de distribution postale**, pas un découpage administratif.
Rien n'oblige une tournée à s'arrêter à la frontière d'un État. Fort Campbell est l'exemple le plus
net — la base militaire est physiquement répartie sur le Kentucky et le Tennessee. Le jeu de données
crée donc un document par couple (zip, état).

**Peut-on créer un index unique sur `zip` ? Non.** Tenté réellement :

```js
db.zips.createIndex({ zip: 1 }, { unique: true })
```

```
codeName : DuplicateKey
code     : 11000
message  : Index build failed: ... E11000 duplicate key error collection: census.zips
           index: zip_1 dup key: { zip: "32350" }
```

MongoDB refuse et **nomme la première valeur fautive** (`32350`). En revanche la vraie clé naturelle
est le **couple** :

```js
db.zips.createIndex({ zip: 1, state: 1 }, { unique: true })   // OK
```

Celui-là passe. La leçon : un champ qui *ressemble* à un identifiant ne l'est pas forcément — ici il
a fallu 3 documents sur 29 470 (0,01 %) pour invalider l'hypothèse.

### Q5 — population nulle

```js
db.zips.countDocuments({ pop: 0 })
```

**67 documents.** Répartis sur **29 États** (AK 8, CA 7, NM 5, TX 5, KY 4…), donc pas un artefact
local : le phénomène est général.

**Réalité métier, pas erreur de saisie** — pour la même raison qu'en Q4 : un code postal est une
tournée de distribution, pas une zone d'habitation ; un ZIP qui ne dessert que des boîtes postales,
une base militaire, une zone industrielle ou un bâtiment administratif a légitimement **0 résident**
sans que rien ne soit faux.

Réserve honnête : certains cas invitent à la prudence. `CHEVAK`, `EMMONAK` ou `RUSSIAN MISSION`
(Alaska) sont des villages réellement habités. Pour ceux-là, le `0` ressemble davantage à une
non-couverture du recensement de 1990 qu'à une vérité. **Conséquence pratique identique dans les deux
cas :** ces 67 valeurs ne doivent pas entrer dans un calcul de densité ou de population moyenne, où
elles tireraient le résultat vers le bas.

## Partie 1

### Q6 — les curseurs de l'élection

```js
rs.conf().settings
```

| Paramètre | Valeur |
|---|---|
| `electionTimeoutMillis` | **10000** (10 s) |
| `heartbeatIntervalMillis` | **2000** (2 s) |
| `heartbeatTimeoutSecs` | 10 |

**En français :** « un secondary déclare le primary mort au bout de **10 secondes** sans réponse,
alors qu'il l'interroge toutes les **2 secondes**. »

Autrement dit il faut **5 heartbeats manqués consécutifs** pour déclencher une élection. Ces deux
valeurs sont confrontées au chronomètre en Q21 et modifiées en R3.

### Q7 — santé des membres

```js
rs.status().members
```

| Membre | `stateStr` | `health` | `lastHeartbeat` | `pingMs` |
|---|---|---|---|---|
| mongo1:27017 | PRIMARY | 1 | *(self)* | — |
| mongo2:27017 | SECONDARY | 1 | 2026-08-26T13:38:30.945Z | 0 |
| mongo3:27017 | SECONDARY | 1 | 2026-08-26T13:38:30.945Z | 0 |

**Le champ qui signale un nœud injoignable en production : `health`**, qui passe de `1` à `0`.

Mais `health` seul ne suffit pas — c'est un booléen, il ne dit pas *depuis quand*. Le champ vraiment
exploitable en supervision est **`lastHeartbeat`** : c'est un horodatage, donc en le comparant à
l'heure courante on obtient l'**ancienneté** du dernier contact. C'est cet écart qui permet de
distinguer un hoquet réseau de 2 secondes d'une machine morte depuis 10 minutes, et donc de régler un
seuil d'alerte. `stateStr` complète le tableau en passant à `(not reachable/healthy)`.

Le membre local n'a pas de `lastHeartbeat` : un nœud ne s'envoie pas de heartbeat à lui-même.

### Q8 — taille de l'oplog

```js
db.getSiblingDB("local").oplog.rs.stats().maxSize
```

**134217728 octets = exactement 128 Mo.**

Cette valeur vient de la ligne `command:` de `docker-compose.rs.yml` :

```yaml
command: mongod --replSet rs0 --bind_ip_all --port 27017 --oplogSize 128
```

`--oplogSize` s'exprime en Mo : 128 × 1024 × 1024 = 134 217 728.

**Si on ne la fixait pas**, MongoDB applique sa règle par défaut : **5 % de l'espace disque libre**,
avec un plancher de 990 Mo et un plafond de 50 Go. Sur ces conteneurs, l'oplog occuperait donc
plusieurs gigaoctets par nœud — inutilement gros pour un TP, et surtout **non reproductible** : la
taille dépendrait de l'espace libre de chaque machine, donc les calculs de la Q12 donneraient un
résultat différent pour chaque étudiant. Fixer 128 Mo rend la mesure comparable.

### Q9 — granularité de la réplication

```js
db.getSiblingDB("local").oplog.rs.countDocuments({ op: "i", ns: "census.zips" })
```

| | |
|---|---|
| Entrées d'oplog `op: "i"` sur `census.zips` | **29470** |
| Documents importés | **29470** |
| Écart | **0** |

**L'égalité est parfaite, et c'est la démonstration.** `mongoimport` a envoyé les documents par lots
de plusieurs milliers — mais l'oplog n'en garde aucune trace. Il contient **une entrée par document**,
pas une entrée par lot.

La réplication est donc **unitaire** : le lot est une optimisation du *transport* entre le client et
le primary, il disparaît à l'enregistrement. Le secondary rejoue 29 470 opérations indépendantes.
C'est ce qui rend chaque opération individuellement rejouable — le fondement de la Q10.

### Q10 — anatomie d'une entrée et idempotence

```js
db.getSiblingDB("local").oplog.rs.findOne({ op: "i", ns: "census.zips" })
```

```js
{
  op: 'i',
  ns: 'census.zips',
  o: {
    _id: ObjectId('5c8eccc1caa187d17ca6ed1f'),
    city: 'ADAMSVILLE', zip: '35005',
    loc: { y: 33.588437, x: 86.959727 },
    pop: 10616, state: 'AL'
  },
  o2: { _id: ObjectId('5c8eccc1caa187d17ca6ed1f') },
  ts: Timestamp({ t: 1787751441, i: 2 }),
  wall: ISODate('2026-08-26T13:37:21.409Z'),
  lsid: { id: UUID('a6040ede-...') }, txnNumber: Long('1'), stmtId: 0
}
```

| Champ | Rôle |
|---|---|
| `op` | type d'opération — `i` insert, `u` update, `d` delete, `c` commande, `n` no-op |
| `ns` | namespace visé, `base.collection` |
| `o` | la charge utile de l'opération |
| `ts` | Timestamp logique `(secondes, compteur)` — l'ordre total des opérations |
| `wall` | l'heure murale réelle, pour l'humain qui lit |

**Ce qui rend l'opération idempotente, c'est que `o` contient le document *complet, `_id` inclus*.**

L'entrée ne dit pas « insère un document » — elle dit « fais exister *ce* document *sous cet `_id`* ».
Le résultat ne dépend donc **pas de l'état antérieur** de la collection : rejouée deux fois, la
seconde application vise le même `_id` déjà présent et n'a rien à changer. L'état final est le même
après 1 ou 3 rejeux.

C'est indispensable parce qu'un secondary peut redémarrer au milieu d'un lot sans savoir exactement
où il s'était arrêté : il rejoue alors une fenêtre qui **chevauche** ce qu'il avait déjà appliqué.
Sans idempotence, ce chevauchement corromprait les données.

À noter : `lsid` + `txnNumber` + `stmtId` sont les champs des *retryable writes* — ce sont eux qui
répondront à la Q32(d).

### Q11 — pourquoi l'oplog ne stocke jamais `$inc`

```js
db.zips.updateMany({ state: "TX" }, { $inc: { pop: 1 } })
```
→ `matched=1676  modified=1676`

```js
db.getSiblingDB("local").oplog.rs.findOne({ op: "u", ns: "census.zips" })
```

```js
{
  op: 'u',
  ns: 'census.zips',
  o:  { '$v': 2, diff: { u: { pop: 37700 } } },
  o2: { _id: ObjectId('5c8eccc1caa187d17ca74cf7') },
  ts: Timestamp({ t: 1787751535, i: 1 })
}
```

**Non, aucun `$inc`.** À la place : `diff: { u: { pop: 37700 } }` — la **valeur absolue résultante**,
et `o2` qui identifie le document par son `_id`.

**Pourquoi MongoDB procède ainsi — c'est exactement l'idempotence de la Q10.** `$inc` est une
opération **relative** : son résultat dépend de la valeur de départ. Rejouée deux fois, elle
incrémenterait deux fois. Un secondary qui rejoue une fenêtre chevauchante afficherait une population
du Texas fausse, et l'écart serait **silencieux et permanent**.

En convertissant `$inc: 1` en `pop = 37700` au moment de l'écriture, MongoDB transforme une opération
relative en **affectation absolue**, qui redevient rejouable sans dommage. La règle est générale :
**l'oplog n'enregistre jamais l'intention, il enregistre le résultat.**

Second enseignement, cohérent avec la Q9 : un `updateMany` touchant 1 676 documents produit
**1 676 entrées d'oplog distinctes**, pas une seule entrée « updateMany ». Vérifié :

```js
db.getSiblingDB("local").oplog.rs.countDocuments({ op: "u", ns: "census.zips" })   // 1676
```

C'est aussi la raison pour laquelle `updateMany` **n'est jamais rejoué automatiquement** par le
driver (Q32d) : il n'est pas atomique à l'échelle du lot.

### Q12 — dimensionnement

```js
const st = db.getSiblingDB("local").oplog.rs.stats()
```

| | |
|---|---|
| `size` | 12 021 766 octets |
| `count` | 31 190 |
| `maxSize` | 134 217 728 octets (128 Mo) |

**(a) Taille moyenne d'une opération**

```
12 021 766 / 31 190 = 385,44 octets
```

**(b) Capacité de l'oplog**

```
134 217 728 / 385,44 = 348 222 opérations
```

**(c) Fenêtre de réplication à 300 écritures/s**

```
348 222 / 300 = 1 160,7 s = 19,3 minutes = 0,32 heure
```

| | |
|---|---|
| Fenêtre de réplication | **0,32 h ≈ 19 minutes** |
| Vendredi 18 h → lundi 9 h | **63 heures** |
| **Le secondary peut-il rattraper ?** | **NON** |

**Non, et de très loin : il manque un facteur ≈ 195.** L'oplog aura été entièrement réécrit environ
**195 fois** pendant le week-end. Les opérations que le secondary devait rejouer ont disparu depuis
le vendredi 18 h 19.

**Ce qui se passe alors :** le secondary constate que son dernier `ts` appliqué est plus ancien que
la plus vieille entrée encore présente dans l'oplog du primary. Il ne peut plus rattraper de façon
incrémentale, passe en état **`RECOVERING`** et devient inutilisable — il ne sert plus de lecture et
ne compte plus pour le quorum. La seule issue est une **resynchronisation initiale complète**
(*initial sync*) : copie intégrale de toutes les données depuis un autre membre, plusieurs heures sur
un gros volume, avec la charge réseau et disque correspondante.

**La leçon d'exploitation :** 128 Mo est une taille de TP. En production, l'oplog ne se dimensionne
pas en octets mais **en durée** — on choisit la fenêtre de panne qu'on veut pouvoir absorber (« un
nœud doit pouvoir tomber tout un week-end ») et on en déduit la taille. Ici, couvrir 63 heures à
300 écritures/s demanderait :

```
63 × 3600 × 300 × 385,44 octets ≈ 26,2 Go
```

soit **environ 195 fois** l'oplog actuel. C'est ce calcul, et non une valeur par défaut, qui doit
fixer `--oplogSize`.

## Partie 2

### Q13 — lire sur un secondary

```bash
docker exec mongo2 mongosh --quiet census --eval 'db.zips.countDocuments({})'
```
→ **29470**

**Oui, on obtient les données**, sans avoir rien eu à activer.

`rs.secondaryOk()` est **déprécié depuis MongoDB 4.4**. Ce que `mongosh` positionne automatiquement
aujourd'hui, c'est **`directConnection=true`** : quand on se connecte à un membre nommément, le shell
ne cherche pas à découvrir le Replica Set ni à router vers le primary — il parle à *ce* nœud, et
applique la read preference **`secondaryPreferred`**.

L'ancienne commande n'est plus nécessaire parce que le besoin qu'elle servait a changé de camp :
`secondaryOk()` était un **drapeau de connexion** qu'il fallait armer à la main pour lever le refus de
lire sur un secondary. Il a été remplacé par le mécanisme de **read preference**, plus fin (`primary`,
`secondaryPreferred`, `nearest`…) et surtout déclaratif — on décrit ce qu'on veut lire, pas une
permission qu'on s'accorde. `mongosh` choisit le réglage adapté au contexte de connexion.

### Q14 — écrire sur un secondary

```bash
docker exec mongo2 mongosh --quiet census --eval 'db.zips.insertOne({ test: 1 })'
```

```
codeName : NotWritablePrimary
code     : 10107
message  : not primary
```

**Même erreur qu'en Q1**, pour une raison différente : en Q1 le nœud n'avait pas de configuration,
ici il en a une et sait parfaitement qu'il est SECONDARY.

**Pourquoi refuser l'écriture alors que la lecture est permise ?** Parce que ce sont deux risques
opposés. Lire sur un secondary fait courir un seul risque : lire une donnée **légèrement en retard**
(Q15) — dégradé, mais réparable et borné. Écrire sur un secondary créerait une donnée **qui n'existe
nulle part ailleurs** : elle ne remonterait jamais vers le primary (la réplication est à sens unique,
primary → secondaries) et serait écrasée à la prochaine synchronisation.

C'est la règle absolue du modèle : **un seul primary, toutes les écritures y passent**. Elle est ce
qui garantit un ordre total des opérations dans l'oplog, donc la convergence de tous les nœuds.

### Q15 — retard de réplication

```js
rs.printSecondaryReplicationInfo()
```

Au repos :

| Source | `replLag` |
|---|---|
| mongo2:27017 | 0 secs behind the primary |
| mongo3:27017 | 0 secs behind the primary |

Après insertion de 1 000 documents d'un coup (38 ms côté primary) :

| Source | `replLag` |
|---|---|
| mongo2:27017 | **1 secs** behind the primary |
| mongo3:27017 | **1 secs** behind the primary |

**Le retard bouge — il passe de 0 à 1 seconde.** Puis il retombe à 0 quelques secondes plus tard.

Test complémentaire, plus sévère (5 000 documents de ~200 octets, 57 ms côté primary), en lisant le
secondary immédiatement après :

| | |
|---|---|
| primary | 5000 documents |
| secondary, lecture immédiate | **5000 documents** |
| secondary, +3 s | 5000 documents |

**Conclusion honnête sur ce montage : la réplication est bien asynchrone, mais le retard est ici
sous le seuil de mesure.** Trois conteneurs sur la même machine n'ont ni latence réseau ni contention
disque : le secondary rattrape en quelques millisecondes. `replLag` étant exprimé en **secondes
entières**, tout retard inférieur à une seconde s'affiche `0` — la valeur `1 secs` relevée juste après
le lot est la seule trace visible.

Ce que cela ne remet pas en cause : le primary **n'attend pas** les secondaries pour acquitter une
écriture en `w: 1`. C'est justement ce découplage qui rend possible la perte d'écriture de la Q24 et
le rollback du bonus B4. Sur un vrai déploiement multi-datacenter, ce retard se compte en dizaines ou
centaines de millisecondes, et devient parfaitement mesurable.

### Q16 — Read Preference

```js
db.getMongo().setReadPref("primary");   db.zips.countDocuments({ state: "NY" })
db.getMongo().setReadPref("secondary"); db.zips.countDocuments({ state: "NY" })
```

| Read preference | Résultat |
|---|---|
| `primary` | **1596** |
| `secondary` | **1596** |
| `secondaryPreferred` | **1596** |

**Résultat identique** — attendu ici, puisque plus rien n'était en cours d'écriture et que le retard
mesuré en Q15 est nul. L'égalité ne prouve donc pas que lire sur un secondary est toujours sûr : elle
prouve qu'à cet instant les nœuds étaient convergés.

**Cas où lire sur un secondary est acceptable** — un tableau de bord analytique : « population totale
par État », un export nocturne, une page de statistiques. La donnée a des heures de pertinence ; qu'elle
ait 200 ms de retard ne change strictement rien, et on décharge le primary d'une requête lourde.

**Cas où c'est dangereux — le read-after-write.** Un utilisateur modifie son adresse, l'application
confirme, puis recharge la page. Si la lecture part sur un secondary qui n'a pas encore reçu
l'opération, il voit **son ancienne adresse** : il croit que l'enregistrement a échoué, et recommence.
C'est le problème de la donnée **stale** — périmée. Toute lecture qui suit immédiatement une écriture
du même utilisateur, tout contrôle de solde avant débit, tout test d'unicité avant insertion doit
partir sur le **primary**.

La règle : lire sur un secondary est acceptable quand la donnée est **consultée**, dangereux quand
elle est **utilisée pour décider**.
