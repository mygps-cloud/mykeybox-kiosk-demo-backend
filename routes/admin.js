const express = require('express')
const router = express.Router()
const { getDb } = require('../db/setup')

module.exports = function (driver) {

    // ── SETUP ──────────────────────────────────────────

    // First-time setup
    router.post('/setup', (req, res) => {
        const { admin_name, admin_pin, mode, door_count, device_name } = req.body
        const db = getDb()

        const setupDone = db.prepare("SELECT value FROM settings WHERE key = 'setup_complete'").get()
        if (setupDone?.value === 'true')
            return res.json({ success: false, message: 'Setup already completed' })

        // Create admin user
        db.prepare('INSERT INTO users (name, pin, role, max_keys) VALUES (?, ?, ?, ?)')
            .run(admin_name, admin_pin, 'admin', 99)

        // Create key slots
        const count = parseInt(door_count) || 4
        for (let i = 1; i <= count; i++) {
            db.prepare('INSERT OR IGNORE INTO key_slots (door_number, status) VALUES (?, ?)')
                .run(i, 'empty')
        }

        // Save settings
        const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        upsert.run('mode', mode || 'internal')
        upsert.run('door_count', String(count))
        upsert.run('device_name', device_name || 'DEMO-1')
        upsert.run('setup_complete', 'true')

        // Audit
        db.prepare("INSERT INTO audit_log (user_name, action, details) VALUES (?, ?, ?)")
            .run(admin_name, 'setup', `Mode: ${mode}, Doors: ${count}`)

        res.json({ success: true, message: 'Setup complete' })
    })

    // Check if setup is done
    router.get('/setup-status', (req, res) => {
        const db = getDb()
        const setupDone = db.prepare("SELECT value FROM settings WHERE key = 'setup_complete'").get()
        res.json({ setup_complete: setupDone?.value === 'true' })
    })

    // ── USERS ──────────────────────────────────────────

    router.get('/users', (req, res) => {
        const db = getDb()
        const users = db.prepare('SELECT id, name, pin, role, max_keys, active, created_at FROM users ORDER BY id').all()
        res.json({ users })
    })

    router.post('/users', (req, res) => {
        const { name, pin, role, max_keys } = req.body
        if (!name || !pin) return res.json({ success: false, message: 'Name and PIN required' })

        const db = getDb()

        // Check PIN uniqueness
        const existing = db.prepare('SELECT id FROM users WHERE pin = ? AND active = 1').get(pin)
        if (existing) return res.json({ success: false, message: 'PIN already in use' })

        const result = db.prepare('INSERT INTO users (name, pin, role, max_keys) VALUES (?, ?, ?, ?)')
            .run(name, pin, role || 'employee', max_keys || 2)

        db.prepare("INSERT INTO audit_log (user_name, action, details) VALUES (?, ?, ?)")
            .run('Admin', 'add_user', `Added user: ${name} (${role || 'employee'})`)

        res.json({ success: true, id: result.lastInsertRowid })
    })

    router.put('/users/:id', (req, res) => {
        const { name, pin, role, max_keys, active } = req.body
        const db = getDb()

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
        if (!user) return res.json({ success: false, message: 'User not found' })

        // Check PIN uniqueness if changed
        if (pin && pin !== user.pin) {
            const existing = db.prepare('SELECT id FROM users WHERE pin = ? AND active = 1 AND id != ?').get(pin, user.id)
            if (existing) return res.json({ success: false, message: 'PIN already in use' })
        }

        db.prepare('UPDATE users SET name = ?, pin = ?, role = ?, max_keys = ?, active = ? WHERE id = ?')
            .run(name || user.name, pin || user.pin, role || user.role, max_keys ?? user.max_keys, active ?? user.active, user.id)

        res.json({ success: true })
    })

    router.delete('/users/:id', (req, res) => {
        const db = getDb()
        db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id)

        db.prepare("INSERT INTO audit_log (user_name, action, details) VALUES (?, ?, ?)")
            .run('Admin', 'deactivate_user', `User ID: ${req.params.id}`)

        res.json({ success: true })
    })

    // ── KEY SLOTS ──────────────────────────────────────

    router.get('/slots', (req, res) => {
        const db = getDb()
        const slots = db.prepare('SELECT * FROM key_slots ORDER BY door_number').all()
        res.json({ slots, door_states: driver.getDoorStates(), connected: driver.isConnected() })
    })

    router.put('/slots/:id', (req, res) => {
        const { label, vin, status } = req.body
        const db = getDb()

        const slot = db.prepare('SELECT * FROM key_slots WHERE id = ?').get(req.params.id)
        if (!slot) return res.json({ success: false, message: 'Slot not found' })

        db.prepare('UPDATE key_slots SET label = ?, vin = ?, status = ? WHERE id = ?')
            .run(label ?? slot.label, vin ?? slot.vin, status || slot.status, slot.id)

        db.prepare("INSERT INTO audit_log (key_slot_id, door_number, user_name, action, details) VALUES (?, ?, ?, ?, ?)")
            .run(slot.id, slot.door_number, 'Admin', 'update_slot', `Label: ${label}, VIN: ${vin}`)

        res.json({ success: true })
    })

    // Assign key to slot (make it available)
    router.post('/slots/:id/assign', (req, res) => {
        const { label, vin } = req.body
        const db = getDb()

        const slot = db.prepare('SELECT * FROM key_slots WHERE id = ?').get(req.params.id)
        if (!slot) return res.json({ success: false, message: 'Slot not found' })

        db.prepare("UPDATE key_slots SET label = ?, vin = ?, status = 'available', checked_out_by = NULL, checked_out_at = NULL WHERE id = ?")
            .run(label || null, vin || null, slot.id)

        db.prepare("INSERT INTO audit_log (key_slot_id, door_number, user_name, action, details) VALUES (?, ?, ?, ?, ?)")
            .run(slot.id, slot.door_number, 'Admin', 'assign_key', `${label || 'Unnamed'} (${vin || 'No VIN'})`)

        res.json({ success: true })
    })

    // Remove key from slot (make it empty)
    router.post('/slots/:id/remove', (req, res) => {
        const db = getDb()

        const slot = db.prepare('SELECT * FROM key_slots WHERE id = ?').get(req.params.id)
        if (!slot) return res.json({ success: false, message: 'Slot not found' })

        db.prepare("UPDATE key_slots SET label = NULL, vin = NULL, status = 'empty', checked_out_by = NULL, checked_out_at = NULL WHERE id = ?")
            .run(slot.id)

        db.prepare("INSERT INTO audit_log (key_slot_id, door_number, user_name, action, details) VALUES (?, ?, ?, ?, ?)")
            .run(slot.id, slot.door_number, 'Admin', 'remove_key', `Removed: ${slot.label}`)

        res.json({ success: true })
    })

    // Open door manually (admin)
    router.post('/slots/:id/open', (req, res) => {
        const db = getDb()
        const slot = db.prepare('SELECT * FROM key_slots WHERE id = ?').get(req.params.id)
        if (!slot) return res.json({ success: false, message: 'Slot not found' })

        const opened = driver.openDoor(slot.door_number - 1)

        db.prepare("INSERT INTO audit_log (key_slot_id, door_number, user_name, action, details) VALUES (?, ?, ?, ?, ?)")
            .run(slot.id, slot.door_number, 'Admin', 'manual_open', `Manual door open`)

        res.json({ success: opened })
    })

    // ── AUDIT LOG ──────────────────────────────────────

    router.get('/audit', (req, res) => {
        const { limit, action, user_id } = req.query
        const db = getDb()

        let query = 'SELECT * FROM audit_log WHERE 1=1'
        const params = []

        if (action) { query += ' AND action = ?'; params.push(action) }
        if (user_id) { query += ' AND user_id = ?'; params.push(user_id) }

        query += ' ORDER BY timestamp DESC LIMIT ?'
        params.push(parseInt(limit) || 100)

        const logs = db.prepare(query).all(...params)
        res.json({ logs })
    })

    // ── SETTINGS ───────────────────────────────────────

    router.get('/settings', (req, res) => {
        const db = getDb()
        const rows = db.prepare('SELECT * FROM settings').all()
        const settings = {}
        rows.forEach(r => settings[r.key] = r.value)
        res.json({ settings })
    })

    router.put('/settings', (req, res) => {
        const db = getDb()
        const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')

        Object.entries(req.body).forEach(([key, value]) => {
            upsert.run(key, String(value))
        })

        res.json({ success: true })
    })

    // ── RESET ──────────────────────────────────────────

    // Reset all doors (clear all codes, make empty)
    router.post('/reset-checkouts', (req, res) => {
        const db = getDb()
        db.prepare("UPDATE key_slots SET status = 'empty', code = NULL, code_type = NULL, checked_out_by = NULL, checked_out_at = NULL")
            .run()

        db.prepare("INSERT INTO audit_log (user_name, action, details) VALUES (?, ?, ?)")
            .run('Admin', 'reset', 'All doors reset to empty')

        res.json({ success: true, message: 'All doors reset' })
    })

    // Full factory reset
    router.post('/factory-reset', (req, res) => {
        const db = getDb()
        db.prepare('DELETE FROM audit_log').run()
        db.prepare('DELETE FROM key_slots').run()
        db.prepare('DELETE FROM users').run()
        db.prepare("UPDATE settings SET value = 'false' WHERE key = 'setup_complete'").run()

        res.json({ success: true, message: 'Factory reset complete' })
    })

    // ── DASHBOARD ──────────────────────────────────────

    router.get('/dashboard', (req, res) => {
        const db = getDb()

        const slots = db.prepare('SELECT * FROM key_slots ORDER BY door_number').all()

        const recentActivity = db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 20').all()
        const userCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE active = 1').get()
        const keysOccupied = db.prepare("SELECT COUNT(*) as count FROM key_slots WHERE status = 'occupied'").get()
        const keysEmpty = db.prepare("SELECT COUNT(*) as count FROM key_slots WHERE status = 'empty'").get()
        const settings = {}
        db.prepare('SELECT * FROM settings').all().forEach(r => settings[r.key] = r.value)

        res.json({
            slots,
            door_states: driver.getDoorStates(),
            connected: driver.isConnected(),
            recent_activity: recentActivity,
            stats: {
                total_users: userCount.count,
                keys_occupied: keysOccupied.count,
                doors_empty: keysEmpty.count
            },
            settings
        })
    })

    return router
}
