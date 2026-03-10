const BaseDriver = require('./base')

class SimulatorDriver extends BaseDriver {
    constructor(doorCount) {
        super(doorCount)
    }

    async initialize() {
        this.connected = true
        console.log(`[SIMULATOR] Initialized with ${this.doorCount} doors (all closed)`)
    }

    async openDoor(doorNumber) {
        if (doorNumber < 0 || doorNumber >= this.doorCount) {
            console.log(`[SIMULATOR] Invalid door number: ${doorNumber}`)
            return false
        }

        console.log(`[SIMULATOR] Opening door ${doorNumber + 1}`)
        this.doorStates[doorNumber] = false // open

        // Simulate door closing after 5 seconds
        setTimeout(() => {
            this.doorStates[doorNumber] = true // closed
            console.log(`[SIMULATOR] Door ${doorNumber + 1} closed`)
        }, 5000)

        return true
    }
}

module.exports = SimulatorDriver
