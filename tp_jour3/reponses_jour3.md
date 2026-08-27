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

## Partie 3

Mesures complètes et horodatées dans **`failover.md`**. Outil : `watch_primary.py`, sondage 300 ms.

### Q17 — panne propre

```bash
docker stop mongo1
```

```
docker stop a 15:54:06.076
[   0.01s] 15:54:03.182  primary = mongo1:27017
[   3.08s] 15:54:06.257  primary = mongo2:27017
```

| | |
|---|---|
| Délai | **0,181 s** |
| Nœud élu | **mongo2** |

**La bascule est quasi instantanée** — deux ordres de grandeur sous l'`electionTimeoutMillis`.
`docker stop` envoie **SIGTERM** : mongod l'intercepte, se **rétrograde volontairement** et prévient
le set avant de mourir. Aucun timeout n'est attendu puisque personne n'a besoin de *deviner* que le
primary est mort — il l'a annoncé.

*Réserve :* avec un sondage à 300 ms, 0,181 s est un **majorant**, pas une mesure fine.

### Q18 — état pendant la bascule

Depuis mongo2, pendant que mongo1 est arrêté :

| Membre | `stateStr` | `health` |
|---|---|---|
| mongo1:27017 | **`(not reachable/healthy)`** | **0** |
| mongo2:27017 | PRIMARY | 1 |
| mongo3:27017 | SECONDARY | 1 |

`lastHeartbeatMessage` : `Error connecting to mongo1:27017 :: caused by :: Could not find address…`

C'est la confirmation de la Q7 : **`health: 0`** est le signal d'injoignabilité, et `stateStr` bascule
sur un libellé explicite plutôt que sur un état du protocole.

### Q19 — retour du nœud et priority takeover

```bash
docker start mongo1
```

```
docker start a 15:50:59.842
[   0.01s] 15:50:57.921  primary = mongo2:27017
[  13.48s] 15:51:11.396  primary = mongo1:27017
```

| | |
|---|---|
| État immédiat au retour | STARTUP2 puis SECONDARY |
| **Redevient-il PRIMARY ?** | **Oui** |
| Délai | **11,55 s** |

mongo1 ne revient jamais directement PRIMARY : il rejoint d'abord en **SECONDARY**, rattrape son
retard par l'oplog (Q20), et **seulement une fois à jour** déclenche une élection.

**Le mécanisme : `rs.conf().members[0].priority = 2`** contre `1` pour les deux autres. Un membre de
priorité supérieure qui est à jour force un *priority takeover* : il réclame le rôle même si le
primary en place fonctionne parfaitement. mongo2 n'avait aucun problème — il a été destitué par la
configuration.

**Nombre de bascules depuis le `docker stop` : 2.**

1. mongo1 → mongo2 (à l'arrêt)
2. mongo2 → mongo1 (au retour, priority takeover)

**Pourquoi c'est un argument contre les priorités asymétriques en production :** un seul incident,
ou un simple redémarrage de maintenance, coûte **deux élections au lieu d'une**. Le service subit
deux interruptions là où une seule était nécessaire, et la seconde est **entièrement gratuite** — elle
ne répare rien, elle ne fait que satisfaire une préférence de configuration. Elle survient de surcroît
au pire moment : juste après un incident, quand le cluster vient de se stabiliser.

Sur ce set, cette seconde bascule coûte **11,55 s**, soit **plus que la panne brutale elle-même
(9,04 s)**. En priorités égales, le nœud revenu resterait tranquillement SECONDARY et le service ne
serait pas réinterrompu. Les priorités ne se justifient que pour une raison **topologique** — garder
le primary dans un datacenter précis — jamais par habitude.

### Q20 — récupération des écritures manquées

Avant de redémarrer mongo1, 3 documents écrits sur le nouveau primary (mongo2) :

```js
db.pendant_panne.insertMany([{ n: 1, ... }, { n: 2, ... }, { n: 3, ... }])
```

Après `docker start mongo1`, en se connectant **directement à mongo1** :

```bash
docker exec mongo1 mongosh --quiet census --eval 'db.pendant_panne.countDocuments({})'
```
→ **3**

Les trois documents sont présents. **Le mécanisme est l'oplog** (Partie 1).

Au démarrage, mongo1 compare le `ts` de sa dernière opération appliquée avec l'oplog d'un membre à
jour, et **rejoue toutes les entrées postérieures**. Il ne recopie pas la base : il rattrape le
journal. C'est pour cela que les entrées doivent être **idempotentes** (Q10) — mongo1 rejoue
potentiellement une fenêtre chevauchant ce qu'il avait déjà appliqué avant de mourir, et un `$inc`
relatif fausserait le résultat (Q11).

C'est aussi ce qui rend la **Q12 critique** : ce rattrapage n'est possible que si les opérations
manquées **sont encore dans l'oplog**. Au-delà de 19 minutes d'absence sur ce set, mongo1 n'aurait pas
pu procéder ainsi et aurait dû subir une resynchronisation initiale complète.

### Q21 — panne brutale, la mesure centrale

```bash
docker kill mongo1
```

```
docker kill a 15:52:21.264
[   0.01s] 15:52:18.359  primary = mongo1:27017
[   3.06s] 15:52:21.411  primary = AUCUN
[  11.95s] 15:52:30.301  primary = mongo3:27017
```

| Scénario | Délai | Nœud élu |
|---|---|---|
| Arrêt propre (Q17) | **0,181 s** | mongo2 |
| **Panne brutale** | **9,037 s** | **mongo3** |
| **Rapport** | **≈ 50×** | |

**La différence est d'un facteur 50.** Et la ligne du milieu est celle qui compte : pendant
**8,9 secondes**, `primary = AUCUN`. Ce n'est pas un basculement, c'est un **trou de service** — le
cluster n'accepte aucune écriture pendant ce temps.

**Confrontation à `electionTimeoutMillis` = 10 000 ms : mon délai est *légèrement inférieur*** —
9,037 s pour un timeout de 10 s, soit **963 ms de moins**.

**Explication de l'écart.** Le compte à rebours ne démarre **pas** à l'instant de la mort du nœud,
mais à son **dernier heartbeat réussi**. Avec `heartbeatIntervalMillis = 2000`, les secondaries
interrogent mongo1 toutes les 2 secondes. Quand SIGKILL frappe, le dernier heartbeat réussi date donc
d'un instant **aléatoire entre 0 et 2 secondes plus tôt** — en moyenne 1 seconde.

Le nœud est donc déclaré mort environ `10 s − 1 s = 9 s` après sa mort réelle, et non 10 s. Mes
963 ms d'écart tombent exactement dans cette fenêtre. L'élection elle-même est rapide (quelques
centaines de millisecondes) et ne pèse presque rien.

Autrement dit, le délai observé vaut :

```
electionTimeoutMillis − (temps écoulé depuis le dernier heartbeat) + durée de l'élection
```

et il varie donc, d'une panne à l'autre, **entre 8 et 10 secondes** sur cette configuration. Ce n'est
pas une constante : c'est une fourchette. On le vérifie en R3 en abaissant le paramètre.

### Q22 — synthèse

Tableau complet dans **`failover.md`**.

| Scénario | Commande | Délai | Nœud élu | Écritures perdues ? |
|---|---|---|---|---|
| Arrêt propre | `docker stop mongo1` | **0,18 s** | mongo2 | Non |
| Panne brutale | `docker kill mongo1` | **9,04 s** | mongo3 | Non |
| Retour du nœud | `docker start mongo1` | **11,55 s** | mongo1 | Non |

**Ce que j'annonce à la DSI.** Le SLA de 99,9 % autorise 43 min/mois ; à 9,04 s par panne brutale, il
faudrait **285 basculements dans le mois** pour l'épuiser — le failover automatique consomme 0,35 %
du budget par incident, il n'est pas le risque. Un arrêt planifié (0,18 s) est invisible.

Deux réserves que je ne tais pas : ces 9 s sont mesurées **vue du cluster**, l'application subit un
trou plus long (Q31) ; et le retour du nœud coûte **11,55 s supplémentaires** à cause du `priority: 2`,
soit une seconde interruption pour un seul incident.

### Q23 — le quorum

```bash
docker start mongo1              # remise en marche des 3
docker stop mongo2 mongo3        # on tue 2 nœuds sur 3
docker exec mongo1 mongosh --quiet --eval 'print(db.hello().isWritablePrimary, rs.status().myState)'
```

**(a) Les deux relevés**

| Instant | `isWritablePrimary` | `myState` | État |
|---|---|---|---|
| **Immédiat** | **`true`** | **1** | PRIMARY |
| **+15 secondes** | **`false`** | **2** | **SECONDARY** |

**Ce qui s'est passé entre les deux : mongo1 s'est rétrogradé tout seul.**

Au moment de l'arrêt, mongo1 *croit* encore être primary — il n'a pas encore constaté la disparition
de ses deux pairs. Il faut `electionTimeoutMillis` (10 s) sans pouvoir joindre une **majorité de
votants** pour qu'il en tire la conséquence. Il n'attend alors aucune instruction : il **abdique de
lui-même** et repasse SECONDARY.

C'est le mécanisme **anti-split-brain**. Sans lui, une coupure réseau séparant le set en deux
partitions laisserait un primary de chaque côté, chacun acceptant des écritures divergentes,
irréconciliables au retour. La règle « un primary qui perd la majorité se rétrograde » garantit qu'il
ne peut jamais y avoir **deux primaries simultanés**.

Ces 10 secondes sont aussi la fenêtre pendant laquelle un client mal informé pourrait encore écrire
sur un primary condamné — c'est précisément la situation que `w: "majority"` (Q24) neutralise.

**(b) Le nœud survivant accepte-t-il encore des écritures ? Des lectures ?**

| Opération | Résultat |
|---|---|
| Écriture | **refusée** — `codeName: NotWritablePrimary`, « not primary » |
| Lecture | **acceptée** — 29 470 documents |

Le cluster est donc en **lecture seule**. C'est le comportement voulu : les données sont toujours là
et restent servies, mais plus aucune modification n'est acceptée puisque aucune ne pourrait être
confirmée par une majorité. **Un Replica Set qui perd le quorum ne tombe pas — il se fige.**

**(c) Pourquoi 3 nœuds tolèrent 1 panne et pas 2, et pourquoi 4 ne font pas mieux**

La **majorité** d'un set de N membres votants vaut `⌊N/2⌋ + 1`. Un primary ne peut être élu, et ne
peut se maintenir, que s'il est en contact avec au moins ce nombre de membres.

| Membres | Majorité requise | Survivants avec 1 panne | Survivants avec 2 pannes | Pannes tolérées |
|---|---|---|---|---|
| **3** | **2** | 2 ✅ | 1 ❌ | **1** |
| **4** | **3** | 3 ✅ | 2 ❌ | **1** |
| 5 | 3 | 4 ✅ | 3 ✅ | **2** |

Avec 3 membres, la majorité est 2 : une panne laisse 2 survivants, le quorum tient. **Deux pannes
laissent 1 survivant, qui est minoritaire** — c'est exactement ce que j'ai observé, mongo1 se
rétrogradant après 15 s.

**Passer à 4 ne change rien**, parce que la majorité monte à 3 en même temps que l'effectif. Deux
pannes laissent 2 survivants sur une majorité de 3 : toujours insuffisant. On paie une machine de
plus pour la **même tolérance d'une panne**, tout en ajoutant un composant supplémentaire susceptible
de tomber — la fiabilité globale **baisse**.

C'est pourquoi les Replica Sets se dimensionnent en **nombres impairs** : seul le passage à 5
(majorité 3) fait réellement progresser la tolérance, à 2 pannes. Vérifié expérimentalement en R1.

## Partie 4

### Q24 — `w: 1` vs `w: "majority"`

```js
db.demo.insertOne({ a: "w1" },   { writeConcern: { w: 1 } })          // OK en 14 ms
db.demo.insertOne({ a: "wmaj" }, { writeConcern: { w: "majority" } }) // OK en  8 ms
```

Les deux réussissent. **La différence n'est pas le résultat, c'est la garantie.**

| | Ce que le serveur confirme |
|---|---|
| `w: 1` | l'écriture est **sur le primary**. Rien n'est dit des secondaries. |
| `w: "majority"` | l'écriture est **sur une majorité de nœuds porteurs de données** (ici 2 sur 3). |

**Le scénario précis de la Partie 3 où `w: 1` aurait perdu l'écriture : la panne brutale de la Q21.**
Le primary acquitte en `w: 1` dès qu'il a écrit localement, **sans attendre** les secondaries
(Q15 : la réplication est asynchrone). Si SIGKILL le frappe dans cet intervalle, l'écriture n'a
jamais quitté la machine morte. Le nouveau primary est élu **sans elle**, et elle disparaît.

Pire : elle réapparaît puis s'efface. Quand l'ancien primary revient, il découvre une écriture que la
majorité ignore et doit **l'annuler** — c'est le **rollback**, reproduit en **B4**, où 3 écritures
acquittées en `w: 1` ont été effacées et écrites dans un fichier de rollback.

`w: "majority"` supprime ce risque par construction : une écriture confirmée est sur au moins 2
nœuds, donc **au moins un survivant l'a** et le nouveau primary en héritera.

### Q25 — un write concern impossible

```js
db.demo.insertOne({ a: 1 }, { writeConcern: { w: 4, wtimeout: 3000 } })
```

```
codeName : UnsatisfiableWriteConcern
code     : 100
message  : Not enough data-bearing nodes
durée    : 1 ms
```

**MongoDB refuse en 1 milliseconde, pas au bout des 3 secondes.** Parce que `w: 4` n'est pas une
condition *qui pourrait finir par se réaliser*, c'est une condition **structurellement impossible** :
le set compte 3 nœuds porteurs de données, un quatrième acquittement ne peut pas exister, quelle que
soit la durée d'attente.

Le serveur **valide le write concern contre la configuration** avant de se mettre à attendre.
`wtimeout` borne l'attente d'une réplication *possible* ; il ne sert à rien quand l'objectif est
inatteignable. Attendre 3 secondes pour échouer de toute façon ne serait qu'une latence gratuite.

Ce comportement contraste avec la **Q26**, où `w: 3` est *possible en principe* (3 nœuds sont
configurés) : là, MongoDB attend bien le `wtimeout` complet.

### Q26 — la question d'écart de la journée

`docker stop mongo3`, puis depuis le primary :

**(a) Laquelle passe, laquelle échoue**

| Écriture | Résultat | Durée |
|---|---|---|
| `{ b: 1 }` en `w: "majority", wtimeout: 3000` | **OK** | 4 ms |
| `{ c: 1 }` en `w: 3, wtimeout: 3000` | **ÉCHEC — `WriteConcernFailed` (code 64)** | **3027 ms** |

Message : `waiting for replication timed out`.

`w: "majority"` passe parce que la majorité de 3 vaut **2**, et 2 nœuds sont vivants (mongo1 +
mongo2). `w: 3` exige les 3, or mongo3 est arrêté : le serveur attend, espère son retour, et abandonne
au bout du `wtimeout` — **3027 ms**, cette fois-ci pleinement consommées, contrairement à la Q25.

**(b) Le décompte**

```js
db.demo.countDocuments({})
```

| | |
|---|---|
| **Documents trouvés** | **5** |
| Attendus si « échec » signifiait « rien n'a été écrit » | **4** |
| **Écart** | **+1** |

Le document `{ c: 1 }`, celui de l'écriture **échouée**, est **bel et bien en base** :

```js
[ { a: 'w1' }, { a: 'wmaj' }, { a: 1 }, { b: 1 }, { c: 1 } ]
```

*(le `{ a: 1 }` est d'ailleurs le document de la **Q25**, dont l'écriture avait elle aussi « échoué »
en `UnsatisfiableWriteConcern` — le phénomène s'était déjà produit sans qu'on le remarque.)*

**(c) Explication du résultat contre-intuitif**

**Un échec de write concern n'est pas un échec d'écriture.** Ce sont deux étapes distinctes :

1. Le primary **applique** l'écriture localement et l'inscrit dans son oplog. **C'est fait, c'est
   définitif.**
2. Le primary **attend** les acquittements demandés par le write concern.

L'erreur ne concerne que l'étape 2. Elle dit exactement : *« l'écriture a eu lieu, mais je n'ai pas
pu confirmer qu'elle était répliquée autant que tu le demandais »*. Elle ne déclenche **aucune
annulation** — MongoDB ne revient pas en arrière, il se contente de ne pas garantir la durabilité
souhaitée. Et de fait, `{ c: 1 }` a été répliqué sur mongo2 ; seul le 3ᵉ acquittement manquait.

**Conséquence pour une application qui rejouerait l'écriture après l'erreur : elle crée un doublon.**
Elle croit que rien n'a été écrit, réémet l'insertion, et se retrouve avec **deux documents**. Sur une
commande client, un paiement ou un mouvement de stock, c'est une double exécution — la conséquence
est plus grave que l'erreur d'origine.

La bonne réaction à un `WriteConcernFailed` n'est pas de rejouer à l'aveugle, mais de **vérifier
l'état réel** avant de décider, ou de rendre l'opération idempotente (clé métier unique, `upsert` sur
un identifiant stable) pour qu'un rejeu soit inoffensif. C'est exactement le mécanisme
`lsid`/`txnNumber` que `retryWrites` exploite (Q32d).

Ce résultat est confirmé en **Q33** : lors d'un `stepDown` sans `retryWrites`, le script compte 39
réussites alors que la base en contient **40**.

### Q27 — `j: true`

```js
db.demo.insertOne({ d: "j" },   { writeConcern: { w: "majority", j: true } })   // 10 ms
db.demo.insertOne({ e: "noj" }, { writeConcern: { w: "majority", j: false } })  //  3 ms
```

Moyenne sur 50 écritures :

| Write concern | Coût moyen |
|---|---|
| `w: 1` | 0,76 ms |
| `w: "majority"` | 1,28 ms |
| `w: "majority", j: true` | **1,34 ms** |

**Ce que `j: true` garantit en plus.** Sans lui, « écrit » signifie **écrit en mémoire** : la donnée
est dans le cache du serveur, qui la persistera au disque plus tard. Avec `j: true`, le serveur
n'acquitte qu'après avoir **forcé l'écriture dans le journal sur disque** (`fsync`). La donnée
survit alors à une **perte d'alimentation** du nœud, pas seulement à un crash du processus.

**À quel coût.** Ici +0,06 ms seulement, mais ce chiffre est trompeur : ces conteneurs tournent sur
un **SSD NVMe local**, où un `fsync` est très rapide. Sur un disque mécanique ou un stockage réseau,
le surcoût est d'un tout autre ordre — c'est une **écriture physique synchrone**, le point de
contention classique d'une base de données.

**« Que se passe-t-il si les 3 machines perdent le courant en même temps ? »** C'est le seul scénario
où `j: true` change quelque chose, et il est plus subtil qu'il n'y paraît.

- En `w: "majority"` **sans** `j`, l'écriture est confirmée par 2 nœuds — mais peut-être **dans leur
  mémoire seulement**. Une coupure simultanée des 3 machines efface la mémoire des 3 : l'écriture
  acquittée **est perdue**, alors même que la majorité l'avait confirmée.
- En `w: "majority", j: true`, les 2 nœuds ont écrit dans leur journal disque avant d'acquitter.
  Au redémarrage, ils rejouent le journal et **la retrouvent**.

Autrement dit `w: "majority"` protège contre la perte de **machines**, `j: true` contre la perte de
**courant**. Ce sont deux risques différents, et la réplication ne couvre pas le second : une panne
électrique de datacenter frappe tous les nœuds **en même temps**, ce qui annule le bénéfice de la
redondance.

Réserve d'honnêteté : ce scénario suppose les 3 nœuds sur la **même alimentation**. C'est justement
ce qu'on évite en les répartissant sur plusieurs zones — la vraie parade est topologique, `j: true`
n'est que le filet.

### Q28 — Read Concern

```js
db.demo.countDocuments({})                                        // 7  (readConcern "local")
db.runCommand({ count: "demo", readConcern: { level: "majority" } })  // 7
```

Résultat identique ici, le cluster étant au repos et convergé.

**Ce que `readConcern: "majority"` change pour un utilisateur final**, en repartant de la Q26 : on y a
vu qu'une écriture peut **exister localement sur le primary sans être confirmée par la majorité**
(`{ c: 1 }`). En `readConcern: "local"`, un lecteur **voit cette donnée** — alors qu'elle n'est
garantie sur aucun autre nœud et pourrait être annulée par un rollback (B4). L'utilisateur lit une
information qui peut **disparaître ensuite**.

En `readConcern: "majority"`, le serveur ne renvoie que ce qui est **répliqué sur une majorité**, donc
ce qui **survivra à toute bascule**. Concrètement : `"local"` répond « voici ce que je sais »,
`"majority"` répond « voici ce qui est acquis ». Le prix est un léger retard — les toutes dernières
écritures, pas encore confirmées, sont invisibles.

Le compromis se choisit par usage : `"local"` pour un affichage sans conséquence, `"majority"` dès
qu'une décision s'appuie sur la lecture (solde avant débit, stock avant commande).

## Partie 5

Sortie brute complète, horodatée, dans **`resilience.md`**. Livrable : **`writer.py`**.

### Q29 — le piège de l'URI

```python
MongoClient("mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0")
```

```
ServerSelectionTimeoutError
mongo1:27017: [Errno 8] nodename nor servname provided, or not known,
mongo3:27017: [Errno 8] nodename nor servname provided, or not known,
mongo2:27017: [Errno 8] nodename nor servname provided, or not known,
Timeout: 5.0s,
Topology Description: <TopologyDescription id: 6a8fe0fed9e404e2ac24df1c,
  topology_type: ReplicaSetNoPrimary,
  servers: [<ServerDescription ('mongo1', 27017) server_type: Unknown, rtt: None,
              error=AutoReconnect('mongo1:27017: [Errno 8] nodename nor servname provided...')>,
            <ServerDescription ('mongo2', 27017) server_type: Unknown, ...>,
            <ServerDescription ('mongo3', 27017) server_type: Unknown, ...>]>
```

**(a) Hôtes essayés : `mongo1:27017`, `mongo2:27017`, `mongo3:27017`.** Pas un seul `localhost`.

**(b) D'où sortent-ils ?** De **`rs.conf()`**. Les membres y sont déclarés sous leurs noms de
conteneurs — c'est ce que `init-rs.js` a écrit. La liste de l'URI n'est qu'une **liste d'amorçage**
(*seed list*) : elle sert uniquement à joindre **un** nœud. Dès le premier contact, le driver demande
au nœud de décrire le set, reçoit `hosts: ['mongo1:27017', 'mongo2:27017', 'mongo3:27017']`, et
**remplace intégralement** sa liste par celle-là. Les `localhost` sont jetés.

Depuis l'hôte macOS, ces noms ne résolvent pas — ils n'existent que dans le réseau Docker.

**(c) Vérification : l'hypothèse était incomplète**

```python
MongoClient("mongodb://localhost:27017")     # sans ?replicaSet=
```
→ **échoue aussi**, avec les mêmes `mongo1/mongo2/mongo3`.

Ce que le nœud annonce spontanément :

```js
db.hello()
// setName : rs0
// hosts   : [ 'mongo1:27017', 'mongo2:27017', 'mongo3:27017' ]
// me      : mongo1:27017
```

**Reformulation : ce n'est pas le paramètre `?replicaSet=` qui déclenche le remplacement de la
liste, c'est la découverte du set elle-même.** Le driver l'engage **dès qu'un nœud se déclare membre
d'un Replica Set** — c'est-à-dire dès que `hello()` renvoie un `setName`. Le paramètre `?replicaSet=`
ne fait qu'ajouter une **vérification** (« refuse si le set ne s'appelle pas rs0 ») ; il ne commande
pas la découverte, qui est le comportement par défaut.

**(d) Désactiver la découverte : `directConnection=true`**

```python
MongoClient("mongodb://localhost:27017/?directConnection=true")
```

| | |
|---|---|
| `ping` | **OK** |
| `topology_description.topology_type_name` | **`Single`** |
| `client.primary` | **`None`** |
| `client.secondaries` | **`set()`** — vide |
| Lecture `census.zips` | 29 470 documents |

**Ça marche — mais on a perdu le Replica Set.** Le driver ne voit plus qu'**un serveur isolé** : il
ignore qu'il y a un primary, des secondaries, et une topologie. `client.primary` vaut `None` non
parce qu'il n'y en a pas, mais parce que le driver **ne cherche plus à le savoir**.

**Ce qu'on a perdu, c'est le failover automatique.** Si ce nœud tombe ou rétrograde, le driver n'a
**aucun autre nœud vers qui basculer** : il échouera, indéfiniment. On a troqué la haute
disponibilité contre une simple commodité de connexion. C'est acceptable pour un diagnostic ponctuel,
jamais pour une application.

La vraie solution est celle de la partie 5.2 : **lancer l'application dans le réseau du cluster**, où
`mongo1/2/3` résolvent.

### Q30 → Q33

Réponses détaillées, sorties brutes et tableaux comparatifs dans **`resilience.md`**. Synthèse :

| Q | Résultat |
|---|---|
| Q30 | Primary vu : **mongo1:27017**, latence 4–13 ms |
| Q31 | **1 seule** écriture en échec · 36 réussies · écart **0** · indisponibilité **≈ 10,4 s** |
| Q32a | `retryWrites` true vs false sur `docker kill` : **1 échec dans les deux cas**, écart **0** |
| Q32c | Sur `rs.stepDown(20)` : **0 échec** avec `retryWrites`, **1 échec** sans — code **189 `PrimarySteppedDown`** |
| Q33 | Le seul écart est **−1** : une écriture comptée en échec était **bien en base** |

Le point saillant : **`retryWrites` ne sert à rien contre une panne brutale** (aucun primary à qui
reparler pendant 9 s) mais annule complètement l'impact d'une rétrogradation planifiée.

## Partie 6 — Réflexion

### R1 — le collègue qui veut un 4ᵉ nœud

**Vérifié expérimentalement avant de répondre.**

```js
rs.add("mongo4:27017")
// mongo1=PRIMARY  mongo2=SECONDARY  mongo3=SECONDARY  mongo4=SECONDARY
```

Puis `docker stop mongo3 mongo4` — 2 pannes sur 4 :

| | Set de 4, 2 pannes | Set de 3, 1 panne (Q23) |
|---|---|---|
| `isWritablePrimary` | **`false`** | `true` |
| `myState` | **2 (SECONDARY)** | 1 (PRIMARY) |
| Écriture | **REFUSÉE — `NotWritablePrimary`** | acceptée |
| Lecture | OK, 29 470 docs | OK |

**Le set de 4 n'accepte plus les écritures avec 2 pannes.** Le survivant s'est rétrogradé, exactement
comme le set de 3 avec 2 pannes en Q23. Le set de 3 avec **1** panne, lui, continue d'écrire
normalement.

*Observation de passage :* juste après l'arrêt, mongo1 annonçait encore `isWritablePrimary: true`
tout en **refusant déjà les écritures** — la rétrogradation formelle suit de quelques secondes la
perte effective du droit d'écrire. Un client qui se fie au seul `hello()` peut donc croire à tort que
le service est nominal pendant cette fenêtre.

**Réponse au collègue, en une phrase :** *« Un 4ᵉ nœud coûte une machine de plus sans rien apporter —
la majorité passe de 2 à 3 en même temps que l'effectif, donc le set tolère toujours exactement une
panne, tout en ajoutant un composant supplémentaire susceptible de tomber. »*

**Ce que je proposerais avec un budget de 4 machines :**

1. **3 nœuds porteurs de données + 1 machine pour la supervision, les sauvegardes, ou un membre
   `hidden`** (B2) dédié aux exports analytiques et aux backups sans impacter la production. La 4ᵉ
   machine sert, mais **pas comme votant**.
2. Si l'objectif est vraiment de tolérer **2 pannes**, il faut **5 votants** — pas 4. Avec 4 machines,
   on peut monter un set de 5 en plaçant un membre `votes: 1, priority: 0` léger sur la machine de
   supervision, mais c'est un compromis, pas une vraie 5ᵉ machine.
3. **Ce que je déconseille : l'arbitre.** C'est la tentation naturelle (« un votant gratuit »), et
   c'est le piège démontré en **B1** : sur un set Primary + Secondary + Arbitre, la perte du seul
   secondary laisse le primary élu et la supervision au vert, **mais toutes les écritures
   `w: "majority"` échouent** — l'arbitre ne porte aucune donnée et ne peut rien acquitter.

### R2 — deux problèmes, deux réponses

**Réplication** — *« comment le service survit-il à la perte d'une machine ? »* C'est un problème de
**disponibilité et de durabilité** : on garde **N copies de la même donnée** pour qu'une panne
n'interrompe ni ne détruise rien. Mesuré aujourd'hui : 9,04 s de bascule (Q21), 0 donnée perdue en
`w: "majority"`.

**Sharding** — *« comment stocker et servir plus de données que n'en tient une machine ? »* C'est un
problème de **capacité et de débit** : on **découpe** la donnée en tranches disjointes réparties sur
plusieurs machines. Chaque shard ne détient qu'**une partie** du tout.

La distinction tient en une phrase : **la réplication duplique, le sharding divise.** L'une répond à
la panne, l'autre au volume. Aucune ne remplace l'autre.

**Nombre de machines d'un cluster de production à 3 shards**, en repartant de la majorité de la
Q23(c) — chaque composant répliqué doit lui-même être un Replica Set impair, donc 3 nœuds minimum :

| Composant | Calcul | Machines |
|---|---|---|
| Shards | 3 shards × 3 nœuds | **9** |
| Config servers | 1 Replica Set de 3 | **3** |
| Routeurs `mongos` | 2 minimum (sinon SPOF) | **2** |
| **Total** | | **14** |

C'est le « 14+ machines mini » du cours, et il se **déduit** de la règle de majorité : chaque brique
doit survivre à la perte d'un nœud, donc chaque brique coûte 3 machines.

**Pourquoi un cluster shardé non répliqué serait plus fragile qu'un simple Replica Set.** Parce que
les modes de défaillance s'**additionnent au lieu de se compenser**.

Dans un Replica Set de 3, la perte d'un nœud ne coûte **rien** : les deux autres ont la même donnée,
le service continue (mesuré : 9 s d'interruption). Les copies sont **redondantes**.

Dans un cluster de 3 shards non répliqués, chaque shard détient une **tranche unique**. Perdre un
shard, c'est perdre **définitivement un tiers des données** — aucune autre machine n'en a la copie.
Et comme la probabilité qu'au moins une machine tombe **croît avec leur nombre**, on obtient le pire
des deux mondes : **plus de machines, donc plus de pannes probables, et chaque panne est fatale au
lieu d'être absorbée**.

C'est pourquoi sharding et réplication se combinent toujours : **on shard pour la capacité, on
réplique chaque shard pour la survie**. Un shard est un Replica Set, jamais une machine seule.

### R3 — régler le curseur, vérifié par l'expérience

```js
cfg = rs.conf(); cfg.settings.electionTimeoutMillis = 2000; rs.reconfig(cfg)
```

Puis `docker kill` du primary, `watch_primary.py` en marche :

```
docker kill a 09:12:37.433
[   0.01s] 09:12:34.540  primary = mongo1:27017
[   3.07s] 09:12:37.606  primary = AUCUN
[   4.91s] 09:12:39.445  primary = mongo2:27017      <- 2,012 s
[  12.89s] 09:12:47.427  primary = AUCUN             <- bascule spontanée !
[  15.05s] 09:12:49.580  primary = mongo2:27017
```

**(a) Les deux délais et leur rapport**

| `electionTimeoutMillis` | Délai mesuré |
|---|---|
| 10 000 ms (Q21) | **9,037 s** |
| 2 000 ms | **2,012 s** |
| **Rapport** | **4,49×** |

**Non, la bascule n'est pas 5 fois plus rapide.** Le paramètre a été divisé par 5, le délai seulement
par **4,49**.

**La part du délai qui ne dépend pas du paramètre**, c'est celle identifiée en Q21 : le compte à
rebours démarre au **dernier heartbeat réussi**, pas à la mort du nœud. Avec
`heartbeatIntervalMillis = 2000`, ce décalage vaut de 0 à 2 s (≈ 1 s en moyenne). S'ajoute la durée
de l'élection elle-même, ~150 ms.

Le détail éclaire le rapport non entier :

```
à 10 000 ms : 10 000 − ~1 100 (dernier heartbeat) + ~150 (élection) ≈ 9 040 ms  ✓
à  2 000 ms :  2 000 −   ~150                     + ~160            ≈ 2 010 ms  ✓
```

À 10 s, le décalage de heartbeat **retranche** environ 1 s (−11 %). À 2 s, il ne peut plus retrancher
autant — le timeout est devenu du même ordre que l'intervalle de heartbeat lui-même. **Le gain
sature** : plus on descend, plus la part incompressible (heartbeat + élection) pèse dans le total. On
ne descendra jamais en dessous d'environ `heartbeatIntervalMillis`, quoi qu'on règle.

**(b) Le risque à descendre trop bas — observé, pas supposé**

Le relevé ci-dessus contient une seconde bascule **que je n'ai pas provoquée** : à `t+12,89 s`, alors
que mongo2 était primary et stable depuis 8 secondes, le cluster repasse à `primary = AUCUN` puis
réélit mongo2 à `t+15,05 s`. **Une élection parasite, sans aucune panne.**

C'est exactement le risque : avec un timeout de 2 s, **le moindre ralentissement** — un pic de charge,
une pause GC, un hoquet réseau — suffit à faire manquer un heartbeat et à déclencher une élection.

Sur le réseau à hoquet de 3 secondes évoqué par l'énoncé, le résultat est mécanique : à 2 s de
timeout, **chaque hoquet provoque une bascule**. Or une élection n'est pas gratuite :

- pendant sa durée, il n'y a **aucun primary** — les écritures échouent (Q31) ;
- le nouveau primary doit exécuter un **catch-up** avant d'accepter des écritures ;
- les drivers doivent redécouvrir la topologie (le +1,4 s de la Q31) ;
- des écritures en vol sont interrompues (`PrimarySteppedDown`, Q32c), voire annulées en `w: 1` (B4).

**Un timeout trop bas transforme une micro-perturbation réseau en interruption de service.** On
« gagne » 7 secondes sur une panne réelle rare, et on s'inflige des bascules répétées sur des
incidents bénins fréquents. C'est un mauvais échange.

**(c) Valeur recommandée à la DSI, argument chiffré**

**Je recommande de conserver les 10 000 ms par défaut.**

L'argument est le budget SLA. À 99,9 %, l'enveloppe est de **43 min/mois**. Une panne brutale coûte
**9,04 s** (Q21), soit **0,35 %** du budget — il faudrait **285 pannes serveur dans le mois** pour
l'épuiser. **Le délai d'élection n'est tout simplement pas le facteur limitant du SLA.**

Descendre à 2 s ferait gagner 7 s par panne, soit **0,27 %** du budget mensuel par incident — un gain
négligeable. En face, le coût est une **instabilité observée dès mon unique test** : une élection
parasite en 40 secondes d'observation. Sur un mois, à ce rythme, les bascules spontanées coûteraient
bien plus que les 7 s économisées.

Si la DSI exige malgré tout une bascule plus rapide, la valeur défendable est **5 000 ms** : elle
laisse encore **2,5 heartbeats manqués** de marge (contre 1 seul à 2 000 ms), tout en ramenant la
bascule à ~4 s. Et il faudrait l'accompagner d'une **mesure préalable de la stabilité réseau** — un
timeout se règle sur la latence réelle observée, pas sur un souhait.

### R4 — le chiffre honnête

**La phrase livrée à la DSI :**

> « Lors d'une panne serveur brutale, notre service est indisponible **en écriture pendant environ
> 10 secondes** — 9,0 s pour élire un nouveau primary, 10,4 s avant que l'application ne reprenne
> réellement ses écritures — et il **ne perd aucune écriture confirmée**, à la condition stricte que
> celles-ci soient émises en `w: "majority"`. En `w: 1`, une écriture pourtant acquittée peut être
> annulée : nous l'avons reproduit, 3 écritures effacées après un incident réseau. »

**Pourquoi annoncer le seul chiffre de la Q21 serait malhonnête**, en trois points :

**1. Les 9,04 s ne sont pas ce que vit l'utilisateur.** C'est une mesure prise *du point de vue du
cluster*, avec un outil qui interroge `rs.status()` toutes les 300 ms. L'application, elle, a subi
**10,4 s** (Q31) : le driver doit encore *s'apercevoir* du changement de topologie. Annoncer 9,04 s,
c'est **retrancher 1,4 s** que l'utilisateur subit réellement — présenter la métrique du technicien
comme si c'était celle du client.

**2. Le chiffre ne dit rien de l'intégrité, seulement de la durée.** La Q26 a montré qu'une écriture
peut **exister sans être confirmée** — le `{ c: 1 }` en base malgré son `WriteConcernFailed` — et la
Q33 a mesuré l'écart inverse : le script comptait 39 réussites pour **40 documents réels**. Une
disponibilité de 9 s avec des écritures fantômes n'est pas un bon résultat. **Le temps de bascule ne
mesure pas la correction des données.**

**3. Le chiffre est conditionnel, et taire la condition la rend fausse.** Les 9 s ne valent que
`w: "majority"`. En `w: 1`, la durée est la même mais **des données disparaissent** — démontré en B4,
3 écritures acquittées effacées et retrouvées dans un fichier de rollback. Annoncer « 9 secondes »
sans préciser le write concern laisserait croire que la configuration est sans importance, alors
qu'elle est **la seule chose qui sépare une bascule propre d'une perte de données silencieuse**.

**En un mot :** un chiffre de disponibilité sans son write concern et sans la mesure côté application
n'est pas une information, c'est une publicité.

## Pour aller plus loin

### B1 — l'arbitre et le faux sentiment de sécurité

**MongoDB 7.0 refuse d'emblée d'ajouter un arbitre :**

```
MongoServerError: Reconfig attempted to install a config that would change the implicit default
write concern. Use the setDefaultRWConcern command to set a cluster-wide write concern and try
the reconfig again.
```

C'est déjà la réponse à l'exercice — **le serveur lui-même met en garde**. Il faut le forcer :

```js
db.adminCommand({ setDefaultRWConcern: 1, defaultWriteConcern: { w: "majority" } })
rs.addArb("mongoarb:27017")
```

| Membre | État | `votes` | `arbiterOnly` |
|---|---|---|---|
| mongo1 | PRIMARY | 1 | false |
| mongo2 | SECONDARY | 1 | false |
| mongoarb | **ARBITER** | **1** | **true** |

**Quelles données stocke-t-il ? Aucune.** Toute tentative de lecture est rejetée :

```
MongoServerError: node is not in primary or recovering state
```

Il ne détient ni base, ni oplog, ni copie. **Il ne sert qu'à voter.**

**Le piège**, sur un set réduit à Primary + Secondary + Arbitre — on arrête le seul secondary :

```
mongo1 est-il toujours PRIMARY ? true  (myState=1)
health du set : mongo1=1 mongo2=0 mongoarb=1
```

| Écriture | Résultat |
|---|---|
| `w: "majority", wtimeout: 5000` | **ÉCHEC — `WriteConcernFailed` (64) après 5026 ms** |
| `w: 1` | **OK en 4 ms** |

**Le primary est toujours élu, la supervision est au vert — et toute écriture critique échoue.**

La raison : la majorité de 3 votants vaut 2 acquittements, mais **l'arbitre ne peut pas en fournir**,
puisqu'il ne stocke rien. Le seul nœud porteur de données restant est le primary lui-même. Une
majorité de nœuds **porteurs de données** est devenue inatteignable, alors que la majorité des
**votants** est satisfaite. Le quorum d'élection tient ; le quorum de durabilité, non.

**C'est exactement la raison pour laquelle MongoDB déconseille les arbitres.** Ils créent un cluster
qui **paraît sain** — primary élu, `health: 1`, pas d'alerte — alors qu'il a perdu toute capacité
d'écriture durable. Le mode de défaillance est **silencieux**, et c'est le pire.

À la place : un vrai secondary, même sur une machine modeste (`priority: 0` s'il ne doit jamais
devenir primary). Il vote **et** acquitte.

### B2 — le membre caché et le membre retardé

**Membre caché** — `hidden: true, priority: 0` sur mongo3 :

```js
db.hello().hosts   // [ 'mongo1:27017', 'mongo2:27017' ]
```

**mongo3 a disparu de la liste annoncée aux clients.** Il réplique toujours, mais aucun driver ne le
verra ni ne lui enverra de lecture, quelle que soit la read preference. `priority: 0` lui interdit en
outre de devenir primary.

**Membre retardé** — `secondaryDelaySecs: 60`, puis insertion d'un document daté et recherche toutes
les 10 s :

| Instant | mongo2 (normal) | mongo3 (retardé 60 s) |
|---|---|---|
| t+0 s | **1** | 0 |
| t+10 s | 1 | 0 |
| t+20 s | 1 | 0 |
| t+30 s | 1 | 0 |
| t+40 s | 1 | 0 |
| t+50 s | 1 | 0 |
| **t+60 s** | 1 | **1** |
| t+70 s | 1 | 1 |

**Le retard est exactement celui configuré : 60 secondes.** mongo3 détient délibérément une image du
passé.

**À quoi sert concrètement un membre retardé.** À se protéger de l'**erreur humaine ou applicative**,
pas de la panne matérielle.

La catastrophe qu'un backup ne rattrape pas assez vite, c'est le **`deleteMany` sans filtre**, le
`dropDatabase` de trop, la migration qui corrompt une table — bref une opération **parfaitement
valide** que la base exécute et **réplique instantanément** sur tous les nœuds. La réplication ne
protège de rien ici : elle propage fidèlement la catastrophe en quelques millisecondes.

Un backup nocturne fait perdre jusqu'à 24 h de données et met des heures à restaurer. Le membre
retardé, lui, détient **l'état d'il y a 60 secondes** (en production : 1 h ou plus) : il suffit de
l'isoler avant que le délai ne s'écoule pour disposer d'une copie **saine, immédiate et complète**.
C'est une **fenêtre d'annulation**, la seule protection contre une commande destructrice légitime.

### B3 — authentifier le Replica Set

Un Replica Set authentifié exige un **keyFile partagé** : il sert à la fois d'authentification
*interne* entre les nœuds et active l'authentification des clients.

```bash
openssl rand -base64 756 > mongo-keyfile
```

**Erreur n°1 — permissions trop ouvertes.** Le fichier est créé en `644` par défaut. Les 3 conteneurs
refusent de démarrer et sortent en `Exited (1)` :

```json
{"c":"ACCESS","id":20254,"ctx":"main","msg":"Read security file failed",
 "attr":{"error":{"code":30,"codeName":"InvalidPath",
                  "errmsg":"permissions on /etc/mongo-keyfile are too open"}}}
```

MongoDB **refuse de démarrer** plutôt que d'utiliser un secret lisible par tous. Correctif :

```bash
chmod 400 mongo-keyfile
```

**Erreur n°2 — plus aucun accès aux données.** Les nœuds démarrent, mais :

```js
db.zips.countDocuments({})
// codeName : Unauthorized  (code 13)
// message  : not authorized on census to execute command { aggregate: "zips", ... }
```

Et depuis l'hôte :

```
OperationFailure: Command aggregate requires authentication, code 13, codeName: Unauthorized
```

**Subtilité observée :** `rs.status()` fonctionne encore alors que la lecture des données est
refusée. C'est l'**exception localhost** — tant qu'aucun utilisateur n'existe, MongoDB tolère les
connexions locales non authentifiées, précisément pour permettre de créer le premier compte. Elle ne
s'applique qu'aux connexions depuis la machine du nœud : un `docker exec` en bénéficie, une connexion
depuis l'hôte non.

C'est le piège classique de l'opération : **si l'on active `--auth` sans profiter de cette fenêtre
pour créer l'administrateur, on se verrouille dehors.**

```js
db.createUser({ user: "admin", pwd: "ipssi2025", roles: [{ role: "root", db: "admin" }] })
```

Vérification :

```bash
docker exec mongo1 mongosh -u admin -p ipssi2025 --authenticationDatabase admin census \
  --eval 'db.zips.countDocuments({})'
```
→ **29470** · `mongo1=PRIMARY  mongo2=SECONDARY  mongo3=SECONDARY`

Le set est authentifié, les données intactes. Fichier : **`docker-compose.rs-auth.yml`**.

*Note :* le set a ensuite été **remis en mode non authentifié** pour que toutes les commandes
documentées dans ce rendu restent rejouables telles quelles par un correcteur.

### B4 — le rollback, en vrai

**L'affirmation à prouver :** une écriture confirmée en `w: 1` peut être annulée après un failover.

**1. Isoler le primary** — il se croit encore primary pendant `electionTimeoutMillis` :

```bash
docker network disconnect rslab_default mongo1
```

**2. Y écrire immédiatement en `w: 1`** — les 3 écritures sont **acquittées** :

```
insert 1 OK
insert 2 OK
insert 3 OK
documents sur mongo1 : 3
```

**3. Laisser la majorité élire un nouveau primary :**

| Côté | Primary | Documents dans `rollback_test` |
|---|---|---|
| Majorité (mongo2 + mongo3) | **mongo3** | **0** |
| Isolé (mongo1) | s'est rétrogradé | **3** |

La divergence est en place : mongo1 détient 3 documents que la majorité n'a jamais vus. On écrit un
document côté majorité pour rendre l'écart irréconciliable.

**4. Reconnecter mongo1 :**

```bash
docker network connect rslab_default mongo1
```

```js
db.rollback_test.countDocuments({})   // 1
db.rollback_test.find({}, { _id: 0 }) // [ { n: 99, note: 'ecrit cote majorite' } ]
```

**Les 3 documents ont disparu.** mongo1 revient SECONDARY et ne conserve que la version de la
majorité.

**5. Le fichier de rollback :**

```
/data/db/rollback/80d82523-55f1-4092-a2c1-af7f26ac2ffa/removed.2026-08-27T07-18-34.0.bson
```

```bash
docker exec mongo1 bsondump /data/db/rollback/.../removed.2026-08-27T07-18-34.0.bson
```
```json
{"_id":{"$oid":"6a8fe4ab7efe743658591669"},"n":3,"note":"ecrit sur le primary isole"}
{"_id":{"$oid":"6a8fe4ab7efe743658591668"},"n":2,"note":"ecrit sur le primary isole"}
{"_id":{"$oid":"6a8fe4ab7efe743658591667"},"n":1,"note":"ecrit sur le primary isole"}
```

**Le fichier contient exactement les 3 documents annulés.** La preuve est complète.

**Ce que cela démontre.** Ces 3 écritures avaient reçu un **acquittement positif** : l'application a
été informée que tout s'était bien passé. Elles ont pourtant été **effacées**, sans erreur, sans
alerte, sans qu'aucun client ne soit prévenu. MongoDB ne les jette pas — il les met de côté dans un
fichier BSON, ce qui suppose que **quelqu'un aille le chercher** : une intervention manuelle, sur un
nœud, dans un répertoire que personne ne surveille.

C'est la justification concrète de **`w: "majority"`** (Q24) : une écriture confirmée par la majorité
est **présente sur au moins un nœud du côté qui gagne l'élection**, donc aucun rollback ne peut
l'atteindre. Et c'est la raison pour laquelle la phrase livrée à la DSI en R4 est **conditionnelle** :
« ne perd aucune écriture confirmée » n'est vrai qu'en `w: "majority"`.
