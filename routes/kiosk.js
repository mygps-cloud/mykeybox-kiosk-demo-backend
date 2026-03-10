const express = require('express')
const router = express.Router()
const { getDb } = require('../db/setup')

module.exports = function (driver) {

    // Verify PIN → returns user info + available actions
    router.post('/verify-pin', (req, res) => {
        const { pin } = req.body
        if (!pin) return res.json({ success: false, message: 'PIN required' })

        const db = getDb()
        const user = db.prepare('SELECT * FROM users WHERE pin = ? AND active = 1').get(pin)

        if (!user) return res.json({ success: false, message: 'Invalid PIN' })

        // Count how many keys this user currently has out
        const keysOut = db.prepare('SELECT COUNT(*) as count FROM key_slots WHERE checked_out_by = ?').get(user.id)

        // Get available slots for checkout
        const availableSlots = db.prepare("SELECT * FROM key_slots WHERE status = 'available'").all()

        // Get slots checked out by this user (for return)
        const userSlots = db.prepare('SELECT * FROM key_slots WHERE checked_out_by = ?').all(user.id)

        // Get mode
        const mode = db.prepare("SELECT value FROM settings WHERE key = 'mode'").get()

        // Log access
        db.prepare('INSERT INTO audit_log (user_id, user_name, action, details) VALUES (?, ?, ?, ?)')
            .run(user.id, user.name, 'login', `PIN verified`)

        res.json({
            success: true,
            user: { id: user.id, name: user.name, role: user.role, max_keys: user.max_keys },
            keys_out: keysOut.count,
            available_slots: availableSlots,
            user_slots: userSlots,
            mode: mode?.value || 'internal'
        })
    })

    // Get all slots with current status
    router.get('/slots', (req, res) => {
        const db = getDb()
        const slots = db.prepare(`
            SELECT ks.*, u.name as checked_out_by_name
            FROM key_slots ks
            LEFT JOIN users u ON ks.checked_out_by = u.id
            ORDER BY ks.door_number
        `).all()

        res.json({ slots })
    })

    // Checkout key — open door for user to take key
    router.post('/checkout', (req, res) => {
        const { user_id, slot_id } = req.body
        const db = getDb()

        const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(user_id)
        if (!user) return res.json({ success: false, message: 'User not found' })

        const slot = db.prepare('SELECT * FROM key_slots WHERE id = ?').get(slot_id)
        if (!slot) return res.json({ success: false, message: 'Slot not found' })

        if (slot.status !== 'available')
            return res.json({ success: false, message: 'Key not available' })

        // Check max keys
        const keysOut = db.prepare('SELECT COUNT(*) as count FROM key_slots WHERE checked_out_by = ?').get(user.id)
        if (keysOut.count >= user.max_keys)
            return res.json({ success: false, message: `Maximum ${user.max_keys} keys allowed` })

        // Open the door
        const doorIdx = slot.door_number - 1
        const opened = driver.openDoor(doorIdx)
        if (!opened) return res.json({ success: false, message: 'Failed to open door' })

        // Update slot status
        db.prepare(`
            UPDATE key_slots SET status = 'checked_out', checked_out_by = ?, checked_out_at = datetime('now')
            WHERE id = ?
        `).run(user.id, slot.id)

        // Audit log
        db.prepare('INSERT INTO audit_log (user_id, user_name, key_slot_id, door_number, action, details) VALUES (?, ?, ?, ?, ?, ?)')
            .run(user.id, user.name, slot.id, slot.door_number, 'checkout', `Key: ${slot.label || 'Slot ' + slot.door_number}`)

        console.log(`[KIOSK] ${user.name} checked out key from door ${slot.door_number} (${slot.label})`)

        res.json({ success: true, door_number: slot.door_number, message: 'Door is open — take your key' })
    })

    // Return key — open door for user to place key back
    router.post('/return', (req, res) => {
        const { user_id, slot_id } = req.body
        const db = getDb()

        const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(user_id)
        if (!user) return res.json({ success: false, message: 'User not found' })

        const slot = db.prepare('SELECT * FROM key_slots WHERE id = ?').get(slot_id)
        if (!slot) return res.json({ success: false, message: 'Slot not found' })

        if (slot.status !== 'checked_out' || slot.checked_out_by !== user.id)
            return res.json({ success: false, message: 'This key is not checked out by you' })

        // Open the door
        const doorIdx = slot.door_number - 1
        const opened = driver.openDoor(doorIdx)
        if (!opened) return res.json({ success: false, message: 'Failed to open door' })

        // Update slot status
        db.prepare("UPDATE key_slots SET status = 'available', checked_out_by = NULL, checked_out_at = NULL WHERE id = ?")
            .run(slot.id)

        // Audit log
        db.prepare('INSERT INTO audit_log (user_id, user_name, key_slot_id, door_number, action, details) VALUES (?, ?, ?, ?, ?, ?)')
            .run(user.id, user.name, slot.id, slot.door_number, 'return', `Key: ${slot.label || 'Slot ' + slot.door_number}`)

        console.log(`[KIOSK] ${user.name} returned key to door ${slot.door_number} (${slot.label})`)

        res.json({ success: true, door_number: slot.door_number, message: 'Door is open — place your key' })
    })

    // Handoff mode: Place key (dealer drops off)
    router.post('/place-key', (req, res) => {
        const { user_id, slot_id, recipient_info } = req.body
        const db = getDb()

        const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(user_id)
        if (!user) return res.json({ success: false, message: 'User not found' })

        const slot = db.prepare('SELECT * FROM key_slots WHERE id = ?').get(slot_id)
        if (!slot) return res.json({ success: false, message: 'Slot not found' })

        if (slot.status !== 'empty' && slot.status !== 'available')
            return res.json({ success: false, message: 'Slot not available' })

        // Open door
        const doorIdx = slot.door_number - 1
        const opened = driver.openDoor(doorIdx)
        if (!opened) return res.json({ success: false, message: 'Failed to open door' })

        // Update slot — mark as reserved for pickup
        db.prepare("UPDATE key_slots SET status = 'reserved', checked_out_by = ?, checked_out_at = datetime('now') WHERE id = ?")
            .run(user.id, slot.id)

        // Audit log
        db.prepare('INSERT INTO audit_log (user_id, user_name, key_slot_id, door_number, action, details) VALUES (?, ?, ?, ?, ?, ?)')
            .run(user.id, user.name, slot.id, slot.door_number, 'place_key', `Placed by: ${user.name}. ${recipient_info || ''}`)

        res.json({ success: true, door_number: slot.door_number, message: 'Door is open — place the key' })
    })

    // Handoff mode: Retrieve key (carrier picks up)
    router.post('/retrieve-key', (req, res) => {
        const { user_id, slot_id } = req.body
        const db = getDb()

        const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(user_id)
        if (!user) return res.json({ success: false, message: 'User not found' })

        const slot = db.prepare('SELECT * FROM key_slots WHERE id = ?').get(slot_id)
        if (!slot) return res.json({ success: false, message: 'Slot not found' })

        if (slot.status !== 'reserved')
            return res.json({ success: false, message: 'No key waiting for pickup' })

        // Open door
        const doorIdx = slot.door_number - 1
        const opened = driver.openDoor(doorIdx)
        if (!opened) return res.json({ success: false, message: 'Failed to open door' })

        // Update slot
        db.prepare("UPDATE key_slots SET status = 'empty', checked_out_by = NULL, checked_out_at = NULL WHERE id = ?")
            .run(slot.id)

        // Audit log
        db.prepare('INSERT INTO audit_log (user_id, user_name, key_slot_id, door_number, action, details) VALUES (?, ?, ?, ?, ?, ?)')
            .run(user.id, user.name, slot.id, slot.door_number, 'retrieve_key', `Retrieved by: ${user.name}`)

        res.json({ success: true, door_number: slot.door_number, message: 'Door is open — take the key' })
    })

    // Live door states from hardware
    router.get('/door-states', (req, res) => {
        res.json({
            states: driver.getDoorStates(),
            connected: driver.isConnected()
        })
    })

    return router
}
