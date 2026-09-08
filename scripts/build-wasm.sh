#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
duckdb_dir="$repo_dir/duckdb"
build_dir="$repo_dir/build/wasm_eh"
versions="$repo_dir/versions.lock"

pinned_emscripten=$(sed -n 's/^emscripten=//p' "$versions")
pinned_duckdb=$(sed -n 's/^duckdb_commit=//p' "$versions")
actual_duckdb=$(git -C "$duckdb_dir" rev-parse HEAD)
if [ "$actual_duckdb" != "$pinned_duckdb" ]; then
  echo "VERSION_PIN_MISMATCH:duckdb_submodule expected=$pinned_duckdb actual=$actual_duckdb" >&2
  exit 1
fi

if [ -n "${EMSDK_DIR:-}" ]; then
  if [ ! -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    echo "EMSDK_DIR does not contain emsdk_env.sh: $EMSDK_DIR" >&2
    exit 1
  fi
  EMSDK_QUIET=1 . "$EMSDK_DIR/emsdk_env.sh"
fi
if ! command -v emcc >/dev/null 2>&1; then
  echo "Emscripten $pinned_emscripten is required; source emsdk_env.sh or set EMSDK_DIR" >&2
  exit 1
fi
actual_emscripten=$(emcc --version | sed -n '1s/.*) \([^ ]*\) (.*/\1/p')
if [ "$actual_emscripten" != "$pinned_emscripten" ]; then
  echo "VERSION_PIN_MISMATCH:emscripten expected=$pinned_emscripten actual=$actual_emscripten" >&2
  exit 1
fi

emcmake cmake \
  -S "$duckdb_dir" \
  -B "$build_dir" \
  -DWASM_LOADABLE_EXTENSIONS=1 \
  -DBUILD_EXTENSIONS_ONLY=1 \
  -DBUILD_UNITTESTS=OFF \
  -DBUILD_SHELL=OFF \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="-fwasm-exceptions -DWEBDB_FAST_EXCEPTIONS=1 -DDUCKDB_CUSTOM_PLATFORM=wasm_eh" \
  -DDUCKDB_EXPLICIT_PLATFORM=wasm_eh \
  -DDUCKDB_EXTENSION_CONFIGS="$repo_dir/extension_config.cmake"
cmake --build "$build_dir" --target in_memory_catalog_loadable_extension -j4

artifact="$build_dir/extension/in_memory_catalog/in_memory_catalog.duckdb_extension.wasm"
if [ ! -s "$artifact" ]; then
  echo "In-Memory Catalog Wasm extension was not produced: $artifact" >&2
  exit 1
fi
