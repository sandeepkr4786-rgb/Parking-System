cmake_minimum_required(VERSION 3.16)
project(parking_server LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_path(MYSQL_INCLUDE_DIR NAMES mysql.h PATH_SUFFIXES mysql mariadb)
find_library(MYSQL_LIBRARY NAMES mysqlclient mariadb libmysql)
find_path(HTTPLIB_INCLUDE_DIR httplib.h HINTS "${CMAKE_CURRENT_SOURCE_DIR}")

if(NOT MYSQL_INCLUDE_DIR OR NOT MYSQL_LIBRARY OR NOT HTTPLIB_INCLUDE_DIR)
  message(FATAL_ERROR
    "Missing dependencies. Set MYSQL_INCLUDE_DIR, MYSQL_LIBRARY, and ensure httplib.h is in backend/.")
endif()

find_package(Threads REQUIRED)

add_executable(parking_server main.cpp)
target_include_directories(parking_server PRIVATE
  "${MYSQL_INCLUDE_DIR}"
  "${HTTPLIB_INCLUDE_DIR}"
)
target_link_libraries(parking_server PRIVATE "${MYSQL_LIBRARY}" Threads::Threads)

if(WIN32)
  target_link_libraries(parking_server PRIVATE ws2_32)
endif()
