.PHONY: configure build build-wasm test test-js test-scan-uri pages

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
	$(MAKE) test-js
	$(MAKE) test-scan-uri

test-js:
	pnpm test

test-scan-uri:
	@mkdir -p build
	c++ -std=c++17 -Isrc/include test/native/in_memory_catalog_scan_uri_test.cpp -o build/in_memory_catalog_scan_uri_test
	build/in_memory_catalog_scan_uri_test

pages: build build-wasm
	pnpm build:pages
