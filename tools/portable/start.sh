#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install it from https://nodejs.org and run this again."
  exit 1
fi
if [ ! -f server/.env ]; then
  cp server/.env.example server/.env
  echo "Created server/.env. Open it and put your Runware key after RUNWARE_API_KEY="
  echo "Without a key the editor works but the AI buttons will say the key is missing."
  echo "You can also run: ./start.sh --mock   to try the AI with fake free results."
  echo
fi
node server/serve.js --open "$@"
