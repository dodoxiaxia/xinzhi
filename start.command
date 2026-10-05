#!/bin/zsh
cd "${0:A:h}"
open http://127.0.0.1:8765
python3 scripts/serve_preview.py
