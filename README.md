# Parking Occupancy & Space Utilization

A parking operations dashboard backed by a C++17 HTTP server and MySQL. The server hosts the static dashboard and exposes the parking API.

## Requirements

- C++17 compiler and CMake 3.16+
- MySQL or MariaDB server and client development headers/library
- `httplib.h` from [cpp-httplib](https://github.com/yhirose/cpp-httplib), saved in `backend/`
- MySQL 8.0+ for the recursive CTE used by hourly utilization

## Database setup

Create the database, tables, view, sample lots, and 32 sample spaces:

```sh
mysql -u root -p < schema.sql
```

The SQL seed statements are safe to run again. They do not reset live parking sessions or occupied spaces.

## Build and run

```sh
cd backend
cmake -S . -B build
cmake --build build
cd build
```

Configure the connection with `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, and `DB_NAME`, then start the server:

```sh
DB_USER=root DB_PASS=yourpassword ./parking_server
```

On Windows PowerShell:

```powershell
$env:DB_USER = "root"
$env:DB_PASS = "yourpassword"
.\parking_server.exe
```

Run the executable from `backend/build`; the server serves files from `../../frontend`. The dashboard is at <http://localhost:8080>. Set `PORT` to change the HTTP port.

For MySQL Connector/C on Windows, pass its include and library locations to CMake if they are not in its default search paths, for example `-DMYSQL_INCLUDE_DIR="C:\path\to\include" -DMYSQL_LIBRARY="C:\path\to\lib\libmysql.lib"`.

**For live database operations:** Start MySQL and `parking_server`, then open the dashboard from the server URL (`http://localhost:8080` by default). The page should show **Live database**. After entry, it shows the assigned space; after exit, it shows the billable hours and fee.

If the API is unavailable (or the HTML is opened directly), the dashboard switches to **Local demo · browser only** mode. Entry and exit then work using browser storage so the interface can be tried without installing the backend. This demo data is not sent to or saved in MySQL. For real operations, start MySQL and `parking_server` and confirm the page shows **Live database**.

## API

POST bodies use `application/x-www-form-urlencoded`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/lots` | Lot totals and current occupancy |
| GET | `/api/slots?lot_id=N` | Slots and active parked vehicles |
| POST | `/api/entry` | `lot_id`, `vehicle_number`, `slot_type`; assigns the first free matching space |
| POST | `/api/exit` | `vehicle_number`; closes its active session and charges ₹20 per started hour (minimum one hour) |
| GET | `/api/utilization/hourly?lot_id=N` | Utilization percentage for each of the last 24 hourly intervals |
| GET | `/api/summary` | Active vehicles, completed-session revenue, average completed stay, and total spaces |

Hourly utilization counts the actual seconds of each session overlapping each hour and divides by lot capacity × 3600. The current hour is partial. Occupancy is the number of occupied spaces divided by total capacity.
