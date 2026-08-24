(function () {
  const total = db.restaurants.countDocuments({});
  print("1. TOTAL RESTAURANTS : " + total);

  const cuisines = db.restaurants.distinct("cuisine");
  const parCuisine = [];
  for (const c of cuisines) {
    parCuisine.push([c, db.restaurants.countDocuments({ cuisine: c })]);
  }
  parCuisine.sort((a, b) => b[1] - a[1]);

  print("\n2. TOP 5 CUISINES");
  for (let i = 0; i < 5; i++) {
    print("   " + (i + 1) + ". " + parCuisine[i][0] + " : " + parCuisine[i][1]);
  }

  print("\n3. PAR ARRONDISSEMENT");
  for (const b of db.restaurants.distinct("borough")) {
    print("   " + b + " : " + db.restaurants.countDocuments({ borough: b }));
  }
})();
