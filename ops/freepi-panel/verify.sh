#!/usr/bin/env bash
# End-to-end verification for freepi-panel, run on the box itself.
# The token is read here and never printed.
set -uo pipefail
B=http://127.0.0.1:8787
ORIGIN="Origin: http://127.0.0.1:8787"
JAR=/tmp/panel.jar
TOKEN="$(cat /etc/freepi-panel/token)"
SMOKE=/root/panel-smoke
pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
code() { curl -s -o /tmp/panel.out -w '%{http_code}' "$@"; }

echo "=== 1. service + health ==="
systemctl is-active freepi-panel | grep -q '^active$' && ok "service active" || bad "service not active"
H="$(curl -s $B/healthz)"; echo "  healthz: $H"
echo "$H" | grep -q '"ok":true' && ok "healthz ok" || bad "healthz bad"
curl -s $B/ | grep -q "<title>freepi panel</title>" && ok "UI shell served at /" || bad "UI shell missing"

echo
echo "=== 2. auth ==="
C="$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/login -H 'content-type: application/json' -d '{"token":"definitely-wrong"}')"
[ "$C" = "401" ] && ok "wrong token -> 401" || bad "wrong token -> $C (expected 401)"
C="$(curl -s -c $JAR -o /dev/null -w '%{http_code}' -X POST $B/api/login -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}")"
[ "$C" = "200" ] && ok "right token -> 200, cookie stored" || bad "right token -> $C"
C="$(code -b $JAR $B/api/status)"; echo "  /api/status -> $C"
[ "$C" = "200" ] && ok "status with cookie" || bad "status -> $C"
python3 - <<'PY'
import json
d=json.load(open('/tmp/panel.out'))
b=d.get('balance',{})
print("  host:", d.get('host'), "| balance ok:", b.get('ok'), "| available:", b.get('availableUsd'),
      "| reserved:", b.get('reservedUsd'), "| spent:", b.get('spentUsd'), "| requests:", b.get('requests'))
print("  box held:", d.get('box',{}).get('held'), "| box state:", (d.get('box',{}).get('state') or '')[:70])
print("  sessions:", d.get('sessionCount'), "| freepi cmd:", d.get('freepiCmd'))
PY
C="$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/api/box/hold -H 'content-type: application/json' -H 'Origin: https://evil.example' -d '{}')"
[ "$C" = "403" ] && ok "mismatched Origin on a mutation -> 403" || bad "mismatched Origin -> $C (expected 403)"
C="$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/api/box/hold -H 'content-type: application/json' -H 'Sec-Fetch-Site: cross-site' -d '{}')"
[ "$C" = "403" ] && ok "Sec-Fetch-Site: cross-site -> 403" || bad "cross-site fetch -> $C (expected 403)"
C="$(curl -s -o /dev/null -w '%{http_code}' $B/api/sessions)"
[ "$C" = "401" ] && ok "no cookie -> 401" || bad "no cookie -> $C (expected 401)"

echo
echo "=== 3. sessions + transcript ==="
curl -s -b $JAR "$B/api/sessions" >/tmp/panel.sessions
python3 - <<'PY'
import json
d=json.load(open('/tmp/panel.sessions'))
s=d['sessions']
print("  sessions:", len(s))
for row in s[:3]:
    print("   ", row.get('id','')[:8], "|", (row.get('cwd') or row.get('slug'))[:38], "|", row.get('model'),
          "| live:", row.get('live'), "| msgs:", row.get('messageCount'), "|", (row.get('title') or '')[:46])
open('/tmp/newest','w').write(s[0]['id'] if s else '')
PY
NEWEST="$(cat /tmp/newest)"
if [ -n "$NEWEST" ]; then
  curl -s -b $JAR "$B/api/sessions/$NEWEST/entries?limit=5" >/tmp/panel.entries
  python3 - <<'PY'
import json
d=json.load(open('/tmp/panel.entries'))
print("  entries:", len(d['entries']), "of", d['total'], "| cursor:", (d.get('cursor') or '')[:9], "| cwd:", d.get('header',{}).get('cwd'))
PY
  CS="$(python3 -c "import json;print(json.load(open('/tmp/panel.entries')).get('cursor') or '')")"
  [ -n "$CS" ] && ok "entries + cursor for a real session" || bad "no cursor in entries payload"
  curl -s -b $JAR "$B/api/sessions/$NEWEST/entries?since=$CS&limit=5" >/tmp/panel.entries2
  python3 -c "
import json
d=json.load(open('/tmp/panel.entries2'))
print('  incremental fetch since the cursor ->', len(d['entries']), 'new entries')
"
else
  bad "no sessions to read"
fi

echo
echo "=== 4. live tail (read-only watch of a session being appended) ==="
mkdir -p $SMOKE
SLUG="--$(echo "$SMOKE" | sed 's#^/##; s#/#-#g')--"
SDIR="/root/.free-pi/agent/sessions/$SLUG"
mkdir -p "$SDIR"
FAKE="$SDIR/2026-01-01T00-00-00-000Z_01010101-0101-0101-0101-010101010101.jsonl"
printf '%s\n' '{"type":"session","version":3,"id":"01010101-0101-0101-0101-010101010101","timestamp":"2026-01-01T00:00:00.000Z","cwd":"'"$SMOKE"'"}' >"$FAKE"
printf '%s\n' '{"type":"message","id":"aaa111","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"tail test"}}' >>"$FAKE"
curl -s -b $JAR -N "$B/api/sessions/01010101-0101-0101-0101-010101010101/stream?since=aaa111" >/tmp/panel.sse 2>/dev/null &
SSE_PID=$!
sleep 2
printf '%s\n' '{"type":"message","id":"bbb222","parentId":"aaa111","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"TAIL_OK"}],"provider":"test","model":"test"}}' >>"$FAKE"
sleep 3
kill $SSE_PID 2>/dev/null
grep -q "TAIL_OK" /tmp/panel.sse && ok "SSE delivered the appended entry (TAIL_OK)" || { bad "SSE missed the appended entry"; head -c 200 /tmp/panel.sse; }
grep -q "panel_ready" /tmp/panel.sse && ok "SSE handshake" || bad "SSE handshake missing"

echo
echo "=== 5. control: start a real freepi rpc agent and prompt it ==="
curl -s -b $JAR -X POST "$B/api/agents/start" -H 'content-type: application/json' -H "$ORIGIN" \
  -d "{\"cwd\":\"$SMOKE\",\"newSession\":true}" >/tmp/panel.agent
AID="$(python3 -c "import json;print((json.load(open('/tmp/panel.agent')).get('agent') or {}).get('id') or '')" 2>/dev/null)"
python3 - <<'PY'
import json
d=json.load(open('/tmp/panel.agent'))
a=d.get('agent') or {}
st=a.get('state') or {}
print("  start response:", json.dumps(d)[:200])
print("  agent:", a.get('id'), "| cwd:", a.get('cwd'), "| session:", (a.get('sessionPath') or '')[-46:])
print("  state: sessionId", st.get('sessionId'), "| model", (st.get('model') or {}).get('id'), "| streaming", st.get('isStreaming'))
PY
[ -n "$AID" ] && ok "agent started ($AID)" || bad "agent did not start"

if [ -n "$AID" ]; then
  ( timeout 90 curl -s -N -b $JAR "$B/api/agents/$AID/stream" >/tmp/panel.agent.sse 2>/dev/null ) &
  sleep 1
  curl -s -b $JAR -X POST "$B/api/agents/$AID/command" -H 'content-type: application/json' -H "$ORIGIN" \
    -d '{"command":{"type":"prompt","message":"Reply with exactly PANEL_OK and nothing else."},"timeoutMs":60000}' >/tmp/panel.prompt
  grep -q '"success":true' /tmp/panel.prompt && ok "prompt accepted" || { bad "prompt rejected"; head -c 300 /tmp/panel.prompt; }
  # Wait for an assistant *text* containing PANEL_OK (the string also appears in
  # the echo of our own prompt, so wait for the reply, not the word). freepi may
  # need more than one turn: when the free-pi allowance for the day is spent the
  # first call 429s and it auto-switches to Antseed before answering.
  for i in $(seq 1 60); do
    sleep 3
    python3 -c "
import json,sys
for line in open('/tmp/panel.agent.sse'):
    if not line.startswith('data: '): continue
    try: o=json.loads(line[6:])
    except Exception: continue
    if o.get('type')=='message_end' and (o.get('message') or {}).get('role')=='assistant':
        for b in (o['message'].get('content') or []):
            if isinstance(b,dict) and b.get('type')=='text' and 'PANEL_OK' in (b.get('text') or ''): sys.exit(0)
sys.exit(1)
" && break
  done
  grep -q '"type":"turn_end"' /tmp/panel.agent.sse && ok "turn_end event" || bad "no turn_end"
  sleep 1
  grep -q '"type":"message_update"' /tmp/panel.agent.sse && ok "token-level message_update events" || bad "no message_update events"
  SSE_FACTS="$(python3 - <<'PY'
import json
assistant=[]; errs=[]
for line in open('/tmp/panel.agent.sse'):
    if not line.startswith('data: '): continue
    try: o=json.loads(line[6:])
    except Exception: continue
    if o.get('type')=='extension_error':
        errs.append((o.get('extensionPath'), o.get('event'), str(o.get('error'))[:80]))
    if o.get('type')=='message_end' and (o.get('message') or {}).get('role')=='assistant':
        for b in (o['message'].get('content') or []):
            if isinstance(b, dict) and b.get('text'): assistant.append(b['text'].strip())
print('  assistant text delivered over RPC:', (assistant[-1][:70] if assistant else '(none)'))
print('  extension errors this turn:', errs if errs else 'none')
logs=[l[6:].strip() for l in open('/tmp/panel.agent.sse') if l.startswith('data: ') and '"panel_log"' in l]
if logs: print('  agent stderr tail:', logs[-1][-220:])
print('  ASSISTANT-REPLY-OK' if any('PANEL_OK' in t for t in assistant) else '  ASSISTANT-REPLY-MISSING')
PY
)"
  echo "$SSE_FACTS"
  echo "$SSE_FACTS" | grep -q ASSISTANT-REPLY-OK && ok "assistant reply reached the browser channel" || bad "assistant reply missing from the RPC channel"
  echo "$SSE_FACTS" | grep -q 'extension errors this turn: none' && ok "no extension errors in headless mode" || bad "an extension threw during the turn"
  # model switching through the panel (the thing this whole panel exists for)
  curl -s -b $JAR -X POST "$B/api/agents/$AID/command" -H 'content-type: application/json' -H "$ORIGIN" \
    -d '{"command":{"type":"get_available_models"}}' >/tmp/panel.models
  python3 -c "
import json
d=json.load(open('/tmp/panel.models'))
ms=((d.get('response') or {}).get('data') or {}).get('models') or []
print('  available models in the picker:', len(ms), '->', [ (m.get('provider','')+'/'+m.get('id','')) for m in ms[:4] ])
"
  curl -s -b $JAR -X POST "$B/api/agents/$AID/command" -H 'content-type: application/json' -H "$ORIGIN" \
    -d '{"command":{"type":"get_state"}}' >/tmp/panel.state
  python3 -c "
import json
d=json.load(open('/tmp/panel.state'))
st=(d.get('response') or {}).get('data') or {}
print('  get_state -> sessionId', st.get('sessionId'), '| model', (st.get('model') or {}).get('id'), '| messages', st.get('messageCount'))
open('/tmp/smoke_session','w').write(st.get('sessionId') or '')
"
  curl -s -b $JAR -X POST "$B/api/agents/$AID/command" -H 'content-type: application/json' -H "$ORIGIN" \
    -d '{"command":{"type":"abort"}}' >/tmp/panel.abort
  grep -q '"success":true' /tmp/panel.abort && ok "abort accepted" || bad "abort failed"
  python3 -c "
import json
n=0
for line in open('/tmp/panel.agent.sse'):
    if line.startswith('data: '):
        try: json.loads(line[6:]); n+=1
        except Exception: pass
print('  agent SSE frames:', n)
"

  echo "  --- the session the panel drove, as the UI would list it ---"
  curl -s -b $JAR "$B/api/sessions" >/tmp/panel.sessions2
  python3 - <<'PY'
import json
d=json.load(open('/tmp/panel.sessions2'))
rows=[s for s in d['sessions'] if 'panel-smoke' in (s.get('cwd') or '')]
print("  sessions in /root/panel-smoke:", len(rows), "| attached:", [r.get('attached') for r in rows])
for s in rows[:3]:
    print("   ", s['id'][:8], "| model:", s.get('model'), "| title:", (s.get('title') or '')[:44], "| msgs:", s.get('messageCount'), "| live:", s.get('live'))
PY
  [ "$(python3 -c "import json;print(len([s for s in json.load(open('/tmp/panel.sessions2'))['sessions'] if 'panel-smoke' in (s.get('cwd') or '')]))")" -ge 1 ] \
    && ok "panel-created session appears in the list" || bad "panel session missing from the list"
fi

echo
echo "=== 6. box hold/release round trip (and leave it held) ==="
curl -s -b $JAR -X POST $B/api/box/release -H "$ORIGIN" -H 'content-type: application/json' -d '{}' >/tmp/panel.rel
[ -f /var/lib/idle-guard/keepalive ] && bad "release left the keepalive in place" || ok "release cleared the keepalive"
curl -s -b $JAR -X POST $B/api/box/hold -H "$ORIGIN" -H 'content-type: application/json' -d '{}' >/tmp/panel.hold
[ -f /var/lib/idle-guard/keepalive ] && ok "hold set the keepalive" || bad "hold did not set the keepalive"
python3 -c "
import json
d=json.load(open('/tmp/panel.hold'))
print('  box after hold -> held:', (d.get('box') or {}).get('held'), '| state:', ((d.get('box') or {}).get('state') or '')[:70])
"
python3 -c "
import json
d=json.load(open('/tmp/panel.hold'))
print('  PANEL-REPORTS-HELD' if (d.get('box') or {}).get('held') else '  PANEL-REPORTS-NOT-HELD')
"

echo
echo "=== 7. cleanup ==="
curl -s -b $JAR -X POST "$B/api/agents/$AID/halt" -H "$ORIGIN" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1
rm -f "$FAKE"
kill $SSE_PID 2>/dev/null
python3 - <<'PY'
import json,subprocess
out=subprocess.run(['curl','-s','-b','/tmp/panel.jar','http://127.0.0.1:8787/api/status'],capture_output=True,text=True).stdout
d=json.loads(out)
print("  agents after halt:", len(d['agents']), "| held:", d['box'].get('held'))
PY
echo "  panel log tail:"; tail -3 /var/log/freepi-panel.log 2>/dev/null | sed 's/^/    /'

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
