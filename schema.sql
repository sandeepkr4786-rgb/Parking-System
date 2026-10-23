CREATE DATABASE IF NOT EXISTS parking_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE parking_db;

CREATE TABLE IF NOT EXISTS parking_lots (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  address VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS parking_slots (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  lot_id INT UNSIGNED NOT NULL,
  slot_number VARCHAR(20) NOT NULL,
  slot_type ENUM('regular', 'compact', 'accessible', 'electric') NOT NULL DEFAULT 'regular',
  status ENUM('available', 'occupied') NOT NULL DEFAULT 'available',
  PRIMARY KEY (id),
  UNIQUE KEY uq_lot_slot (lot_id, slot_number),
  KEY idx_lot_status_type (lot_id, status, slot_type),
  CONSTRAINT fk_slots_lot FOREIGN KEY (lot_id) REFERENCES parking_lots (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS parking_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slot_id INT UNSIGNED NOT NULL,
  vehicle_number VARCHAR(20) NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exited_at DATETIME NULL,
  fee DECIMAL(10, 2) NULL,
  PRIMARY KEY (id),
  KEY idx_active_vehicle (vehicle_number, exited_at),
  KEY idx_slot_times (slot_id, started_at, exited_at),
  CONSTRAINT fk_sessions_slot FOREIGN KEY (slot_id) REFERENCES parking_slots (id)
) ENGINE=InnoDB;

INSERT INTO parking_lots (id, name, address) VALUES
  (1, 'Central Plaza', '100 Main Street'),
  (2, 'Riverside Market', '25 River Road')
ON DUPLICATE KEY UPDATE name = VALUES(name), address = VALUES(address);

INSERT INTO parking_slots (lot_id, slot_number, slot_type) VALUES
  (1, 'A-01', 'regular'), (1, 'A-02', 'regular'),
  (1, 'A-03', 'compact'), (1, 'A-04', 'regular'),
  (1, 'A-05', 'accessible'), (1, 'A-06', 'regular'),
  (1, 'A-07', 'electric'), (1, 'A-08', 'regular'),
  (1, 'B-01', 'regular'), (1, 'B-02', 'compact'),
  (1, 'B-03', 'regular'), (1, 'B-04', 'regular'),
  (1, 'B-05', 'regular'), (1, 'B-06', 'electric'),
  (1, 'B-07', 'regular'), (1, 'B-08', 'accessible'),
  (2, 'C-01', 'regular'), (2, 'C-02', 'regular'),
  (2, 'C-03', 'compact'), (2, 'C-04', 'regular'),
  (2, 'C-05', 'electric'), (2, 'C-06', 'regular'),
  (2, 'C-07', 'accessible'), (2, 'C-08', 'regular'),
  (2, 'D-01', 'regular'), (2, 'D-02', 'compact'),
  (2, 'D-03', 'regular'), (2, 'D-04', 'regular'),
  (2, 'D-05', 'electric'), (2, 'D-06', 'regular'),
  (2, 'D-07', 'regular'), (2, 'D-08', 'accessible')
ON DUPLICATE KEY UPDATE slot_type = VALUES(slot_type);

INSERT INTO parking_sessions (slot_id, vehicle_number, started_at, exited_at, fee)
SELECT s.id, sample.vehicle_number, sample.started_at, sample.exited_at, sample.fee
FROM (
  SELECT 'A-01' AS slot_number, 'MH02AB1234' AS vehicle_number,
         DATE_SUB(NOW(), INTERVAL 45 MINUTE) AS started_at,
         NULL AS exited_at, NULL AS fee
  UNION ALL
  SELECT 'B-03', 'DL8CAF4321', DATE_SUB(NOW(), INTERVAL 2 HOUR),
         NULL, NULL
  UNION ALL
  SELECT 'C-04', 'KA03MN9876', DATE_SUB(NOW(), INTERVAL 90 MINUTE),
         NULL, NULL
  UNION ALL
  SELECT 'B-01', 'GJ01XY2468', DATE_SUB(NOW(), INTERVAL 4 HOUR),
         DATE_SUB(NOW(), INTERVAL 2 HOUR), 40.00
) AS sample
JOIN parking_slots s ON s.slot_number = sample.slot_number
JOIN parking_lots l ON l.id = s.lot_id
WHERE (sample.slot_number <> 'C-04' OR l.id = 2)
  AND (sample.slot_number = 'C-04' OR l.id = 1)
  AND NOT EXISTS (
    SELECT 1 FROM parking_sessions existing
    WHERE existing.vehicle_number = sample.vehicle_number
  );

UPDATE parking_slots s
SET s.status = IF(
  EXISTS (SELECT 1 FROM parking_sessions p WHERE p.slot_id = s.id AND p.exited_at IS NULL),
  'occupied',
  'available'
);

CREATE OR REPLACE VIEW current_parking AS
SELECT s.id AS slot_id, s.lot_id, s.slot_number, s.slot_type, s.status,
       p.vehicle_number, p.started_at
FROM parking_slots s
LEFT JOIN parking_sessions p ON p.slot_id = s.id AND p.exited_at IS NULL;
