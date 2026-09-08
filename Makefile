.PHONY: configure build build-wasm test pages

DUCKDB_DIR := $(CURDIR)/duckdb
NATIVE_BUILD_DIR := $(CURDIR)/build/native

configure: $(NATIVE_BUILD_DIR)/Makefile

$(NATIVE_BUILD_DIR)/Makefile:
	cmake -S $(DUCKDB_DIR) -B $(NATIVE_BUILD_DIR) -DDUCKDB_EXTENSION_CONFIGS=$(CURDIR)/extension_config.cmake -DBUILD_UNITTESTS=OFF -DBUILD_SHELL=ON -DCMAKE_BUILD_TYPE=Release

build: $(NATIVE_BUILD_DIR)/Makefile
	cmake --build $(NATIVE_BUILD_DIR) --target shell -j4

build-wasm:
	sh scripts/build-wasm.sh

test:
	npm test

pages: build build-wasm
	npm run build:pages
