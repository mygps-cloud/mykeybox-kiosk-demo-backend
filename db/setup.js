const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = path.join(__dirname, 'demo.db')

let db

function getDb() {
    if (db) return db

    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // Create tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            pin TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'employee',
            max_keys INTEGER NOT NULL DEFAULT 2,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS key_slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            door_number INTEGER NOT NULL UNIQUE,
            label TEXT,
            vin TEXT,
            status TEXT NOT NULL DEFAULT 'empty',
            checked_out_by INTEGER,
            checked_out_at TEXT,
            FOREIGN KEY (checked_out_by) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            user_name TEXT,
            key_slot_id INTEGER,
            door_number INTEGER,
            action TEXT NOT NULL,
            details TEXT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `)

    // Insert default settings if not exist
    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    insertSetting.run('mode', 'internal')
    insertSetting.run('device_name', 'DEMO-1')
    insertSetting.run('door_count', '4')
    insertSetting.run('setup_complete', 'false')

    return db
}

module.exports = { getDb }
