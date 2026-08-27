#!/bin/bash
set -e

docker compose -f docker-compose.shard.yml up -d
sleep 15

docker exec cfg1   mongosh --quiet --eval "rs.initiate({_id:'cfgRS',configsvr:true,members:[{_id:0,host:'cfg1:27017'}]})"
docker exec shardA mongosh --quiet --eval "rs.initiate({_id:'shardA',members:[{_id:0,host:'shardA:27017'}]})"
docker exec shardB mongosh --quiet --eval "rs.initiate({_id:'shardB',members:[{_id:0,host:'shardB:27017'}]})"
sleep 15

docker exec mongos mongosh --quiet --eval "sh.addShard('shardA/shardA:27017'); sh.addShard('shardB/shardB:27017')"
docker exec mongos mongosh --quiet config --eval "db.settings.updateOne({_id:'chunksize'},{\$set:{value:1}},{upsert:true})"
