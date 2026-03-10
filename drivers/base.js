// Base driver interface — all hardware drivers must implement these methods
class BaseDriver {
    constructor(doorCount) {
        this.doorCount = doorCount
        // Door states: true = closed, false = open
        this.doorStates = new Array(doorCount).fill(true)
        this.connected = false
    }

    // Initialize hardware connection
    async initialize() {
        throw new Error('Not implemented')
    }

    // Open a specific door (0-indexed)
    async openDoor(doorNumber) {
        throw new Error('Not implemented')
    }

    // Get current door states: array of booleans (true=closed, false=open)
    getDoorStates() {
        return this.doorStates
    }

    // Is hardware connected and responding
    isConnected() {
        return this.connected
    }

    // Cleanup on shutdown
    async close() {
        this.connected = false
    }
}

module.exports = BaseDriver
