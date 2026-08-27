# resilience.md — ce que voit vraiment l'application

`writer.py` · 1 insertion/seconde dans `census.heartbeat` · `serverSelectionTimeoutMS = 5000`
Lancé dans le réseau du cluster (`--network rslab_default`), horodatage UTC du conteneur.

## Q30 — 5 premières lignes en régime normal

```
07:03:27.028  n=1    primary=mongo1:27017     OK          13ms
07:03:28.029  n=2    primary=mongo1:27017     OK           9ms
07:03:29.030  n=3    primary=mongo1:27017     OK           5ms
07:03:30.031  n=4    primary=mongo1:27017     OK           8ms
07:03:31.033  n=5    primary=mongo1:27017     OK           6ms
```

Primary vu : **mongo1:27017**. Latence d'écriture au repos : **4 à 13 ms**.

## Q31 — sortie brute pendant `docker kill mongo1`

`docker kill` envoyé à **07:03:54.192** (heure conteneur).

```
07:03:50.450  n=9    primary=mongo1:27017     OK           9ms
07:03:51.452  n=10   primary=mongo1:27017     OK           2ms
07:03:52.453  n=11   primary=mongo1:27017     OK           6ms
07:03:53.454  n=12   primary=mongo1:27017     OK           4ms
07:03:54.455  n=13   primary=AUCUN            ECHEC     5429ms  ServerSelectionTimeoutError: No primary
                                                                available for writes, Timeout: 5.0s
07:03:59.884  n=14   primary=AUCUN            OK        4932ms
07:04:04.816  n=15   primary=mongo2:27017     OK           2ms
07:04:05.816  n=16   primary=mongo2:27017     OK           8ms
07:04:06.818  n=17   primary=mongo2:27017     OK          12ms
```

**(a) Écritures en échec consécutives : 1 seule.**

| | |
|---|---|
| Dernière ligne OK avant panne | `n=12` à **07:03:53.454** |
| Première ligne en échec | `n=13` à **07:03:54.455** |
| Première ligne redevenue OK | `n=14` à **07:03:59.884** (aboutie après 4932 ms) |
| Service nominal retrouvé | `n=15` à **07:04:04.816** (2 ms) |

La fenêtre de perturbation va de 07:03:54.455 à 07:04:04.816, soit **≈ 10,4 s**, mais une seule
écriture a réellement échoué. Les deux lignes intermédiaires sont instructives : `n=13` a **attendu
5429 ms** avant d'abandonner, et `n=14` a **attendu 4932 ms puis réussi**. Le driver ne renonce pas
tout de suite — il bloque en attendant qu'un primary apparaisse.

**(b) Décompte total**

| | |
|---|---|
| Écritures réussies | **36** |
| Écritures en échec | **1** |
| Documents réellement en base | **36** |
| **Écart** | **0** |

**(c) Oui, le driver s'est reconnecté seul.** Rien n'a été redémarré côté application. Le changement
de primary est visible **ligne `n=15`** : `primary=mongo2:27017`. Le driver a découvert la nouvelle
topologie, ré-élu sa cible et repris les écritures sans intervention.

**(d) Comparaison avec la Q21**

| Mesure | Valeur |
|---|---|
| Q21 — vue du cluster (`watch_primary.py`) | **9,04 s** |
| Q31 — vue de l'application | **≈ 10,4 s** |
| Écart | **≈ +1,4 s** |

**Elles ne sont pas égales, et l'application est la plus lente.** Explication : les deux mesures ne
comptent pas la même chose.

`watch_primary.py` interroge le cluster toutes les 300 ms et voit le nouveau primary **dès que
l'élection est close**. L'application, elle, doit en plus **s'en apercevoir** : le driver PyMongo
maintient sa propre vision de la topologie, rafraîchie par son *monitoring* interne. Entre l'instant
où mongo2 devient primary et celui où le driver le sait, il s'écoule le temps de son prochain cycle
de découverte. S'y ajoute le fait que l'écriture `n=14` était **déjà engagée** dans son attente de
5 s quand l'élection s'est terminée.

**C'est ce chiffre-là — 10,4 s — qui compte pour l'utilisateur final**, pas les 9,04 s du cluster.

## Q32 — `retryWrites`

### (a) Panne brutale : aucune différence

Même scénario, `docker kill` du primary, une fois avec `retryWrites=true` et une fois avec
`retryWrites=false`.

| URI | Échecs | Exception levée |
|---|---|---|
| `retryWrites=true` | **1** | `ServerSelectionTimeoutError` |
| `retryWrites=false` | **1** | `ServerSelectionTimeoutError` |
| **Écart** | **0** | identique |

```
retryWrites=false :
07:05:30.339  n=13   primary=AUCUN   ECHEC   5360ms  ServerSelectionTimeoutError: No primary available
07:05:35.700  n=14   primary=AUCUN   OK      4153ms
```

**Écart nul, et c'est le résultat attendu.** Le type d'exception est **le même** dans les deux cas.

### (b) Pourquoi `retryWrites` ne sert à rien ici

Pendant une panne brutale, il n'y a **aucun primary pendant ≈ 9 secondes** (Q21 : la ligne
`primary = AUCUN` dure 8,9 s). Or `retryWrites` rejoue une écriture **une fois** — et rejouer suppose
d'avoir un primary à qui reparler. Quand il n'y en a aucun, la reprise se heurte exactement au même
mur que la tentative initiale.

Le driver n'échoue d'ailleurs pas immédiatement : la ligne en échec affiche **5429 ms** et **5360 ms**,
c'est-à-dire précisément le `serverSelectionTimeoutMS = 5000` du script (plus la marge de traitement).
Il **attend** un primary pendant 5 secondes avant d'abandonner. `retryWrites` n'ajoute rien à cette
attente : le problème n'est pas que l'écriture a été rejetée, c'est qu'il n'y a **personne à qui
l'adresser**.

### (c) L'expérience qui prouve : `rs.stepDown(20)`

Un primary qui **rétrograde en restant vivant**. Cette fois il y a bien un nœud joignable — il refuse
simplement l'écriture.

| URI | Échecs | Écart script / base |
|---|---|---|
| `retryWrites=true` | **0** | 40 / 40 → 0 |
| `retryWrites=false` | **1** | 39 / 40 → **−1** |

**Avec `retryWrites=true`** — bascule totalement transparente, pas une écriture perdue :

```
07:07:46.820  n=15   primary=mongo1:27017     OK           3ms
07:07:47.821  n=16   primary=mongo2:27017     OK          12ms
```

Le primary change entre `n=15` et `n=16` sans la moindre erreur.

**Avec `retryWrites=false`** — exception et code exacts :

```
07:09:00.181  n=36   primary=mongo2:27017     ECHEC   12ms
   WriteConcernError: Received stepdown request while waiting for replication
   full error: {'code': 189, 'codeName': 'PrimarySteppedDown'}
```

**En quoi diffèrent-ils du (a) :**

| | Panne brutale (a) | `stepDown` (c) |
|---|---|---|
| Exception | `ServerSelectionTimeoutError` | **`WriteConcernError`** |
| Code | — (échec côté driver) | **189 — `PrimarySteppedDown`** |
| Durée avant échec | **5360 ms** (timeout) | **12 ms** (réponse immédiate) |
| Origine | le driver ne trouve personne | **le serveur répond et refuse** |

La différence est de nature. En (a), l'erreur est **côté client** : aucun serveur n'a répondu, le
driver a expiré. En (c), l'erreur vient **du serveur lui-même**, qui était joignable, a reçu la
requête et l'a rejetée en 12 ms. C'est précisément ce genre d'erreur que `retryWrites` sait
intercepter et rejouer sur le nouveau primary.

**Conclusion.** `retryWrites` protège contre les pannes où **un nœud reste joignable pour dire non** —
rétrogradation, reconfiguration, bascule planifiée, coupure réseau brève. Il ne peut **rien** contre
une panne où il n'y a **aucun primary à qui parler** : là, seule la durée de l'élection compte, et
c'est `electionTimeoutMillis` qu'il faut régler (R3), pas `retryWrites`.

### (d) À quelle condition un rejeu est sans risque de doublon

Les champs responsables ont été vus en **Q10**, dans l'entrée d'oplog d'une insertion :

```js
lsid: { id: UUID('a6040ede-...') },  txnNumber: Long('1'),  stmtId: 0
```

`lsid` identifie la **session**, `txnNumber` numérote l'écriture dans cette session. Le serveur
**mémorise le résultat** de chaque `(lsid, txnNumber)` déjà traité. Si le driver rejoue la même
écriture, le serveur reconnaît le couple, **ne réapplique rien**, et renvoie le résultat d'origine.
Le rejeu est donc idempotent **au niveau du protocole**, pas seulement de la donnée.

**Pourquoi `updateMany` et `deleteMany` ne sont jamais rejoués automatiquement :** ils ne sont **pas
atomiques à l'échelle du lot**. Une opération multi-documents s'exécute document par document — on
l'a mesuré en Q11 : un `updateMany` sur 1 676 documents produit **1 676 entrées d'oplog distinctes**.
Si le primary tombe au milieu, une partie du lot est appliquée et l'autre non, et **le serveur ne
sait pas où il s'est arrêté** : il n'y a pas un `stmtId` unique à mémoriser, mais 1 676.

Rejouer un `updateMany { $inc: { pop: 1 } }` déjà à moitié appliqué incrémenterait deux fois les
documents traités. Le driver refuse donc de décider à la place du développeur : c'est à
l'application de rendre l'opération rejouable, ou de la découper.

## Q33 — le décompte final

**(a) Les deux nombres coïncident-ils ?**

| Scénario | Compteur script | `count_documents` réel | Écart |
|---|---|---|---|
| Panne brutale, `retryWrites=true` (Q31) | 36 | 36 | **0** |
| Panne brutale, `retryWrites=false` (Q32a) | 32 | 32 | **0** |
| `stepDown`, `retryWrites=true` (Q32c) | 40 | 40 | **0** |
| **`stepDown`, `retryWrites=false` (Q32c)** | **39** | **40** | **−1** |

**Le seul écart est de −1, et son signe est capital.**

`écart = réussites annoncées − documents réels`. Un écart **négatif** signifie qu'il y a **plus de
documents en base que le script n'en revendique** : l'écriture `n=36`, que l'application a comptée
comme **échouée**, a en réalité **été enregistrée**.

C'est exactement la leçon de la **Q26** : l'échec d'un write concern ne veut pas dire « rien n'a été
écrit », il veut dire « je n'ai pas pu confirmer ». Une application qui rejouerait `n=36` après
l'erreur créerait un **doublon**.

Ce qu'on n'a **pas** observé, et c'est rassurant : aucun écart **positif**. Aucune écriture annoncée
réussie n'a été perdue. Ce cas-là existe pourtant — c'est le **rollback**, reproduit en B4 : avec
`w: 1` et une partition réseau, 3 écritures acquittées ont été annulées.

**(b) Même scénario avec `w: "majority"`**

| Tirage | Échecs | Compteur | Réel | Écart |
|---|---|---|---|---|
| 1 | 0 | 40 | 40 | 0 |
| 2 | 0 | 30 | 30 | 0 |

**Sur deux tirages, aucun échec ne s'est produit — écart 0 les deux fois.** Je ne peux donc pas
conclure que `w: "majority"` supprime l'écart : je n'ai simplement pas reproduit le cas d'échec, qui
dépend de la coïncidence entre le `stepDown` et une écriture en vol.

Ce que `w: "majority"` garantit en revanche, et qui est démontré ailleurs : il empêche l'écart de
**signe opposé**. Une écriture confirmée en `w: "majority"` est présente sur une majorité de nœuds,
donc **elle survit à toute bascule** — c'est précisément ce qui manquait aux 3 écritures perdues
en B4.

**(c) Le chiffre annoncé à la DSI**

> « Lors d'une panne serveur brutale, notre service est indisponible en écriture pendant **≈ 10 s**
> (10,4 s mesurés côté application, pour 9,0 s côté cluster) et perd **au plus 1 écriture**, à
> condition que les écritures soient émises en **`w: "majority"`** et que le driver soit configuré
> avec la **liste complète des membres du Replica Set** et `retryWrites=true`. »

Les trois conditions ne sont pas décoratives :

- **`w: "majority"`** — sans lui, une écriture acquittée peut être annulée par un rollback (B4 : 3
  documents perdus). Le « au plus 1 » ne tient pas en `w: 1`.
- **liste complète des membres** — avec un seul hôte ou `directConnection=true`, le driver ne
  découvre pas le set (Q29d : `topology_type = Single`, `primary = None`) et **ne bascule jamais** :
  l'indisponibilité devient totale, pas de 10 secondes.
- **`retryWrites=true`** — inutile sur une panne brutale (Q32a), mais il fait passer les
  rétrogradations planifiées de 1 échec à **0** (Q32c). C'est gratuit, il n'y a aucune raison de s'en
  priver.
