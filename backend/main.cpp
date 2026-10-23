#include "httplib.h"
#include <mysql.h>

#include <cctype>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace {

std::mutex database_mutex;
MYSQL* database = nullptr;

struct ResultDeleter {
  void operator()(MYSQL_RES* result) const {
    if (result) mysql_free_result(result);
  }
};
using Result = std::unique_ptr<MYSQL_RES, ResultDeleter>;

std::string env_or(const char* key, const char* fallback) {
  const char* value = std::getenv(key);
  return value && *value ? value : fallback;
}

std::string json_escape(const std::string& value) {
  std::ostringstream out;
  for (unsigned char ch : value) {
    switch (ch) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) {
          const char hex[] = "0123456789abcdef";
          out << "\\u00" << hex[ch >> 4] << hex[ch & 0x0f];
        } else {
          out << static_cast<char>(ch);
        }
    }
  }
  return out.str();
}

std::string json_string(const std::string& value) {
  return "\"" + json_escape(value) + "\"";
}

std::string mysql_escape(const std::string& value) {
  std::string escaped(value.size() * 2 + 1, '\0');
  const auto length = mysql_real_escape_string(
      database, escaped.data(), value.data(),
      static_cast<unsigned long>(value.size()));
  escaped.resize(length);
  return escaped;
}

bool execute(const std::string& sql, std::string& error) {
  if (mysql_query(database, sql.c_str()) == 0) return true;
  error = mysql_error(database);
  return false;
}

Result query(const std::string& sql, std::string& error) {
  if (!execute(sql, error)) return {};
  Result result(mysql_store_result(database));
  if (!result && mysql_field_count(database) != 0) error = mysql_error(database);
  return result;
}

void send_error(httplib::Response& response, int status,
                const std::string& message) {
  response.status = status;
  response.set_content("{\"error\":" + json_string(message) + "}",
                       "application/json; charset=utf-8");
}

bool require_param(const httplib::Request& request, const char* name,
                   std::string& value, httplib::Response& response) {
  if (!request.has_param(name)) {
    send_error(response, 400, std::string("Missing parameter: ") + name);
    return false;
  }
  value = request.get_param_value(name);
  if (value.empty()) {
    send_error(response, 400, std::string("Parameter cannot be empty: ") + name);
    return false;
  }
  return true;
}

bool positive_id(const std::string& value, unsigned long& id) {
  if (value.empty()) return false;
  try {
    std::size_t used = 0;
    const auto parsed = std::stoul(value, &used);
    if (used != value.size() || parsed == 0) return false;
    id = parsed;
    return true;
  } catch (const std::exception&) {
    return false;
  }
}

bool valid_vehicle_number(const std::string& value) {
  if (value.empty() || value.size() > 20) return false;
  for (unsigned char ch : value) {
    if (!std::isalnum(ch) && ch != '-' && ch != ' ') return false;
  }
  return true;
}

void send_query_error(httplib::Response& response, const std::string& error) {
  std::cerr << "Database query failed: " << error << '\n';
  send_error(response, 500, "Database operation failed");
}

void register_routes(httplib::Server& server) {
  server.Get("/api/lots", [](const httplib::Request&, httplib::Response& response) {
    std::lock_guard<std::mutex> lock(database_mutex);
    std::string error;
    auto result = query(
        "SELECT l.id, l.name, l.address, COUNT(s.id) AS total_slots, "
        "SUM(s.status = 'occupied') AS occupied_slots "
        "FROM parking_lots l LEFT JOIN parking_slots s ON s.lot_id = l.id "
        "GROUP BY l.id, l.name, l.address ORDER BY l.id", error);
    if (!result) return send_query_error(response, error);

    std::ostringstream json;
    json << '[';
    bool first = true;
    MYSQL_ROW row;
    while ((row = mysql_fetch_row(result.get()))) {
      if (!first) json << ',';
      first = false;
      json << "{\"id\":" << row[0] << ",\"name\":" << json_string(row[1] ? row[1] : "")
           << ",\"address\":" << json_string(row[2] ? row[2] : "")
           << ",\"total_slots\":" << (row[3] ? row[3] : "0")
           << ",\"occupied_slots\":" << (row[4] ? row[4] : "0") << '}';
    }
    json << ']';
    response.set_content(json.str(), "application/json; charset=utf-8");
  });

  server.Get("/api/slots", [](const httplib::Request& request, httplib::Response& response) {
    std::string lot_value;
    if (!require_param(request, "lot_id", lot_value, response)) return;
    unsigned long lot_id = 0;
    if (!positive_id(lot_value, lot_id)) return send_error(response, 400, "lot_id must be a positive integer");

    std::lock_guard<std::mutex> lock(database_mutex);
    std::string error;
    auto result = query(
        "SELECT s.id, s.slot_number, s.slot_type, s.status, "
        "p.vehicle_number, p.started_at "
        "FROM parking_slots s LEFT JOIN parking_sessions p "
        "ON p.slot_id = s.id AND p.exited_at IS NULL "
        "WHERE s.lot_id = " + std::to_string(lot_id) + " ORDER BY s.slot_number", error);
    if (!result) return send_query_error(response, error);

    std::ostringstream json;
    json << '[';
    bool first = true;
    MYSQL_ROW row;
    while ((row = mysql_fetch_row(result.get()))) {
      if (!first) json << ',';
      first = false;
      json << "{\"id\":" << row[0]
           << ",\"slot_number\":" << json_string(row[1] ? row[1] : "")
           << ",\"slot_type\":" << json_string(row[2] ? row[2] : "")
           << ",\"status\":" << json_string(row[3] ? row[3] : "")
           << ",\"vehicle_number\":";
      if (row[4]) json << json_string(row[4]);
      else json << "null";
      json << ",\"started_at\":";
      if (row[5]) json << json_string(row[5]);
      else json << "null";
      json << '}';
    }
    json << ']';
    response.set_content(json.str(), "application/json; charset=utf-8");
  });

  server.Post("/api/entry", [](const httplib::Request& request, httplib::Response& response) {
    std::string lot_value, vehicle, slot_type;
    if (!require_param(request, "lot_id", lot_value, response) ||
        !require_param(request, "vehicle_number", vehicle, response) ||
        !require_param(request, "slot_type", slot_type, response)) return;
    unsigned long lot_id = 0;
    if (!positive_id(lot_value, lot_id)) return send_error(response, 400, "lot_id must be a positive integer");
    if (!valid_vehicle_number(vehicle)) return send_error(response, 400, "vehicle_number must be 1-20 letters, digits, spaces, or hyphens");
    if (slot_type != "regular" && slot_type != "compact" &&
        slot_type != "accessible" && slot_type != "electric") {
      return send_error(response, 400, "Unsupported slot_type");
    }

    std::lock_guard<std::mutex> lock(database_mutex);
    std::string error;
    if (!execute("START TRANSACTION", error)) return send_query_error(response, error);
    const auto escaped_vehicle = mysql_escape(vehicle);
    auto existing = query(
        "SELECT id FROM parking_sessions WHERE vehicle_number = '" + escaped_vehicle +
        "' AND exited_at IS NULL LIMIT 1", error);
    if (!existing) {
      execute("ROLLBACK", error);
      return send_query_error(response, error);
    }
    if (mysql_num_rows(existing.get()) > 0) {
      execute("ROLLBACK", error);
      return send_error(response, 409, "This vehicle already has an active parking session");
    }
    existing.reset();

    auto available = query(
        "SELECT id, slot_number FROM parking_slots WHERE lot_id = " +
        std::to_string(lot_id) + " AND slot_type = '" + slot_type +
        "' AND status = 'available' ORDER BY id LIMIT 1 FOR UPDATE", error);
    if (!available) {
      execute("ROLLBACK", error);
      return send_query_error(response, error);
    }
    MYSQL_ROW slot = mysql_fetch_row(available.get());
    if (!slot) {
      execute("ROLLBACK", error);
      return send_error(response, 409, "No available slot of the requested type");
    }
    const std::string slot_id = slot[0];
    const std::string slot_number = slot[1];
    available.reset();

    if (!execute("UPDATE parking_slots SET status = 'occupied' WHERE id = " + slot_id, error) ||
        !execute("INSERT INTO parking_sessions (slot_id, vehicle_number) VALUES (" +
                 slot_id + ", '" + escaped_vehicle + "')", error)) {
      execute("ROLLBACK", error);
      return send_query_error(response, error);
    }
    if (!execute("COMMIT", error)) {
      execute("ROLLBACK", error);
      return send_query_error(response, error);
    }
    response.status = 201;
    response.set_content("{\"message\":\"Vehicle checked in\",\"slot_number\":" +
                         json_string(slot_number) + "}", "application/json; charset=utf-8");
  });

  server.Post("/api/exit", [](const httplib::Request& request, httplib::Response& response) {
    std::string vehicle;
    if (!require_param(request, "vehicle_number", vehicle, response)) return;
    if (!valid_vehicle_number(vehicle)) return send_error(response, 400, "Invalid vehicle_number");

    std::lock_guard<std::mutex> lock(database_mutex);
    std::string error;
    if (!execute("START TRANSACTION", error)) return send_query_error(response, error);
    auto active = query(
        "SELECT p.id, p.slot_id, p.started_at, "
        "GREATEST(1, CEIL(TIMESTAMPDIFF(SECOND, p.started_at, NOW()) / 3600)) AS billable_hours "
        "FROM parking_sessions p WHERE p.vehicle_number = '" + mysql_escape(vehicle) +
        "' AND p.exited_at IS NULL LIMIT 1 FOR UPDATE", error);
    if (!active) {
      execute("ROLLBACK", error);
      return send_query_error(response, error);
    }
    MYSQL_ROW row = mysql_fetch_row(active.get());
    if (!row) {
      execute("ROLLBACK", error);
      return send_error(response, 404, "No active parking session found for this vehicle");
    }
    const std::string session_id = row[0];
    const std::string slot_id = row[1];
    const std::string started_at = row[2];
    const unsigned long hours = std::stoul(row[3]);
    active.reset();
    const unsigned long fee = hours * 20;
    if (!execute("UPDATE parking_sessions SET exited_at = NOW(), fee = " +
                 std::to_string(fee) + " WHERE id = " + session_id, error) ||
        !execute("UPDATE parking_slots SET status = 'available' WHERE id = " + slot_id, error)) {
      execute("ROLLBACK", error);
      return send_query_error(response, error);
    }
    if (!execute("COMMIT", error)) {
      execute("ROLLBACK", error);
      return send_query_error(response, error);
    }
    response.set_content("{\"message\":\"Vehicle checked out\",\"started_at\":" +
                         json_string(started_at) + ",\"billable_hours\":" +
                         std::to_string(hours) + ",\"fee\":" + std::to_string(fee) + "}",
                         "application/json; charset=utf-8");
  });

  server.Get("/api/utilization/hourly", [](const httplib::Request& request, httplib::Response& response) {
    std::string lot_value;
    if (!require_param(request, "lot_id", lot_value, response)) return;
    unsigned long lot_id = 0;
    if (!positive_id(lot_value, lot_id)) return send_error(response, 400, "lot_id must be a positive integer");

    std::lock_guard<std::mutex> lock(database_mutex);
    std::string error;
    auto result = query(
        "WITH RECURSIVE hours AS ("
        " SELECT CAST(DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00') AS DATETIME)"
        " - INTERVAL 23 HOUR AS hour_start, 0 AS n"
        " UNION ALL SELECT hour_start + INTERVAL 1 HOUR, n + 1 FROM hours WHERE n < 23"
        "), lot_size AS ("
        " SELECT COUNT(*) AS total FROM parking_slots WHERE lot_id = " + std::to_string(lot_id) +
        ") SELECT DATE_FORMAT(h.hour_start, '%Y-%m-%d %H:00:00') AS hour_start,"
        " COALESCE(ROUND(100 * SUM(GREATEST(0, TIMESTAMPDIFF(SECOND,"
        " GREATEST(p.started_at, h.hour_start),"
        " LEAST(COALESCE(p.exited_at, NOW()), h.hour_start + INTERVAL 1 HOUR)"
        " ))) / NULLIF(l.total * 3600, 0), 1), 0) AS utilization_percent"
        " FROM hours h CROSS JOIN lot_size l LEFT JOIN parking_slots s ON s.lot_id = " +
        std::to_string(lot_id) + " LEFT JOIN parking_sessions p ON p.slot_id = s.id"
        " AND p.started_at < h.hour_start + INTERVAL 1 HOUR"
        " AND COALESCE(p.exited_at, NOW()) > h.hour_start"
        " GROUP BY h.hour_start, l.total ORDER BY h.hour_start", error);
    if (!result) return send_query_error(response, error);

    std::ostringstream json;
    json << '[';
    bool first = true;
    MYSQL_ROW row;
    while ((row = mysql_fetch_row(result.get()))) {
      if (!first) json << ',';
      first = false;
      json << "{\"hour\":" << json_string(row[0] ? row[0] : "")
           << ",\"utilization_percent\":" << (row[1] ? row[1] : "0") << '}';
    }
    json << ']';
    response.set_content(json.str(), "application/json; charset=utf-8");
  });

  server.Get("/api/summary", [](const httplib::Request&, httplib::Response& response) {
    std::lock_guard<std::mutex> lock(database_mutex);
    std::string error;
    auto result = query(
        "SELECT (SELECT COUNT(*) FROM parking_sessions WHERE exited_at IS NULL) AS vehicles_parked,"
        " COALESCE((SELECT SUM(fee) FROM parking_sessions WHERE exited_at >= CURDATE()), 0) AS revenue_today,"
        " COALESCE((SELECT AVG(TIMESTAMPDIFF(MINUTE, started_at, exited_at) / 60.0)"
        " FROM parking_sessions WHERE exited_at >= CURDATE()), 0) AS average_stay_hours"
        ", (SELECT COUNT(*) FROM parking_slots) AS total_slots", error);
    if (!result) return send_query_error(response, error);
    MYSQL_ROW row = mysql_fetch_row(result.get());
    if (!row) return send_error(response, 500, "Could not load dashboard summary");
    const std::string json =
        "{\"vehicles_parked\":" + std::string(row[0] ? row[0] : "0") +
        ",\"revenue_today\":" + std::string(row[1] ? row[1] : "0") +
        ",\"average_stay_hours\":" + std::string(row[2] ? row[2] : "0") +
        ",\"total_slots\":" + std::string(row[3] ? row[3] : "0") + "}";
    response.set_content(json, "application/json; charset=utf-8");
  });
}

}  // namespace

int main() {
  const auto host = env_or("DB_HOST", "127.0.0.1");
  const auto user = env_or("DB_USER", "root");
  const auto password = env_or("DB_PASS", "");
  const auto name = env_or("DB_NAME", "parking_db");
  unsigned long port = 0;
  if (!positive_id(env_or("DB_PORT", "3306"), port) || port > 65535) {
    std::cerr << "DB_PORT must be between 1 and 65535\n";
    return 1;
  }

  database = mysql_init(nullptr);
  if (!database) {
    std::cerr << "Could not initialize MySQL client\n";
    return 1;
  }
  if (!mysql_real_connect(database, host.c_str(), user.c_str(), password.c_str(),
                          name.c_str(), static_cast<unsigned int>(port), nullptr, 0)) {
    std::cerr << "Could not connect to MySQL: " << mysql_error(database) << '\n';
    mysql_close(database);
    return 1;
  }
  if (mysql_set_character_set(database, "utf8mb4") != 0) {
    std::cerr << "Could not set MySQL connection character set: "
              << mysql_error(database) << '\n';
    mysql_close(database);
    return 1;
  }

  httplib::Server server;
  register_routes(server);
  if (!server.set_mount_point("/", "../../frontend")) {
    std::cerr << "Could not mount ../../frontend; run from backend/build\n";
    mysql_close(database);
    return 1;
  }
  server.set_error_handler([](const httplib::Request&, httplib::Response& response) {
    if (response.body.empty()) send_error(response, response.status, "Not found");
  });

  unsigned long port_value = 0;
  if (!positive_id(env_or("PORT", "8080"), port_value)) {
    std::cerr << "PORT must be between 1 and 65535\n";
    mysql_close(database);
    return 1;
  }
  if (port_value == 0 || port_value > 65535) {
    std::cerr << "PORT must be between 1 and 65535\n";
    mysql_close(database);
    return 1;
  }
  std::cout << "Parking server listening on http://localhost:" << port_value << '\n';
  if (!server.listen("0.0.0.0", static_cast<int>(port_value))) {
    std::cerr << "Could not start HTTP server\n";
    mysql_close(database);
    return 1;
  }
  mysql_close(database);
  return 0;
}
