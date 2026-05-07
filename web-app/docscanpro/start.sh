#!/bin/bash
# Static server for DocScan Pro Web on port 19002
cd "$(dirname "$0")"
exec python3 -m http.server 19002 --bind 0.0.0.0
