#!/usr/bin/env bash
# Rebuild contracts and regenerate web/lib/abi.ts
set -e
cd "$(dirname "$0")/.."
(cd contracts && forge build -q)
python3 - <<'PY'
import json
out=[]
for name in ["TifoPromo","TifoFactory","TifoAccount"]:
    abi=json.load(open(f"contracts/out/{name}.sol/{name}.json"))["abi"]
    out.append(f"export const {name[0].lower()+name[1:]}Abi = {json.dumps(abi)} as const;\n")
out.append('export const erc20Abi = [{"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"type":"uint256"}]},{"type":"function","name":"nonces","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"type":"uint256"}]}] as const;\n')
open("web/lib/abi.ts","w").write("// Generated from contracts/out by scripts/abi.sh. Do not edit by hand.\n"+"\n".join(out))
PY
