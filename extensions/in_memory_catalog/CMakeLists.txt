cmake_minimum_required(VERSION 3.10)

set(TARGET_NAME in_memory_catalog)
set(EXTENSION_NAME ${TARGET_NAME}_extension)
set(LOADABLE_EXTENSION_NAME ${TARGET_NAME}_loadable_extension)

project(${TARGET_NAME})
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include_directories(${CMAKE_CURRENT_LIST_DIR}/../../src/include)
include_directories(${DuckDB_SOURCE_DIR}/extension/parquet/include)
include_directories(
  ${DuckDB_SOURCE_DIR}/third_party/lz4
  ${DuckDB_SOURCE_DIR}/third_party/parquet
  ${DuckDB_SOURCE_DIR}/third_party/thrift
  ${DuckDB_SOURCE_DIR}/third_party/snappy
  ${DuckDB_SOURCE_DIR}/third_party/brotli/include)
set(EXTENSION_SOURCES
    ${CMAKE_CURRENT_LIST_DIR}/../../src/in_memory_catalog_extension.cpp)

build_static_extension(${TARGET_NAME} ${EXTENSION_SOURCES})
build_loadable_extension(${TARGET_NAME} "" ${EXTENSION_SOURCES})

install(
  TARGETS ${EXTENSION_NAME}
  EXPORT "${DUCKDB_EXPORT_SET}"
  LIBRARY DESTINATION "${INSTALL_LIB_DIR}"
  ARCHIVE DESTINATION "${INSTALL_LIB_DIR}")
