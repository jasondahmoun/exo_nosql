db = db.getSiblingDB("bibliotheque");
db.livres.drop();

db.livres.insertMany([
  { titre: "Dune",                          auteur: "Frank Herbert",     annee: 1965, genre: "SF",        note: 9.2, tags: ["classique", "space-opera"] },
  { titre: "Neuromancien",                  auteur: "William Gibson",    annee: 1984, genre: "SF",        note: 8.4, tags: ["cyberpunk", "culte"] },
  { titre: "La Horde du Contrevent",        auteur: "Alain Damasio",     annee: 2004, genre: "SF",        note: 9.0, tags: ["francais", "culte"] },
  { titre: "Les Furtifs",                   auteur: "Alain Damasio",     annee: 2019, genre: "SF",        note: 7.8, tags: ["francais"] },
  { titre: "Le Probleme a trois corps",     auteur: "Liu Cixin",         annee: 2008, genre: "SF",        note: 8.7, tags: ["hard-sf", "chine"] },
  { titre: "La Foret sombre",               auteur: "Liu Cixin",         annee: 2015, genre: "SF",        note: 8.9, tags: ["hard-sf", "chine"] },
  { titre: "Project Hail Mary",             auteur: "Andy Weir",         annee: 2021, genre: "SF",        note: 9.1, tags: ["hard-sf", "espace"] },
  { titre: "Seul sur Mars",                 auteur: "Andy Weir",         annee: 2011, genre: "SF",        note: 8.3, tags: ["hard-sf", "mars"] },
  { titre: "1984",                          auteur: "George Orwell",     annee: 1949, genre: "Dystopie",  note: 9.4, tags: ["classique", "politique"] },
  { titre: "Le Meilleur des mondes",        auteur: "Aldous Huxley",     annee: 1932, genre: "Dystopie",  note: 8.6, tags: ["classique", "politique"] },
  { titre: "La Servante ecarlate",          auteur: "Margaret Atwood",   annee: 1985, genre: "Dystopie",  note: 8.5, tags: ["feminisme"] },
  { titre: "Le Nom du vent",                auteur: "Patrick Rothfuss",  annee: 2007, genre: "Fantasy",   note: 8.8, tags: ["magie", "saga"] },
  { titre: "La Voie des rois",              auteur: "Brandon Sanderson", annee: 2010, genre: "Fantasy",   note: 8.9, tags: ["magie", "saga"] },
  { titre: "Fils-des-brumes",               auteur: "Brandon Sanderson", annee: 2006, genre: "Fantasy",   note: 8.6, tags: ["magie"] },
  { titre: "Le Seigneur des anneaux",       auteur: "J.R.R. Tolkien",    annee: 1954, genre: "Fantasy",   note: 9.5, tags: ["classique", "saga"] },
  { titre: "Designing Data-Intensive Apps", auteur: "Martin Kleppmann",  annee: 2017, genre: "Technique", note: 9.3, tags: ["nosql", "reference"] },
  { titre: "MongoDB: The Definitive Guide", auteur: "Shannon Bradshaw",  annee: 2019, genre: "Technique", note: 8.1, tags: ["nosql", "reference"] },
  { titre: "Clean Code",                    auteur: "Robert C. Martin",  annee: 2008, genre: "Technique", note: 7.6, tags: ["reference"] },
  { titre: "Le Grand Livre rate",           auteur: "Anonyme",           annee: 2013, genre: "Essai",     note: 3.5, tags: ["obscur"] },
  { titre: "Traite du vide inutile",        auteur: "Anonyme",           annee: 2016, genre: "Essai",     note: 4.2, tags: ["obscur"] }
]);
print("4. inseres : " + db.livres.countDocuments());

print("\n5. livres > 2010, tries par note :");
printjson(db.livres.find({ annee: { $gt: 2010 } }, { titre: 1, auteur: 1, _id: 0 }).sort({ note: -1 }).toArray());

const u = db.livres.updateMany({ genre: "SF" }, { $set: { favori: true } });
print("\n6. SF passes en favori : " + u.modifiedCount);

const d = db.livres.deleteMany({ note: { $lt: 5 } });
print("\n7. supprimes : " + d.deletedCount + " | restants : " + db.livres.countDocuments());

print("\nbonus $in :");
printjson(db.livres.find({ genre: { $in: ["SF", "Fantasy"] } }, { titre: 1, note: 1, _id: 0 }).sort({ note: -1 }).limit(5).toArray());

print("\nbonus $gte + tags :");
printjson(db.livres.find({ note: { $gte: 8.5 }, tags: "classique" }, { titre: 1, tags: 1, _id: 0 }).toArray());
