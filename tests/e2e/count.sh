#!/bin/bash
# Prints the server's unread count for the test group as seen by teletest1, bypassing Synapse's sync response cache
TOK=$(cat /opt/tele/test/tok1); ROOM=$(cat /opt/tele/test/group_room)
F=$(python3 -c "import json,urllib.parse,random;print(urllib.parse.quote(json.dumps({'room':{'timeline':{'limit':1}},'event_fields':['type','event_id','x%d'%random.randint(0,10**9)]})))")
curl -s -H "Authorization: Bearer $TOK" "https://mtx.peyvand-yar.ir/_matrix/client/v3/sync?timeout=0&filter=$F" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['rooms']['join']['$ROOM']['unread_notifications'])"
