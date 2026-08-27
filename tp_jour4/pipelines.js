db = db.getSiblingDB("citibike");

print("=== Q12 — Top 5 des stations de départ ===");
printjson(db.trips.aggregate([
  { $group: { _id: "$start station name", n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 }
]).toArray());

print("=== Q13 — Répartition par usertype et durée moyenne ===");
printjson(db.trips.aggregate([
  { $group: { _id: "$usertype", n: { $sum: 1 }, duree_moy: { $avg: "$tripduration" } } },
  { $sort: { n: -1 } }
]).toArray());

print("=== Q14 — Trajets par jour ===");
printjson(db.trips.aggregate([
  { $group: { _id: { $dateTrunc: { date: "$start time", unit: "day" } }, n: { $sum: 1 } } },
  { $sort: { _id: 1 } }
]).toArray());

print("=== Q15 — Heure de pointe, top 5 ===");
printjson(db.trips.aggregate([
  { $group: { _id: { $hour: "$start time" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 }
]).toArray());

print("=== Q16 — Distribution des durées ===");
printjson(db.trips.aggregate([
  { $bucket: {
      groupBy: "$tripduration",
      boundaries: [0, 300, 600, 1800, 3600, 1000000],
      default: "hors bornes",
      output: { n: { $sum: 1 } } } }
]).toArray());

print("=== Q17 — Boucles : départ = arrivée ===");
printjson(db.trips.aggregate([
  { $match: { $expr: { $eq: ["$start station id", "$end station id"] } } },
  { $count: "boucles" }
]).toArray());

print("=== Q11 — Plage temporelle réelle du jeu ===");
printjson(db.trips.aggregate([
  { $group: { _id: null,
              min_start: { $min: "$start time" },
              max_start: { $max: "$start time" },
              max_stop:  { $max: "$stop time" } } }
]).toArray());

print("=== Q18 — Type de birth year croisé avec usertype ===");
printjson(db.trips.aggregate([
  { $group: { _id: { type: { $type: "$birth year" }, usertype: "$usertype" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } }
]).toArray());

print("=== Q19 — Âge moyen en 2016, années numériques seulement ===");
printjson(db.trips.aggregate([
  { $match: { "birth year": { $type: "int" } } },
  { $group: { _id: null,
              age_moyen:   { $avg: { $subtract: [2016, "$birth year"] } },
              effectif:    { $sum: 1 },
              plus_vieux:  { $max: { $subtract: [2016, "$birth year"] } },
              annee_min:   { $min: "$birth year" } } }
]).toArray());

print("=== Q20 — Valeurs aberrantes ===");
printjson(db.trips.aggregate([
  { $group: { _id: null,
              plus_de_3h:  { $sum: { $cond: [{ $gt: ["$tripduration", 10800] }, 1, 0] } },
              plus_de_24h: { $sum: { $cond: [{ $gt: ["$tripduration", 86400] }, 1, 0] } } } }
]).toArray());
printjson(db.trips.aggregate([
  { $sort: { tripduration: -1 } },
  { $limit: 3 },
  { $project: { _id: 0, tripduration: 1, usertype: 1, "start time": 1, "stop time": 1 } }
]).toArray());

print("=== Q21 — Durée moyenne par usertype, hors trajets de plus de 3 h ===");
printjson(db.trips.aggregate([
  { $match: { tripduration: { $lte: 10800 } } },
  { $group: { _id: "$usertype", n: { $sum: 1 }, duree_moy: { $avg: "$tripduration" } } },
  { $sort: { n: -1 } }
]).toArray());
printjson(db.trips.aggregate([
  { $match: { tripduration: { $gt: 10800 } } },
  { $group: { _id: "$usertype", exclus: { $sum: 1 } } }
]).toArray());

print("=== Q22 A — $match avant $group ===");
printjson(db.trips.explain("executionStats").aggregate([
  { $match: { usertype: "Subscriber" } },
  { $group: { _id: "$start station id", n: { $sum: 1 } } }
]).stages[0].$cursor.executionStats);

print("=== Q22 B — $group avant $match ===");
printjson(db.trips.explain("executionStats").aggregate([
  { $group: { _id: { s: "$start station id", u: "$usertype" }, n: { $sum: 1 } } },
  { $match: { "_id.u": "Subscriber" } }
]).stages[0].$cursor.executionStats);

print("=== Q23 — $match sur un champ calculé par $group ===");
printjson(db.trips.explain("executionStats").aggregate([
  { $group: { _id: "$start station id", n: { $sum: 1 } } },
  { $match: { n: { $gt: 50 } } }
]).stages[0].$cursor.executionStats);
printjson(db.trips.aggregate([
  { $group: { _id: "$start station id", n: { $sum: 1 } } },
  { $match: { n: { $gt: 50 } } },
  { $count: "stations_de_plus_de_50_departs" }
]).toArray());

print("=== Q24 — $merge : matérialiser la collection stations ===");
db.trips.aggregate([
  { $group: { _id: "$start station id",
              nom:      { $first: "$start station name" },
              position: { $first: "$start station location" },
              departs:  { $sum: 1 } } },
  { $merge: { into: "stations", whenMatched: "replace" } }
]);
print("stations créées : " + db.stations.countDocuments({}));
printjson(db.stations.find({}, { nom: 1, departs: 1 }).sort({ departs: -1 }).limit(3).toArray());

print("=== Q26 — $lookup : top 5 des stations d'arrivée avec leur nom ===");
printjson(db.trips.aggregate([
  { $group: { _id: "$end station id", arrivees: { $sum: 1 } } },
  { $sort: { arrivees: -1 } },
  { $limit: 5 },
  { $lookup: { from: "stations", localField: "_id", foreignField: "_id", as: "st" } },
  { $project: { _id: 1, arrivees: 1,
                nom:     { $first: "$st.nom" },
                departs: { $first: "$st.departs" },
                solde:   { $subtract: ["$arrivees", { $first: "$st.departs" }] } } },
  { $sort: { arrivees: -1 } }
]).toArray());
