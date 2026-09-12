#include "in_memory_catalog_extension.hpp"

#include "duckdb/catalog/catalog_entry/schema_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/table_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/table_function_catalog_entry.hpp"
#include "duckdb/catalog/duck_catalog.hpp"
#include "duckdb/common/complex_json.hpp"
#include "duckdb/common/file_system.hpp"
#include "duckdb/common/multi_file/multi_file_reader.hpp"
#include "duckdb/common/multi_file/multi_file_function.hpp"
#include "duckdb/common/multi_file/multi_file_list.hpp"
#include "duckdb/common/multi_file/multi_file_states.hpp"
#include "duckdb/common/string_util.hpp"
#include "duckdb/function/scalar_function.hpp"
#include "duckdb/main/attached_database.hpp"
#include "duckdb/main/config.hpp"
#include "duckdb/main/extension/extension_loader.hpp"
#include "duckdb/parser/parsed_data/attach_info.hpp"
#include "duckdb/parser/parsed_data/create_schema_info.hpp"
#include "duckdb/parser/parsed_data/create_table_info.hpp"
#include "duckdb/parser/constraints/not_null_constraint.hpp"
#include "duckdb/storage/database_size.hpp"
#include "duckdb/storage/storage_extension.hpp"
#include "duckdb/transaction/transaction.hpp"
#include "duckdb/transaction/transaction_manager.hpp"
#include "yyjson.hpp"
#include "in_memory_catalog_scan_uri.hpp"
#include "parquet_multi_file_info.hpp"

#include <atomic>
#include <mutex>
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

struct CatalogFileMetadata {
	string uri;
};

struct CatalogTableDescriptor {
	string workspace;
	uint64_t catalog_revision;
	string schema_name;
	string table_name;
	string snapshot_id;
	vector<CatalogColumnMetadata> columns;
	vector<CatalogFileMetadata> files;
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
// clang-format on
#endif

[[noreturn]] static void DescriptorInvalid() {
	throw InvalidInputException("RC_METADATA_INVALID: Worker table descriptor is invalid");
}

static string JSONString(yyjson_val *object, const char *key) {
	auto value = yyjson_obj_get(object, key);
	if (!value || !yyjson_is_str(value)) {
		DescriptorInvalid();
	}
	return string(unsafe_yyjson_get_str(value), unsafe_yyjson_get_len(value));
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

static bool IsSupportedLogicalType(const string &type) {
	static const unordered_set<string> supported_types {
	    "BOOLEAN",   "TINYINT",  "SMALLINT", "INTEGER",   "BIGINT",    "UTINYINT", "USMALLINT",
	    "UINTEGER",  "UBIGINT",  "FLOAT",    "DOUBLE",    "VARCHAR",   "DATE",     "TIMESTAMP",
	    "TIMESTAMP_TZ"};
	return supported_types.find(type) != supported_types.end();
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
		if (name.empty() || name.find('\0') != string::npos ||
		    !column_names.insert(StringUtil::Lower(name)).second ||
		    !IsSupportedLogicalType(type_name) || !nullable || !yyjson_is_bool(nullable)) {
			DescriptorInvalid();
		}
		descriptor.columns.push_back(
		    {std::move(name), TransformStringToLogicalType(type_name), yyjson_get_bool(nullable)});
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

	if (yyjson_obj_size(root) != 6) {
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

	DecodeColumns(root, *descriptor);

	auto files = yyjson_obj_get(root, "files");
	if (!files || !yyjson_is_arr(files) || yyjson_arr_size(files) == 0) {
		DescriptorInvalid();
	}
	unordered_set<string> uris;
	size_t file_index, file_count;
	yyjson_val *file;
	yyjson_arr_foreach(files, file_index, file_count, file) {
		if (!yyjson_is_obj(file) || yyjson_obj_size(file) != 1) {
			DescriptorInvalid();
		}
		CatalogFileMetadata catalog_file {JSONString(file, "uri")};
		if (catalog_file.uri.empty() || catalog_file.uri.find('\0') != string::npos ||
		    !uris.insert(catalog_file.uri).second) {
			DescriptorInvalid();
		}
		descriptor->files.push_back(std::move(catalog_file));
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
		auto &entry = Catalog::GetSystemCatalog(context).GetEntry<TableFunctionCatalogEntry>(context, DEFAULT_SCHEMA,
		                                                                                     "parquet_scan");
		auto function = entry.functions.GetFunctionByArguments(context, {LogicalType::LIST(LogicalType::VARCHAR)});

		vector<Value> files;
		files.reserve(descriptor->files.size());
		for (const auto &file : descriptor->files) {
			files.push_back(Value(in_memory_catalog::MakeDuckDBScanURI(file.uri, descriptor->snapshot_id)));
		}
		// Metadata is supplied to parquet_scan so DESCRIBE/EXPLAIN stay remote-free.
		// The host URI remains opaque metadata; only the scanner receives the
		// snapshot-versioned URI.
		named_parameter_map_t named_parameters;
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

		vector<OpenFileInfo> open_files;
		open_files.reserve(files.size());
		for (const auto &file : files) {
			open_files.emplace_back(file.GetValue<string>());
		}
		auto file_list = make_shared_ptr<SimpleMultiFileList>(std::move(open_files));
		auto interface = make_uniq<ParquetMultiFileInfo>();
		auto multi_file_reader = MultiFileReader::Create(function);
		interface->InitializeInterface(context, *multi_file_reader, *file_list);
		MultiFileOptions file_options;
		auto options = interface->InitializeOptions(context, nullptr);
		for (const auto &parameter : named_parameters) {
			if (multi_file_reader->ParseOption(parameter.first, parameter.second, file_options, context)) {
				continue;
			}
			if (!interface->ParseOption(context, parameter.first, parameter.second, file_options, *options)) {
				throw NotImplementedException("Unimplemented Parquet option %s", parameter.first);
			}
		}
		vector<LogicalType> return_types;
		vector<string> return_names;
		bind_data = MultiFileFunction<ParquetMultiFileInfo>::MultiFileBindInternal(
		    context, std::move(multi_file_reader), std::move(file_list), return_types, return_names,
		    std::move(file_options), std::move(options), std::move(interface));
		parquet_scan_execution.store(function.function);
		function.function = CatalogParquetScan;
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

	void Scan(ClientContext &, CatalogType type, const std::function<void(CatalogEntry &)> &callback) override {
		ScanInternal(type, callback);
	}
	void Scan(CatalogType type, const std::function<void(CatalogEntry &)> &callback) override {
		ScanInternal(type, callback);
	}
	optional_ptr<CatalogEntry> LookupEntry(CatalogTransaction, const EntryLookupInfo &lookup) override {
		if (lookup.GetCatalogType() != CatalogType::TABLE_ENTRY) {
			return nullptr;
		}
		return GetCurrentEntry(lookup.GetEntryName());
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
	void ScanInternal(CatalogType type, const std::function<void(CatalogEntry &)> &callback) {
		if (type != CatalogType::TABLE_ENTRY) {
			return;
		}
		auto revision = GetQueryVisibleRevision(workspace);
		if (!revision) {
			return;
		}
		for (const auto &descriptor : ListQueryVisibleTables(workspace, *revision, schema_name)) {
			callback(*GetEnumerationEntry(descriptor, *revision));
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
	void AdvanceRevision(uint64_t revision) {
		if (current_revision && *current_revision == revision) {
			return;
		}
		previous_entries = std::move(entries);
		entries.clear();
		previous_enumeration_entries = std::move(enumeration_entries);
		enumeration_entries.clear();
		current_revision = revision;
	}

	string workspace;
	string schema_name;
	mutex entries_lock;
	unordered_map<string, unique_ptr<InMemoryTableEntry>> entries;
	unordered_map<string, unique_ptr<InMemoryTableEntry>> previous_entries;
	unordered_map<string, unique_ptr<InMemoryTableEntry>> enumeration_entries;
	unordered_map<string, unique_ptr<InMemoryTableEntry>> previous_enumeration_entries;
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
