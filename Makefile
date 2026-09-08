.PHONY: build-wasm test

build-wasm:
	sh scripts/build-wasm.sh

test:
	npm test
