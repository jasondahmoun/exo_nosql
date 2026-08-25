db = db.getSiblingDB("mflix");

print("Q11 top 5 genres");
printjson(db.movies.aggregate([
  { $unwind: "$genres" },
  { $group: { _id: "$genres", films: { $sum: 1 } } },
  { $sort: { films: -1, _id: 1 } },
  { $limit: 5 }
]).toArray());

print("\nQ12 films par decennie");
printjson(db.movies.aggregate([
  { $match: { year: { $type: "int" } } },
  { $group: { _id: { $subtract: ["$year", { $mod: ["$year", 10] }] }, films: { $sum: 1 } } },
  { $sort: { films: -1 } }
]).toArray());

print("\nQ13 note imdb moyenne des Drama");
printjson(db.movies.aggregate([
  { $match: { genres: "Drama", "imdb.rating": { $type: "number" } } },
  { $group: { _id: null, moyenne: { $avg: "$imdb.rating" }, films: { $sum: 1 } } },
  { $project: { _id: 0, films: 1, moyenne: { $round: ["$moyenne", 4] } } }
]).toArray());

print("\nQ14 top 3 realisateurs");
printjson(db.movies.aggregate([
  { $unwind: "$directors" },
  { $group: { _id: "$directors", films: { $sum: 1 } } },
  { $sort: { films: -1, _id: 1 } },
  { $limit: 3 }
]).toArray());

print("\nQ15 top 5 films les plus commentes");
printjson(db.comments.aggregate([
  { $group: { _id: "$movie_id", commentaires: { $sum: 1 } } },
  { $sort: { commentaires: -1, _id: 1 } },
  { $limit: 5 },
  { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "film" } },
  { $unwind: "$film" },
  { $project: { _id: 0, titre: "$film.title", annee: "$film.year", commentaires: 1, compteur: "$film.num_mflix_comments" } },
  { $sort: { commentaires: -1, titre: 1 } }
]).toArray());
