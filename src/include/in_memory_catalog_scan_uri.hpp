#pragma once

#include <cstddef>
#include <string>

namespace duckdb {
namespace in_memory_catalog {

inline bool IsHTTPURI(const std::string &uri) {
	if (uri.size() < 7) {
		return false;
	}
	const auto starts_with = [](const std::string &value, const char *prefix) {
		for (std::size_t index = 0; prefix[index] != '\0'; index++) {
			char left = value[index];
			char right = prefix[index];
			if (left >= 'A' && left <= 'Z') {
				left = static_cast<char>(left - 'A' + 'a');
			}
			if (right >= 'A' && right <= 'Z') {
				right = static_cast<char>(right - 'A' + 'a');
			}
			if (left != right) {
				return false;
			}
		}
		return true;
	};
	return starts_with(uri, "http://") || (uri.size() >= 8 && starts_with(uri, "https://"));
}

inline bool IsURIUnreserved(unsigned char value) {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
	       (value >= '0' && value <= '9') || value == '-' || value == '.' || value == '_' || value == '~';
}

inline std::string EncodeSnapshotForFragment(const std::string &snapshot) {
	static constexpr char HEX[] = "0123456789ABCDEF";
	std::string encoded;
	encoded.reserve(snapshot.size());
	for (const auto character : snapshot) {
		auto value = static_cast<unsigned char>(character);
		if (IsURIUnreserved(value)) {
			encoded.push_back(static_cast<char>(value));
		} else {
			encoded.push_back('%');
			encoded.push_back(HEX[value >> 4]);
			encoded.push_back(HEX[value & 0x0F]);
		}
	}
	return encoded;
}

inline std::string MakeDuckDBScanURI(const std::string &uri, const std::string &snapshot) {
	if (!IsHTTPURI(uri)) {
		return uri;
	}

	const auto version = std::string("duckdb-snapshot=") + EncodeSnapshotForFragment(snapshot);
	const auto fragment = uri.find('#');
	if (fragment == std::string::npos) {
		return uri + "#" + version;
	}
	return uri + (fragment + 1 == uri.size() ? "" : "&") + version;
}

} // namespace in_memory_catalog
} // namespace duckdb
