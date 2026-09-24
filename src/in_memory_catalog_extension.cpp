#include "in_memory_catalog_extension.hpp"

#include "duckdb/catalog/catalog_entry/schema_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/table_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/table_function_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/view_catalog_entry.hpp"
#include "duckdb/catalog/duck_catalog.hpp"
#include "duckdb/common/complex_json.hpp"
#include "duckdb/common/file_system.hpp"
#include "duckdb/common/multi_file/multi_file_reader.hpp"
#include "duckdb/common/multi_file/multi_file_function.hpp"
#include "duckdb/common/multi_file/multi_file_list.hpp"
#include "duckdb/common/multi_file/multi_file_states.hpp"
#include "duckdb/common/string_util.hpp"
#include "duckdb/execution/operator/csv_scanner/csv_multi_file_info.hpp"
#include "duckdb/function/scalar_function.hpp"
#include "duckdb/main/attached_database.hpp"
#include "duckdb/main/config.hpp"
#include "duckdb/main/extension/extension_loader.hpp"
#include "duckdb/parser/parsed_data/attach_info.hpp"
#include "duckdb/parser/parsed_data/create_schema_info.hpp"
#include "duckdb/parser/parsed_data/create_table_info.hpp"
#include "duckdb/parser/parsed_data/create_view_info.hpp"
#include "duckdb/parser/tableref/table_function_ref.hpp"
#include "duckdb/parser/constraints/not_null_constraint.hpp"
#include "duckdb/storage/database_size.hpp"
#include "duckdb/storage/storage_extension.hpp"
#include "duckdb/transaction/transaction.hpp"
#include "duckdb/transaction/transaction_manager.hpp"
#include "yyjson.hpp"
#include "in_memory_catalog_scan_uri.hpp"
#include "parquet_multi_file_info.hpp"

#include <atomic>
#include <cstdint>
#include <mutex>
#include <optional>
#include <unordered_set>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace duckdb {
namespace {

using namespace duckdb_yyjson;
struct CatalogColumnMetadata {
	string name;
	LogicalType type;
	bool nullable;
};

struct CatalogScannerDescriptor {
	string type;
	named_parameter_map_t options;
};

struct CatalogTableDescriptor {
	string workspace;
	uint64_t catalog_revision;
	string schema_name;
	string table_name;
	string snapshot_id;
	CatalogScannerDescriptor scanner;
	vector<CatalogColumnMetadata> columns;
	vector<string> files;
};

struct CatalogViewDescriptor {
	string workspace;
	uint64_t catalog_revision;
	string schema_name;
	string view_name;
	string query;
};

std::atomic<uint64_t> catalog_table_entry_count {0};
std::atomic<uint64_t> catalog_table_entry_high_watermark {0};
std::atomic<uint64_t> catalog_schema_entry_count {0};
std::atomic<uint64_t> catalog_schema_entry_high_watermark {0};

#ifdef __EMSCRIPTEN__
// clang-format off: EM_JS bodies use JavaScript syntax that clang-format rewrites incorrectly.
EM_JS(int, InMemoryCatalogSnapshotRevision,
      (const char *workspace_ptr, char *output, int output_size), {
	const bridge = globalThis.DUCKDB_IN_MEMORY_CATALOG;
	if (!bridge || typeof bridge.currentRevision !== 'function') return 0;
	const revision = bridge.currentRevision(UTF8ToString(workspace_ptr));
	if (revision === undefined || revision === null) return 0;
	const encoded = String(revision);
	const required = lengthBytesUTF8(encoded) + 1;
	if (!output) return required;
	if (output_size < required) return -required;
	stringToUTF8(encoded, output, output_size);
	return required;
});

EM_JS(int, InMemoryCatalogLookupTable,
      (const char *workspace_ptr, const char *revision_ptr, const char *schema_ptr,
       const char *table_ptr, char *output, int output_size), {
	const bridge = globalThis.DUCKDB_IN_MEMORY_CATALOG;
	if (!bridge || typeof bridge.lookupTable !== 'function') return 0;
	let descriptor;
	try {
		descriptor = bridge.lookupTable(
			UTF8ToString(workspace_ptr), UTF8ToString(revision_ptr),
			UTF8ToString(schema_ptr), UTF8ToString(table_ptr));
	} catch (error) {
		return error && error.code === 'RC_METADATA_REVISION_CHANGED' ? -1 : -2;
	}
	if (descriptor === undefined || descriptor === null) return 0;
	const required = lengthBytesUTF8(descriptor) + 1;
	if (!output) return required;
	if (output_size < required) return -required;
	stringToUTF8(descriptor, output, output_size);
	return required;
});

EM_JS(int, InMemoryCatalogListSchemas,
      (const char *workspace_ptr, const char *revision_ptr, char *output, int output_size), {
	const bridge = globalThis.DUCKDB_IN_MEMORY_CATALOG;
	if (!bridge || typeof bridge.listSchemas !== 'function') return 0;
	let encoded;
	try {
		encoded = bridge.listSchemas(UTF8ToString(workspace_ptr), UTF8ToString(revision_ptr));
	} catch (error) {
		return error && error.code === 'RC_METADATA_REVISION_CHANGED' ? -1 : -2;
	}
	const required = lengthBytesUTF8(encoded) + 1;
	if (!output) return required;
	if (output_size < required) return -required;
	stringToUTF8(encoded, output, output_size);
	return required;
});

EM_JS(int, InMemoryCatalogListTables,
      (const char *workspace_ptr, const char *revision_ptr, const char *schema_ptr,
       char *output, int output_size), {
	const bridge = globalThis.DUCKDB_IN_MEMORY_CATALOG;
	if (!bridge || typeof bridge.listTables !== 'function') return 0;
	let encoded;
	try {
		encoded = bridge.listTables(
			UTF8ToString(workspace_ptr), UTF8ToString(revision_ptr), UTF8ToString(schema_ptr));
	} catch (error) {
		return error && error.code === 'RC_METADATA_REVISION_CHANGED' ? -1 : -2;
	}
	const required = lengthBytesUTF8(encoded) + 1;
	if (!output) return required;
	if (output_size < required) return -required;
	stringToUTF8(encoded, output, output_size);
	return required;
});

EM_JS(int, InMemoryCatalogLookupView,
      (const char *workspace_ptr, const char *revision_ptr, const char *schema_ptr,
       const char *view_ptr, char *output, int output_size), {
	const bridge = globalThis.DUCKDB_IN_MEMORY_CATALOG;
	if (!bridge || typeof bridge.lookupView !== 'function') return 0;
	let descriptor;
	try {
		descriptor = bridge.lookupView(
			UTF8ToString(workspace_ptr), UTF8ToString(revision_ptr),
			UTF8ToString(schema_ptr), UTF8ToString(view_ptr));
	} catch (error) {
		return error && error.code === 'RC_METADATA_REVISION_CHANGED' ? -1 : -2;
	}
	if (descriptor === undefined || descriptor === null) return 0;
	const required = lengthBytesUTF8(descriptor) + 1;
	if (!output) return required;
	if (output_size < required) return -required;
	stringToUTF8(descriptor, output, output_size);
	return required;
});

EM_JS(int, InMemoryCatalogListViews,
      (const char *workspace_ptr, const char *revision_ptr, const char *schema_ptr,
       char *output, int output_size), {
	const bridge = globalThis.DUCKDB_IN_MEMORY_CATALOG;
	if (!bridge || typeof bridge.listViews !== 'function') return 0;
	let encoded;
	try {
		encoded = bridge.listViews(
			UTF8ToString(workspace_ptr), UTF8ToString(revision_ptr), UTF8ToString(schema_ptr));
	} catch (error) {
		return error && error.code === 'RC_METADATA_REVISION_CHANGED' ? -1 : -2;
	}
	const required = lengthBytesUTF8(encoded) + 1;
	if (!output) return required;
	if (output_size < required) return -required;
	stringToUTF8(encoded, output, output_size);
	return required;
});
// clang-format on
#endif

[[noreturn]] static void DescriptorInvalid() {
	throw InvalidInputException("RC_METADATA_INVALID: Worker catalog descriptor is invalid");
}

static string JSONString(yyjson_val *object, const char *key) {
	auto value = yyjson_obj_get(object, key);
	if (!value || !yyjson_is_str(value)) {
		DescriptorInvalid();
	}
	return string(unsafe_yyjson_get_str(value), unsafe_yyjson_get_len(value));
}

static bool IsSupportedCSVScannerOption(const string &key) {
	static const unordered_set<string> supported_options {
	    "auto_detect",       "header",           "delimiter",       "quote",          "escape",
	    "comment",           "skip",             "nullstr",         "dateformat",     "timestampformat",
	    "compression",       "ignore_errors",    "null_padding",    "allow_quoted_nulls",
	    "buffer_size",       "decimal_separator", "encoding",       "force_not_null", "max_line_size",
	    "new_line",          "parallel",         "sample_size",     "strict_mode",    "thousands",
	};
	return supported_options.find(key) != supported_options.end();
}

static string CSVScannerOptionName(const string &key) {
	if (key == "delimiter") {
		return "delim";
	}
	return key;
}

static bool IsCSVScannerBooleanOption(const string &key) {
	return key == "auto_detect" || key == "header" || key == "ignore_errors" || key == "null_padding" ||
	       key == "allow_quoted_nulls" || key == "parallel" || key == "strict_mode";
}

static bool IsCSVScannerIntegerOption(const string &key) {
	return key == "skip" || key == "buffer_size" || key == "max_line_size" || key == "sample_size";
}

static bool IsCSVScannerStringArrayOption(const string &key) {
	return key == "force_not_null" || key == "nullstr";
}

static bool IsCSVScannerEmptyStringOption(const string &key) {
	return key == "quote" || key == "escape" || key == "comment" || key == "thousands";
}

static Value DecodeCSVScannerOption(const string &key, yyjson_val *value) {
	if (!IsSupportedCSVScannerOption(key)) {
		DescriptorInvalid();
	}
	const auto is_boolean_option = IsCSVScannerBooleanOption(key);
	const auto is_integer_option = IsCSVScannerIntegerOption(key);
	const auto is_array_option = IsCSVScannerStringArrayOption(key);
	if (is_boolean_option && !yyjson_is_bool(value)) {
		DescriptorInvalid();
	}
	if (is_integer_option && !yyjson_is_sint(value) && !yyjson_is_uint(value)) {
		DescriptorInvalid();
	}
	if (is_array_option && !yyjson_is_arr(value) && !(key == "nullstr" && yyjson_is_str(value))) {
		DescriptorInvalid();
	}
	if (!is_boolean_option && !is_integer_option && !is_array_option && !yyjson_is_str(value)) {
		DescriptorInvalid();
	}
	if (yyjson_is_bool(value)) {
		return Value::BOOLEAN(yyjson_get_bool(value));
	}
	if (yyjson_is_str(value)) {
		string result(unsafe_yyjson_get_str(value), unsafe_yyjson_get_len(value));
		if (result.empty() && key != "nullstr" && !IsCSVScannerEmptyStringOption(key)) {
			DescriptorInvalid();
		}
		return Value(std::move(result));
	}
	if (yyjson_is_sint(value)) {
		const auto number = yyjson_get_sint(value);
		if ((key != "sample_size" && number < 0) || (key == "sample_size" && (number < 1 && number != -1)) ||
		    (key == "buffer_size" && number == 0)) {
			DescriptorInvalid();
		}
		if (key == "buffer_size") {
			return Value::UBIGINT(static_cast<uint64_t>(number));
		}
		return Value::BIGINT(number);
	}
	if (yyjson_is_uint(value)) {
		const auto number = yyjson_get_uint(value);
		if (number > NumericLimits<int64_t>::Maximum()) {
			DescriptorInvalid();
		}
		if (key == "buffer_size" && number == 0) {
			DescriptorInvalid();
		}
		if (key == "buffer_size") {
			return Value::UBIGINT(number);
		}
		return Value::BIGINT(static_cast<int64_t>(number));
	}
	if (yyjson_is_arr(value)) {
		vector<Value> values;
		if (key == "force_not_null" && yyjson_arr_size(value) == 0) {
			DescriptorInvalid();
		}
		size_t index, count;
		yyjson_val *item;
		yyjson_arr_foreach(value, index, count, item) {
			if (!yyjson_is_str(item)) {
				DescriptorInvalid();
			}
			string item_value(unsafe_yyjson_get_str(item), unsafe_yyjson_get_len(item));
			if ((key == "force_not_null" && item_value.empty()) || item_value.find('\0') != string::npos) {
				DescriptorInvalid();
			}
			values.emplace_back(std::move(item_value));
		}
		return Value::LIST(LogicalType::VARCHAR, std::move(values));
	}
	DescriptorInvalid();
}

static bool IsSupportedJSONScannerOption(const string &key) {
	static const unordered_set<string> supported_options {"format",         "compression", "records",
	                                                      "ignore_errors",  "maximum_object_size",
	                                                      "dateformat",     "timestampformat"};
	return supported_options.find(key) != supported_options.end();
}

static Value DecodeJSONScannerOption(const string &key, yyjson_val *value) {
	if (!IsSupportedJSONScannerOption(key)) {
		DescriptorInvalid();
	}
	if (key == "ignore_errors") {
		if (!yyjson_is_bool(value)) {
			DescriptorInvalid();
		}
		return Value::BOOLEAN(yyjson_get_bool(value));
	}
	if (key == "maximum_object_size") {
		if (!yyjson_is_uint(value)) {
			DescriptorInvalid();
		}
		auto number = yyjson_get_uint(value);
		if (number == 0 || number > NumericLimits<uint32_t>::Maximum()) {
			DescriptorInvalid();
		}
		return Value::UINTEGER(static_cast<uint32_t>(number));
	}
	if (!yyjson_is_str(value)) {
		DescriptorInvalid();
	}
	string result(unsafe_yyjson_get_str(value), unsafe_yyjson_get_len(value));
	if (result.empty() || result.find('\0') != string::npos) {
		DescriptorInvalid();
	}
	if (key == "format" && result != "auto" && result != "array" && result != "newline_delimited" &&
	    result != "unstructured") {
		DescriptorInvalid();
	}
	if (key == "records" && result != "auto" && result != "true" && result != "false") {
		DescriptorInvalid();
	}
	return Value(std::move(result));
}

static bool IsSupportedXLSXScannerOption(const string &key) {
	static const unordered_set<string> supported_options {"header",        "sheet",         "range",
	                                                      "all_varchar",   "ignore_errors", "stop_at_empty",
	                                                      "empty_as_varchar"};
	return supported_options.find(key) != supported_options.end();
}

static Value DecodeXLSXScannerOption(const string &key, yyjson_val *value) {
	if (!IsSupportedXLSXScannerOption(key)) {
		DescriptorInvalid();
	}
	if (key == "sheet" || key == "range") {
		if (!yyjson_is_str(value)) {
			DescriptorInvalid();
		}
		string result(unsafe_yyjson_get_str(value), unsafe_yyjson_get_len(value));
		if (result.empty() || result.find('\0') != string::npos) {
			DescriptorInvalid();
		}
		return Value(std::move(result));
	}
	if (!yyjson_is_bool(value)) {
		DescriptorInvalid();
	}
	return Value::BOOLEAN(yyjson_get_bool(value));
}

static void DecodeScanner(yyjson_val *object, CatalogTableDescriptor &descriptor) {
	auto scanner = yyjson_obj_get(object, "scanner");
	if (!scanner || !yyjson_is_obj(scanner) || yyjson_obj_size(scanner) != 2) {
		DescriptorInvalid();
	}
	descriptor.scanner.type = JSONString(scanner, "type");
	if (descriptor.scanner.type != "parquet" && descriptor.scanner.type != "csv" &&
	    descriptor.scanner.type != "json" && descriptor.scanner.type != "xlsx") {
		DescriptorInvalid();
	}
	auto options = yyjson_obj_get(scanner, "options");
	if (!options || !yyjson_is_obj(options)) {
		DescriptorInvalid();
	}
	if (descriptor.scanner.type == "parquet" && yyjson_obj_size(options) != 0) {
		DescriptorInvalid();
	}
	if (descriptor.scanner.type != "parquet") {
		size_t index, count;
		yyjson_val *key, *option_value;
		yyjson_obj_foreach(options, index, count, key, option_value) {
			auto option_name = string(unsafe_yyjson_get_str(key), unsafe_yyjson_get_len(key));
			if (descriptor.scanner.type == "csv") {
				descriptor.scanner.options.emplace(CSVScannerOptionName(option_name),
				                                  DecodeCSVScannerOption(option_name, option_value));
			} else if (descriptor.scanner.type == "json") {
				descriptor.scanner.options.emplace(option_name, DecodeJSONScannerOption(option_name, option_value));
			} else {
				descriptor.scanner.options.emplace(option_name, DecodeXLSXScannerOption(option_name, option_value));
			}
		}
	}
}

static uint64_t ParseCatalogRevision(const string &value) {
	if (value.empty()) {
		DescriptorInvalid();
	}
	for (const auto character : value) {
		if (character < '0' || character > '9') {
			DescriptorInvalid();
		}
	}
	try {
		size_t consumed = 0;
		auto revision = std::stoull(value, &consumed);
		if (consumed != value.size()) {
			DescriptorInvalid();
		}
		return revision;
	} catch (const std::exception &) {
		DescriptorInvalid();
	}
}

static bool IsSupportedPrimitiveLogicalType(const LogicalType &type) {
	switch (type.id()) {
	case LogicalTypeId::BOOLEAN:
	case LogicalTypeId::TINYINT:
	case LogicalTypeId::SMALLINT:
	case LogicalTypeId::INTEGER:
	case LogicalTypeId::BIGINT:
	case LogicalTypeId::UTINYINT:
	case LogicalTypeId::USMALLINT:
	case LogicalTypeId::UINTEGER:
	case LogicalTypeId::UBIGINT:
	case LogicalTypeId::FLOAT:
	case LogicalTypeId::DOUBLE:
	case LogicalTypeId::VARCHAR:
	case LogicalTypeId::DATE:
	case LogicalTypeId::TIMESTAMP:
	case LogicalTypeId::TIMESTAMP_TZ:
		return !type.HasAlias();
	default:
		return false;
	}
}

static LogicalType NormalizeSupportedLogicalType(const LogicalType &type, idx_t depth = 0) {
	if (depth > 32) {
		DescriptorInvalid();
	}
	if (type.id() == LogicalTypeId::USER && type.HasAlias() && StringUtil::CIEquals(type.GetAlias(), "JSON")) {
		return LogicalType::JSON();
	}
	if (IsSupportedPrimitiveLogicalType(type)) {
		return type;
	}
	if (type.id() == LogicalTypeId::LIST) {
		return LogicalType::LIST(NormalizeSupportedLogicalType(ListType::GetChildType(type), depth + 1));
	}
	if (type.id() == LogicalTypeId::STRUCT) {
		child_list_t<LogicalType> children;
		unordered_set<string> names;
		for (const auto &child : StructType::GetChildTypes(type)) {
			if (child.first.empty() || !names.insert(StringUtil::Lower(child.first)).second) {
				DescriptorInvalid();
			}
			children.emplace_back(child.first, NormalizeSupportedLogicalType(child.second, depth + 1));
		}
		if (children.empty()) {
			DescriptorInvalid();
		}
		return LogicalType::STRUCT(std::move(children));
	}
	DescriptorInvalid();
}

static void DecodeColumns(yyjson_val *object, CatalogTableDescriptor &descriptor) {
	auto columns = yyjson_obj_get(object, "columns");
	if (!columns || !yyjson_is_arr(columns) || yyjson_arr_size(columns) == 0) {
		DescriptorInvalid();
	}
	unordered_set<string> column_names;
	size_t column_index, column_count;
	yyjson_val *column;
	yyjson_arr_foreach(columns, column_index, column_count, column) {
		if (!yyjson_is_obj(column) || yyjson_obj_size(column) != 3) {
			DescriptorInvalid();
		}
		auto name = JSONString(column, "name");
		auto type_name = JSONString(column, "type");
		auto nullable = yyjson_obj_get(column, "nullable");
		if (name.empty() || name.find('\0') != string::npos || type_name.empty() || type_name.size() > 4096 ||
		    type_name.find('\0') != string::npos || !column_names.insert(StringUtil::Lower(name)).second || !nullable ||
		    !yyjson_is_bool(nullable)) {
			DescriptorInvalid();
		}
		try {
			auto type = NormalizeSupportedLogicalType(TransformStringToLogicalType(type_name));
			descriptor.columns.push_back({std::move(name), std::move(type), yyjson_get_bool(nullable)});
		} catch (const Exception &) {
			DescriptorInvalid();
		} catch (const std::exception &) {
			DescriptorInvalid();
		}
	}
}

static shared_ptr<const CatalogTableDescriptor> DecodeProductionDescriptor(const string &workspace,
	                                                                       uint64_t expected_revision,
	                                                                       const string &schema_name,
	                                                                       const string &table_name,
	                                                                       const string &json) {
	yyjson_doc *document = yyjson_read(json.c_str(), json.size(), 0);
	if (!document) {
		DescriptorInvalid();
	}
	std::unique_ptr<yyjson_doc, decltype(&yyjson_doc_free)> document_guard(document, yyjson_doc_free);
	auto root = yyjson_doc_get_root(document);
	if (!root || !yyjson_is_obj(root)) {
		DescriptorInvalid();
	}

	if (yyjson_obj_size(root) != 7) {
		DescriptorInvalid();
	}
	auto descriptor = make_shared_ptr<CatalogTableDescriptor>();
	descriptor->workspace = workspace;
	descriptor->catalog_revision = ParseCatalogRevision(JSONString(root, "catalog_revision"));
	descriptor->schema_name = JSONString(root, "schema_name");
	descriptor->table_name = JSONString(root, "table_name");
	descriptor->snapshot_id = JSONString(root, "snapshot");
	if (descriptor->catalog_revision != expected_revision || descriptor->schema_name != schema_name ||
	    descriptor->table_name != table_name || descriptor->snapshot_id.empty() ||
	    descriptor->snapshot_id.find('\0') != string::npos) {
		DescriptorInvalid();
	}

	DecodeScanner(root, *descriptor);
	DecodeColumns(root, *descriptor);

	auto files = yyjson_obj_get(root, "files");
	if (!files || !yyjson_is_arr(files) || yyjson_arr_size(files) == 0) {
		DescriptorInvalid();
	}
	unordered_set<string> uris;
	size_t file_index, file_count;
	yyjson_val *file;
	yyjson_arr_foreach(files, file_index, file_count, file) {
		if (!yyjson_is_str(file)) {
			DescriptorInvalid();
		}
		string uri(unsafe_yyjson_get_str(file), unsafe_yyjson_get_len(file));
		if (uri.empty() || uri.find('\0') != string::npos || !uris.insert(uri).second) {
			DescriptorInvalid();
		}
		descriptor->files.push_back(std::move(uri));
	}
	if (descriptor->scanner.type == "xlsx" && descriptor->files.size() != 1) {
		DescriptorInvalid();
	}
	return descriptor;
}

static shared_ptr<const CatalogViewDescriptor> DecodeProductionViewDescriptor(const string &workspace,
	                                                                           uint64_t expected_revision,
	                                                                           const string &schema_name,
	                                                                           const string &view_name,
	                                                                           const string &json) {
	yyjson_doc *document = yyjson_read(json.c_str(), json.size(), 0);
	if (!document) {
		DescriptorInvalid();
	}
	std::unique_ptr<yyjson_doc, decltype(&yyjson_doc_free)> document_guard(document, yyjson_doc_free);
	auto root = yyjson_doc_get_root(document);
	if (!root || !yyjson_is_obj(root) || yyjson_obj_size(root) != 4) {
		DescriptorInvalid();
	}
	auto descriptor = make_shared_ptr<CatalogViewDescriptor>();
	descriptor->workspace = workspace;
	descriptor->catalog_revision = ParseCatalogRevision(JSONString(root, "catalog_revision"));
	descriptor->schema_name = JSONString(root, "schema_name");
	descriptor->view_name = JSONString(root, "view_name");
	descriptor->query = JSONString(root, "query");
	if (descriptor->catalog_revision != expected_revision || descriptor->schema_name != schema_name ||
	    descriptor->view_name != view_name || descriptor->query.empty() || descriptor->query.find('\0') != string::npos) {
		DescriptorInvalid();
	}
	return descriptor;
}

static std::optional<uint64_t> GetProductionSnapshotRevision(const string &workspace) {
#ifdef __EMSCRIPTEN__
	auto required = InMemoryCatalogSnapshotRevision(workspace.c_str(), nullptr, 0);
	if (required == 0) {
		return {};
	}
	if (required < 2) {
		DescriptorInvalid();
	}
	vector<char> revision(static_cast<idx_t>(required));
	auto written = InMemoryCatalogSnapshotRevision(workspace.c_str(), revision.data(), required);
	if (written != required) {
		DescriptorInvalid();
	}
	return ParseCatalogRevision(string(revision.data(), static_cast<idx_t>(written - 1)));
#else
	return {};
#endif
}

static shared_ptr<const CatalogTableDescriptor> LookupProductionDescriptor(const string &workspace,
	                                                                      uint64_t revision,
	                                                                      const string &schema_name,
	                                                                      const string &table_name) {
#ifdef __EMSCRIPTEN__
	auto revision_text = to_string(revision);
	auto required = InMemoryCatalogLookupTable(workspace.c_str(), revision_text.c_str(), schema_name.c_str(),
	                                                   table_name.c_str(), nullptr, 0);
	if (required == 0) {
		return nullptr;
	}
	if (required == -1) {
		throw InvalidInputException("RC_METADATA_REVISION_CHANGED: Catalog revision changed during lookup");
	}
	if (required < 2) {
		DescriptorInvalid();
	}
	vector<char> encoded(static_cast<idx_t>(required));
	auto written = InMemoryCatalogLookupTable(workspace.c_str(), revision_text.c_str(), schema_name.c_str(),
	                                                  table_name.c_str(), encoded.data(), required);
	if (written == -1) {
		throw InvalidInputException("RC_METADATA_REVISION_CHANGED: Catalog revision changed during lookup");
	}
	if (written != required) {
		DescriptorInvalid();
	}
	return DecodeProductionDescriptor(workspace, revision, schema_name, table_name,
	                                  string(encoded.data(), static_cast<idx_t>(written - 1)));
#else
	return nullptr;
#endif
}

static shared_ptr<const CatalogViewDescriptor> LookupProductionViewDescriptor(const string &workspace,
	                                                                          uint64_t revision,
	                                                                          const string &schema_name,
	                                                                          const string &view_name) {
#ifdef __EMSCRIPTEN__
	auto revision_text = to_string(revision);
	auto required = InMemoryCatalogLookupView(workspace.c_str(), revision_text.c_str(), schema_name.c_str(),
	                                          view_name.c_str(), nullptr, 0);
	if (required == 0) {
		return nullptr;
	}
	if (required == -1) {
		throw InvalidInputException("RC_METADATA_REVISION_CHANGED: Catalog revision changed during view lookup");
	}
	if (required < 2) {
		DescriptorInvalid();
	}
	vector<char> encoded(static_cast<idx_t>(required));
	auto written = InMemoryCatalogLookupView(workspace.c_str(), revision_text.c_str(), schema_name.c_str(),
	                                         view_name.c_str(), encoded.data(), required);
	if (written == -1) {
		throw InvalidInputException("RC_METADATA_REVISION_CHANGED: Catalog revision changed during view lookup");
	}
	if (written != required) {
		DescriptorInvalid();
	}
	return DecodeProductionViewDescriptor(workspace, revision, schema_name, view_name,
	                                      string(encoded.data(), static_cast<idx_t>(written - 1)));
#else
	return nullptr;
#endif
}

static vector<string> DecodeNameList(const string &json) {
	yyjson_doc *document = yyjson_read(json.c_str(), json.size(), 0);
	if (!document) {
		DescriptorInvalid();
	}
	std::unique_ptr<yyjson_doc, decltype(&yyjson_doc_free)> document_guard(document, yyjson_doc_free);
	auto root = yyjson_doc_get_root(document);
	if (!root || !yyjson_is_arr(root)) {
		DescriptorInvalid();
	}
	vector<string> names;
	unordered_set<string> keys;
	size_t index, count;
	yyjson_val *value;
	yyjson_arr_foreach(root, index, count, value) {
		if (!yyjson_is_str(value)) {
			DescriptorInvalid();
		}
		string name(unsafe_yyjson_get_str(value), unsafe_yyjson_get_len(value));
		if (name.empty() || name.find('\0') != string::npos || !keys.insert(StringUtil::Lower(name)).second) {
			DescriptorInvalid();
		}
		names.push_back(std::move(name));
	}
	return names;
}

static vector<shared_ptr<const CatalogTableDescriptor>> DecodeTableList(const string &workspace,
	                                                                    uint64_t revision,
	                                                                    const string &schema_name,
	                                                                    const string &json) {
	yyjson_doc *document = yyjson_read(json.c_str(), json.size(), 0);
	if (!document) {
		DescriptorInvalid();
	}
	std::unique_ptr<yyjson_doc, decltype(&yyjson_doc_free)> document_guard(document, yyjson_doc_free);
	auto root = yyjson_doc_get_root(document);
	if (!root || !yyjson_is_arr(root)) {
		DescriptorInvalid();
	}
	vector<shared_ptr<const CatalogTableDescriptor>> descriptors;
	unordered_set<string> keys;
	size_t index, count;
	yyjson_val *value;
	yyjson_arr_foreach(root, index, count, value) {
		if (!yyjson_is_obj(value) || yyjson_obj_size(value) != 2) {
			DescriptorInvalid();
		}
		auto descriptor = make_shared_ptr<CatalogTableDescriptor>();
		descriptor->workspace = workspace;
		descriptor->catalog_revision = revision;
		descriptor->schema_name = schema_name;
		descriptor->table_name = JSONString(value, "name");
		if (descriptor->table_name.empty() || descriptor->table_name.find('\0') != string::npos ||
		    !keys.insert(StringUtil::Lower(descriptor->table_name)).second) {
			DescriptorInvalid();
		}
		DecodeColumns(value, *descriptor);
		descriptors.push_back(std::move(descriptor));
	}
	return descriptors;
}

static vector<shared_ptr<const CatalogViewDescriptor>> DecodeViewList(const string &workspace, uint64_t revision,
	                                                                   const string &schema_name, const string &json) {
	yyjson_doc *document = yyjson_read(json.c_str(), json.size(), 0);
	if (!document) {
		DescriptorInvalid();
	}
	std::unique_ptr<yyjson_doc, decltype(&yyjson_doc_free)> document_guard(document, yyjson_doc_free);
	auto root = yyjson_doc_get_root(document);
	if (!root || !yyjson_is_arr(root)) {
		DescriptorInvalid();
	}
	vector<shared_ptr<const CatalogViewDescriptor>> descriptors;
	unordered_set<string> keys;
	size_t index, count;
	yyjson_val *value;
	yyjson_arr_foreach(root, index, count, value) {
		if (!yyjson_is_obj(value) || yyjson_obj_size(value) != 2) {
			DescriptorInvalid();
		}
		auto descriptor = make_shared_ptr<CatalogViewDescriptor>();
		descriptor->workspace = workspace;
		descriptor->catalog_revision = revision;
		descriptor->schema_name = schema_name;
		descriptor->view_name = JSONString(value, "name");
		descriptor->query = JSONString(value, "query");
		if (descriptor->view_name.empty() || descriptor->view_name.find('\0') != string::npos ||
		    descriptor->query.empty() || descriptor->query.find('\0') != string::npos ||
		    !keys.insert(StringUtil::Lower(descriptor->view_name)).second) {
			DescriptorInvalid();
		}
		descriptors.push_back(std::move(descriptor));
	}
	return descriptors;
}

static void CheckEnumerationResult(int result) {
	if (result == -1) {
		throw InvalidInputException("RC_METADATA_REVISION_CHANGED: Catalog revision changed during enumeration");
	}
	if (result < 2) {
		DescriptorInvalid();
	}
}

static vector<string> ListProductionSchemas(const string &workspace, uint64_t revision) {
#ifdef __EMSCRIPTEN__
	auto revision_text = to_string(revision);
	auto required = InMemoryCatalogListSchemas(workspace.c_str(), revision_text.c_str(), nullptr, 0);
	CheckEnumerationResult(required);
	vector<char> encoded(static_cast<idx_t>(required));
	auto written = InMemoryCatalogListSchemas(workspace.c_str(), revision_text.c_str(), encoded.data(), required);
	if (written != required) {
		CheckEnumerationResult(written);
		DescriptorInvalid();
	}
	return DecodeNameList(string(encoded.data(), static_cast<idx_t>(written - 1)));
#else
	return {};
#endif
}

static vector<shared_ptr<const CatalogTableDescriptor>> ListProductionTables(const string &workspace, uint64_t revision,
	                                                                         const string &schema_name) {
#ifdef __EMSCRIPTEN__
	auto revision_text = to_string(revision);
	auto required = InMemoryCatalogListTables(workspace.c_str(), revision_text.c_str(), schema_name.c_str(),
	                                                  nullptr, 0);
	CheckEnumerationResult(required);
	vector<char> encoded(static_cast<idx_t>(required));
	auto written = InMemoryCatalogListTables(workspace.c_str(), revision_text.c_str(), schema_name.c_str(),
	                                                 encoded.data(), required);
	if (written != required) {
		CheckEnumerationResult(written);
		DescriptorInvalid();
	}
	return DecodeTableList(workspace, revision, schema_name,
	                       string(encoded.data(), static_cast<idx_t>(written - 1)));
#else
	return {};
#endif
}

static vector<shared_ptr<const CatalogViewDescriptor>> ListProductionViews(const string &workspace, uint64_t revision,
	                                                                        const string &schema_name) {
#ifdef __EMSCRIPTEN__
	auto revision_text = to_string(revision);
	auto required = InMemoryCatalogListViews(workspace.c_str(), revision_text.c_str(), schema_name.c_str(), nullptr, 0);
	CheckEnumerationResult(required);
	vector<char> encoded(static_cast<idx_t>(required));
	auto written = InMemoryCatalogListViews(workspace.c_str(), revision_text.c_str(), schema_name.c_str(), encoded.data(),
	                                       required);
	if (written != required) {
		CheckEnumerationResult(written);
		DescriptorInvalid();
	}
	return DecodeViewList(workspace, revision, schema_name,
	                      string(encoded.data(), static_cast<idx_t>(written - 1)));
#else
	return {};
#endif
}

static bool HasQueryVisibleSnapshot(const string &workspace) {
	return GetProductionSnapshotRevision(workspace).has_value();
}

static std::optional<uint64_t> GetQueryVisibleRevision(const string &workspace) {
	return GetProductionSnapshotRevision(workspace);
}

static vector<string> ListQueryVisibleSchemas(const string &workspace, uint64_t revision) {
	return ListProductionSchemas(workspace, revision);
}

static vector<shared_ptr<const CatalogTableDescriptor>> ListQueryVisibleTables(const string &workspace, uint64_t revision,
	                                                                           const string &schema_name) {
	return ListProductionTables(workspace, revision, schema_name);
}

static shared_ptr<const CatalogTableDescriptor> LookupQueryVisibleTable(const string &workspace,
	                                                                    uint64_t revision,
	                                                                    const string &schema_name,
	                                                                    const string &table_name) {
	return LookupProductionDescriptor(workspace, revision, schema_name, table_name);
}

static vector<shared_ptr<const CatalogViewDescriptor>> ListQueryVisibleViews(const string &workspace,
	                                                                          uint64_t revision,
	                                                                          const string &schema_name) {
	return ListProductionViews(workspace, revision, schema_name);
}

static shared_ptr<const CatalogViewDescriptor> LookupQueryVisibleView(const string &workspace,
	                                                                    uint64_t revision,
	                                                                    const string &schema_name,
	                                                                    const string &view_name) {
	return LookupProductionViewDescriptor(workspace, revision, schema_name, view_name);
}

static void RecordCatalogTableEntryCreated() {
	auto count = ++catalog_table_entry_count;
	auto high_watermark = catalog_table_entry_high_watermark.load();
	while (count > high_watermark &&
	       !catalog_table_entry_high_watermark.compare_exchange_weak(high_watermark, count)) {
	}
}

static void RecordCatalogSchemaEntryCreated() {
	auto count = ++catalog_schema_entry_count;
	auto high_watermark = catalog_schema_entry_high_watermark.load();
	while (count > high_watermark &&
	       !catalog_schema_entry_high_watermark.compare_exchange_weak(high_watermark, count)) {
	}
}

std::atomic<table_function_t> parquet_scan_execution {nullptr};
mutex physical_schema_validation_lock;
vector<weak_ptr<BaseFileReader>> validated_physical_readers;

static bool IsPhysicalSchemaMismatch(const string &message) {
	return message.find("schema mismatch") != string::npos || message.find("failed to cast column") != string::npos ||
	       (message.find("the column") != string::npos && message.find("trying to read it as type") != string::npos);
}

static void ValidatePhysicalSchema(const MultiFileBindData &bind_data, const BaseFileReader &reader) {
	const auto &physical_columns = reader.GetColumns();
	vector<reference<const MultiFileColumnDefinition>> data_columns;
	bool catalog_has_file_row_number = false;
	for (const auto &name : bind_data.names) {
		catalog_has_file_row_number = catalog_has_file_row_number || StringUtil::CIEquals(name, "file_row_number");
	}
	for (const auto &column : physical_columns) {
		const auto is_file_row_number = StringUtil::CIEquals(column.name, "file_row_number") &&
		                                !catalog_has_file_row_number;
		if (is_file_row_number ||
		    (!column.identifier.IsNull() && column.identifier.type().id() == LogicalTypeId::INTEGER &&
		     column.GetIdentifierFieldId() == MultiFileReader::ORDINAL_FIELD_ID)) {
			continue;
		}
		data_columns.push_back(column);
	}
	if (data_columns.size() != bind_data.names.size()) {
		throw InvalidInputException(
		    "RC_PARQUET_SCHEMA_MISMATCH: physical column count does not match Catalog metadata");
	}
	for (idx_t index = 0; index < data_columns.size(); index++) {
		const auto &column = data_columns[index].get();
		if (column.name != bind_data.names[index] || column.type != bind_data.types[index]) {
			throw InvalidInputException(
			    "RC_PARQUET_SCHEMA_MISMATCH: physical column order, name, or type does not match Catalog metadata");
		}
	}
}

static void ValidatePhysicalSchemaOnce(const MultiFileBindData &bind_data,
	                                   const shared_ptr<BaseFileReader> &reader) {
	lock_guard<mutex> guard(physical_schema_validation_lock);
	for (auto entry = validated_physical_readers.begin(); entry != validated_physical_readers.end();) {
		auto existing = entry->lock();
		if (!existing) {
			entry = validated_physical_readers.erase(entry);
			continue;
		}
		if (existing.get() == reader.get()) {
			return;
		}
		entry++;
	}
	ValidatePhysicalSchema(bind_data, *reader);
	validated_physical_readers.push_back(reader);
}

static void CatalogParquetScan(ClientContext &context, TableFunctionInput &input, DataChunk &output) {
	auto execute = parquet_scan_execution.load();
	if (!execute) {
		throw InternalException("in_memory_catalog Parquet execution function is not initialized");
	}
	auto &local_state = input.local_state->Cast<MultiFileLocalState>();
	auto reader_before = local_state.reader.get();
	try {
		if (local_state.reader) {
			ValidatePhysicalSchemaOnce(input.bind_data->Cast<MultiFileBindData>(), local_state.reader);
		}
		execute(context, input, output);
		if (local_state.reader && local_state.reader.get() != reader_before) {
			ValidatePhysicalSchemaOnce(input.bind_data->Cast<MultiFileBindData>(), local_state.reader);
		}
	} catch (const Exception &error) {
		if (IsPhysicalSchemaMismatch(error.what())) {
			throw InvalidInputException("RC_PARQUET_SCHEMA_MISMATCH: %s", error.what());
		}
		throw;
	}
}

static unique_ptr<ViewCatalogEntry> MakeInMemoryViewEntry(ClientContext &context, Catalog &catalog,
	                                                        SchemaCatalogEntry &schema,
	                                                        const CatalogViewDescriptor &descriptor) {
	auto info = make_uniq<CreateViewInfo>(schema, descriptor.view_name);
	info->sql = descriptor.query;
	try {
		info = CreateViewInfo::FromSelect(context, std::move(info));
	} catch (const Exception &error) {
		auto message = string(error.what());
		if (message.find("RC_CATALOG_VIEW_CYCLE:") != string::npos ||
		    message.find("RC_METADATA_REVISION_CHANGED:") != string::npos) {
			throw;
		}
		throw InvalidInputException("RC_CATALOG_VIEW_INVALID: %s", error.what());
	}
	return make_uniq<ViewCatalogEntry>(catalog, schema, *info);
}

class InMemoryTableEntry : public TableCatalogEntry {
public:
	InMemoryTableEntry(Catalog &catalog, SchemaCatalogEntry &schema, shared_ptr<const CatalogTableDescriptor> descriptor_p)
	    : InMemoryTableEntry(catalog, schema, descriptor_p, MakeInfo(schema, *descriptor_p)) {
	}
	~InMemoryTableEntry() override {
		catalog_table_entry_count--;
	}

	unique_ptr<BaseStatistics> GetStatistics(ClientContext &, column_t) override {
		return nullptr;
	}

	TableStorageInfo GetStorageInfo(ClientContext &) override {
		return {};
	}
	vector<column_t> GetRowIdColumns() const override {
		throw NotImplementedException("RC_READ_ONLY: in_memory_catalog is read-only");
	}
	void BindUpdateConstraints(Binder &, LogicalGet &, LogicalProjection &, LogicalUpdate &, ClientContext &) override {
		throw NotImplementedException("RC_READ_ONLY: in_memory_catalog is read-only");
	}

	TableFunction GetScanFunction(ClientContext &context, unique_ptr<FunctionData> &bind_data) override {
		const auto &scanner = descriptor->scanner;
		const auto scanner_name = scanner.type == "csv"    ? "read_csv"
		                          : scanner.type == "json" ? "read_json"
		                          : scanner.type == "xlsx" ? "read_xlsx"
		                                                   : "parquet_scan";
		auto &entry = Catalog::GetSystemCatalog(context).GetEntry<TableFunctionCatalogEntry>(context, DEFAULT_SCHEMA,
		                                                                                     scanner_name);
		auto function = entry.functions.GetFunctionByArguments(
		    context, {scanner.type == "xlsx" ? LogicalType::VARCHAR : LogicalType::LIST(LogicalType::VARCHAR)});

		vector<Value> files;
		files.reserve(descriptor->files.size());
		for (const auto &uri : descriptor->files) {
			files.push_back(Value(in_memory_catalog::MakeDuckDBScanURI(uri, descriptor->snapshot_id)));
		}
		named_parameter_map_t named_parameters;
		if (scanner.type == "parquet") {
			// Metadata is supplied to parquet_scan so DESCRIBE/EXPLAIN stay remote-free.
			// The host URI remains opaque metadata; only the scanner receives the
			// snapshot-versioned URI.
			auto schema_struct_type = LogicalType::STRUCT(
			    {{"name", LogicalType::VARCHAR}, {"type", LogicalType::VARCHAR}, {"default_value", LogicalType::VARCHAR}});
			vector<Value> schema_keys;
			vector<Value> schema_values;
			schema_keys.reserve(descriptor->columns.size());
			schema_values.reserve(descriptor->columns.size());
			for (const auto &column : descriptor->columns) {
				schema_keys.push_back(Value(column.name));
				schema_values.push_back(Value::STRUCT(
				    schema_struct_type, {Value(column.name), Value(column.type.ToString()), Value(LogicalType::VARCHAR)}));
			}
			named_parameters["schema"] =
			    Value::MAP(LogicalType::VARCHAR, schema_struct_type, std::move(schema_keys), std::move(schema_values));
		} else if (scanner.type == "csv" || scanner.type == "json") {
			// Text scanners use the Catalog schema as their explicit columns definition.
			child_list_t<Value> column_definitions;
			column_definitions.reserve(descriptor->columns.size());
			for (const auto &column : descriptor->columns) {
				column_definitions.emplace_back(column.name, Value(column.type.ToString()));
			}
			named_parameters["columns"] = Value::STRUCT(std::move(column_definitions));
		}
		for (const auto &option : scanner.options) {
			named_parameters[option.first] = option.second;
		}

		if (scanner.type == "json" || scanner.type == "xlsx") {
			vector<Value> inputs;
			if (scanner.type == "xlsx") {
				inputs.push_back(files[0]);
			} else {
				inputs.push_back(Value::LIST(LogicalType::VARCHAR, files));
			}
			vector<LogicalType> input_table_types;
			vector<string> input_table_names;
			vector<LogicalType> return_types;
			vector<string> return_names;
			TableFunctionRef ref;
			TableFunctionBindInput input(inputs, named_parameters, input_table_types, input_table_names,
			                             function.function_info.get(), nullptr, function, ref);
			bind_data = function.bind(context, input, return_types, return_names);
			if (return_names.size() != descriptor->columns.size()) {
				if (scanner.type == "xlsx") {
					throw InvalidInputException(
					    "RC_XLSX_SCHEMA_MISMATCH: physical column count does not match Catalog metadata");
				}
				throw InvalidInputException(
				    "RC_JSON_SCHEMA_MISMATCH: physical column count does not match Catalog metadata");
			}
			for (idx_t index = 0; index < descriptor->columns.size(); index++) {
				const auto &column = descriptor->columns[index];
				if (return_names[index] != column.name) {
					if (scanner.type == "xlsx") {
						throw InvalidInputException(
						    "RC_XLSX_SCHEMA_MISMATCH: physical column order or name does not match Catalog metadata");
					}
					throw InvalidInputException(
					    "RC_JSON_SCHEMA_MISMATCH: physical column order, name, or type does not match Catalog metadata");
				}
				if (scanner.type == "json" && return_types[index] != column.type) {
					throw InvalidInputException(
					    "RC_JSON_SCHEMA_MISMATCH: physical column order, name, or type does not match Catalog metadata");
				}
			}
			return function;
		}

		vector<OpenFileInfo> open_files;
		open_files.reserve(files.size());
		for (const auto &file : files) {
			open_files.emplace_back(file.GetValue<string>());
		}
		auto file_list = make_shared_ptr<SimpleMultiFileList>(std::move(open_files));
		unique_ptr<MultiFileReaderInterface> interface;
		if (scanner.type == "parquet") {
			interface = make_uniq<ParquetMultiFileInfo>();
		} else {
			interface = make_uniq<CSVMultiFileInfo>();
		}
		auto multi_file_reader = MultiFileReader::Create(function);
		interface->InitializeInterface(context, *multi_file_reader, *file_list);
		MultiFileOptions file_options;
		auto options = interface->InitializeOptions(context, nullptr);
		for (const auto &parameter : named_parameters) {
			if (multi_file_reader->ParseOption(parameter.first, parameter.second, file_options, context)) {
				continue;
			}
			if (!interface->ParseOption(context, parameter.first, parameter.second, file_options, *options)) {
				throw NotImplementedException("Unimplemented %s option %s", scanner.type, parameter.first);
			}
		}
		vector<LogicalType> return_types;
		vector<string> return_names;
		if (scanner.type == "parquet") {
			bind_data = MultiFileFunction<ParquetMultiFileInfo>::MultiFileBindInternal(
			    context, std::move(multi_file_reader), std::move(file_list), return_types, return_names,
			    std::move(file_options), std::move(options), std::move(interface));
			parquet_scan_execution.store(function.function);
			function.function = CatalogParquetScan;
		} else {
			bind_data = MultiFileFunction<CSVMultiFileInfo>::MultiFileBindInternal(
			    context, std::move(multi_file_reader), std::move(file_list), return_types, return_names,
			    std::move(file_options), std::move(options), std::move(interface));
			if (return_names.size() != descriptor->columns.size()) {
				throw InvalidInputException("RC_CSV_SCHEMA_MISMATCH: physical column count does not match Catalog metadata");
			}
			for (idx_t index = 0; index < descriptor->columns.size(); index++) {
				const auto &column = descriptor->columns[index];
				if (return_names[index] != column.name || return_types[index] != column.type) {
					throw InvalidInputException(
					    "RC_CSV_SCHEMA_MISMATCH: physical column order, name, or type does not match Catalog metadata");
				}
			}
		}
		return function;
	}

private:
	InMemoryTableEntry(Catalog &catalog, SchemaCatalogEntry &schema,
	                 shared_ptr<const CatalogTableDescriptor> descriptor_p,
	                 CreateTableInfo info)
	    : TableCatalogEntry(catalog, schema, info), descriptor(std::move(descriptor_p)) {
		RecordCatalogTableEntryCreated();
	}

	static CreateTableInfo MakeInfo(SchemaCatalogEntry &schema, const CatalogTableDescriptor &descriptor) {
		CreateTableInfo info(schema, descriptor.table_name);
		for (idx_t index = 0; index < descriptor.columns.size(); index++) {
			const auto &column = descriptor.columns[index];
			info.columns.AddColumn(ColumnDefinition(column.name, column.type));
			if (!column.nullable) {
				info.constraints.push_back(make_uniq<NotNullConstraint>(LogicalIndex(index)));
			}
		}
		return info;
	}

	shared_ptr<const CatalogTableDescriptor> descriptor;
};

class InMemorySchemaEntry : public SchemaCatalogEntry {
public:
	InMemorySchemaEntry(Catalog &catalog, string workspace_p, string schema_name_p)
	    : InMemorySchemaEntry(catalog, std::move(workspace_p), schema_name_p, MakeInfo(schema_name_p)) {
	}
	~InMemorySchemaEntry() override {
		catalog_schema_entry_count--;
	}

	void Scan(ClientContext &context, CatalogType type, const std::function<void(CatalogEntry &)> &callback) override {
		ScanInternal(&context, type, callback);
	}
	void Scan(CatalogType type, const std::function<void(CatalogEntry &)> &callback) override {
		ScanInternal(nullptr, type, callback);
	}
	optional_ptr<CatalogEntry> LookupEntry(CatalogTransaction transaction, const EntryLookupInfo &lookup) override {
		if (lookup.GetCatalogType() == CatalogType::TABLE_ENTRY) {
			auto table = GetCurrentEntry(lookup.GetEntryName());
			if (table) {
				return table;
			}
		}
		if ((lookup.GetCatalogType() == CatalogType::TABLE_ENTRY ||
		     lookup.GetCatalogType() == CatalogType::VIEW_ENTRY) && transaction.HasContext()) {
			auto view = GetCurrentViewEntry(transaction.GetContext(), lookup.GetEntryName());
			return view ? optional_ptr<CatalogEntry>(view.get()) : nullptr;
		}
		return nullptr;
	}

	optional_ptr<CatalogEntry> CreateIndex(CatalogTransaction, CreateIndexInfo &, TableCatalogEntry &) override {
		return ReadOnly();
	}
	optional_ptr<CatalogEntry> CreateFunction(CatalogTransaction, CreateFunctionInfo &) override {
		return ReadOnly();
	}
	optional_ptr<CatalogEntry> CreateTable(CatalogTransaction, BoundCreateTableInfo &) override {
		return ReadOnly();
	}
	optional_ptr<CatalogEntry> CreateView(CatalogTransaction, CreateViewInfo &) override {
		return ReadOnly();
	}
	optional_ptr<CatalogEntry> CreateSequence(CatalogTransaction, CreateSequenceInfo &) override {
		return ReadOnly();
	}
	optional_ptr<CatalogEntry> CreateTableFunction(CatalogTransaction, CreateTableFunctionInfo &) override {
		return ReadOnly();
	}
	optional_ptr<CatalogEntry> CreateCopyFunction(CatalogTransaction, CreateCopyFunctionInfo &) override {
		return ReadOnly();
	}
	optional_ptr<CatalogEntry> CreatePragmaFunction(CatalogTransaction, CreatePragmaFunctionInfo &) override {
		return ReadOnly();
	}
	optional_ptr<CatalogEntry> CreateCollation(CatalogTransaction, CreateCollationInfo &) override {
		return ReadOnly();
	}
	optional_ptr<CatalogEntry> CreateType(CatalogTransaction, CreateTypeInfo &) override {
		return ReadOnly();
	}
	void DropEntry(ClientContext &, DropInfo &) override {
		ReadOnly();
	}
	void Alter(CatalogTransaction, AlterInfo &) override {
		ReadOnly();
	}

private:
	InMemorySchemaEntry(Catalog &catalog, string workspace_p, string schema_name_p, CreateSchemaInfo info)
	    : SchemaCatalogEntry(catalog, info), workspace(std::move(workspace_p)), schema_name(std::move(schema_name_p)) {
		RecordCatalogSchemaEntryCreated();
	}

	static CreateSchemaInfo MakeInfo(const string &schema_name) {
		CreateSchemaInfo info;
		info.schema = schema_name;
		return info;
	}
	static optional_ptr<CatalogEntry> ReadOnly() {
		throw NotImplementedException("RC_READ_ONLY: in_memory_catalog is read-only");
	}
	void ScanInternal(ClientContext *context, CatalogType type, const std::function<void(CatalogEntry &)> &callback) {
		if (type != CatalogType::TABLE_ENTRY && type != CatalogType::VIEW_ENTRY) {
			return;
		}
		auto revision = GetQueryVisibleRevision(workspace);
		if (!revision) {
			return;
		}
		if (type == CatalogType::TABLE_ENTRY) {
			for (const auto &descriptor : ListQueryVisibleTables(workspace, *revision, schema_name)) {
				callback(*GetEnumerationEntry(descriptor, *revision));
			}
			// DuckDB stores tables and views in the same catalog set. A
			// context-aware TABLE_ENTRY scan therefore includes both kinds of
			// entries; callers filter by the concrete CatalogType. The
			// context-free overload cannot bind view definitions, so it keeps
			// returning tables only.
			if (context) {
				for (const auto &descriptor : ListQueryVisibleViews(workspace, *revision, schema_name)) {
					callback(*GetEnumerationViewEntry(*context, descriptor, *revision));
				}
			}
		} else if (type == CatalogType::VIEW_ENTRY && context) {
			for (const auto &descriptor : ListQueryVisibleViews(workspace, *revision, schema_name)) {
				callback(*GetEnumerationViewEntry(*context, descriptor, *revision));
			}
		}
	}
	optional_ptr<CatalogEntry> GetCurrentEntry(const string &table_name) {
		auto revision = GetQueryVisibleRevision(workspace);
		if (!revision) {
			return nullptr;
		}
		return GetEntryAtRevision(table_name, *revision);
	}
	optional_ptr<CatalogEntry> GetEntryAtRevision(const string &table_name, uint64_t revision) {
		lock_guard<mutex> guard(entries_lock);
		AdvanceRevision(revision);
		auto key = StringUtil::Lower(table_name);
		auto entry = entries.find(key);
		if (entry == entries.end()) {
			auto descriptor = LookupQueryVisibleTable(workspace, revision, schema_name, table_name);
			if (!descriptor) {
				return nullptr;
			}
			entry = entries.emplace(std::move(key), make_uniq<InMemoryTableEntry>(catalog, *this, descriptor)).first;
		}
		return entry->second.get();
	}
	InMemoryTableEntry *GetEnumerationEntry(shared_ptr<const CatalogTableDescriptor> descriptor, uint64_t revision) {
		lock_guard<mutex> guard(entries_lock);
		AdvanceRevision(revision);
		auto key = StringUtil::Lower(descriptor->table_name);
		auto entry = enumeration_entries.find(key);
		if (entry == enumeration_entries.end()) {
			entry = enumeration_entries
			            .emplace(std::move(key), make_uniq<InMemoryTableEntry>(catalog, *this, std::move(descriptor)))
			            .first;
		}
		return entry->second.get();
	}
	optional_ptr<ViewCatalogEntry> GetCurrentViewEntry(ClientContext &context, const string &view_name) {
		auto revision = GetQueryVisibleRevision(workspace);
		if (!revision) {
			return nullptr;
		}
		return GetViewEntryAtRevision(context, view_name, *revision);
	}
	optional_ptr<ViewCatalogEntry> GetViewEntryAtRevision(ClientContext &context, const string &view_name,
	                                                     uint64_t revision) {
		auto key = StringUtil::Lower(view_name);
		{
			lock_guard<mutex> guard(entries_lock);
			AdvanceRevision(revision);
			auto entry = views.find(key);
			if (entry != views.end()) {
				return entry->second.get();
			}
		}
		auto descriptor = LookupQueryVisibleView(workspace, revision, schema_name, view_name);
		return descriptor ? GetOrCreateViewEntry(context, std::move(descriptor), revision) : nullptr;
	}
	ViewCatalogEntry *GetEnumerationViewEntry(ClientContext &context,
	                                          shared_ptr<const CatalogViewDescriptor> descriptor,
	                                          uint64_t revision) {
		return GetOrCreateViewEntry(context, std::move(descriptor), revision);
	}
	ViewCatalogEntry *GetOrCreateViewEntry(ClientContext &context,
	                                       shared_ptr<const CatalogViewDescriptor> descriptor,
	                                       uint64_t revision) {
		auto key = StringUtil::Lower(descriptor->view_name);
		{
			lock_guard<mutex> guard(entries_lock);
			AdvanceRevision(revision);
			auto entry = views.find(key);
			if (entry != views.end()) {
				return entry->second.get();
			}
		}

		// Binding a view recursively resolves referenced relations through this
		// schema. Keep the recursion guard thread-local so concurrent connections
		// can bind the same uncached view without being mistaken for a cycle.
		static thread_local unordered_set<string> view_bind_stack;
		auto binding_key = to_string(reinterpret_cast<uintptr_t>(this)) + ":" + key;
		if (!view_bind_stack.insert(binding_key).second) {
			throw InvalidInputException("RC_CATALOG_VIEW_CYCLE: circular view dependency involving %s",
			                            descriptor->view_name);
		}
		unique_ptr<ViewCatalogEntry> created;
		try {
			created = MakeInMemoryViewEntry(context, catalog, *this, *descriptor);
		} catch (...) {
			view_bind_stack.erase(binding_key);
			throw;
		}
		view_bind_stack.erase(binding_key);

		lock_guard<mutex> guard(entries_lock);
		if (!current_revision || *current_revision != revision) {
			throw InvalidInputException("RC_METADATA_REVISION_CHANGED: Catalog revision changed during view binding");
		}
		auto entry = views.find(key);
		if (entry == views.end()) {
			entry = views.emplace(key, std::move(created)).first;
		}
		return entry->second.get();
	}
	void AdvanceRevision(uint64_t revision) {
		if (current_revision && *current_revision == revision) {
			return;
		}
		previous_entries = std::move(entries);
		entries.clear();
		previous_enumeration_entries = std::move(enumeration_entries);
		enumeration_entries.clear();
		previous_views = std::move(views);
		views.clear();
		current_revision = revision;
	}

	string workspace;
	string schema_name;
	mutex entries_lock;
	unordered_map<string, unique_ptr<InMemoryTableEntry>> entries;
	unordered_map<string, unique_ptr<InMemoryTableEntry>> previous_entries;
	unordered_map<string, unique_ptr<InMemoryTableEntry>> enumeration_entries;
	unordered_map<string, unique_ptr<InMemoryTableEntry>> previous_enumeration_entries;
	unordered_map<string, unique_ptr<ViewCatalogEntry>> views;
	unordered_map<string, unique_ptr<ViewCatalogEntry>> previous_views;
	std::optional<uint64_t> current_revision;
};

class InMemoryCatalog : public DuckCatalog {
public:
	InMemoryCatalog(AttachedDatabase &db, string workspace_p) : DuckCatalog(db), workspace(std::move(workspace_p)) {
	}
	void Initialize(bool load_builtin) override {
		DuckCatalog::Initialize(load_builtin);
		auto revision = GetQueryVisibleRevision(workspace);
		if (!revision) {
			return;
		}
		for (const auto &schema_name : ListQueryVisibleSchemas(workspace, *revision)) {
			GetOrCreateSchema(schema_name, *revision);
		}
	}
	bool IsDuckCatalog() override {
		return false;
	}
	string GetCatalogType() override {
		return "in_memory_catalog";
	}
	optional_idx GetCatalogVersion(ClientContext &) override {
		auto revision = GetQueryVisibleRevision(workspace);
		return revision ? optional_idx(*revision) : optional_idx();
	}
	optional_ptr<SchemaCatalogEntry> LookupSchema(CatalogTransaction transaction, const EntryLookupInfo &lookup,
	                                              OnEntryNotFound if_not_found) override {
		if (!HasQueryVisibleSnapshot(workspace)) {
			return DuckCatalog::LookupSchema(transaction, lookup, if_not_found);
		}
		auto revision = GetQueryVisibleRevision(workspace);
		if (revision) {
			for (const auto &schema_name : ListQueryVisibleSchemas(workspace, *revision)) {
				if (StringUtil::CIEquals(schema_name, lookup.GetEntryName())) {
					return GetOrCreateSchema(schema_name, *revision);
				}
			}
		}
		if (if_not_found == OnEntryNotFound::THROW_EXCEPTION) {
			throw CatalogException(lookup.GetErrorContext(), "Schema with name %s does not exist!", lookup.GetEntryName());
		}
		return nullptr;
	}
	void ScanSchemas(ClientContext &, std::function<void(SchemaCatalogEntry &)> callback) override {
		auto revision = GetQueryVisibleRevision(workspace);
		if (!revision) {
			return;
		}
		for (const auto &schema_name : ListQueryVisibleSchemas(workspace, *revision)) {
			callback(*GetOrCreateSchema(schema_name, *revision));
		}
	}

private:
	InMemorySchemaEntry *GetOrCreateSchema(const string &schema_name, uint64_t revision) {
		lock_guard<mutex> guard(schemas_lock);
		if (!current_revision || *current_revision != revision) {
			previous_schemas = std::move(schemas);
			schemas.clear();
			current_revision = revision;
		}
		auto key = StringUtil::Lower(schema_name);
		auto entry = schemas.find(key);
		if (entry == schemas.end()) {
			entry = schemas.emplace(std::move(key), make_uniq<InMemorySchemaEntry>(*this, workspace, schema_name)).first;
		}
		return entry->second.get();
	}

	string workspace;
	mutex schemas_lock;
	unordered_map<string, unique_ptr<InMemorySchemaEntry>> schemas;
	unordered_map<string, unique_ptr<InMemorySchemaEntry>> previous_schemas;
	std::optional<uint64_t> current_revision;
};

class InMemoryTransaction : public Transaction {
public:
	InMemoryTransaction(TransactionManager &manager, ClientContext &context) : Transaction(manager, context) {
	}
	void SetReadWrite() override {
		throw TransactionException("RC_READ_ONLY: in_memory_catalog is read-only");
	}
};

class InMemoryTransactionManager : public TransactionManager {
public:
	explicit InMemoryTransactionManager(AttachedDatabase &db) : TransactionManager(db) {
	}
	Transaction &StartTransaction(ClientContext &context) override {
		auto transaction = make_shared_ptr<InMemoryTransaction>(*this, context);
		auto &result = *transaction;
		lock_guard<mutex> guard(lock);
		transactions[result] = std::move(transaction);
		return result;
	}
	ErrorData CommitTransaction(ClientContext &, Transaction &transaction) override {
		lock_guard<mutex> guard(lock);
		transactions.erase(transaction);
		return ErrorData();
	}
	void RollbackTransaction(Transaction &transaction) override {
		lock_guard<mutex> guard(lock);
		transactions.erase(transaction);
	}
	void Checkpoint(ClientContext &, bool = false) override {
	}

private:
	mutex lock;
	reference_map_t<Transaction, shared_ptr<InMemoryTransaction>> transactions;
};

struct InMemoryStorageExtension : StorageExtension {
	InMemoryStorageExtension() {
		attach = [](optional_ptr<StorageExtensionInfo>, ClientContext &, AttachedDatabase &db, const string &,
		            AttachInfo &info, AttachOptions &options) -> unique_ptr<Catalog> {
			if (info.path.empty()) {
				throw InvalidInputException("in_memory_catalog workspace must not be empty");
			}
			if (options.access_mode != AccessMode::READ_ONLY) {
				throw InvalidInputException("in_memory_catalog must be attached READ_ONLY");
			}
			if (!HasQueryVisibleSnapshot(info.path)) {
				throw InvalidInputException("RC_CATALOG_NOT_INITIALIZED: workspace is not registered");
			}
			return make_uniq_base<Catalog, InMemoryCatalog>(db, info.path);
		};
		create_transaction_manager = [](optional_ptr<StorageExtensionInfo>, AttachedDatabase &db,
		                                Catalog &) -> unique_ptr<TransactionManager> {
			return make_uniq<InMemoryTransactionManager>(db);
		};
	}
};

void InMemoryCatalogDiagnostics(DataChunk &, ExpressionState &, Vector &result) {
	auto json =
	    "{\"catalog_entries\":{\"current_count\":" + to_string(catalog_table_entry_count.load()) +
	    ",\"high_watermark\":" + to_string(catalog_table_entry_high_watermark.load()) +
	    "},\"schema_entries\":{\"current_count\":" + to_string(catalog_schema_entry_count.load()) +
	    ",\"high_watermark\":" + to_string(catalog_schema_entry_high_watermark.load()) + "}}";
	result.SetVectorType(VectorType::CONSTANT_VECTOR);
	auto data = ConstantVector::GetData<string_t>(result);
	data[0] = StringVector::AddString(result, json);
}

void LoadInternal(ExtensionLoader &loader) {
	auto &db = loader.GetDatabaseInstance();
	auto &config = DBConfig::GetConfig(db);
	config.storage_extensions["in_memory_catalog"] = make_uniq<InMemoryStorageExtension>();
	loader.RegisterFunction(
	    ScalarFunction("in_memory_catalog_diagnostics", {}, LogicalType::VARCHAR, InMemoryCatalogDiagnostics));
}

} // namespace

void InMemoryCatalogExtension::Load(ExtensionLoader &loader) {
	LoadInternal(loader);
}
std::string InMemoryCatalogExtension::Name() {
	return "in_memory_catalog";
}
std::string InMemoryCatalogExtension::Version() const {
	return DefaultVersion();
}

} // namespace duckdb

extern "C" {
DUCKDB_CPP_EXTENSION_ENTRY(in_memory_catalog, loader) {
	duckdb::LoadInternal(loader);
}
}
