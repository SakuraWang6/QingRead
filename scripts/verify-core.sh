#!/bin/bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
export CLANG_MODULE_CACHE_PATH="$repo_root/.build/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$repo_root/.build/module-cache"
args=(test --scratch-path .build --cache-path .build/cache --config-path .build/config --security-path .build/security)
developer_dir="$(xcode-select -p)"
if [[ "$developer_dir" == */CommandLineTools ]]; then
  # Swift Testing ships in this CLT's Developer/Frameworks directory; XCTest does not.
  frameworks="$developer_dir/Library/Developer/Frameworks"
  args+=(--disable-xctest --disable-sandbox --build-system native -Xswiftc -F -Xswiftc "$frameworks" -Xlinker -rpath -Xlinker "$frameworks")
fi
exec swift "${args[@]}"
