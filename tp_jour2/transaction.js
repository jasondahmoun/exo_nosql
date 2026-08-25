db = db.getSiblingDB("mflix");

const film = db.movies.findOne({ title: "The Taking of Pelham 1 2 3" });
print("film    : " + film.title);
print("avant   : compteur=" + film.num_mflix_comments +
      "  commentaires=" + db.comments.countDocuments({ movie_id: film._id }));

function etat(tag) {
  const f = db.movies.findOne({ _id: film._id }, { num_mflix_comments: 1 });
  print(tag + " : compteur=" + f.num_mflix_comments +
        "  commentaires=" + db.comments.countDocuments({ movie_id: film._id }));
}

print("\n--- transaction 1 : COMMIT ---");
const cible = db.comments.findOne({ movie_id: film._id });
print("commentaire supprime : " + cible._id + " (" + cible.name + ")");

let s = db.getMongo().startSession();
s.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
try {
  const sdb = s.getDatabase("mflix");
  sdb.comments.deleteOne({ _id: cible._id });
  sdb.movies.updateOne({ _id: film._id }, { $inc: { num_mflix_comments: -1 } });
  s.commitTransaction();
  print("commit OK");
} catch (e) {
  s.abortTransaction();
  print("abort : " + e);
}
s.endSession();
etat("apres commit");

print("\n--- transaction 2 : ABORT ---");
const cible2 = db.comments.findOne({ movie_id: film._id });
print("commentaire vise    : " + cible2._id + " (" + cible2.name + ")");

s = db.getMongo().startSession();
s.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
const sdb = s.getDatabase("mflix");
sdb.comments.deleteOne({ _id: cible2._id });
sdb.movies.updateOne({ _id: film._id }, { $inc: { num_mflix_comments: -1 } });

print("dans la session (non commite) : compteur=" +
      sdb.movies.findOne({ _id: film._id }, { num_mflix_comments: 1 }).num_mflix_comments +
      "  commentaires=" + sdb.comments.countDocuments({ movie_id: film._id }));
etat("hors session (isolation)");

s.abortTransaction();
s.endSession();
etat("apres abort");
print("commentaire toujours present : " + (db.comments.countDocuments({ _id: cible2._id }) === 1));
