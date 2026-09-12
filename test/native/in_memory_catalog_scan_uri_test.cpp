#include "in_memory_catalog_scan_uri.hpp"

#include <cassert>
#include <string>

using duckdb::in_memory_catalog::MakeDuckDBScanURI;

int main() {
	const std::string uri = "https://example.test/files/events";
	const auto first = MakeDuckDBScanURI(uri, "events-r42");
	assert(first == "https://example.test/files/events#duckdb-snapshot=events-r42");
	assert(MakeDuckDBScanURI(uri, "events-r42") == first);
	assert(MakeDuckDBScanURI(uri, "events-r43") != first);

	assert(MakeDuckDBScanURI("https://example.test/files/events#section", "events r42/#") ==
	       "https://example.test/files/events#section&duckdb-snapshot=events%20r42%2F%23");
	assert(MakeDuckDBScanURI("https://example.test/files/events#", "events-r42") ==
	       "https://example.test/files/events#duckdb-snapshot=events-r42");
	assert(MakeDuckDBScanURI("https://example.test/files/events#duckdb-snapshot=old", "events-r42") ==
	       "https://example.test/files/events#duckdb-snapshot=old&duckdb-snapshot=events-r42");

	assert(MakeDuckDBScanURI("s3://example.test/events", "events-r42") == "s3://example.test/events");
	assert(MakeDuckDBScanURI("file:///tmp/events#section", "events-r42") == "file:///tmp/events#section");
	assert(MakeDuckDBScanURI("HTTP://example.test/events", "events-r42") ==
	       "HTTP://example.test/events#duckdb-snapshot=events-r42");
}
