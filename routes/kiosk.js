const express = require('express')
const router = express.Router()
const { getDb } = require('../db/setup')

module.exports = function (driver) {

    // Check code — main kiosk endpoint
    // D + code → place key (find empty door, assign code)
    // C or S + same code → retrieve key (find door with that code)
    router.post('/check-code', (req, res) => {
        const { type, code } = req.body
        if (!type || !code) return res.json({ success: false, message: 'Type and code required' })
        if (!['C', 'S', 'D'].includes(type.toUpperCase()))
            return res.json({ success: false, message: 'Invalid type. Use C, S, or D' })
        if (code.length !== 5 || !/^\d{5}$/.test(code))
            return res.json({ success: false, message: 'Code must be 5 digits' })

        const db = getDb()
        const upperType = type.toUpperCase()

        if (upperType === 'D') {
            // Dealer placing a key — code must NOT already exist
            const existing = db.prepare("SELECT * FROM key_slots WHERE code = ? AND status = 'occupied'").get(code)
            if (existing) {
                return res.json({ success: false, message: 'Code already in use' })
            }

            // Find first empty door
            const emptySlot = db.prepare("SELECT * FROM key_slots WHERE status = 'empty' ORDER BY door_number LIMIT 1").get()
            if (!emptySlot) {
                return res.json({ success: false, message: 'No empty doors available' })
            }

            // Open the door
            const opened = driver.openDoor(emptySlot.door_number - 1)
            if (!opened) return res.json({ success: false, message: 'Failed to open door' })

            // Save code to this door
            db.prepare("UPDATE key_slots SET status = 'occupied', code = ?, code_type = 'D', checked_out_at = datetime('now') WHERE id = ?")
                .run(code, emptySlot.id)

            // Audit
            db.prepare('INSERT INTO audit_log (user_name, key_slot_id, door_number, action, details) VALUES (?, ?, ?, ?, ?)')
                .run(`Dealer (D)`, emptySlot.id, emptySlot.door_number, 'place_key', `Code: D-${code}`)

            console.log(`[KIOSK] D-${code} → Door ${emptySlot.door_number} PLACED`)

            res.json({
                success: true,
                action: 'place',
                door_number: emptySlot.door_number,
                message: `Door ${emptySlot.door_number} is open — place the key`
            })

        } else {
            // Carrier (C) or Service (S) retrieving — code must exist
            const slot = db.prepare("SELECT * FROM key_slots WHERE code = ? AND status = 'occupied'").get(code)
            if (!slot) {
                return res.json({ success: false, message: 'Code not found' })
            }

            // Open the door
            const opened = driver.openDoor(slot.door_number - 1)
            if (!opened) return res.json({ success: false, message: 'Failed to open door' })

            // Clear the code — door becomes empty again
            db.prepare("UPDATE key_slots SET status = 'empty', code = NULL, code_type = NULL, checked_out_by = NULL, checked_out_at = NULL WHERE id = ?")
                .run(slot.id)

            // Audit
            db.prepare('INSERT INTO audit_log (user_name, key_slot_id, door_number, action, details) VALUES (?, ?, ?, ?, ?)')
                .run(`${upperType === 'C' ? 'Carrier' : 'Service'} (${upperType})`, slot.id, slot.door_number, 'retrieve_key', `Code: ${upperType}-${code}`)

            console.log(`[KIOSK] ${upperType}-${code} → Door ${slot.door_number} RETRIEVED`)

            res.json({
                success: true,
                action: 'retrieve',
                door_number: slot.door_number,
                message: `Door ${slot.door_number} is open — take the key`
            })
        }
    })

    // Get all slots with current status (for welcome screen boxes)
    router.get('/slots', (req, res) => {
        const db = getDb()
        const slots = db.prepare('SELECT id, door_number, label, status, code FROM key_slots ORDER BY door_number').all()
        res.json({ slots })
    })

    // Live door states from hardware
    router.get('/door-states', (req, res) => {
        res.json({
            states: driver.getDoorStates(),
            connected: driver.isConnected()
        })
    })

    // Legacy: verify-pin (kept for admin panel compatibility)
    router.post('/verify-pin', (req, res) => {
        const { pin } = req.body
        if (!pin) return res.json({ success: false, message: 'PIN required' })

        const db = getDb()
        const user = db.prepare('SELECT * FROM users WHERE pin = ? AND active = 1').get(pin)
        if (!user) return res.json({ success: false, message: 'Invalid PIN' })

        const mode = db.prepare("SELECT value FROM settings WHERE key = 'mode'").get()
        res.json({
            success: true,
            user: { id: user.id, name: user.name, role: user.role, max_keys: user.max_keys },
            mode: mode?.value || 'internal'
        })
    })

    return router
}
