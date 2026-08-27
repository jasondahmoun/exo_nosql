db = db.getSiblingDB("citibike");

const TIMES_SQUARE = [-73.9855, 40.7580];
const RAYON_TERRE_KM = 6378.1;

print("=== Q27 — $near sans index 2dsphere ===");
db.trips.getIndexes().filter(i => i.key["start station location"] === "2dsphere").forEach(i => db.trips.dropIndex(i.name));

try {
  db.trips.find({
    "start station location": {
      $near: { $geometry: { type: "Point", coordinates: TIMES_SQUARE }, $maxDistance: 500 }
    }
  }).toArray();
  print("aucune erreur — l'index existait déjà");
} catch (e) {
  print("ERREUR : " + e.message);
}

print("=== Q28 — Création de l'index et relance ===");
print(db.trips.createIndex({ "start station location": "2dsphere" }));

const proche = {
  "start station location": {
    $near: { $geometry: { type: "Point", coordinates: TIMES_SQUARE }, $maxDistance: 500 }
  }
};
print("résultats : " + db.trips.countDocuments({
  "start station location": { $geoWithin: { $centerSphere: [TIMES_SQUARE, 0.5 / RAYON_TERRE_KM] } }
}));
print("5 premiers renvoyés par $near :");
const cinq = db.trips.find(proche, { _id: 0, "start station name": 1 }).limit(5).toArray();
cinq.forEach((d, i) => print("  " + (i + 1) + ". " + d["start station name"]));

print("=== Q29 — countDocuments avec $near ===");
try {
  db.trips.countDocuments(proche);
  print("aucune erreur");
} catch (e) {
  print("ERREUR : " + e.message);
}

print("=== Q29 — Remplacement par $geoWithin + $centerSphere ===");
[0.5, 1].forEach(km => {
  const n = db.trips.countDocuments({
    "start station location": { $geoWithin: { $centerSphere: [TIMES_SQUARE, km / RAYON_TERRE_KM] } }
  });
  print("  moins de " + km * 1000 + " m : " + n + " trajets");
});

print("=== Q30 — $geoNear sur la collection stations ===");
print(db.stations.createIndex({ position: "2dsphere" }));

const stations = db.stations.aggregate([
  { $geoNear: {
      near: { type: "Point", coordinates: TIMES_SQUARE },
      distanceField: "distance_m",
      maxDistance: 1000,
      spherical: true } },
  { $project: { _id: 0, nom: 1, departs: 1, distance_m: { $round: ["$distance_m", 0] } } },
  { $sort: { distance_m: 1 } }
]).toArray();

print("stations à moins de 1 km : " + stations.length);
printjson(stations);
