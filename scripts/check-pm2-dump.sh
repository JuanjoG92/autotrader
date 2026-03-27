#!/bin/bash
# Check PM2 dump for autotrader entries
echo "=== All apps in PM2 dump ==="
python3 -c '
import json
data = json.load(open("/root/.pm2/dump.pm2"))
for p in data:
    name = p.get("name", "?")
    cwd = p.get("pm2_env", {}).get("pm_cwd", "?")
    print(f"  - {name} (cwd: {cwd})")
print(f"\nTotal apps: {len(data)}")
found = [p for p in data if "autotrader" in p.get("name","").lower() or "autotrader" in p.get("pm2_env",{}).get("pm_cwd","").lower()]
if found:
    print("WARNING: AUTOTRADER FOUND IN DUMP!")
    for f in found:
        print(f"  >>> {f.get('name')} at {f.get('pm2_env',{}).get('pm_cwd','')}")
else:
    print("OK: No autotrader in PM2 dump")
'
