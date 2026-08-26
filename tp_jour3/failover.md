# failover.md — mesures de bascule

Replica Set `rs0` · 3 nœuds · `electionTimeoutMillis = 10000` · `heartbeatIntervalMillis = 2000`
Mesures prises avec `watch_primary.py` (sondage 300 ms) le 26/08/2026.

## Q22 — tableau de synthèse

| Scénario | Commande | Délai mesuré | Nœud élu | Écritures perdues ? |
|---|---|---|---|---|
| **Arrêt propre** | `docker stop mongo1` | **0,18 s** | mongo2 | Non |
| **Panne brutale** | `docker kill mongo1` | **9,04 s** | mongo3 | Non (voir Q26/Q33) |
| **Retour du nœud** | `docker start mongo1` | **11,55 s** | mongo1 *(priority takeover)* | Non |

**Rapport panne brutale / arrêt propre : ≈ 50×.**

### Détail des relevés

**Arrêt propre** — `docker stop` envoie SIGTERM, mongod a le temps de prévenir le set :

```
docker stop a 15:54:06.076
[   0.01s] 15:54:03.182  primary = mongo1:27017
[   3.08s] 15:54:06.257  primary = mongo2:27017
```
→ 15:54:06.257 − 15:54:06.076 = **0,181 s**

*Réserve de mesure :* le sondage est à 300 ms, donc 0,181 s est un **majorant**. La bascule réelle
est comprise entre 0 et 181 ms. C'est en dessous de la résolution de l'outil — l'ordre de grandeur
(« quasi instantané ») est ce qui compte, pas la troisième décimale.

**Panne brutale** — `docker kill` envoie SIGKILL, aucun préavis :

```
docker kill a 15:52:21.264
[   0.01s] 15:52:18.359  primary = mongo1:27017
[   3.06s] 15:52:21.411  primary = AUCUN
[  11.95s] 15:52:30.301  primary = mongo3:27017
```
→ 15:52:30.301 − 15:52:21.264 = **9,037 s**

La ligne intermédiaire est importante : pendant **8,9 secondes**, le cluster n'a **aucun primary**.
Ce n'est pas un basculement instantané d'un nœud à l'autre, c'est un trou de service.

**Retour du nœud** — `docker start` puis priority takeover :

```
docker start a 15:50:59.842
[   0.01s] 15:50:57.921  primary = mongo2:27017
[  13.48s] 15:51:11.396  primary = mongo1:27017
```
→ 15:51:11.396 − 15:50:59.842 = **11,554 s**

## Ce que j'annonce à la DSI

Le SLA de 99,9 % autorise **43 min/mois**. À **9,04 s** par panne brutale, le budget couvre
**285 basculements** dans le mois — le failover automatique n'est pas le risque pour ce SLA, il en
consomme 0,35 % par incident. Un arrêt planifié (0,18 s) est, lui, invisible : 14 000 tiendraient
dans l'enveloppe.

Deux réserves à ne pas taire. **(1)** Ces 9 s sont mesurées *vue du cluster* ; l'application, elle,
subit un trou plus long (Q31) — c'est ce chiffre-là qui compte pour l'utilisateur. **(2)** Le retour
du nœud coûte **11,55 s de plus**, soit une seconde bascule pour un seul incident : conséquence
directe du `priority: 2` de mongo1 (Q19). En priorités égales, un redémarrage de maintenance ne
coûterait qu'une seule bascule.
